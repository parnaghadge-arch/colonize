import type { AuditAction } from '@colonize/shared';
import type { Document } from '../db/drivers/types.js';
import type { TenantDatabase } from '../db/drivers/types.js';
import type { RequestContext } from '../middleware/context.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { diffDocuments } from '../utils/serialize.js';

/**
 * Audit logging (§44).
 *
 * Append-only: the `audit_logs` collection has soft delete disabled in the registry and no
 * route exposes update or delete for it. Society administrators can *read* audit logs; nobody
 * (including a super admin) can edit one through the API.
 *
 * Every critical operation goes through `AuditService.log`, either explicitly from a service
 * or automatically from the write helpers below.
 */

export interface AuditInput {
  action: AuditAction | string;
  module: string;
  recordId?: string | null;
  recordType?: string | null;
  oldValue?: Document | null;
  newValue?: Document | null;
  severity?: 'INFO' | 'NOTICE' | 'WARNING' | 'CRITICAL';
  status?: 'SUCCESS' | 'FAILURE';
  errorMessage?: string;
  meta?: Record<string, unknown>;
  /** Explicit actor, used by jobs and platform actions with no request context. */
  actor?: { id?: string | null; name?: string | null; type?: 'USER' | 'SYSTEM' | 'JOB' | 'PLATFORM'; roles?: string[] };
}

export class AuditService {
  constructor(private readonly ctx: RequestContext) {}

  /** Write an audit entry to the society database (or the platform log for platform actions). */
  async log(input: AuditInput): Promise<void> {
    if (!env.AUDIT_ENABLED) return;
    const { ctx } = this;
    const isPlatformAction = ctx.principal.isPlatformUser && !ctx.society;
    const db: TenantDatabase = isPlatformAction ? ctx.platformDatabase : (ctx.db ?? ctx.platformDatabase);
    const collectionName = isPlatformAction ? 'platform_audit_logs' : 'audit_logs';

    const diff = input.oldValue || input.newValue
      ? diffDocuments(input.oldValue, input.newValue)
      : { changedFields: [], oldValue: {}, newValue: {} };

    const entry: Document = {
      societyId: ctx.society?.id ?? null,
      actorId: input.actor?.id ?? ctx.principal.userId,
      actorType: input.actor?.type ?? (ctx.principal.isPlatformUser ? 'PLATFORM' : 'USER'),
      actorName: input.actor?.name ?? ctx.principal.fullName,
      actorRoles: input.actor?.roles ?? ctx.principal.roles,
      actorUnitId: ctx.membership.primaryUnitId ?? null,
      action: input.action,
      module: input.module,
      recordId: input.recordId ?? null,
      recordType: input.recordType ?? null,
      oldValue: input.oldValue ? diff.oldValue : null,
      newValue: input.newValue ? diff.newValue : null,
      changedFields: diff.changedFields,
      ip: ctx.ip,
      userAgent: truncate(ctx.userAgent, 400),
      deviceId: ctx.principal.deviceId ?? null,
      platform: ctx.platform,
      requestId: ctx.requestId,
      severity: input.severity ?? 'INFO',
      status: input.status ?? 'SUCCESS',
      errorMessage: input.errorMessage ? truncate(input.errorMessage, 500) : null,
      tookMs: Date.now() - ctx.startedAt,
      meta: input.meta ?? null,
    };

    try {
      await db.collection(collectionName).create(entry);
    } catch (err) {
      // Auditing must never break a user-facing operation, but a failure is itself notable.
      logger.error({ err, action: input.action, module: input.module }, 'audit: failed to write entry');
    }
  }

  /** Convenience for a successful create. */
  created(module: string, record: Document, action: AuditAction | string = 'CREATE') {
    return this.log({ action, module, recordId: String(record._id ?? ''), recordType: module, newValue: record });
  }

  /** Convenience for an update that records the before/after diff. */
  updated(module: string, before: Document | null, after: Document, action: AuditAction | string = 'UPDATE') {
    return this.log({ action, module, recordId: String(after._id ?? ''), recordType: module, oldValue: before, newValue: after });
  }

  /** Convenience for a delete/soft delete. */
  deleted(module: string, record: Document, action: AuditAction | string = 'DELETE') {
    return this.log({ action, module, recordId: String(record._id ?? ''), recordType: module, oldValue: record });
  }

  /** Security-relevant event (failed auth, cross-tenant attempt, permission change). */
  security(action: AuditAction | string, module: string, detail: Record<string, unknown> = {}) {
    return this.log({
      action,
      module,
      severity: 'WARNING',
      status: 'FAILURE',
      meta: detail,
    });
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Audit an action performed outside a request (scheduled jobs, queue workers).
 * Builds a minimal synthetic context so the entry still records the actor and society.
 */
export async function logSystemAudit(
  db: TenantDatabase,
  input: AuditInput & { societyId: string; collection?: 'audit_logs' | 'platform_audit_logs' },
): Promise<void> {
  if (!env.AUDIT_ENABLED) return;
  try {
    await db.collection(input.collection ?? 'audit_logs').create({
      societyId: input.societyId,
      actorId: input.actor?.id ?? 'system',
      actorType: input.actor?.type ?? 'SYSTEM',
      actorName: input.actor?.name ?? 'System',
      actorRoles: input.actor?.roles ?? [],
      action: input.action,
      module: input.module,
      recordId: input.recordId ?? null,
      recordType: input.recordType ?? null,
      oldValue: input.oldValue ?? null,
      newValue: input.newValue ?? null,
      changedFields: input.oldValue || input.newValue ? diffDocuments(input.oldValue, input.newValue).changedFields : [],
      severity: input.severity ?? 'INFO',
      status: input.status ?? 'SUCCESS',
      errorMessage: input.errorMessage ?? null,
      requestId: `job_${Date.now()}`,
      platform: 'system',
    });
  } catch (err) {
    logger.error({ err, module: input.module }, 'audit: system entry failed');
  }
}
