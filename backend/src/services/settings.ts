import type { Document } from '../db/drivers/types.js';
import type { TenantDatabase } from '../db/drivers/types.js';
import { settingsCache, invalidateSociety } from './cache.js';
import { DEFAULT_SETTINGS } from '../db/seedTenant.js';
import { logger } from '../config/logger.js';
import { newId } from '../db/ids.js';

/**
 * Database-driven configuration (§63 — "do not hard-code business rules").
 *
 * Settings are stored per society in namespaces (`visitor`, `maintenance`, `complaint`, …).
 * A read merges, in order:
 *   built-in defaults  →  stored namespace  →  caller's fallback
 * so a society that never touched a setting still behaves sensibly, and a setting it did
 * change is authoritative everywhere (API, jobs, mobile push copy).
 */

export type SettingsNamespace = keyof typeof DEFAULT_SETTINGS | string;

export interface SettingsReaderOptions {
  db: TenantDatabase;
  societyId: string;
}

export async function getSettings<T extends Document = Document>(
  { db, societyId }: SettingsReaderOptions,
  namespace: SettingsNamespace,
): Promise<T> {
  const cacheKey = `set:${societyId}:${namespace}`;
  return settingsCache.wrap<T>(cacheKey, async () => {
    const defaults = (DEFAULT_SETTINGS[namespace] ?? {}) as Document;
    const record = await db.collection('society_settings').findOne({ societyId, key: namespace });
    const stored = (record?.value ?? {}) as Document;
    return deepMerge(defaults, stored) as T;
  }, 60_000);
}

export async function getSettingValue<T = unknown>(
  opts: SettingsReaderOptions,
  namespace: SettingsNamespace,
  path: string,
  fallback?: T,
): Promise<T> {
  const settings = await getSettings(opts, namespace);
  const value = path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, settings);
  return (value === undefined || value === null ? fallback : value) as T;
}

export async function getAllSettings({ db, societyId }: SettingsReaderOptions): Promise<Record<string, unknown>> {
  const records = await db.collection('society_settings').find({ societyId }, { limit: 200 });
  const out: Record<string, unknown> = {};
  for (const [namespace, defaults] of Object.entries(DEFAULT_SETTINGS)) {
    const record = records.find((r) => r.key === namespace);
    out[namespace] = deepMerge(defaults as Document, (record?.value ?? {}) as Document);
  }
  for (const record of records) {
    if (!out[String(record.key)]) out[String(record.key)] = record.value;
  }
  return out;
}

/**
 * Persist a namespace. Uses a shallow-then-deep merge so a partial update never wipes
 * sibling keys, and invalidates the caches that depend on the society.
 */
export async function updateSettings(
  { db, societyId }: SettingsReaderOptions,
  namespace: SettingsNamespace,
  patch: Document,
  actorUserId?: string | null,
): Promise<Document> {
  const collection = db.collection('society_settings');
  const existing = await collection.findOne({ societyId, key: namespace });
  const merged = deepMerge(
    deepMerge((DEFAULT_SETTINGS[namespace] ?? {}) as Document, (existing?.value ?? {}) as Document),
    patch,
  );

  if (existing) {
    await collection.updateOne(
      { societyId, key: namespace },
      { $set: { value: merged, updatedBy: actorUserId ?? null } },
    );
  } else {
    await collection.create({
      _id: newId('society_settings'),
      societyId,
      key: namespace,
      value: merged,
      description: `Configurable ${namespace} rules`,
      updatedBy: actorUserId ?? null,
    });
  }

  settingsCache.delete(`set:${societyId}:${namespace}`);
  invalidateSociety(societyId);
  logger.debug({ societyId, namespace }, 'settings: updated');
  return merged;
}

/** Reset a namespace back to platform defaults. */
export async function resetSettings(
  { db, societyId }: SettingsReaderOptions,
  namespace: SettingsNamespace,
): Promise<Document> {
  await db.collection('society_settings').deleteOne({ societyId, key: namespace }, { includeDeleted: true });
  settingsCache.delete(`set:${societyId}:${namespace}`);
  invalidateSociety(societyId);
  return (DEFAULT_SETTINGS[namespace] ?? {}) as Document;
}

/** Deep merge where `null` explicitly clears a value and arrays replace (never concatenate). */
export function deepMerge<T extends Document>(base: T, patch: Document): T {
  const out: Document = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      out[key] = null;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = [...value];
      continue;
    }
    if (value && typeof value === 'object' && !((value as unknown) instanceof Date)) {
      const current = out[key];
      out[key] = current && typeof current === 'object' && !Array.isArray(current)
        ? deepMerge(current as Document, value as Document)
        : { ...(value as Document) };
      continue;
    }
    out[key] = value;
  }
  return out as T;
}
