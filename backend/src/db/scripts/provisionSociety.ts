import { fileURLToPath } from 'node:url';
import { databases } from '../manager.js';
import type { Document } from '../drivers/types.js';
import { logger } from '../../config/logger.js';
import { provisionSocietyDatabase } from '../../modules/societies/societiesService.js';

/**
 * Operational CLI: create (or repair) the private database for one or more societies.
 *
 *   npm run db:provision                       # list every society + provisioning state
 *   npm run db:provision -- --all              # provision every society missing its database
 *   npm run db:provision -- --society soc_abc  # provision one society, by id
 *   npm run db:provision -- --society green-valley-residency
 *   npm run db:provision -- --verify           # provision then confirm the collections exist
 *
 * Provisioning is idempotent: a society already flagged `databaseProvisioned` is skipped, so this
 * is safe to re-run after a failed deploy. Normally the onboarding wizard calls the same function
 * — this CLI exists for repairs, migrations and bringing up a society created directly in the DB.
 */

interface Options {
  society?: string;
  all: boolean;
  verify: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { all: false, verify: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') opts.all = true;
    else if (arg === '--verify') opts.verify = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--society' || arg === '-s') opts.society = argv[i + 1];
    else if (arg?.startsWith('--society=')) opts.society = arg.slice('--society='.length);
  }
  return opts;
}

/** Baseline collections every society database is expected to hold after provisioning. */
const EXPECTED_COLLECTIONS = ['society_settings', 'units', 'users', 'buildings'] as const;

export interface ProvisionReport {
  requested: string | 'all' | null;
  societies: Array<{
    societyId: string;
    slug: string;
    name: string;
    databaseName: string;
    status: string;
    action: 'PROVISIONED' | 'ALREADY_PROVISIONED' | 'FAILED';
    verified?: boolean;
    missing?: string[];
    error?: string;
  }>;
  counts: { total: number; provisioned: number; skipped: number; failed: number };
}

async function verifySociety(society: Document): Promise<{ ok: boolean; missing: string[] }> {
  const db = await databases.tenantDb(String(society._id));
  const missing: string[] = [];
  for (const name of EXPECTED_COLLECTIONS) {
    // A missing collection throws or returns null on the embedded driver; either means "absent".
    try {
      await db.collection(name).countDocuments({});
    } catch {
      missing.push(name);
    }
  }
  return { ok: missing.length === 0, missing };
}

export async function provisionSocieties(options: Options): Promise<ProvisionReport> {
  const platform = await databases.platform();
  const societiesCol = platform.collection('societies');

  const filter: Record<string, unknown> = options.society
    ? { $or: [{ _id: options.society }, { slug: options.society }] }
    : {};
  const societies = (await societiesCol.find(filter)) ?? [];

  if (options.society && societies.length === 0) {
    throw new Error(`No society matches "${options.society}" (tried id and slug).`);
  }

  // Without --society we default to only the ones that still need it, so a bare run is a dry look.
  const targets = options.society || options.all
    ? societies
    : societies.filter((s) => !s.databaseProvisioned);

  const report: ProvisionReport = {
    requested: options.society ?? (options.all ? 'all' : null),
    societies: [],
    counts: { total: targets.length, provisioned: 0, skipped: 0, failed: 0 },
  };

  for (const society of targets) {
    const entry = {
      societyId: String(society._id),
      slug: String(society.slug ?? ''),
      name: String(society.name ?? ''),
      databaseName: String(society.databaseName ?? ''),
      status: String(society.status ?? 'UNKNOWN'),
      action: 'ALREADY_PROVISIONED' as const,
    };

    if (society.databaseProvisioned) {
      report.counts.skipped += 1;
      if (options.verify) {
        const check = await verifySociety(society);
        Object.assign(entry, { verified: check.ok, missing: check.missing });
        if (!check.ok) report.counts.failed += 1;
      }
      report.societies.push(entry);
      continue;
    }

    try {
      await provisionSocietyDatabase(society);
      Object.assign(entry, { action: 'PROVISIONED' as const });
      report.counts.provisioned += 1;
      if (options.verify) {
        const check = await verifySociety(society);
        Object.assign(entry, { verified: check.ok, missing: check.missing });
        if (!check.ok) report.counts.failed += 1;
      }
    } catch (err) {
      Object.assign(entry, {
        action: 'FAILED' as const,
        error: err instanceof Error ? err.message : String(err),
      });
      report.counts.failed += 1;
      logger.error({ err, societyId: society._id }, 'db:provision failed for society');
    }

    report.societies.push(entry);
  }

  return report;
}

function printTable(report: ProvisionReport): void {
  if (report.societies.length === 0) {
    // eslint-disable-next-line no-console
    console.log('No societies need provisioning. Pass --all to inspect every society.');
    return;
  }
  // eslint-disable-next-line no-console
  console.log(
    [
      'SOCIETY ID'.padEnd(26),
      'SLUG'.padEnd(28),
      'DATABASE'.padEnd(30),
      'ACTION',
    ].join(''),
  );
  for (const row of report.societies) {
    const extra = row.verified === false ? ` (missing: ${row.missing?.join(', ')})` : '';
    const err = row.error ? ` — ${row.error}` : '';
    // eslint-disable-next-line no-console
    console.log(
      [
        row.societyId.padEnd(26),
        row.slug.slice(0, 27).padEnd(28),
        row.databaseName.slice(0, 29).padEnd(30),
        `${row.action}${extra}${err}`,
      ].join(''),
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    `\n${report.counts.provisioned} provisioned · ${report.counts.skipped} already done · ${report.counts.failed} failed`,
  );
}

/* -------------------------------------------------------------------------- */
/* CLI: `npm run db:provision`                                                */
/* -------------------------------------------------------------------------- */

const isDirectRun = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;

if (isDirectRun) {
  const options = parseArgs(process.argv.slice(2));
  provisionSocieties(options)
    .then(async (report) => {
      if (options.json) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(report, null, 2));
      } else {
        printTable(report);
      }
      await databases.flush().catch(() => undefined);
      await databases.closeAll();
      process.exit(report.counts.failed > 0 ? 1 : 0);
    })
    .catch(async (err) => {
      logger.fatal({ err }, 'db:provision failed');
      // eslint-disable-next-line no-console
      console.error(`db:provision failed: ${err instanceof Error ? err.message : String(err)}`);
      await databases.closeAll().catch(() => undefined);
      process.exit(1);
    });
}
