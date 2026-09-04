import type { Document, TenantDatabase } from '../../db/drivers/types.js';
import { newId } from '../../db/ids.js';
import { ApiError } from '../../utils/errors.js';
import { nextReference } from '../../services/counters.js';
import { logger } from '../../config/logger.js';

/**
 * Double-entry accounting (§29, §43).
 *
 * Every rupee that moves posts a journal entry whose debits equal its credits. Entries are
 * immutable once posted: a mistake is corrected by a reversing entry, never by editing
 * history — which is what makes the ledger auditable by a society's own auditor.
 *
 * Ledger balances are cached on the `ledgers` document but are always recomputable from the
 * journal, so `rebuildLedgerBalances` can repair them if anything ever drifts.
 */

export interface AccountingContext {
  db: TenantDatabase;
  societyId: string;
  actorId: string;
  actorName?: string | null;
}

export type LedgerGroup = 'INCOME' | 'EXPENSE' | 'ASSET' | 'LIABILITY' | 'EQUITY';
export type LineType = 'DEBIT' | 'CREDIT';

export interface JournalLine {
  ledgerId: string;
  type: LineType;
  amount: number;
  note?: string | null;
}

function round2(value: number): number {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/* --------------------------------- ledgers ---------------------------------- */

/** Find a system ledger by name, creating it from the seeded defaults if it is missing. */
export async function ensureLedger(
  ctx: AccountingContext,
  name: string,
  fallback: { type: string; group: LedgerGroup; code?: string },
): Promise<Document> {
  const existing = await ctx.db.collection('ledgers').findOne({ societyId: ctx.societyId, name });
  if (existing) return existing;
  return ctx.db.collection('ledgers').create({
    _id: newId('ledgers'),
    societyId: ctx.societyId,
    name,
    code: fallback.code ?? null,
    type: fallback.type,
    group: fallback.group,
    openingBalance: 0,
    currentBalance: 0,
    isSystem: true,
    vendorId: null,
    unitId: null,
    description: `Auto-created system ledger for ${name.toLowerCase()}`,
    isActive: true,
    createdBy: ctx.actorId,
    updatedBy: ctx.actorId,
  });
}

/** The ledgers a maintenance receipt posts to (§29). */
export async function maintenanceLedgers(ctx: AccountingContext): Promise<{ receivable: Document; income: Document; cash: Document }> {
  const [receivable, income, cash] = await Promise.all([
    ensureLedger(ctx, 'Maintenance Receivable', { type: 'ASSET', group: 'ASSET', code: 'ACC-1001' }),
    ensureLedger(ctx, 'Maintenance Income', { type: 'MAINTENANCE_INCOME', group: 'INCOME', code: 'INC-4001' }),
    ensureLedger(ctx, 'Bank / Cash', { type: 'ASSET', group: 'ASSET', code: 'ACC-1000' }),
  ]);
  return { receivable, income, cash };
}

/* ------------------------------ journal entries ----------------------------- */

export interface PostEntryInput {
  date?: Date | string;
  narration: string;
  lines: JournalLine[];
  referenceType?: 'PAYMENT' | 'RECEIPT' | 'EXPENSE' | 'INCOME' | 'BILL' | 'ADJUSTMENT' | 'OPENING';
  referenceId?: string | null;
  unitId?: string | null;
  vendorId?: string | null;
  paymentId?: string | null;
  attachments?: Document[];
}

/**
 * Post a balanced journal entry and move the ledger balances in the same transaction.
 *
 * An unbalanced entry is rejected outright — the ledger can never silently drift out of
 * balance because a caller made an arithmetic mistake.
 */
export async function postJournalEntry(ctx: AccountingContext, input: PostEntryInput): Promise<Document> {
  if (!input.lines?.length) throw ApiError.badRequest('A journal entry needs at least one line');

  const totalDebit = round2(input.lines.filter((l) => l.type === 'DEBIT').reduce((s, l) => s + Number(l.amount), 0));
  const totalCredit = round2(input.lines.filter((l) => l.type === 'CREDIT').reduce((s, l) => s + Number(l.amount), 0));
  if (totalDebit !== totalCredit) {
    throw ApiError.badRequest(`The entry does not balance: debits ₹${totalDebit} vs credits ₹${totalCredit}`);
  }
  if (totalDebit <= 0) throw ApiError.badRequest('The entry amount must be greater than zero');

  // Every referenced ledger must exist and belong to this society — an id from another
  // society's database would resolve to nothing and silently drop money from the books.
  const ledgerIds = Array.from(new Set(input.lines.map((l) => String(l.ledgerId))));
  const ledgers = await ctx.db.collection('ledgers').find({ societyId: ctx.societyId, _id: { $in: ledgerIds } }, { limit: ledgerIds.length });
  if (ledgers.length !== ledgerIds.length) {
    const found = new Set(ledgers.map((l) => String(l._id)));
    throw ApiError.badRequest(`Unknown ledger(s): ${ledgerIds.filter((id) => !found.has(id)).join(', ')}`);
  }

  const date = input.date ? new Date(input.date as string) : new Date();
  const entryId = newId('journal_entries');
  const entryNumber = await nextReference({ db: ctx.db, societyId: ctx.societyId, kind: 'JOURNAL' });

  const entry = await ctx.db.withTransaction(async () => {
    const doc = await ctx.db.collection('journal_entries').create({
      _id: entryId,
      societyId: ctx.societyId,
      entryNumber,
      date,
      narration: String(input.narration).trim(),
      referenceType: input.referenceType ?? 'ADJUSTMENT',
      referenceId: input.referenceId ?? null,
      totalDebit,
      totalCredit,
      lines: input.lines.map((l) => ({ ledgerId: String(l.ledgerId), type: l.type, amount: round2(l.amount), note: l.note ?? null })),
      isPosted: true,
      postedAt: new Date(),
      reversedByEntryId: null,
      reversesEntryId: null,
      unitId: input.unitId ?? null,
      vendorId: input.vendorId ?? null,
      paymentId: input.paymentId ?? null,
      attachments: input.attachments ?? [],
      createdBy: ctx.actorId,
      updatedBy: ctx.actorId,
    });

    // Balances follow the ledger's own group: an ASSET or EXPENSE grows on a debit, while
    // INCOME, LIABILITY and EQUITY grow on a credit.
    for (const line of input.lines) {
      const ledger = ledgers.find((l) => String(l._id) === String(line.ledgerId));
      if (!ledger) continue;
      const growsOnDebit = ['ASSET', 'EXPENSE'].includes(String(ledger.group));
      const delta = line.type === 'DEBIT' ? (growsOnDebit ? 1 : -1) : growsOnDebit ? -1 : 1;
      await ctx.db.collection('ledgers').updateOne(
        { societyId: ctx.societyId, _id: line.ledgerId },
        { $inc: { currentBalance: round2(Number(line.amount) * delta) } },
      );
    }
    return doc;
  });

  logger.debug({ societyId: ctx.societyId, entryNumber, totalDebit }, 'accounting: journal posted');
  return entry;
}

/**
 * Reverse a posted entry (§29).
 *
 * The original is never edited — a new entry with swapped debits/credits is posted and both
 * are cross-linked, which is what an auditor expects to see.
 */
export async function reverseJournalEntry(ctx: AccountingContext, entryId: string, reason: string): Promise<Document> {
  const original = await ctx.db.collection('journal_entries').findOne({ societyId: ctx.societyId, _id: entryId });
  if (!original) throw ApiError.notFound('Journal entry');
  if (original.reversedByEntryId) throw ApiError.conflict('This entry has already been reversed');

  const reversal = await postJournalEntry(ctx, {
    date: new Date(),
    narration: `Reversal of ${original.entryNumber}: ${reason}`,
    lines: ((original.lines as Document[]) ?? []).map((l) => ({
      ledgerId: String(l.ledgerId),
      type: l.type === 'DEBIT' ? ('CREDIT' as LineType) : ('DEBIT' as LineType),
      amount: Number(l.amount),
      note: 'Reversal',
    })),
    referenceType: 'ADJUSTMENT',
    referenceId: String(original._id),
    unitId: original.unitId ?? null,
    vendorId: original.vendorId ?? null,
    paymentId: original.paymentId ?? null,
  });

  await ctx.db.collection('journal_entries').updateOne(
    { societyId: ctx.societyId, _id: entryId },
    { $set: { reversedByEntryId: reversal._id } },
  );
  await ctx.db.collection('journal_entries').updateOne(
    { societyId: ctx.societyId, _id: reversal._id },
    { $set: { reversesEntryId: entryId } },
  );

  return reversal;
}

/* ------------------------------ common postings ----------------------------- */

/**
 * Post a maintenance receipt (§29 — "bill → pay → ledger → receipt").
 *
 *   Dr Bank / Cash                Cr Maintenance Income        (the money received)
 *   Dr Maintenance Income*        Cr Maintenance Receivable    (clearing the dues)
 *
 * Simplified to the two lines a society treasurer expects: cash comes in, the receivable
 * goes down. When the bill was never raised as a receivable, the credit goes to income.
 */
export async function postReceipt(
  ctx: AccountingContext,
  input: { amount: number; billId?: string | null; paymentId: string; unitId?: string | null; narration?: string; date?: Date; receiptNumber: string },
): Promise<Document> {
  const { receivable, income, cash } = await maintenanceLedgers(ctx);
  const amount = round2(input.amount);

  // If this payment clears a raised bill, the credit side is the receivable; otherwise it is
  // recognised straight as income.
  let creditLedger = income;
  if (input.billId) {
    const bill = await ctx.db.collection('maintenance_bills').findOne({ societyId: ctx.societyId, _id: input.billId });
    if (bill) creditLedger = receivable;
  }

  return postJournalEntry(ctx, {
    date: input.date ?? new Date(),
    narration: input.narration ?? `Maintenance receipt ${input.receiptNumber}`,
    referenceType: 'RECEIPT',
    referenceId: input.paymentId,
    paymentId: input.paymentId,
    unitId: input.unitId ?? null,
    lines: [
      { ledgerId: String(cash._id), type: 'DEBIT', amount, note: 'Money received' },
      { ledgerId: String(creditLedger._id), type: 'CREDIT', amount, note: input.billId ? 'Dues cleared' : 'Income recognised' },
    ],
  });
}

/** Post an amenity booking fee (separate income ledger so the reports can split it out). */
export async function postAmenityReceipt(
  ctx: AccountingContext,
  input: { amount: number; paymentId: string; bookingId: string; unitId?: string | null; amenityName?: string; receiptNumber: string },
): Promise<Document> {
  const cash = await ensureLedger(ctx, 'Bank / Cash', { type: 'ASSET', group: 'ASSET', code: 'ACC-1000' });
  const income = await ensureLedger(ctx, 'Amenity Income', { type: 'AMENITY_INCOME', group: 'INCOME', code: 'INC-4003' });
  return postJournalEntry(ctx, {
    narration: `Amenity booking receipt ${input.receiptNumber}${input.amenityName ? ` — ${input.amenityName}` : ''}`,
    referenceType: 'RECEIPT',
    referenceId: input.paymentId,
    paymentId: input.paymentId,
    unitId: input.unitId ?? null,
    lines: [
      { ledgerId: String(cash._id), type: 'DEBIT', amount: round2(input.amount), note: 'Booking fee received' },
      { ledgerId: String(income._id), type: 'CREDIT', amount: round2(input.amount), note: 'Amenity income' },
    ],
  });
}

/** Post a society expense (§29) against the right expense ledger and vendor. */
export async function postExpense(
  ctx: AccountingContext,
  input: { amount: number; ledgerName: string; ledgerType?: string; vendorId?: string | null; narration: string; date?: Date | string; invoiceNumber?: string | null; workOrderId?: string | null },
): Promise<Document> {
  const cash = await ensureLedger(ctx, 'Bank / Cash', { type: 'ASSET', group: 'ASSET', code: 'ACC-1000' });
  const expense = await ensureLedger(ctx, input.ledgerName, {
    type: input.ledgerType ?? 'OTHER_EXPENSE',
    group: 'EXPENSE',
  });

  return postJournalEntry(ctx, {
    date: input.date ?? new Date(),
    narration: input.narration,
    referenceType: 'EXPENSE',
    referenceId: input.invoiceNumber ?? null,
    vendorId: input.vendorId ?? null,
    lines: [
      { ledgerId: String(expense._id), type: 'DEBIT', amount: round2(input.amount), note: input.narration },
      { ledgerId: String(cash._id), type: 'CREDIT', amount: round2(input.amount), note: 'Paid out' },
    ],
  });
}

/** Raise a receivable when a bill is generated, so the books match what residents owe. */
export async function postBillAccrual(ctx: AccountingContext, input: { billId: string; amount: number; unitId: string; invoiceNumber: string; period: string }): Promise<Document> {
  const { receivable, income } = await maintenanceLedgers(ctx);
  return postJournalEntry(ctx, {
    narration: `Maintenance bill ${input.invoiceNumber} for ${input.period}`,
    referenceType: 'BILL',
    referenceId: input.billId,
    unitId: input.unitId,
    lines: [
      { ledgerId: String(receivable._id), type: 'DEBIT', amount: round2(input.amount), note: 'Amount receivable' },
      { ledgerId: String(income._id), type: 'CREDIT', amount: round2(input.amount), note: 'Income accrued' },
    ],
  });
}

/* --------------------------- expenses and incomes ---------------------------- */

export interface RecordExpenseInput {
  title: string;
  ledgerId: string;
  amount: number;
  date: string | Date;
  vendorId?: string | null;
  workOrderId?: string | null;
  category?: string | null;
  gstin?: string | null;
  taxableAmount?: number | null;
  cgst?: number;
  sgst?: number;
  igst?: number;
  invoiceNumber?: string | null;
  paymentMode?: string | null;
  attachments?: Document[];
  note?: string | null;
  isPaid?: boolean;
  approvedBy?: string | null;
}

/**
 * Record a society expense (§29).
 *
 * The expense row and its journal entry are written together: an unpaid expense is booked as a
 * liability (money owed), and marking it paid moves it out through Bank / Cash. Recording the
 * row alone would leave the ledger blind to money the society has already committed to spend.
 */
export async function recordExpense(ctx: AccountingContext, input: RecordExpenseInput): Promise<Document> {
  const amount = round2(Number(input.amount));
  if (!amount || amount <= 0) throw ApiError.badRequest('The expense amount must be greater than zero');

  const ledger = await ctx.db.collection('ledgers').findOne({ societyId: ctx.societyId, _id: input.ledgerId });
  if (!ledger) throw ApiError.notFound('Ledger');
  if (String(ledger.group) !== 'EXPENSE') throw ApiError.badRequest(`"${ledger.name}" is not an expense ledger`);

  const expenseId = newId('expenses');
  const isPaid = Boolean(input.isPaid);
  const cash = await ensureLedger(ctx, 'Bank / Cash', { type: 'ASSET', group: 'ASSET', code: 'ACC-1000' });

  // Paid now → straight out of the bank. Unpaid → owed to the vendor (a liability) until paid.
  const creditLedger = isPaid
    ? cash
    : await ensureLedger(ctx, 'Sundry Creditors', { type: 'LIABILITY', group: 'LIABILITY', code: 'LIA-3000' });

  const entry = await postJournalEntry(ctx, {
    date: input.date,
    narration: `${input.title}${input.invoiceNumber ? ` (invoice ${input.invoiceNumber})` : ''}`,
    referenceType: 'EXPENSE',
    referenceId: expenseId,
    vendorId: input.vendorId ?? null,
    attachments: input.attachments ?? [],
    lines: [
      { ledgerId: String(ledger._id), type: 'DEBIT', amount, note: input.title },
      { ledgerId: String(creditLedger._id), type: 'CREDIT', amount, note: isPaid ? 'Paid out' : 'Amount payable' },
    ],
  });

  const expense = await ctx.db.collection('expenses').create({
    _id: expenseId,
    societyId: ctx.societyId,
    title: String(input.title).trim(),
    ledgerId: ledger._id,
    vendorId: input.vendorId ?? null,
    workOrderId: input.workOrderId ?? null,
    amount,
    date: new Date(input.date as string | Date),
    category: input.category ?? null,
    gstin: input.gstin ?? null,
    taxableAmount: input.taxableAmount ?? null,
    cgst: round2(Number(input.cgst ?? 0)),
    sgst: round2(Number(input.sgst ?? 0)),
    igst: round2(Number(input.igst ?? 0)),
    invoiceNumber: input.invoiceNumber ?? null,
    paymentMode: input.paymentMode ?? null,
    attachments: input.attachments ?? [],
    note: input.note ?? null,
    isPaid,
    paidAt: isPaid ? new Date(input.date as string | Date) : null,
    paymentId: null,
    journalEntryId: entry._id,
    approvedBy: input.approvedBy ?? ctx.actorId,
    approvedAt: new Date(),
    status: isPaid ? 'PAID' : 'APPROVED',
    createdBy: ctx.actorId,
    updatedBy: ctx.actorId,
  });

  logger.info({ societyId: ctx.societyId, expenseId, amount, isPaid }, 'accounting: expense recorded');
  return expense;
}

/**
 * Settle an already-recorded expense: move it from the creditor liability out through the bank.
 */
export async function markExpensePaid(
  ctx: AccountingContext,
  expenseId: string,
  input: { paymentMode?: string; paymentId?: string | null; paidAt?: string | Date } = {},
): Promise<Document> {
  const expense = await ctx.db.collection('expenses').findOne({ societyId: ctx.societyId, _id: expenseId });
  if (!expense) throw ApiError.notFound('Expense');
  if (expense.isPaid) throw ApiError.conflict('This expense is already paid');

  const amount = round2(Number(expense.amount));
  const cash = await ensureLedger(ctx, 'Bank / Cash', { type: 'ASSET', group: 'ASSET', code: 'ACC-1000' });
  const creditors = await ensureLedger(ctx, 'Sundry Creditors', { type: 'LIABILITY', group: 'LIABILITY', code: 'LIA-3000' });
  const paidAt = new Date(input.paidAt ?? new Date());

  const entry = await postJournalEntry(ctx, {
    date: paidAt,
    narration: `Payment for expense: ${expense.title}`,
    referenceType: 'EXPENSE',
    referenceId: expenseId,
    vendorId: expense.vendorId ?? null,
    paymentId: input.paymentId ?? null,
    lines: [
      { ledgerId: String(creditors._id), type: 'DEBIT', amount, note: 'Liability settled' },
      { ledgerId: String(cash._id), type: 'CREDIT', amount, note: 'Paid out' },
    ],
  });

  const updated = await ctx.db.collection('expenses').findOneAndUpdate(
    { societyId: ctx.societyId, _id: expenseId, isPaid: false },
    {
      $set: {
        isPaid: true,
        paidAt,
        status: 'PAID',
        paymentMode: input.paymentMode ?? expense.paymentMode ?? null,
        paymentId: input.paymentId ?? null,
        journalEntryId: entry._id,
        updatedBy: ctx.actorId,
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) throw ApiError.conflict('This expense was settled by someone else just now');

  logger.info({ societyId: ctx.societyId, expenseId, amount }, 'accounting: expense paid');
  return updated;
}

export interface RecordIncomeInput {
  title: string;
  ledgerId: string;
  amount: number;
  date: string | Date;
  unitId?: string | null;
  source?: string | null;
  gstin?: string | null;
  taxableAmount?: number | null;
  cgst?: number;
  sgst?: number;
  igst?: number;
  invoiceNumber?: string | null;
  attachments?: Document[];
  note?: string | null;
  paymentId?: string | null;
  isReceived?: boolean;
}

/**
 * Record income that did not arrive through a maintenance bill or an amenity booking (§29) —
 * interest, rent from society-owned space, advertisement hoardings, donations.
 */
export async function recordIncome(ctx: AccountingContext, input: RecordIncomeInput): Promise<Document> {
  const amount = round2(Number(input.amount));
  if (!amount || amount <= 0) throw ApiError.badRequest('The income amount must be greater than zero');

  const ledger = await ctx.db.collection('ledgers').findOne({ societyId: ctx.societyId, _id: input.ledgerId });
  if (!ledger) throw ApiError.notFound('Ledger');
  if (String(ledger.group) !== 'INCOME') throw ApiError.badRequest(`"${ledger.name}" is not an income ledger`);

  const incomeId = newId('incomes');
  const isReceived = input.isReceived !== false;
  const cash = await ensureLedger(ctx, 'Bank / Cash', { type: 'ASSET', group: 'ASSET', code: 'ACC-1000' });
  // Money not yet in hand is a receivable, so the books still balance on the day it is earned.
  const debitLedger = isReceived
    ? cash
    : await ensureLedger(ctx, 'Other Receivables', { type: 'ASSET', group: 'ASSET', code: 'ACC-1002' });

  const entry = await postJournalEntry(ctx, {
    date: input.date,
    narration: `${input.title}${input.invoiceNumber ? ` (invoice ${input.invoiceNumber})` : ''}`,
    referenceType: 'INCOME',
    referenceId: incomeId,
    unitId: input.unitId ?? null,
    paymentId: input.paymentId ?? null,
    attachments: input.attachments ?? [],
    lines: [
      { ledgerId: String(debitLedger._id), type: 'DEBIT', amount, note: isReceived ? 'Money received' : 'Amount receivable' },
      { ledgerId: String(ledger._id), type: 'CREDIT', amount, note: input.title },
    ],
  });

  const income = await ctx.db.collection('incomes').create({
    _id: incomeId,
    societyId: ctx.societyId,
    title: String(input.title).trim(),
    ledgerId: ledger._id,
    unitId: input.unitId ?? null,
    source: input.source ?? null,
    amount,
    date: new Date(input.date as string | Date),
    paymentId: input.paymentId ?? null,
    journalEntryId: entry._id,
    gstin: input.gstin ?? null,
    taxableAmount: input.taxableAmount ?? null,
    cgst: round2(Number(input.cgst ?? 0)),
    sgst: round2(Number(input.sgst ?? 0)),
    igst: round2(Number(input.igst ?? 0)),
    invoiceNumber: input.invoiceNumber ?? null,
    attachments: input.attachments ?? [],
    note: input.note ?? null,
    isReceived,
    createdBy: ctx.actorId,
    updatedBy: ctx.actorId,
  });

  logger.info({ societyId: ctx.societyId, incomeId, amount, isReceived }, 'accounting: income recorded');
  return income;
}

/* --------------------------------- reports ---------------------------------- */

/** Recompute every ledger balance from the journal — the repair tool for §29. */
export async function rebuildLedgerBalances(ctx: AccountingContext): Promise<{ ledgers: number; corrections: number }> {
  const ledgers = await ctx.db.collection('ledgers').find({ societyId: ctx.societyId }, { limit: 1000 });
  const entries = await ctx.db.collection('journal_entries').find(
    { societyId: ctx.societyId, isPosted: true, reversedByEntryId: null },
    { limit: 200_000 },
  );

  const balances = new Map<string, number>();
  for (const entry of entries) {
    for (const line of (entry.lines as Document[]) ?? []) {
      const ledger = ledgers.find((l) => String(l._id) === String(line.ledgerId));
      if (!ledger) continue;
      const growsOnDebit = ['ASSET', 'EXPENSE'].includes(String(ledger.group));
      const delta = line.type === 'DEBIT' ? (growsOnDebit ? 1 : -1) : growsOnDebit ? -1 : 1;
      balances.set(String(line.ledgerId), round2((balances.get(String(line.ledgerId)) ?? 0) + Number(line.amount) * delta));
    }
  }

  let corrections = 0;
  for (const ledger of ledgers) {
    const expected = round2(Number(ledger.openingBalance ?? 0) + (balances.get(String(ledger._id)) ?? 0));
    if (Math.abs(expected - Number(ledger.currentBalance ?? 0)) > 0.005) {
      await ctx.db.collection('ledgers').updateOne({ societyId: ctx.societyId, _id: ledger._id }, { $set: { currentBalance: expected } });
      corrections += 1;
    }
  }
  logger.info({ societyId: ctx.societyId, ledgers: ledgers.length, corrections }, 'accounting: ledger balances rebuilt');
  return { ledgers: ledgers.length, corrections };
}

export interface TrialBalanceRow {
  ledgerId: string;
  name: string;
  code: string | null;
  type: string;
  group: LedgerGroup;
  openingBalance: number;
  debit: number;
  credit: number;
  closingBalance: number;
}

/** Trial balance for a date range (§43). Debits must equal credits — the UI asserts it. */
export async function trialBalance(ctx: AccountingContext, from: Date, to: Date): Promise<{ rows: TrialBalanceRow[]; totalDebit: number; totalCredit: number; balanced: boolean }> {
  const ledgers = await ctx.db.collection('ledgers').find({ societyId: ctx.societyId }, { sort: { group: 1, name: 1 }, limit: 1000 });
  const entries = await ctx.db.collection('journal_entries').find(
    { societyId: ctx.societyId, isPosted: true, reversedByEntryId: null, date: { $gte: from, $lte: to } },
    { limit: 200_000 },
  );

  const debitByLedger = new Map<string, number>();
  const creditByLedger = new Map<string, number>();
  for (const entry of entries) {
    for (const line of (entry.lines as Document[]) ?? []) {
      const key = String(line.ledgerId);
      const amount = Number(line.amount);
      if (line.type === 'DEBIT') debitByLedger.set(key, round2((debitByLedger.get(key) ?? 0) + amount));
      else creditByLedger.set(key, round2((creditByLedger.get(key) ?? 0) + amount));
    }
  }

  let totalDebit = 0;
  let totalCredit = 0;
  const rows = ledgers.map((ledger) => {
    const debit = debitByLedger.get(String(ledger._id)) ?? 0;
    const credit = creditByLedger.get(String(ledger._id)) ?? 0;
    const growsOnDebit = ['ASSET', 'EXPENSE'].includes(String(ledger.group));
    const opening = Number(ledger.openingBalance ?? 0);
    const closing = round2(growsOnDebit ? opening + debit - credit : opening + credit - debit);
    totalDebit = round2(totalDebit + debit);
    totalCredit = round2(totalCredit + credit);
    return {
      ledgerId: String(ledger._id),
      name: String(ledger.name),
      code: ledger.code ? String(ledger.code) : null,
      type: String(ledger.type),
      group: ledger.group as LedgerGroup,
      openingBalance: opening,
      debit,
      credit,
      closingBalance: closing,
    };
  });

  return { rows, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 };
}

/** Income and expense totals for a period — the society's P&L (§43). */
export async function incomeStatement(ctx: AccountingContext, from: Date, to: Date): Promise<Document> {
  const { rows } = await trialBalance(ctx, from, to);
  const income = rows.filter((r) => r.group === 'INCOME');
  const expense = rows.filter((r) => r.group === 'EXPENSE');
  const totalIncome = round2(income.reduce((s, r) => s + r.closingBalance, 0));
  const totalExpense = round2(expense.reduce((s, r) => s + r.closingBalance, 0));

  return {
    from,
    to,
    income: income.map((r) => ({ name: r.name, amount: r.closingBalance })).sort((a, b) => b.amount - a.amount),
    expense: expense.map((r) => ({ name: r.name, amount: r.closingBalance })).sort((a, b) => b.amount - a.amount),
    totalIncome,
    totalExpense,
    netSurplus: round2(totalIncome - totalExpense),
  };
}

/** What the society owns and owes on a date (§43). */
export async function balanceSheet(ctx: AccountingContext, asOf: Date): Promise<Document> {
  const ledgers = await ctx.db.collection('ledgers').find({ societyId: ctx.societyId }, { limit: 1000 });
  const entries = await ctx.db.collection('journal_entries').find(
    { societyId: ctx.societyId, isPosted: true, reversedByEntryId: null, date: { $lte: asOf } },
    { limit: 500_000 },
  );

  const balances = new Map<string, number>();
  for (const entry of entries) {
    for (const line of (entry.lines as Document[]) ?? []) {
      const ledger = ledgers.find((l) => String(l._id) === String(line.ledgerId));
      if (!ledger) continue;
      const growsOnDebit = ['ASSET', 'EXPENSE'].includes(String(ledger.group));
      const delta = line.type === 'DEBIT' ? (growsOnDebit ? 1 : -1) : growsOnDebit ? -1 : 1;
      balances.set(String(line.ledgerId), round2((balances.get(String(line.ledgerId)) ?? 0) + Number(line.amount) * delta));
    }
  }

  const shape = (group: LedgerGroup) =>
    ledgers
      .filter((l) => l.group === group)
      .map((l) => ({ name: String(l.name), amount: round2(Number(l.openingBalance ?? 0) + (balances.get(String(l._id)) ?? 0)) }));

  const assets = shape('ASSET');
  const liabilities = shape('LIABILITY');
  const income = shape('INCOME');
  const expense = shape('EXPENSE');
  const totalAssets = round2(assets.reduce((s, r) => s + r.amount, 0));
  const totalLiabilities = round2(liabilities.reduce((s, r) => s + r.amount, 0));
  const surplus = round2(income.reduce((s, r) => s + r.amount, 0) - expense.reduce((s, r) => s + r.amount, 0));

  return {
    asOf,
    assets,
    liabilities,
    totalAssets,
    totalLiabilities,
    surplus,
    balanced: Math.abs(totalAssets - (totalLiabilities + surplus)) < 0.01,
  };
}
