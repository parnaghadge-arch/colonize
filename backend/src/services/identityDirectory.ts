import { randomHex } from './crypto.js';
import { databases } from '../db/manager.js';
import { societyCache } from './cache.js';
import { logger } from '../config/logger.js';
import type { Document, TenantDatabase } from '../db/drivers/types.js';

/**
 * Cross-society identity directory (§5).
 *
 * A person can be an owner in one society and a committee member in another. Because each
 * society lives in its own database, login needs a single place to answer "where does this
 * phone number exist?". That place is `identity_directory` in the platform database.
 *
 * It is written by the users/residents services whenever an account is created, updated or
 * removed, and read only by authentication. It deliberately holds no operational data.
 */

export interface DirectoryMembership {
  societyId: string;
  societyName: string;
  societySlug: string;
  userId: string;
  roles: string[];
  unitIds: string[];
  status: string;
  isActive: boolean;
}

export interface DirectoryEntry extends Document {
  _id: string;
  phone: string | null;
  email: string | null;
  globalUserId: string;
  societyIds: string[];
  memberships: DirectoryMembership[];
}

export async function findByPhone(phone: string): Promise<DirectoryEntry | null> {
  const db = await databases.platform();
  return (await db.collection<DirectoryEntry>('identity_directory').findOne({ phone })) ?? null;
}

export async function findByEmail(email: string): Promise<DirectoryEntry | null> {
  const db = await databases.platform();
  return (
    (await db.collection<DirectoryEntry>('identity_directory').findOne({ email: email.toLowerCase() })) ?? null
  );
}

export async function findByIdentifier(identifier: string): Promise<DirectoryEntry | null> {
  const value = identifier.trim();
  if (value.includes('@')) return findByEmail(value);
  return findByPhone(value.replace(/[^\d+]/g, ''));
}

export interface UpsertInput {
  societyId: string;
  societyName: string;
  societySlug: string;
  userId: string;
  phone?: string | null;
  email?: string | null;
  roles: string[];
  unitIds?: string[];
  status?: string;
  isActive?: boolean;
}

/** Add or refresh one society membership inside the directory entry for this person. */
export async function upsertMembership(input: UpsertInput): Promise<void> {
  const db = await databases.platform();
  const collection = db.collection<DirectoryEntry>('identity_directory');
  const phone = input.phone ? normalise(input.phone) : null;
  const email = input.email ? input.email.toLowerCase() : null;
  if (!phone && !email) return;

  const membership: DirectoryMembership = {
    societyId: input.societyId,
    societyName: input.societyName,
    societySlug: input.societySlug,
    userId: input.userId,
    roles: input.roles ?? [],
    unitIds: input.unitIds ?? [],
    status: input.status ?? 'ACTIVE',
    isActive: input.isActive !== false,
  };

  const lookup: Document = phone ? { phone } : { email };
  const existing = await collection.findOne(lookup);

  if (!existing) {
    await collection.create({
      phone,
      email,
      globalUserId: `gid_${randomHex(10)}`,
      societyIds: [input.societyId],
      memberships: [membership],
      lastSeenAt: new Date(),
      isBlocked: false,
    });
    return;
  }

  const memberships = (existing.memberships ?? []).filter((m) => m.societyId !== input.societyId);
  memberships.push(membership);
  const societyIds = Array.from(new Set([...(existing.societyIds ?? []), input.societyId]));

  await collection.updateOne(
    { _id: existing._id },
    {
      $set: {
        memberships,
        societyIds,
        lastSeenAt: new Date(),
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {}),
      },
    },
  );
}

/** Drop one society membership (resident moves out, user deleted, society archived). */
export async function removeMembership(societyId: string, userId: string): Promise<void> {
  const db = await databases.platform();
  const collection = db.collection<DirectoryMembership & Document>('identity_directory');
  const entries = await collection.find({ societyIds: societyId }, { limit: 5000 });
  for (const entry of entries) {
    const current = (entry.memberships ?? []) as DirectoryMembership[];
    const memberships = current.filter((m) => m.userId !== userId);
    if (memberships.length === current.length) continue;
    const existingIds = (entry.societyIds ?? []) as string[];
    const societyIds = memberships.length > 0 ? existingIds : existingIds.filter((s) => s !== societyId);
    await collection.updateOne({ _id: entry._id }, { $set: { memberships, societyIds } });
    if (memberships.length === 0) {
      await collection.deleteOne({ _id: entry._id }, { includeDeleted: true });
    }
  }
}

/**
 * Refresh every membership for a society from its own database.
 * Used after bulk resident import and by a nightly consistency job, so the directory can
 * never drift out of sync with the authoritative tenant data.
 */
export async function rebuildForSociety(
  tenantDb: TenantDatabase,
  society: { id: string; name: string; slug: string },
): Promise<{ users: number }> {
  const users = await tenantDb.collection('users').find(
    { societyId: society.id },
    { projection: { _id: 1, phone: 1, email: 1, roles: 1, status: 1, unitIds: 1 }, limit: 100_000 },
  );
  let count = 0;
  for (const user of users) {
    await upsertMembership({
      societyId: society.id,
      societyName: society.name,
      societySlug: society.slug,
      userId: String(user._id),
      phone: user.phone ? String(user.phone) : null,
      email: user.email ? String(user.email) : null,
      roles: Array.isArray(user.roles) ? (user.roles as string[]) : [],
      unitIds: Array.isArray(user.unitIds) ? (user.unitIds as string[]) : [],
      status: String(user.status ?? 'ACTIVE'),
      isActive: user.status === 'ACTIVE',
    });
    count += 1;
  }
  societyCache.clear();
  logger.info({ society: society.slug, users: count }, 'identity-directory: rebuilt');
  return { users: count };
}

function normalise(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+91${digits}`;
  return digits;
}

/** Block/unblock an identity platform-wide (abuse control). */
export async function setBlocked(identifier: string, blocked: boolean): Promise<boolean> {
  const db = await databases.platform();
  const entry = await findByIdentifier(identifier);
  if (!entry) return false;
  await db.collection('identity_directory').updateOne({ _id: entry._id }, { $set: { isBlocked: blocked } });
  return true;
}
