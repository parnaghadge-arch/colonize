import type {
  AudienceType,
  NotificationChannel,
  NotificationEvent,
  NotificationPriority,
} from '@colonize/shared';
import type { Document, TenantDatabase } from '../../db/drivers/types.js';
import { newId } from '../../db/ids.js';
import { logger } from '../../config/logger.js';
import { enqueue } from '../../jobs/queue.js';
import { emit, emitToUsers } from '../../realtime/gateway.js';
import { getSettings } from '../settings.js';
import { EmailProvider, PushProvider, SmsProvider, WhatsAppProvider } from './providers.js';
import { BUILT_IN_TEMPLATES, interpolate, type NotificationTemplate } from './templates.js';

/**
 * Centralised notification engine (§35, §55).
 *
 *   NotificationService.send({ societyId, type, userIds, data })
 *
 *  1. resolve the template   (society override → platform default → built-in)
 *  2. resolve the audience   (explicit user ids, or ALL / BUILDING / WING / FLOOR / UNIT / ROLE)
 *  3. resolve the channels   (explicit → society `notification.channelsByEvent` → template)
 *  4. persist an in-app notification per recipient
 *  5. push it live over Socket.IO so an open app updates without polling
 *  6. enqueue out-of-app delivery (push / SMS / email / WhatsApp) on the job queue
 *
 * Every delivery attempt is recorded on the notification document, so support can answer
 * "why didn't the resident get the alert?" from data rather than guesswork.
 */

export interface AudienceSpec {
  type: AudienceType | 'USERS';
  ids?: string[];
  roles?: string[];
  userIds?: string[];
}

export interface SendInput {
  db: TenantDatabase;
  societyId: string;
  type: NotificationEvent | string;
  audience?: AudienceSpec;
  userIds?: string[];
  data?: Record<string, unknown>;
  title?: string;
  message?: string;
  channels?: NotificationChannel[];
  priority?: NotificationPriority;
  deepLink?: string;
  groupId?: string;
  isCritical?: boolean;
  /** Skip persistence and only push live + out-of-app (used for transient gate prompts). */
  transient?: boolean;
}

export interface SendResult {
  notificationIds: string[];
  recipients: number;
  channels: NotificationChannel[];
  queued: number;
}

export const NotificationService = {
  async send(input: SendInput): Promise<SendResult> {
    const { db, societyId, type } = input;
    const data = input.data ?? {};

    const template = await resolveTemplate(db, societyId, type);
    const title = input.title ?? interpolate(template.title, data);
    const message = input.message ?? interpolate(template.body, data);
    const deepLink = input.deepLink ?? (template.deepLink ? interpolate(template.deepLink, data) : undefined);
    const priority = input.priority ?? template.priority;
    const channels = await resolveChannels(db, societyId, type, input.channels ?? template.channels);

    const userIds = input.userIds?.length
      ? dedupe(input.userIds)
      : await resolveAudience(db, societyId, input.audience);

    if (userIds.length === 0) {
      logger.debug({ societyId, type }, 'notifications: no recipients resolved');
      return { notificationIds: [], recipients: 0, channels, queued: 0 };
    }

    const notificationIds: string[] = [];
    const now = new Date();

    if (!input.transient) {
      const docs = userIds.map((userId) => {
        const id = newId('notifications');
        notificationIds.push(id);
        return {
          _id: id,
          societyId,
          userId,
          unitId: (data.unitId as string) ?? null,
          residentId: (data.residentId as string) ?? null,
          type,
          title: truncate(title, 160),
          message: truncate(message, 500),
          body: message,
          data,
          deepLink: deepLink ?? null,
          priority,
          channels,
          status: 'QUEUED',
          deliveries: [],
          groupId: input.groupId ?? null,
          isCritical: input.isCritical ?? priority === 'CRITICAL',
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        } as Document;
      });

      // Batch in chunks so a society-wide broadcast of 10,000 residents is a few writes,
      // not ten thousand (§60).
      for (let i = 0; i < docs.length; i += 500) {
        await db.collection('notifications').insertMany(docs.slice(i, i + 500));
      }
    }

    // Live push to connected clients.
    emitToUsers(userIds, {
      event: 'notification:new',
      data: {
        type,
        title,
        message,
        deepLink,
        priority,
        data,
        at: now.toISOString(),
      },
    });

    let queued = 0;
    if (channels.includes('PUSH')) queued += await enqueuePush(db, societyId, userIds, { title, body: message, data, deepLink, priority });
    if (channels.includes('SMS')) queued += await enqueueSms(db, societyId, userIds, message);
    if (channels.includes('EMAIL')) queued += await enqueueEmail(db, societyId, userIds, title, message);
    if (channels.includes('WHATSAPP')) queued += await enqueueWhatsApp(db, societyId, userIds, message);

    if (!input.transient && notificationIds.length > 0) {
      await db
        .collection('notifications')
        .updateMany({ societyId, _id: { $in: notificationIds } }, { $set: { status: 'SENT', sentAt: new Date() } })
        .catch((err) => logger.warn({ err }, 'notifications: status update failed'));
    }

    return { notificationIds, recipients: userIds.length, channels, queued };
  },

  /** Notify the residents of a single unit (visitor arrival, delivery, staff). */
  async sendToUnit(input: Omit<SendInput, 'audience' | 'userIds'> & { unitId: string }): Promise<SendResult> {
    return NotificationService.send({ ...input, audience: { type: 'UNIT', ids: [input.unitId] } });
  },

  /** Notify everyone holding one of the given roles in the society. */
  async sendToRoles(input: Omit<SendInput, 'audience' | 'userIds'> & { roles: string[] }): Promise<SendResult> {
    return NotificationService.send({ ...input, audience: { type: 'ROLE', roles: input.roles } });
  },

  /** Society-wide broadcast (notices, announcements, emergencies). */
  async broadcast(input: Omit<SendInput, 'audience' | 'userIds'> & { audience?: AudienceSpec }): Promise<SendResult> {
    return NotificationService.send({ ...input, audience: input.audience ?? { type: 'ALL' } });
  },

  async markRead(db: TenantDatabase, societyId: string, userId: string, ids?: string[]): Promise<number> {
    const filter: Document = { societyId, userId, readAt: null };
    if (ids?.length) filter._id = { $in: ids };
    const res = await db.collection('notifications').updateMany(filter, { $set: { readAt: new Date(), status: 'READ' } });
    return res.modified;
  },

  async unreadCount(db: TenantDatabase, societyId: string, userId: string): Promise<number> {
    return db.collection('notifications').countDocuments({ societyId, userId, readAt: null });
  },
};

/* ------------------------------ template lookup ---------------------------- */

async function resolveTemplate(
  db: TenantDatabase,
  societyId: string,
  type: string,
): Promise<NotificationTemplate> {
  const fallback: NotificationTemplate = BUILT_IN_TEMPLATES[type as NotificationEvent] ?? {
    title: 'Notification',
    body: '',
    channels: ['IN_APP'],
    priority: 'NORMAL',
  };

  const tenantTemplate = await db
    .collection('notification_templates')
    .findOne({ societyId, code: type, isActive: true })
    .catch(() => null);
  if (tenantTemplate) return toTemplate(tenantTemplate, fallback);

  return fallback;
}

function toTemplate(doc: Document, fallback: NotificationTemplate): NotificationTemplate {
  return {
    title: String(doc.title ?? fallback.title),
    body: String(doc.body ?? fallback.body),
    channels: Array.isArray(doc.channels) && doc.channels.length ? (doc.channels as NotificationChannel[]) : fallback.channels,
    priority: (doc.priority as NotificationPriority) ?? fallback.priority,
    deepLink: doc.deepLinkTemplate ? String(doc.deepLinkTemplate) : fallback.deepLink,
  };
}

async function resolveChannels(
  db: TenantDatabase,
  societyId: string,
  type: string,
  templateChannels: NotificationChannel[],
): Promise<NotificationChannel[]> {
  const settings = await getSettings<{
    pushEnabled?: boolean;
    smsEnabled?: boolean;
    emailEnabled?: boolean;
    whatsappEnabled?: boolean;
    channelsByEvent?: Record<string, string[]>;
  }>(
    { db, societyId },
    'notification',
  );

  const configured = settings.channelsByEvent?.[type] as NotificationChannel[] | undefined;
  const channels = configured?.length ? configured : templateChannels;

  const enabled: Record<string, boolean> = {
    IN_APP: true,
    PUSH: settings.pushEnabled !== false,
    SMS: settings.smsEnabled === true,
    EMAIL: settings.emailEnabled !== false,
    WHATSAPP: settings.whatsappEnabled === true,
  };

  const filtered = channels.filter((c) => enabled[c] !== false);
  return filtered.length ? dedupeArray(filtered) : ['IN_APP'];
}

/* ------------------------------ audience lookup ---------------------------- */

/**
 * Turn an audience specification into concrete user ids.
 *
 * Everything is resolved inside the tenant database, so a broadcast can never reach a user
 * of another society even if an id from elsewhere is passed in.
 */
export async function resolveAudience(
  db: TenantDatabase,
  societyId: string,
  audience?: AudienceSpec,
): Promise<string[]> {
  if (!audience) return [];
  if (audience.type === 'USERS') return dedupe(audience.userIds ?? []);

  const users = db.collection('users');

  switch (audience.type) {
    case 'ALL': {
      const docs = await users.find(
        { societyId, status: 'ACTIVE' },
        { projection: { _id: 1 }, limit: 50_000 },
      );
      return docs.map((d) => String(d._id));
    }
    case 'ROLE': {
      const roles = audience.roles ?? [];
      if (roles.length === 0) return [];
      const docs = await users.find(
        { societyId, status: 'ACTIVE', roles: { $in: roles } },
        { projection: { _id: 1 }, limit: 50_000 },
      );
      return docs.map((d) => String(d._id));
    }
    case 'OWNERS_ONLY':
    case 'TENANTS_ONLY': {
      const kind = audience.type === 'OWNERS_ONLY' ? 'OWNER' : 'TENANT';
      const members = await db.collection('unit_members').find(
        { societyId, kind, isActive: true },
        { projection: { userId: 1 }, limit: 50_000 },
      );
      const ids = dedupe(members.map((m) => String(m.userId)).filter((v) => v && v !== 'null'));
      return ids;
    }
    case 'COMMITTEE':
      return resolveAudience(db, societyId, {
        type: 'ROLE',
        roles: ['SOCIETY_ADMIN', 'CHAIRMAN', 'SECRETARY', 'TREASURER', 'COMMITTEE_MEMBER'],
      });
    case 'STAFF':
      return resolveAudience(db, societyId, {
        type: 'ROLE',
        roles: ['MAINTENANCE_STAFF', 'ELECTRICIAN', 'PLUMBER', 'HOUSEKEEPING', 'GARDENER', 'DRIVER', 'DOMESTIC_STAFF'],
      });
    case 'UNIT':
    case 'BUILDING':
    case 'WING':
    case 'FLOOR': {
      const ids = audience.ids ?? [];
      if (ids.length === 0) return [];
      let unitIds: string[] = ids;
      if (audience.type !== 'UNIT') {
        const field = audience.type === 'BUILDING' ? 'buildingId' : audience.type === 'WING' ? 'wingId' : 'floorId';
        const units = await db.collection('units').find(
          { societyId, [field]: { $in: ids }, isActive: true },
          { projection: { _id: 1 }, limit: 50_000 },
        );
        unitIds = units.map((u) => String(u._id));
      }
      if (unitIds.length === 0) return [];
      const members = await db.collection('unit_members').find(
        { societyId, unitId: { $in: unitIds }, isActive: true },
        { projection: { userId: 1 }, limit: 50_000 },
      );
      return dedupe(members.map((m) => String(m.userId)).filter((v) => v && v !== 'null'));
    }
    default:
      return [];
  }
}

/* ------------------------------ channel dispatch --------------------------- */

interface DeliveryRecord {
  channel: NotificationChannel;
  status: 'SENT' | 'FAILED' | 'SKIPPED';
  at: string;
  provider?: string;
  error?: string;
}

async function recordDelivery(
  db: TenantDatabase,
  societyId: string,
  userId: string,
  type: string,
  record: DeliveryRecord,
): Promise<void> {
  await db
    .collection('notifications')
    .updateOne(
      { societyId, userId, type, readAt: null },
      { $push: { deliveries: record }, $set: { status: record.status === 'FAILED' ? 'FAILED' : 'SENT' } },
    )
    .catch(() => undefined);
}

async function enqueuePush(
  db: TenantDatabase,
  societyId: string,
  userIds: string[],
  payload: { title: string; body: string; data: Record<string, unknown>; deepLink?: string; priority: string },
): Promise<number> {
  enqueue({
    name: 'notification.push',
    societyId,
    payload: { societyId, userIds, ...payload },
    maxAttempts: 3,
  });
  return userIds.length;
}

async function enqueueSms(db: TenantDatabase, societyId: string, userIds: string[], message: string): Promise<number> {
  enqueue({ name: 'notification.sms', societyId, payload: { societyId, userIds, message }, maxAttempts: 2 });
  return userIds.length;
}

async function enqueueEmail(
  db: TenantDatabase,
  societyId: string,
  userIds: string[],
  subject: string,
  body: string,
): Promise<number> {
  enqueue({ name: 'notification.email', societyId, payload: { societyId, userIds, subject, body }, maxAttempts: 2 });
  return userIds.length;
}

async function enqueueWhatsApp(db: TenantDatabase, societyId: string, userIds: string[], message: string): Promise<number> {
  enqueue({ name: 'notification.whatsapp', societyId, payload: { societyId, userIds, message }, maxAttempts: 2 });
  return userIds.length;
}

/** Registered job handlers — one per out-of-app channel. */
export function registerNotificationJobs(): void {
  registerPushJob();
  registerSmsJob();
  registerEmailJob();
  registerWhatsAppJob();
}

function registerPushJob(): void {
  // Imported lazily to avoid a cycle: queue ← notifications ← manager.
  void import('../../jobs/queue.js').then(({ registerJob }) => {
    registerJob<{ societyId: string; userIds: string[]; title: string; body: string; data: Record<string, unknown>; deepLink?: string; priority: string }>(
      'notification.push',
      async (payload) => {
        const db = await tenantDbFor(payload.societyId);
        if (!db) return;
        const tokens = await db.collection('push_tokens').find(
          { societyId: payload.societyId, userId: { $in: payload.userIds }, isActive: true },
          { limit: 20_000 },
        );
        if (tokens.length === 0) return;

        const results = await PushProvider.sendMany(
          tokens.map((t) => ({
            token: String(t.token),
            title: payload.title,
            body: payload.body,
            data: { ...payload.data, deepLink: payload.deepLink },
            priority: payload.priority as 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL',
          })),
        );
        const anyFailed = results.some((r) => r.status === 'FAILED');
        if (anyFailed) {
          logger.warn({ societyId: payload.societyId, failures: results.filter((r) => r.status === 'FAILED').length }, 'notifications: some push deliveries failed');
        }
        // Deactivate tokens that the provider reports as invalid (uninstalled app).
        const dead = results
          .map((r, i) => ({ r, token: tokens[i] }))
          .filter((x) => x.r.status === 'FAILED' && /not registered|invalid|DeviceNotRegistered/i.test(x.r.error ?? ''))
          .map((x) => String(x.token?._id));
        if (dead.length > 0) {
          await db.collection('push_tokens').updateMany({ societyId: payload.societyId, _id: { $in: dead } }, { $set: { isActive: false } });
        }
      },
    );
  });
}

function registerSmsJob(): void {
  void import('../../jobs/queue.js').then(({ registerJob }) => {
    registerJob<{ societyId: string; userIds: string[]; message: string }>('notification.sms', async (payload) => {
      const db = await tenantDbFor(payload.societyId);
      if (!db) return;
      const users = await db.collection('users').find(
        { societyId: payload.societyId, _id: { $in: payload.userIds } },
        { projection: { _id: 1, phone: 1 }, limit: 20_000 },
      );
      for (const user of users) {
        if (!user.phone) continue;
        const result = await SmsProvider.send({ to: String(user.phone), message: payload.message });
        await recordDelivery(db, payload.societyId, String(user._id), 'SMS', {
          channel: 'SMS',
          status: result.status,
          at: new Date().toISOString(),
          provider: result.provider,
          error: result.error,
        });
      }
    });
  });
}

function registerEmailJob(): void {
  void import('../../jobs/queue.js').then(({ registerJob }) => {
    registerJob<{ societyId: string; userIds: string[]; subject: string; body: string }>('notification.email', async (payload) => {
      const db = await tenantDbFor(payload.societyId);
      if (!db) return;
      const users = await db.collection('users').find(
        { societyId: payload.societyId, _id: { $in: payload.userIds } },
        { projection: { _id: 1, email: 1 }, limit: 20_000 },
      );
      for (const user of users) {
        if (!user.email) continue;
        const result = await EmailProvider.send({
          to: String(user.email),
          subject: payload.subject,
          text: payload.body,
          html: `<p>${payload.body.replace(/\n/g, '<br/>')}</p>`,
        });
        await recordDelivery(db, payload.societyId, String(user._id), 'EMAIL', {
          channel: 'EMAIL',
          status: result.status,
          at: new Date().toISOString(),
          provider: result.provider,
          error: result.error,
        });
      }
    });
  });
}

function registerWhatsAppJob(): void {
  void import('../../jobs/queue.js').then(({ registerJob }) => {
    registerJob<{ societyId: string; userIds: string[]; message: string }>('notification.whatsapp', async (payload) => {
      const db = await tenantDbFor(payload.societyId);
      if (!db) return;
      const users = await db.collection('users').find(
        { societyId: payload.societyId, _id: { $in: payload.userIds } },
        { projection: { _id: 1, phone: 1 }, limit: 20_000 },
      );
      for (const user of users) {
        if (!user.phone) continue;
        const result = await WhatsAppProvider.send({ to: String(user.phone), message: payload.message });
        await recordDelivery(db, payload.societyId, String(user._id), 'WHATSAPP', {
          channel: 'WHATSAPP',
          status: result.status,
          at: new Date().toISOString(),
          provider: result.provider,
          error: result.error,
        });
      }
    });
  });
}

async function tenantDbFor(societyId: string): Promise<TenantDatabase | null> {
  try {
    const { databases } = await import('../../db/manager.js');
    const platform = await databases.platform();
    const society = await platform.collection('societies').findById(societyId);
    if (!society) return null;
    const handle = await databases.forSociety({
      id: String(society._id),
      slug: String(society.slug),
      databaseName: String(society.databaseName),
    });
    return handle.db;
  } catch (err) {
    logger.error({ err, societyId }, 'notifications: could not resolve tenant database for job');
    return null;
  }
}

/* --------------------------------- helpers -------------------------------- */

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function dedupeArray<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Broadcast a live-only event (no persistence) — used for gate prompts and dashboards. */
export function emitLive(
  societyId: string,
  event: string,
  data: Record<string, unknown>,
  rooms: Array<'security' | 'admins' | 'society'> = ['society'],
): void {
  emit(
    rooms.map((kind) => ({ kind, societyId }) as never),
    { event, data },
  );
}
