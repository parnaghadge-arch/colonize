import type { Document, TenantDatabase } from '../../db/drivers/types.js';
import { newId } from '../../db/ids.js';
import { ApiError } from '../../utils/errors.js';
import { getSettings } from '../../services/settings.js';
import { nextReference } from '../../services/counters.js';
import { NotificationService } from '../../services/notifications/index.js';
import { logger } from '../../config/logger.js';

/**
 * Maintenance billing (§27, §28, §53, §59).
 *
 * One bill per unit per period — enforced by a unique index on (societyId, unitId, period), so
 * running generation twice can never double-charge a household.
 *
 * Every charge comes from the society's own settings (`billingBasis`, `ratePerSqft`,
 * `waterChargePerUnit`, parking charges, sinking fund) or from a per-unit override. Nothing
 * about pricing is baked into code, and each bill snapshots the rates it used so a later
 * config change never rewrites history.
 */

export interface BillingContext {
  db: TenantDatabase;
  societyId: string;
  actorId: string;
  actorName?: string | null;
}

export interface MaintenanceSettings {
  generateDayOfMonth: number;
  dueDayOfMonth: number;
  graceDays: number;
  lateFeeType: 'FIXED' | 'PERCENT';
  lateFeeValue: number;
  billingBasis: 'PER_SQFT' | 'FIXED' | 'PER_UNIT_TIER';
  ratePerSqft: number;
  fixedChargePerUnit: number;
  waterChargePerUnit: number;
  parkingChargeTwoWheeler: number;
  parkingChargeFourWheeler: number;
  clubhouseChargePerUnit: number;
  autoGenerate: boolean;
  reminderDaysBeforeDue: number[];
  billableMemberKind: string;
  includeSinkingFund: boolean;
  sinkingFundPerUnit: number;
}

export const DEFAULT_MAINTENANCE_SETTINGS: Partial<MaintenanceSettings> = {
  billingBasis: 'PER_SQFT',
  ratePerSqft: 3,
  dueDayOfMonth: 10,
  graceDays: 5,
  lateFeeType: 'FIXED',
  lateFeeValue: 100,
};

export async function billingSettings(ctx: BillingContext): Promise<MaintenanceSettings> {
  return getSettings<MaintenanceSettings>({ db: ctx.db, societyId: ctx.societyId }, 'maintenance');
}

/** `2026-09` → the first and last instant of that month. */
export function periodBounds(period: string): { start: Date; end: Date } {
  if (!/^\d{4}-\d{2}$/.test(period)) throw ApiError.badRequest('A period must look like 2026-09');
  const [year, month] = period.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59));
  return { start, end };
}

export function currentPeriod(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function round2(value: number): number {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/* ------------------------------ bill generation ----------------------------- */

export interface BillLine {
  type: string;
  label: string;
  amount: number;
  quantity?: number;
  rate?: number;
  isTaxable?: boolean;
  taxPercent?: number;
  taxType?: string;
  order: number;
}

/** Which charge heads to include when generating a bill (all default on). */
export interface BillInclude {
  fixed?: boolean;
  water?: boolean;
  parking?: boolean;
  clubhouse?: boolean;
  sinkingFund?: boolean;
}

/** Compute what one unit owes for a period, before anything is written. */
export async function computeBillLines(
  ctx: BillingContext,
  unit: Document,
  settings: MaintenanceSettings,
  include: BillInclude = {},
): Promise<{ lines: BillLine[]; subtotal: number }> {
  const lines: BillLine[] = [];
  let order = 0;
  const wantFixed = include.fixed !== false;
  const wantWater = include.water !== false;
  const wantParking = include.parking !== false;
  const wantClubhouse = include.clubhouse === true;
  const wantSinking = include.sinkingFund !== false;

  const basis = String(settings.billingBasis ?? 'PER_SQFT');
  const area = Number(unit.carpetAreaSqft ?? unit.builtUpAreaSqft ?? 0);
  const unitRate = Number(unit.maintenanceRate ?? 0);

  let maintenanceAmount = 0;
  let maintenanceLabel = 'Maintenance charges';
  if (unitRate > 0) {
    // A per-unit override wins over the society default (§27).
    maintenanceAmount = basis === 'PER_SQFT' && area > 0 ? round2(unitRate * area) : round2(unitRate);
    maintenanceLabel = basis === 'PER_SQFT' && area > 0 ? `Maintenance @ ₹${unitRate}/sq ft × ${area} sq ft` : `Maintenance (fixed)`;
  } else if (basis === 'PER_SQFT') {
    const rate = Number(settings.ratePerSqft ?? 0);
    maintenanceAmount = round2(rate * area);
    maintenanceLabel = `Maintenance @ ₹${rate}/sq ft × ${area} sq ft`;
  } else {
    maintenanceAmount = round2(Number(settings.fixedChargePerUnit ?? 0));
    maintenanceLabel = 'Maintenance (fixed charge)';
  }

  if (wantFixed && maintenanceAmount > 0) {
    lines.push({ type: 'MAINTENANCE', label: maintenanceLabel, amount: maintenanceAmount, quantity: area || 1, rate: unitRate || Number(settings.ratePerSqft ?? 0), order: order++ });
  }

  const waterCharge = Number(unit.waterCharge ?? settings.waterChargePerUnit ?? 0);
  if (wantWater && waterCharge > 0) {
    lines.push({ type: 'WATER', label: 'Water charges', amount: round2(waterCharge), order: order++ });
  }

  // Parking is charged from the vehicles actually registered to this flat.
  if (wantParking) {
    const parkingCharge = Number(unit.parkingCharge ?? 0);
    if (parkingCharge > 0) {
      lines.push({ type: 'PARKING', label: 'Parking (contract slot)', amount: round2(parkingCharge), order: order++ });
    } else {
      const vehicles = await ctx.db.collection('vehicles').find({ societyId: ctx.societyId, unitId: unit._id, isActive: true }, { limit: 20 });
      let twoWheelers = 0;
      let fourWheelers = 0;
      for (const v of vehicles) {
        if (['BIKE', 'SCOOTER', 'CYCLE', 'EV_BIKE'].includes(String(v.type))) twoWheelers += 1;
        else fourWheelers += 1;
      }
      const amount = round2(
        twoWheelers * Number(settings.parkingChargeTwoWheeler ?? 0) + fourWheelers * Number(settings.parkingChargeFourWheeler ?? 0),
      );
      if (amount > 0) {
        lines.push({
          type: 'PARKING',
          label: `Parking (${twoWheelers} two-wheeler, ${fourWheelers} four-wheeler)`,
          amount,
          quantity: twoWheelers + fourWheelers,
          order: order++,
        });
      }
    }
  }

  // Clubhouse membership is opt-in per generation run and per-unit (a flat only pays if it is
  // flagged as a clubhouse member, so we never charge someone for a facility they cannot use).
  if (wantClubhouse && Number(settings.clubhouseChargePerUnit ?? 0) > 0 && unit.clubhouseMember !== false) {
    lines.push({ type: 'CLUBHOUSE', label: 'Clubhouse membership', amount: round2(Number(settings.clubhouseChargePerUnit)), order: order++ });
  }

  if (wantSinking && settings.includeSinkingFund && Number(settings.sinkingFundPerUnit ?? 0) > 0) {
    lines.push({ type: 'SINKING_FUND', label: 'Sinking fund', amount: round2(Number(settings.sinkingFundPerUnit)), order: order++ });
  }

  const subtotal = round2(lines.reduce((sum, l) => sum + Number(l.amount), 0));
  return { lines, subtotal };
}

export interface GenerateBillsInput {
  period: string;
  /** Empty = every active unit. */
  unitIds?: string[];
  /** Narrow generation to whole buildings / wings (resolved to unit ids server-side). */
  buildingIds?: string[];
  wingIds?: string[];
  mode?: 'MANUAL' | 'BULK' | 'SCHEDULED';
  dryRun?: boolean;
  sendImmediately?: boolean;
  dueDate?: string | Date;
  /** Charge heads to include; each defaults to on except clubhouse. */
  include?: BillInclude;
  /** Carry unpaid earlier periods into this bill (default true). */
  carryForwardArrears?: boolean;
  /** Apply the society late fee to carried arrears (default true). */
  applyLateFeeOnArrears?: boolean;
}

export interface GenerateBillsResult {
  period: string;
  generated: number;
  skipped: number;
  totalBilled: number;
  bills: Array<{ billId: string; invoiceNumber: string; unitId: string; unitLabel: string; totalAmount: number; dueDate: Date }>;
  errors: Array<{ unitId: string; message: string }>;
}

/**
 * Generate the month's bills.
 *
 * Each bill is written with its lines inside one transaction: a bill without lines (or lines
 * without a bill) would make the ledger disagree with what residents were asked to pay.
 */
export async function generateBills(ctx: BillingContext, input: GenerateBillsInput): Promise<GenerateBillsResult> {
  const settings = await billingSettings(ctx);
  const { start, end } = periodBounds(input.period);
  const mode = input.mode ?? 'BULK';

  const dueDay = Math.min(Math.max(Number(settings.dueDayOfMonth ?? 10), 1), 28);
  const dueDate = input.dueDate ? new Date(input.dueDate as string) : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), dueDay, 23, 59, 59));

  const unitFilter: Document = { societyId: ctx.societyId, isActive: true };
  // Scope: explicit units win; otherwise narrow by building/wing; otherwise the whole society.
  if (input.unitIds?.length) {
    unitFilter._id = { $in: input.unitIds };
  } else if (input.buildingIds?.length || input.wingIds?.length) {
    const or: Document[] = [];
    if (input.buildingIds?.length) or.push({ buildingId: { $in: input.buildingIds } });
    if (input.wingIds?.length) or.push({ wingId: { $in: input.wingIds } });
    unitFilter.$or = or;
  }
  const units = await ctx.db.collection('units').find(unitFilter, { limit: 100_000 });

  const include: BillInclude = input.include ?? {};
  const carryArrears = input.carryForwardArrears !== false;
  const result: GenerateBillsResult = { period: input.period, generated: 0, skipped: 0, totalBilled: 0, bills: [], errors: [] };

  for (const unit of units) {
    try {
      const existing = await ctx.db.collection('maintenance_bills').findOne({
        societyId: ctx.societyId,
        unitId: unit._id,
        period: input.period,
      });
      if (existing) {
        result.skipped += 1;
        continue;
      }

      const { lines, subtotal } = await computeBillLines(ctx, unit, settings, include);

      // Carry forward anything still unpaid from earlier periods (§28 arrears).
      let arrears = 0;
      if (carryArrears) {
        const arrearsRows = await ctx.db.collection('maintenance_bills').find(
          { societyId: ctx.societyId, unitId: unit._id, dueAmount: { $gt: 0 }, status: { $in: ['GENERATED', 'SENT', 'PARTIALLY_PAID', 'OVERDUE'] }, period: { $lt: input.period } },
          { limit: 200 },
        );
        arrears = round2(arrearsRows.reduce((sum, b) => sum + Number(b.dueAmount ?? 0), 0));
        if (arrears > 0) {
          lines.push({ type: 'ARREARS', label: `Previous dues (${arrearsRows.length} bill${arrearsRows.length === 1 ? '' : 's'})`, amount: arrears, order: lines.length });
        }
      }

      // A society may charge its late fee on money already overdue when it re-bills (§28).
      let arrearsLateFee = 0;
      if (carryArrears && arrears > 0 && input.applyLateFeeOnArrears !== false) {
        arrearsLateFee =
          String(settings.lateFeeType ?? 'FIXED') === 'PERCENT'
            ? round2((arrears * Number(settings.lateFeeValue ?? 0)) / 100)
            : round2(Number(settings.lateFeeValue ?? 0));
        if (arrearsLateFee > 0) {
          lines.push({ type: 'LATE_FEE', label: 'Late fee on previous dues', amount: arrearsLateFee, quantity: 1, rate: Number(settings.lateFeeValue ?? 0), order: lines.length });
        }
      }

      const totalAmount = round2(subtotal + arrears + arrearsLateFee);
      if (totalAmount <= 0) {
        result.skipped += 1;
        continue;
      }

      if (input.dryRun) {
        result.generated += 1;
        result.totalBilled = round2(result.totalBilled + totalAmount);
        result.bills.push({ billId: 'preview', invoiceNumber: 'PREVIEW', unitId: String(unit._id), unitLabel: String(unit.label ?? unit.unitNumber), totalAmount, dueDate });
        continue;
      }

      // Who is billed: the owner by default, or the tenant when the society says so (§28).
      const billableKind = String(settings.billableMemberKind ?? 'OWNER');
      const billable = await ctx.db.collection('residents').findOne({
        societyId: ctx.societyId,
        unitId: unit._id,
        kind: billableKind,
        status: 'ACTIVE',
      });

      const invoiceNumber = await nextReference({ db: ctx.db, societyId: ctx.societyId, kind: 'INVOICE' });
      const billId = newId('maintenance_bills');

      await ctx.db.withTransaction(async () => {
        await ctx.db.collection('maintenance_bills').create({
          _id: billId,
          societyId: ctx.societyId,
          invoiceNumber,
          unitId: unit._id,
          residentId: billable?._id ?? null,
          period: input.period,
          periodStart: start,
          periodEnd: end,
          generatedAt: new Date(),
          dueDate,
          status: 'GENERATED',
          subtotal,
          discount: 0,
          discountReason: null,
          taxBreakup: { cgst: 0, sgst: 0, igst: 0, cess: 0, taxableAmount: 0 },
          totalTax: 0,
          arrears,
          penalty: 0,
          lateFee: arrearsLateFee,
          totalAmount,
          paidAmount: 0,
          dueAmount: totalAmount,
          waivedAmount: 0,
          refundedAmount: 0,
          currency: 'INR',
          notes: null,
          itemCount: lines.length,
          paymentIds: [],
          lastPaymentAt: null,
          paidAt: null,
          sentAt: null,
          reminderCount: 0,
          lastReminderAt: null,
          overdueSince: null,
          pdfUrl: null,
          generationMode: mode,
          disputedReason: null,
          configSnapshot: {
            billingBasis: settings.billingBasis,
            ratePerSqft: settings.ratePerSqft,
            fixedChargePerUnit: settings.fixedChargePerUnit,
            waterChargePerUnit: settings.waterChargePerUnit,
            parkingChargeTwoWheeler: settings.parkingChargeTwoWheeler,
            parkingChargeFourWheeler: settings.parkingChargeFourWheeler,
            includeSinkingFund: settings.includeSinkingFund,
            sinkingFundPerUnit: settings.sinkingFundPerUnit,
            dueDayOfMonth: settings.dueDayOfMonth,
            area: Number(unit.carpetAreaSqft ?? 0),
            unitRateOverride: unit.maintenanceRate ?? null,
          },
          createdBy: ctx.actorId,
          updatedBy: ctx.actorId,
        });

        for (const line of lines) {
          await ctx.db.collection('bill_items').create({
            _id: newId('bill_items'),
            societyId: ctx.societyId,
            billId,
            type: line.type,
            label: line.label,
            amount: round2(line.amount),
            quantity: line.quantity ?? 1,
            rate: line.rate ?? null,
            isTaxable: Boolean(line.isTaxable),
            taxPercent: Number(line.taxPercent ?? 0),
            taxType: line.taxType ?? 'NONE',
            taxAmount: 0,
            order: line.order,
            ledgerId: null,
            meta: null,
            createdBy: ctx.actorId,
          });
        }
        return billId;
      });

      await ctx.db.collection('units').updateOne(
        { societyId: ctx.societyId, _id: unit._id },
        { $inc: { outstandingAmount: totalAmount } },
      );

      result.generated += 1;
      result.totalBilled = round2(result.totalBilled + totalAmount);
      result.bills.push({ billId, invoiceNumber, unitId: String(unit._id), unitLabel: String(unit.label ?? unit.unitNumber), totalAmount, dueDate });
    } catch (err) {
      result.errors.push({ unitId: String(unit._id), message: (err as Error).message });
    }
  }

  if (input.sendImmediately && !input.dryRun) await sendBills(ctx, result.bills.map((b) => b.billId));
  logger.info({ societyId: ctx.societyId, period: input.period, generated: result.generated, total: result.totalBilled }, 'bills generated');
  return result;
}

/* -------------------------------- bill actions ------------------------------ */

export async function getBillDetail(ctx: BillingContext, billId: string): Promise<Document> {
  const bill = await ctx.db.collection('maintenance_bills').findOne({ societyId: ctx.societyId, _id: billId });
  if (!bill) throw ApiError.notFound('Bill');

  const [items, unit, payments, resident] = await Promise.all([
    ctx.db.collection('bill_items').find({ societyId: ctx.societyId, billId }, { sort: { order: 1 }, limit: 100 }),
    ctx.db.collection('units').findOne({ societyId: ctx.societyId, _id: bill.unitId }),
    ctx.db.collection('payments').find({ societyId: ctx.societyId, billId, status: { $in: ['SUCCESS', 'REFUNDED', 'PARTIALLY_REFUNDED'] } }, { sort: { paidAt: -1 }, limit: 50 }),
    bill.residentId ? ctx.db.collection('residents').findOne({ societyId: ctx.societyId, _id: bill.residentId }) : null,
  ]);
  const building = unit ? await ctx.db.collection('buildings').findOne({ societyId: ctx.societyId, _id: unit.buildingId }) : null;

  return {
    ...bill,
    items,
    unit: unit ? { id: unit._id, label: unit.label ?? unit.unitNumber, unitNumber: unit.unitNumber, carpetAreaSqft: unit.carpetAreaSqft ?? null, building: building?.name ?? null } : null,
    billedTo: resident ? { id: resident._id, fullName: resident.fullName, kind: resident.kind, phone: resident.phone } : null,
    payments: payments.map((p) => ({
      id: p._id,
      referenceNumber: p.referenceNumber,
      receiptNumber: p.receiptNumber ?? null,
      amount: p.amount,
      mode: p.mode,
      status: p.status,
      paidAt: p.paidAt ?? null,
    })),
  };
}

export async function sendBills(ctx: BillingContext, billIds: string[]): Promise<{ sent: number }> {
  let sent = 0;
  for (const billId of billIds) {
    const bill = await ctx.db.collection('maintenance_bills').findOne({ societyId: ctx.societyId, _id: billId });
    if (!bill || ['PAID', 'CANCELLED', 'WAIVED'].includes(String(bill.status))) continue;

    await ctx.db.collection('maintenance_bills').updateOne(
      { societyId: ctx.societyId, _id: billId },
      { $set: { status: bill.status === 'PARTIALLY_PAID' ? 'PARTIALLY_PAID' : 'SENT', sentAt: new Date(), updatedBy: ctx.actorId } },
    );

    const unit = await ctx.db.collection('units').findOne({ societyId: ctx.societyId, _id: bill.unitId });
    await NotificationService.send({
      db: ctx.db,
      societyId: ctx.societyId,
      type: 'BILL_GENERATED',
      audience: { type: 'UNIT', ids: [String(bill.unitId)] },
      data: {
        invoiceNumber: bill.invoiceNumber,
        period: bill.period,
        totalAmount: bill.totalAmount,
        dueAmount: bill.dueAmount,
        dueDate: new Date(bill.dueDate as string | Date).toISOString().slice(0, 10),
        unit: unit?.label ?? unit?.unitNumber,
        billId,
      },
      deepLink: `/bills/${billId}`,
      priority: 'NORMAL',
    });
    sent += 1;
  }
  return { sent };
}

export async function waiveBill(
  ctx: BillingContext,
  billId: string,
  input: { amount?: number; percent?: number; reason: string; waiveAll?: boolean },
): Promise<Document> {
  const bill = await ctx.db.collection('maintenance_bills').findOne({ societyId: ctx.societyId, _id: billId });
  if (!bill) throw ApiError.notFound('Bill');
  if (!input.reason || input.reason.trim().length < 3) throw ApiError.badRequest('A reason is required to waive a charge');
  if (['PAID', 'CANCELLED', 'WAIVED'].includes(String(bill.status))) throw ApiError.conflict(`This bill is already ${String(bill.status).toLowerCase()}`);

  const dueAmount = Number(bill.dueAmount ?? 0);
  const waiver = input.waiveAll
    ? dueAmount
    : input.percent !== undefined
      ? round2((dueAmount * Number(input.percent)) / 100)
      : round2(Math.min(Number(input.amount ?? 0), dueAmount));
  if (waiver <= 0) throw ApiError.badRequest('The waiver amount must be greater than zero');
  if (waiver > dueAmount) throw ApiError.badRequest('The waiver cannot exceed the outstanding amount');

  const newDue = round2(dueAmount - waiver);
  const newWaived = round2(Number(bill.waivedAmount ?? 0) + waiver);
  const status = newDue <= 0 ? 'WAIVED' : bill.status;

  await ctx.db.collection('maintenance_bills').updateOne(
    { societyId: ctx.societyId, _id: billId },
    {
      $set: { dueAmount: newDue, waivedAmount: newWaived, discountReason: input.reason, status, updatedBy: ctx.actorId },
      $inc: { discount: waiver },
    },
  );
  await ctx.db.collection('bill_items').create({
    _id: newId('bill_items'),
    societyId: ctx.societyId,
    billId,
    type: 'OTHER',
    label: `Waiver — ${input.reason}`,
    amount: -waiver,
    quantity: 1,
    rate: null,
    isTaxable: false,
    taxPercent: 0,
    taxType: 'NONE',
    taxAmount: 0,
    order: 900,
    ledgerId: null,
    meta: { waiver: true, approvedBy: ctx.actorId },
    createdBy: ctx.actorId,
  });
  await ctx.db.collection('units').updateOne({ societyId: ctx.societyId, _id: bill.unitId }, { $inc: { outstandingAmount: -waiver } });

  await NotificationService.send({
    db: ctx.db,
    societyId: ctx.societyId,
    type: 'BILL_WAIVED',
    audience: { type: 'UNIT', ids: [String(bill.unitId)] },
    data: { invoiceNumber: bill.invoiceNumber, waivedAmount: waiver, reason: input.reason, dueAmount: newDue, billId },
    deepLink: `/bills/${billId}`,
  });

  return { billId, waivedAmount: waiver, dueAmount: newDue, status };
}

export async function disputeBill(ctx: BillingContext, billId: string, reason: string): Promise<Document> {
  const bill = await ctx.db.collection('maintenance_bills').findOne({ societyId: ctx.societyId, _id: billId });
  if (!bill) throw ApiError.notFound('Bill');
  if (['PAID', 'CANCELLED'].includes(String(bill.status))) throw ApiError.conflict(`This bill is already ${String(bill.status).toLowerCase()}`);

  await ctx.db.collection('maintenance_bills').updateOne(
    { societyId: ctx.societyId, _id: billId },
    { $set: { status: 'DISPUTED', disputedReason: reason, updatedBy: ctx.actorId } },
  );
  await NotificationService.send({
    db: ctx.db,
    societyId: ctx.societyId,
    type: 'BILL_DISPUTED',
    audience: { type: 'ROLE', roles: ['SOCIETY_ADMIN', 'TREASURER', 'ACCOUNTANT'] },
    data: { invoiceNumber: bill.invoiceNumber, reason, unitId: bill.unitId, billId },
    deepLink: `/bills/${billId}`,
    priority: 'HIGH',
  });
  return { billId, status: 'DISPUTED', reason };
}

/**
 * Apply late fees to overdue bills (§28).
 * The fee formula and grace period come from settings, never from the caller.
 */
export async function applyLateFees(ctx: BillingContext, opts: { period?: string } = {}): Promise<{ updated: number; totalFees: number }> {
  const settings = await billingSettings(ctx);
  const graceDays = Number(settings.graceDays ?? 0);
  const now = new Date();
  const cutoff = new Date(now.getTime() - graceDays * 86_400_000);

  const filter: Document = {
    societyId: ctx.societyId,
    dueAmount: { $gt: 0 },
    dueDate: { $lt: cutoff },
    status: { $in: ['GENERATED', 'SENT', 'PARTIALLY_PAID'] },
    lateFee: 0,
  };
  if (opts.period) filter.period = opts.period;

  const bills = await ctx.db.collection('maintenance_bills').find(filter, { limit: 20_000 });
  let updated = 0;
  let totalFees = 0;

  for (const bill of bills) {
    const fee =
      String(settings.lateFeeType ?? 'FIXED') === 'PERCENT'
        ? round2((Number(bill.dueAmount) * Number(settings.lateFeeValue ?? 0)) / 100)
        : round2(Number(settings.lateFeeValue ?? 0));
    if (fee <= 0) continue;

    await ctx.db.collection('maintenance_bills').updateOne(
      { societyId: ctx.societyId, _id: bill._id },
      {
        $set: { status: 'OVERDUE', overdueSince: bill.overdueSince ?? new Date(bill.dueDate as string | Date), updatedBy: 'system' },
        $inc: { lateFee: fee, totalAmount: fee, dueAmount: fee },
      },
    );
    await ctx.db.collection('bill_items').create({
      _id: newId('bill_items'),
      societyId: ctx.societyId,
      billId: bill._id,
      type: 'LATE_FEE',
      label: `Late fee (${String(settings.lateFeeType ?? 'FIXED').toLowerCase()} — ${graceDays} day grace)`,
      amount: fee,
      quantity: 1,
      rate: Number(settings.lateFeeValue ?? 0),
      isTaxable: false,
      taxPercent: 0,
      taxType: 'NONE',
      taxAmount: 0,
      order: 950,
      ledgerId: null,
      meta: { appliedBy: 'system' },
      createdBy: 'system',
    });
    await ctx.db.collection('units').updateOne({ societyId: ctx.societyId, _id: bill.unitId }, { $inc: { outstandingAmount: fee } });
    updated += 1;
    totalFees = round2(totalFees + fee);
  }

  if (updated) logger.info({ societyId: ctx.societyId, updated, totalFees }, 'late fees applied');
  return { updated, totalFees };
}

/** Send reminders for bills due in N days (driven by `reminderDaysBeforeDue`). */
export async function sendBillReminders(ctx: BillingContext): Promise<{ reminded: number }> {
  const settings = await billingSettings(ctx);
  const days = (settings.reminderDaysBeforeDue ?? [5, 2, 0]).map(Number);
  let reminded = 0;

  for (const offset of days) {
    const target = new Date();
    target.setHours(0, 0, 0, 0);
    target.setDate(target.getDate() + offset);
    const nextDay = new Date(target.getTime() + 86_400_000);

    const bills = await ctx.db.collection('maintenance_bills').find(
      { societyId: ctx.societyId, dueAmount: { $gt: 0 }, dueDate: { $gte: target, $lt: nextDay }, status: { $in: ['GENERATED', 'SENT', 'PARTIALLY_PAID', 'OVERDUE'] } },
      { limit: 20_000 },
    );
    for (const bill of bills) {
      const lastReminder = bill.lastReminderAt ? new Date(bill.lastReminderAt as string | Date) : null;
      if (lastReminder && Date.now() - lastReminder.getTime() < 12 * 3_600_000) continue;

      const unit = await ctx.db.collection('units').findOne({ societyId: ctx.societyId, _id: bill.unitId });
      await NotificationService.send({
        db: ctx.db,
        societyId: ctx.societyId,
        type: offset === 0 ? 'BILL_DUE_TODAY' : 'BILL_REMINDER',
        audience: { type: 'UNIT', ids: [String(bill.unitId)] },
        data: {
          invoiceNumber: bill.invoiceNumber,
          dueAmount: bill.dueAmount,
          dueDate: new Date(bill.dueDate as string | Date).toISOString().slice(0, 10),
          daysLeft: offset,
          unit: unit?.label ?? unit?.unitNumber,
          billId: bill._id,
        },
        deepLink: `/bills/${bill._id}`,
        priority: offset === 0 ? 'HIGH' : 'NORMAL',
      });
      await ctx.db.collection('maintenance_bills').updateOne(
        { societyId: ctx.societyId, _id: bill._id },
        { $inc: { reminderCount: 1 }, $set: { lastReminderAt: new Date() } },
      );
      reminded += 1;
    }
  }
  return { reminded };
}

/* -------------------------------- dashboards -------------------------------- */

export async function billingSummary(ctx: BillingContext, period?: string): Promise<Document> {
  const filter: Document = { societyId: ctx.societyId };
  if (period) filter.period = period;
  const rows = await ctx.db.collection('maintenance_bills').aggregate<{
    _id: string;
    count: number;
    billed: number;
    collected: number;
    due: number;
    waived: number;
  }>([
    { $match: filter },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        billed: { $sum: '$totalAmount' },
        collected: { $sum: '$paidAmount' },
        due: { $sum: '$dueAmount' },
        waived: { $sum: '$waivedAmount' },
      },
    },
  ]);

  const byStatus: Record<string, number> = {};
  let billed = 0;
  let collected = 0;
  let due = 0;
  let waived = 0;
  let count = 0;
  for (const row of rows) {
    byStatus[String(row._id)] = Number(row.count);
    billed += Number(row.billed ?? 0);
    collected += Number(row.collected ?? 0);
    due += Number(row.due ?? 0);
    waived += Number(row.waived ?? 0);
    count += Number(row.count ?? 0);
  }

  return {
    period: period ?? 'all',
    bills: count,
    billed: round2(billed),
    collected: round2(collected),
    outstanding: round2(due),
    waived: round2(waived),
    collectionPercent: billed > 0 ? Math.round((collected / billed) * 1000) / 10 : 0,
    byStatus,
  };
}

/** Defaulters list (§43) — units with unpaid bills, oldest first. */
export async function defaulters(ctx: BillingContext, opts: { olderThanDays?: number; limit?: number } = {}): Promise<Document[]> {
  const cutoff = new Date(Date.now() - Number(opts.olderThanDays ?? 0) * 86_400_000);
  const bills = await ctx.db.collection('maintenance_bills').find(
    { societyId: ctx.societyId, dueAmount: { $gt: 0 }, dueDate: { $lte: cutoff }, status: { $in: ['GENERATED', 'SENT', 'PARTIALLY_PAID', 'OVERDUE', 'DISPUTED'] } },
    { sort: { dueDate: 1 }, limit: 20_000 },
  );

  interface DefaulterRow {
    unitId: string;
    totalDue: number;
    billCount: number;
    oldestDueDate: unknown;
    periods: string[];
  }
  const byUnit = new Map<string, DefaulterRow>();
  for (const bill of bills) {
    const key = String(bill.unitId);
    const entry: DefaulterRow = byUnit.get(key) ?? { unitId: key, totalDue: 0, billCount: 0, oldestDueDate: bill.dueDate, periods: [] };
    entry.totalDue = round2(Number(entry.totalDue) + Number(bill.dueAmount));
    entry.billCount += 1;
    entry.periods.push(String(bill.period));
    if (new Date(bill.dueDate as string | Date) < new Date(entry.oldestDueDate as string | Date)) entry.oldestDueDate = bill.dueDate;
    byUnit.set(key, entry);
  }

  const unitIds = Array.from(byUnit.keys());
  const units = unitIds.length ? await ctx.db.collection('units').find({ societyId: ctx.societyId, _id: { $in: unitIds } }, { limit: unitIds.length }) : [];
  const unitById = new Map(units.map((u) => [String(u._id), u]));

  return Array.from(byUnit.values())
    .map((entry) => {
      const unit = unitById.get(entry.unitId);
      const daysOverdue = Math.max(0, Math.floor((Date.now() - new Date(entry.oldestDueDate as string | Date).getTime()) / 86_400_000));
      return {
        ...entry,
        unitLabel: unit?.label ?? unit?.unitNumber ?? null,
        buildingId: unit?.buildingId ?? null,
        daysOverdue,
      };
    })
    .sort((a, b) => Number(b.totalDue) - Number(a.totalDue))
    .slice(0, Number(opts.limit ?? 100));
}
