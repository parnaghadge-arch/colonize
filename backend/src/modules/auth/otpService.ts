import { generateOtp, normalisePhone } from '@colonize/shared';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { databases } from '../../db/manager.js';
import { newId } from '../../db/ids.js';
import { ApiError } from '../../utils/errors.js';
import { hashSecret, safeEqualString } from '../../services/crypto.js';
import { PushProvider, SmsProvider, EmailProvider } from '../../services/notifications/providers.js';
import { findByIdentifier } from '../../services/identityDirectory.js';
import type { Document } from '../../db/drivers/types.js';

/**
 * OTP issuing & verification (§7).
 *
 * Delivery is abstracted: the *primary* channel is an FCM/Expo push to a device the number is
 * already signed in on (no SMS cost, no SIM swap risk), with SMS and email as fallbacks and a
 * `console` channel for local development.
 *
 * Security properties
 * ------------------
 *   • the code is stored only as `sha256(pepper + code)` — a database leak yields nothing
 *   • TTL-bounded, attempt-bounded (locks the record after N tries)
 *   • resend cooldown per number+purpose, plus a rolling hourly cap
 *   • single use: verifying consumes the record
 *   • the same code never crosses purposes (login vs password reset)
 */

export interface SendOtpInput {
  phone?: string;
  email?: string;
  purpose: 'LOGIN' | 'PASSWORD_RESET' | 'PHONE_VERIFY' | 'STEP_UP';
  channel: 'FCM' | 'SMS' | 'EMAIL' | 'WHATSAPP' | 'CONSOLE';
  deviceId?: string;
  ip?: string;
  societySlug?: string;
}

export interface SendOtpResult {
  requestId: string;
  channel: 'FCM' | 'SMS' | 'EMAIL' | 'CONSOLE';
  expiresAt: Date;
  /** Only present when EXPOSE_DEV_OTP is on and NODE_ENV is not production. */
  devOtp?: string;
  maskedTarget: string;
}

const HOURLY_CAP = 10;

export async function sendOtp(input: SendOtpInput): Promise<SendOtpResult> {
  const phone = input.phone ? normalisePhone(input.phone) : null;
  const email = input.email ? input.email.toLowerCase() : null;
  if (!phone && !email) throw ApiError.badRequest('A mobile number or email address is required');

  const db = await databases.platform();
  const otps = db.collection('otp_requests');

  /* ---- cooldown: block rapid re-sends ---- */
  const lookup: Document = { purpose: input.purpose };
  if (phone) lookup.phone = phone;
  else lookup.email = email;

  const recent = await otps.find(lookup, { sort: { createdAt: -1 }, limit: 1 });
  const lastSentAt = recent[0]?.lastSentAt ? new Date(recent[0].lastSentAt as string | Date) : null;
  if (lastSentAt) {
    const sinceSeconds = (Date.now() - lastSentAt.getTime()) / 1000;
    if (sinceSeconds < env.OTP_RESEND_COOLDOWN_SECONDS) {
      const wait = Math.ceil(env.OTP_RESEND_COOLDOWN_SECONDS - sinceSeconds);
      throw new ApiError(`Please wait ${wait} second(s) before requesting another code`, 'OTP_COOLDOWN');
    }
  }

  /* ---- hourly cap ---- */
  const since = new Date(Date.now() - 3600_000);
  const hourlyCount = await otps.countDocuments({ ...lookup, createdAt: { $gte: since } });
  if (hourlyCount >= HOURLY_CAP) {
    throw new ApiError('Too many codes requested for this number. Please try again in an hour.', 'OTP_ATTEMPTS_EXCEEDED');
  }

  const code = generateOtp(env.OTP_LENGTH);
  const otpHash = hashSecret(code, env.JWT_SECRET);
  const expiresAt = new Date(Date.now() + env.OTP_TTL_SECONDS * 1000);
  const requestId = newId('otp_requests');

  /* ---- choose the real delivery channel ---- */
  const channel = await chooseChannel(input.channel, phone, email);

  await otps.create({
    _id: requestId,
    phone,
    email,
    purpose: input.purpose,
    otpHash,
    channel,
    expiresAt,
    attempts: 0,
    maxAttempts: env.OTP_MAX_ATTEMPTS,
    sentCount: 1,
    lastSentAt: new Date(),
    deliveryStatus: 'QUEUED',
    deviceId: input.deviceId ?? null,
    ip: input.ip ?? null,
    societySlug: input.societySlug ?? null,
  });

  const message = buildOtpMessage(code, input.purpose);
  const delivery = await deliver(channel, { phone, email, message, code });

  await otps.updateOne({ _id: requestId }, { $set: { deliveryStatus: delivery.status } });

  logger.info(
    { requestId, channel: delivery.channel, status: delivery.status, purpose: input.purpose },
    'auth: otp dispatched',
  );

  if (delivery.status === 'FAILED' && channel !== 'CONSOLE') {
    // Fall back so the user is never locked out by a provider outage.
    const fallback = phone ? await deliver('SMS', { phone, email, message, code }) : null;
    await otps.updateOne({ _id: requestId }, { $set: { deliveryStatus: fallback?.status ?? 'FAILED', channel: fallback?.status === 'SENT' ? 'SMS' : channel } });
    if (fallback?.status !== 'SENT') {
      logger.error({ requestId, channel }, 'auth: otp delivery failed on all channels');
    }
  }

  return {
    requestId,
    channel: (delivery.status === 'SENT' ? delivery.channel : channel) as SendOtpResult['channel'],
    expiresAt,
    maskedTarget: phone ? maskMobile(phone) : maskMail(email ?? ''),
    ...(env.EXPOSE_DEV_OTP && !env.NODE_ENV.includes('production') ? { devOtp: code } : {}),
  };
}

async function chooseChannel(
  requested: SendOtpInput['channel'],
  phone: string | null,
  email: string | null,
): Promise<'FCM' | 'SMS' | 'EMAIL' | 'CONSOLE'> {
  if (requested === 'CONSOLE') return 'CONSOLE';
  if (requested === 'EMAIL' && email) return 'EMAIL';
  if (requested === 'SMS' && phone) return 'SMS';

  // Default: try push first (this is the "OTP through FCM token" behaviour from §7).
  if (requested === 'FCM' && phone) {
    const hasPush = await hasRegisteredPushToken(phone);
    if (hasPush) return 'FCM';
    return env.NODE_ENV === 'production' ? 'SMS' : 'CONSOLE';
  }
  if (phone) return env.SMS_PROVIDER === 'console' && env.NODE_ENV !== 'production' ? 'CONSOLE' : 'SMS';
  return 'EMAIL';
}

/** Does any society have an active push token for this phone number? */
async function hasRegisteredPushToken(phone: string): Promise<boolean> {
  const entry = await findByIdentifier(phone);
  if (!entry) return false;
  for (const membership of entry.memberships ?? []) {
    if (!membership.isActive) continue;
    try {
      const handle = await databases.forSociety({
        id: membership.societyId,
        slug: membership.societySlug,
        databaseName: (await societyDatabaseName(membership.societyId)) ?? '',
      });
      if (!handle) continue;
      const token = await handle.db.collection('push_tokens').findOne({
        societyId: membership.societyId,
        userId: membership.userId,
        isActive: true,
      });
      if (token) return true;
    } catch {
      // A society we cannot reach must not block login through another channel.
      continue;
    }
  }
  return false;
}

async function societyDatabaseName(societyId: string): Promise<string | null> {
  const db = await databases.platform();
  const society = await db.collection('societies').findById(societyId);
  return society ? String(society.databaseName) : null;
}

function buildOtpMessage(code: string, purpose: string): string {
  if (purpose === 'PASSWORD_RESET') {
    return `${code} is your Colonize password reset code. It expires in ${Math.round(env.OTP_TTL_SECONDS / 60)} minutes. If you did not request this, ignore this message.`;
  }
  return `${code} is your Colonize verification code. It expires in ${Math.round(env.OTP_TTL_SECONDS / 60)} minutes. Never share this code with anyone.`;
}

interface DeliverInput {
  phone: string | null;
  email: string | null;
  message: string;
  code: string;
}

async function deliver(
  channel: 'FCM' | 'SMS' | 'EMAIL' | 'CONSOLE',
  input: DeliverInput,
): Promise<{ status: 'SENT' | 'FAILED'; channel: string }> {
  try {
    if (channel === 'CONSOLE') {
      logger.info({ channel: 'console', phone: input.phone, email: input.email }, 'otp(console): code issued (see meta.devOtp)');
      return { status: 'SENT', channel: 'CONSOLE' };
    }
    if (channel === 'EMAIL' && input.email) {
      const res = await EmailProvider.send({
        to: input.email,
        subject: 'Your Colonize verification code',
        text: input.message,
      });
      return { status: res.status === 'SENT' ? 'SENT' : 'FAILED', channel: 'EMAIL' };
    }
    if (channel === 'FCM' && input.phone) {
      const tokens = await pushTokensForPhone(input.phone);
      if (tokens.length === 0) return { status: 'FAILED', channel: 'FCM' };
      const results = await PushProvider.sendMany(
        tokens.map((t) => ({
          token: t.token,
          title: 'Your verification code',
          // The code travels in `data` so the OS shows a generic alert; the app reads it
          // from the data payload and fills the field automatically.
          body: 'Tap to open Colonize and continue signing in.',
          data: { otp: input.code, purpose: 'LOGIN' },
          priority: 'HIGH' as const,
        })),
      );
      return { status: results.some((r) => r.status === 'SENT') ? 'SENT' : 'FAILED', channel: 'FCM' };
    }
    if (input.phone) {
      const res = await SmsProvider.send({ to: input.phone, message: input.message });
      return { status: res.status === 'SENT' ? 'SENT' : 'FAILED', channel: 'SMS' };
    }
    return { status: 'FAILED', channel };
  } catch (err) {
    logger.warn({ err: (err as Error).message, channel }, 'auth: otp delivery error');
    return { status: 'FAILED', channel };
  }
}

async function pushTokensForPhone(phone: string): Promise<Array<{ token: string }>> {
  const entry = await findByIdentifier(phone);
  if (!entry) return [];
  const tokens: Array<{ token: string }> = [];
  for (const membership of entry.memberships ?? []) {
    if (!membership.isActive) continue;
    const databaseName = await societyDatabaseName(membership.societyId);
    if (!databaseName) continue;
    try {
      const handle = await databases.forSociety({
        id: membership.societyId,
        slug: membership.societySlug,
        databaseName,
      });
      const found = await handle.db.collection('push_tokens').find(
        { societyId: membership.societyId, userId: membership.userId, isActive: true },
        { limit: 10 },
      );
      tokens.push(...found.map((f) => ({ token: String(f.token) })));
    } catch {
      continue;
    }
  }
  return tokens.slice(0, 10);
}

/* ------------------------------- verification ----------------------------- */

export interface VerifyOtpInput {
  phone?: string;
  email?: string;
  otp: string;
  purpose: 'LOGIN' | 'PASSWORD_RESET' | 'PHONE_VERIFY' | 'STEP_UP';
}

export interface VerifiedOtp extends Document {
  _id: string;
  phone: string | null;
  email: string | null;
  purpose: string;
}

export async function verifyOtp(input: VerifyOtpInput): Promise<VerifiedOtp> {
  const phone = input.phone ? normalisePhone(input.phone) : null;
  const email = input.email ? input.email.toLowerCase() : null;
  if (!phone && !email) throw ApiError.badRequest('A mobile number or email address is required');

  const db = await databases.platform();
  const otps = db.collection('otp_requests');
  const lookup: Document = { purpose: input.purpose, consumedAt: null };
  if (phone) lookup.phone = phone;
  else lookup.email = email;

  const record = await otps.findOne(lookup, { sort: { createdAt: -1 }, limit: 1 });
  if (!record) throw new ApiError('Please request a new code', 'OTP_INVALID');

  if (new Date(record.expiresAt as string | Date).getTime() < Date.now()) {
    await otps.updateOne({ _id: record._id }, { $set: { consumedAt: new Date(), deliveryStatus: 'EXPIRED' } });
    throw new ApiError('This code has expired. Please request a new one.', 'OTP_EXPIRED');
  }

  const attempts = Number(record.attempts ?? 0) + 1;
  if (attempts > Number(record.maxAttempts ?? env.OTP_MAX_ATTEMPTS)) {
    await otps.updateOne({ _id: record._id }, { $set: { consumedAt: new Date(), attempts, deliveryStatus: 'LOCKED' } });
    throw new ApiError('Too many incorrect attempts. Please request a new code.', 'OTP_ATTEMPTS_EXCEEDED');
  }

  const provided = hashSecret(String(input.otp).trim(), env.JWT_SECRET);
  const stored = String(record.otpHash ?? '');
  // Constant-time comparison so a wrong code cannot be detected byte-by-byte.
  if (!safeEqualString(provided, stored)) {
    await otps.updateOne({ _id: record._id }, { $set: { attempts } });
    const remaining = Number(record.maxAttempts ?? env.OTP_MAX_ATTEMPTS) - attempts;
    throw new ApiError(
      remaining > 0 ? `Incorrect code. ${remaining} attempt(s) remaining.` : 'Incorrect code. Please request a new one.',
      remaining > 0 ? 'OTP_INVALID' : 'OTP_ATTEMPTS_EXCEEDED',
    );
  }

  // Consume immediately so the same code cannot be replayed.
  await otps.updateOne({ _id: record._id }, { $set: { consumedAt: new Date(), attempts } });
  return record as VerifiedOtp;
}

export function maskMobile(phone: string): string {
  if (phone.length < 6) return phone;
  return `${phone.slice(0, 3)}•••••${phone.slice(-3)}`;
}

export function maskMail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return email;
  return `${local.slice(0, 2)}•••@${domain}`;
}

/** Purge expired OTP records (nightly cleanup job). */
export async function purgeExpiredOtps(): Promise<number> {
  const db = await databases.platform();
  const res = await db
    .collection('otp_requests')
    .deleteMany({ expiresAt: { $lt: new Date(Date.now() - 86400000) } }, { includeDeleted: true });
  return res.deleted;
}
