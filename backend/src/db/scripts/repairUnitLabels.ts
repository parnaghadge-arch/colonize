import { fileURLToPath } from 'node:url';
import { databases } from '../manager.js';
import { logger } from '../../config/logger.js';
import { composeUnitLabel } from '../../modules/structure/structureService.js';
import type { Document } from '../drivers/types.js';

/**
 * Repair script: recompute `units.label` for any unit whose label is missing or is not a string.
 *
 * Why this exists
 * ---------------
 * `createUnit` built the label with an async helper that was not awaited, so the stored value was
 * a Promise — which serialises to `{}`. The bug was in the service layer, so it affected MongoDB
 * deployments as well as the embedded driver. Every unit created before the fix has a label that
 * renders as blank in the resident app, the admin console and printed bills.
 *
 *   npm run db:repair-labels                  # repair every society
 *   npm run db:repair-labels -- --dry-run     # report only, change nothing
 *   npm run db:repair-labels -- --society soc_abc
 *   npm run db:repair-labels -- --json
 *
 * Idempotent: a unit with a correct string label is never touched.
 */

interface Options {
  society?: string;
  dryRun: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '-n') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--society' || arg === '-s') opts.society = argv[i + 1];
    else if (arg?.startsWith('--society=')) opts.society = arg.slice('--society='.length);
  }
  return opts;
}

export interface RepairReport {
  dryRun: boolean;
  societies: Array<{
    societyId: string;
    slug: string;
    scanned: number;
    broken: number;
    repaired: number;
    skipped: string;
  }>;
  totals: { scanned: number; broken: number; repaired: number };
}

/** A label is usable only when it is a non-empty string. */
function isUsableLabel(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

async function repairSociety(society: Document, dryRun: boolean): Promise<RepairReport['societies'][number]> {
  const societyId = String(society._id);
  const db = await databases.tenantDb(societyId);
  const units = db.collection('units');

  const all = (await units.find({}, { limit: 100_000 })) ?? [];
  const broken = all.filter((u) => !isUsableLabel(u.label));

  const report = {
    societyId,
    slug: String(society.slug ?? ''),
    scanned: all.length,
    broken: broken.length,
    repaired: 0,
    skipped: '',
  };

  if (broken.length === 0) return report;
  if (dryRun) {
    report.skipped = 'dry run';
    return report;
  }

  // Load the hierarchy once rather than per unit — a society can have tens of thousands of them.
  const [buildings, wings] = await Promise.all([
    db.collection('buildings').find({}, { limit: 10_000 }),
    db.collection('wings').find({}, { limit: 10_000 }),
  ]);
  const buildingById = new Map((buildings ?? []).map((b) => [String(b._id), b]));
  const wingById = new Map((wings ?? []).map((w) => [String(w._id), w]));

  for (const unit of broken) {
    const building = unit.buildingId ? buildingById.get(String(unit.buildingId)) : undefined;
    const wing = unit.wingId ? wingById.get(String(unit.wingId)) : undefined;
    const label = composeUnitLabel({
      unitNumber: String(unit.unitNumber ?? ''),
      wingCode: wing ? String(wing.code ?? '') : null,
      buildingName: building?.name ? String(building.name) : null,
      buildingCode: building?.code ? String(building.code) : null,
      floorNumber: typeof unit.floorNumber === 'number' ? unit.floorNumber : null,
    });
    if (!label) continue;
    await units.updateOne({ _id: unit._id }, { $set: { label } });
    report.repaired += 1;
  }

  return report;
}

export async function repairUnitLabels(options: Options): Promise<RepairReport> {
  const platform = await databases.platform();
  const filter: Document = options.society
    ? { $or: [{ _id: options.society }, { slug: options.society }] }
    : {};
  const societies = (await platform.collection('societies').find(filter)) ?? [];

  if (options.society && societies.length === 0) {
    throw new Error(`No society matches "${options.society}" (tried id and slug).`);
  }

  const report: RepairReport = {
    dryRun: options.dryRun,
    societies: [],
    totals: { scanned: 0, broken: 0, repaired: 0 },
  };

  for (const society of societies) {
    try {
      const result = await repairSociety(society, options.dryRun);
      report.societies.push(result);
      report.totals.scanned += result.scanned;
      report.totals.broken += result.broken;
      report.totals.repaired += result.repaired;
    } catch (err) {
      // A society whose database was never provisioned must not abort the whole repair.
      report.societies.push({
        societyId: String(society._id),
        slug: String(society.slug ?? ''),
        scanned: 0,
        broken: 0,
        repaired: 0,
        skipped: err instanceof Error ? err.message : String(err),
      });
      logger.warn({ err, societyId: society._id }, 'db:repair-labels skipped a society');
    }
  }

  return report;
}

function printReport(report: RepairReport): void {
  if (report.societies.length === 0) {
    // eslint-disable-next-line no-console
    console.log('No societies found.');
    return;
  }
  // eslint-disable-next-line no-console
  console.log(['SOCIETY'.padEnd(30), 'UNITS'.padEnd(8), 'BROKEN'.padEnd(9), 'REPAIRED'].join(''));
  for (const row of report.societies) {
    const note = row.skipped ? `  (${row.skipped})` : '';
    // eslint-disable-next-line no-console
    console.log(
      [
        (row.slug || row.societyId).slice(0, 29).padEnd(30),
        String(row.scanned).padEnd(8),
        String(row.broken).padEnd(9),
        `${row.repaired}${note}`,
      ].join(''),
    );
  }
  const { scanned, broken, repaired } = report.totals;
  // eslint-disable-next-line no-console
  console.log(
    `\n${scanned} units scanned · ${broken} had an unusable label · ${repaired} repaired${report.dryRun ? ' (dry run — nothing written)' : ''}`,
  );
}

/* -------------------------------------------------------------------------- */
/* CLI: `npm run db:repair-labels`                                            */
/* -------------------------------------------------------------------------- */

const isDirectRun = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;

if (isDirectRun) {
  const options = parseArgs(process.argv.slice(2));
  repairUnitLabels(options)
    .then(async (report) => {
      if (options.json) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(report, null, 2));
      } else {
        printReport(report);
      }
      await databases.flush().catch(() => undefined);
      await databases.closeAll();
      process.exit(0);
    })
    .catch(async (err) => {
      logger.fatal({ err }, 'db:repair-labels failed');
      // eslint-disable-next-line no-console
      console.error(`db:repair-labels failed: ${err instanceof Error ? err.message : String(err)}`);
      await databases.closeAll().catch(() => undefined);
      process.exit(1);
    });
}
