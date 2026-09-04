import PDFDocument from 'pdfkit';
import type { Document } from '../db/drivers/types.js';

/**
 * Receipt and invoice PDF generation (§59).
 *
 * Rendered server-side with PDFKit so the document a resident downloads is the same one the
 * society's auditor sees — nothing is composed in the browser where amounts could be altered.
 */

export interface ReceiptParty {
  name: string;
  address?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  gstin?: string | null;
  logoUrl?: string | null;
}

export interface ReceiptInput {
  receiptNumber: string;
  society: ReceiptParty;
  receivedFrom: string;
  unit?: { label: string; building?: string | null } | null;
  paidBy?: string;
  amount: number;
  currency: string;
  mode: string;
  paidAt: Date;
  purpose: string;
  referenceNumber?: string;
  providerPaymentId?: string | null;
  amountInWords: string;
  invoice?: {
    invoiceNumber: string;
    period: string;
    totalAmount: number;
    paidAmount: number;
    dueAmount: number;
    dueDate: Date | null;
    items: Array<{ label: string; type: string; amount: number }>;
  } | null;
}

export interface InvoiceInput {
  invoiceNumber: string;
  society: ReceiptParty;
  unit: { label: string; unitNumber?: string; building?: string | null; carpetAreaSqft?: number | null };
  billedTo?: { fullName: string; kind?: string; phone?: string | null } | null;
  period: string;
  periodStart: Date;
  periodEnd: Date;
  dueDate: Date;
  items: Array<{ label: string; type: string; amount: number; quantity?: number; rate?: number | null }>;
  subtotal: number;
  arrears: number;
  lateFee: number;
  penalty: number;
  discount: number;
  waivedAmount: number;
  totalTax: number;
  taxBreakup?: Document | null;
  totalAmount: number;
  paidAmount: number;
  dueAmount: number;
  currency: string;
  notes?: string | null;
  amountInWords: string;
  generatedAt: Date;
}

const INK = '#0F172A';
const MUTED = '#64748B';
const RULE = '#E2E8F0';
const ACCENT = '#4F46E5';
const DANGER = '#B91C1C';
const SUCCESS = '#15803D';

const FONT = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';

function money(value: number, currency = 'INR'): string {
  const symbol = currency === 'INR' ? '\u20B9' : `${currency} `;
  const amount = Number(value ?? 0);
  // Indian digit grouping: 1,00,000 rather than 100,000.
  const [whole, fraction] = Math.abs(amount).toFixed(2).split('.');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${amount < 0 ? '-' : ''}${symbol}${grouped}${fraction && fraction !== '00' ? `.${fraction}` : ''}`;
}

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata',
  });
}

/** Render to a buffer so it can be stored, streamed or attached to an email. */
function render(draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, info: { Title: 'Colonize', Producer: 'Colonize API' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      draw(doc);
    } catch (err) {
      reject(err as Error);
      return;
    }
    doc.end();
  });
}

function drawHeader(doc: PDFKit.PDFDocument, society: ReceiptParty, title: string, subtitle: string): void {
  const top = doc.page.margins.top;
  doc.rect(0, 0, doc.page.width, 96).fill('#F8FAFC');
  doc.rect(0, 94, doc.page.width, 2).fill(ACCENT);

  doc.fillColor(INK).font(FONT_BOLD).fontSize(18).text(society.name, 48, top - 8, { width: 340 });
  const contact = [society.address, [society.contactPhone, society.contactEmail].filter(Boolean).join('  ·  ')].filter(Boolean).join('\n');
  if (contact) doc.fillColor(MUTED).font(FONT).fontSize(8.5).text(contact, 48, doc.y + 3, { width: 340, lineGap: 1.5 });
  if (society.gstin) doc.fillColor(MUTED).fontSize(8).text(`GSTIN: ${society.gstin}`, 48, doc.y + 2);

  doc.fillColor(INK).font(FONT_BOLD).fontSize(15).text(title, 400, top - 4, { width: 164, align: 'right' });
  doc.fillColor(MUTED).font(FONT).fontSize(9).text(subtitle, 400, doc.y + 3, { width: 164, align: 'right' });

  doc.y = 120;
}

function drawFooter(doc: PDFKit.PDFDocument, note: string): void {
  const bottom = doc.page.height - doc.page.margins.bottom;
  doc.moveTo(48, bottom - 46).lineTo(doc.page.width - 48, bottom - 46).strokeColor(RULE).lineWidth(1).stroke();
  doc.fillColor(MUTED).font(FONT).fontSize(8).text(note, 48, bottom - 38, { width: doc.page.width - 96, align: 'center', lineGap: 1.5 });
  doc
    .fontSize(7.5)
    .text('This is a computer-generated document and does not require a signature.', 48, bottom - 16, {
      width: doc.page.width - 96,
      align: 'center',
    });
}

function row(doc: PDFKit.PDFDocument, label: string, value: string, opts: { x?: number; width?: number; y?: number; valueColor?: string; bold?: boolean } = {}): number {
  const x = opts.x ?? 48;
  const width = opts.width ?? doc.page.width - 96;
  const y = opts.y ?? doc.y;
  doc.fillColor(MUTED).font(FONT).fontSize(8.5).text(label.toUpperCase(), x, y, { width: width * 0.5 });
  doc
    .fillColor(opts.valueColor ?? INK)
    .font(opts.bold ? FONT_BOLD : FONT)
    .fontSize(9.5)
    .text(value, x + width * 0.5, y, { width: width * 0.5, align: 'right' });
  return y + 16;
}

/* --------------------------------- receipt --------------------------------- */

export async function generateReceiptPdf(input: ReceiptInput): Promise<Buffer> {
  return render((doc) => {
    drawHeader(doc, input.society, 'PAYMENT RECEIPT', `${input.receiptNumber}`);

    const width = doc.page.width - 96;
    let y = doc.y;

    // Received-from / payment facts, two columns.
    doc.fillColor(INK).font(FONT_BOLD).fontSize(11).text('Received from', 48, y);
    doc.font(FONT).fontSize(12).text(input.receivedFrom, 48, y + 16, { width: width * 0.5 });
    if (input.unit?.building) doc.fillColor(MUTED).fontSize(8.5).text(input.unit.building, 48, y + 32);

    doc.fillColor(ACCENT).font(FONT_BOLD).fontSize(22).text(money(input.amount, input.currency), 48 + width * 0.5, y + 6, { width: width * 0.5, align: 'right' });
    doc.fillColor(MUTED).font(FONT).fontSize(8.5).text(input.amountInWords, 48 + width * 0.5, y + 34, { width: width * 0.5, align: 'right' });

    y += 62;
    doc.moveTo(48, y).lineTo(48 + width, y).strokeColor(RULE).lineWidth(1).stroke();
    y += 16;

    const left: Array<[string, string]> = [
      ['Receipt number', input.receiptNumber],
      ['Payment reference', input.referenceNumber ?? '—'],
      ['Received on', formatDateTime(input.paidAt)],
      ['Payment mode', String(input.mode).replace('_', ' ')],
    ];
    const right: Array<[string, string]> = [
      ['Purpose', String(input.purpose).replace(/_/g, ' ').toLowerCase()],
      ['Gateway payment id', input.providerPaymentId ?? '—'],
      ['Status', 'PAID'],
      ['Currency', input.currency],
    ];

    let ly = y;
    let ry = y;
    for (const [label, value] of left) {
      doc.fillColor(MUTED).font(FONT).fontSize(8.5).text(label.toUpperCase(), 48, ly);
      doc.fillColor(INK).font(FONT).fontSize(9.5).text(value, 48, ly + 12, { width: width * 0.45 });
      ly += 34;
    }
    for (const [label, value] of right) {
      doc.fillColor(MUTED).font(FONT).fontSize(8.5).text(label.toUpperCase(), 48 + width * 0.55, ry);
      doc
        .fillColor(label === 'Status' ? SUCCESS : INK)
        .font(label === 'Status' ? FONT_BOLD : FONT)
        .fontSize(9.5)
        .text(value, 48 + width * 0.55, ry + 12, { width: width * 0.45 });
      ry += 34;
    }
    y = Math.max(ly, ry) + 6;

    if (input.invoice) {
      doc.moveTo(48, y).lineTo(48 + width, y).strokeColor(RULE).stroke();
      y += 18;
      doc.fillColor(INK).font(FONT_BOLD).fontSize(11).text(`Against invoice ${input.invoice.invoiceNumber}`, 48, y);
      doc.fillColor(MUTED).font(FONT).fontSize(8.5).text(`Billing period ${input.invoice.period}`, 48 + width * 0.55, y + 2, { width: width * 0.45, align: 'right' });
      y += 22;

      // Line items
      doc.rect(48, y, width, 22).fill('#F1F5F9');
      doc.fillColor(MUTED).font(FONT_BOLD).fontSize(8).text('DESCRIPTION', 56, y + 7);
      doc.text('AMOUNT', 48 + width - 110, y + 7, { width: 102, align: 'right' });
      y += 22;

      for (const item of input.invoice.items) {
        if (y > doc.page.height - 190) {
          doc.addPage();
          y = doc.page.margins.top;
        }
        doc.fillColor(INK).font(FONT).fontSize(9).text(item.label, 56, y + 5, { width: width - 130 });
        doc.fillColor(item.amount < 0 ? SUCCESS : INK).text(money(item.amount, input.currency), 48 + width - 110, y + 5, { width: 102, align: 'right' });
        y += 20;
        doc.moveTo(56, y - 6).lineTo(48 + width - 8, y - 6).strokeColor('#F1F5F9').stroke();
      }

      y += 8;
      y = row(doc, 'Invoice total', money(input.invoice.totalAmount, input.currency), { y, width });
      y = row(doc, 'Paid with this receipt', money(input.amount, input.currency), { y, width, bold: true, valueColor: SUCCESS });
      if (input.invoice.dueAmount > 0) {
        y = row(doc, 'Still due', money(input.invoice.dueAmount, input.currency), { y, width, bold: true, valueColor: DANGER });
      } else {
        y = row(doc, 'Balance', money(0, input.currency), { y, width, valueColor: SUCCESS });
      }
      if (input.invoice.dueDate) y = row(doc, 'Due date', formatDate(input.invoice.dueDate), { y, width });
    }

    drawFooter(doc, 'Please retain this receipt for your records. For queries, contact the society office.');
  });
}

/* --------------------------------- invoice --------------------------------- */

export async function generateInvoicePdf(input: InvoiceInput): Promise<Buffer> {
  return render((doc) => {
    drawHeader(doc, input.society, 'TAX INVOICE', input.invoiceNumber);

    const width = doc.page.width - 96;
    let y = doc.y;

    // Billed to
    doc.fillColor(INK).font(FONT_BOLD).fontSize(11).text('Billed to', 48, y);
    doc.font(FONT).fontSize(11).text(input.unit.label, 48, y + 16, { width: width * 0.5 });
    const billedToLine = [input.billedTo?.fullName, input.billedTo?.kind, input.billedTo?.phone].filter(Boolean).join('  ·  ');
    if (billedToLine) doc.fillColor(MUTED).fontSize(8.5).text(billedToLine, 48, y + 31, { width: width * 0.5 });
    if (input.unit.carpetAreaSqft) {
      doc.fillColor(MUTED).fontSize(8.5).text(`Carpet area ${input.unit.carpetAreaSqft} sq ft`, 48, y + 45, { width: width * 0.5 });
    }

    doc.fillColor(MUTED).font(FONT_BOLD).fontSize(8.5).text('BILLING PERIOD', 48 + width * 0.55, y);
    doc.fillColor(INK).font(FONT).fontSize(10).text(`${formatDate(input.periodStart)} – ${formatDate(input.periodEnd)}`, 48 + width * 0.55, y + 13, { width: width * 0.45 });
    doc.fillColor(MUTED).font(FONT_BOLD).fontSize(8.5).text('DUE DATE', 48 + width * 0.55, y + 32);
    doc.fillColor(DANGER).font(FONT_BOLD).fontSize(10).text(formatDate(input.dueDate), 48 + width * 0.55, y + 45, { width: width * 0.45 });

    y += 68;
    doc.moveTo(48, y).lineTo(48 + width, y).strokeColor(RULE).lineWidth(1).stroke();
    y += 18;

    // Items table
    doc.rect(48, y, width, 24).fill('#F1F5F9');
    doc.fillColor(MUTED).font(FONT_BOLD).fontSize(8).text('DESCRIPTION', 56, y + 8);
    doc.text('RATE', 48 + width - 220, y + 8, { width: 70, align: 'right' });
    doc.text('AMOUNT', 48 + width - 110, y + 8, { width: 102, align: 'right' });
    y += 24;

    for (const item of input.items) {
      if (y > doc.page.height - 220) {
        doc.addPage();
        y = doc.page.margins.top;
      }
      doc.fillColor(INK).font(FONT).fontSize(9).text(item.label, 56, y + 6, { width: width - 240 });
      if (item.rate) {
        doc.fillColor(MUTED).fontSize(8.5).text(money(item.rate, input.currency), 48 + width - 220, y + 6, { width: 70, align: 'right' });
      }
      doc.fillColor(item.amount < 0 ? SUCCESS : INK).font(FONT).fontSize(9).text(money(item.amount, input.currency), 48 + width - 110, y + 6, { width: 102, align: 'right' });
      y += 21;
      doc.moveTo(56, y - 7).lineTo(48 + width - 8, y - 7).strokeColor('#F1F5F9').stroke();
    }

    y += 10;
    y = row(doc, 'Subtotal', money(input.subtotal, input.currency), { y, width });
    if (input.arrears > 0) y = row(doc, 'Previous arrears', money(input.arrears, input.currency), { y, width });
    if (input.lateFee > 0) y = row(doc, 'Late fee', money(input.lateFee, input.currency), { y, width, valueColor: DANGER });
    if (input.penalty > 0) y = row(doc, 'Penalty', money(input.penalty, input.currency), { y, width, valueColor: DANGER });
    if (input.discount > 0) y = row(doc, 'Discount / waiver', `- ${money(input.discount, input.currency)}`, { y, width, valueColor: SUCCESS });
    if (input.totalTax > 0) y = row(doc, 'Tax', money(input.totalTax, input.currency), { y, width });

    doc.moveTo(48 + width * 0.45, y + 2).lineTo(48 + width, y + 2).strokeColor(RULE).stroke();
    y += 12;
    y = row(doc, 'Total payable', money(input.totalAmount, input.currency), { y, width, bold: true });

    if (input.paidAmount > 0) {
      y = row(doc, 'Already paid', `- ${money(input.paidAmount, input.currency)}`, { y, width, valueColor: SUCCESS });
    }
    y = row(doc, 'Amount due', money(input.dueAmount, input.currency), { y, width, bold: true, valueColor: input.dueAmount > 0 ? DANGER : SUCCESS });

    doc.fillColor(MUTED).font(FONT).fontSize(8.5).text(input.amountInWords, 48, y + 8, { width });
    y += 28;

    if (input.notes) {
      doc.fillColor(MUTED).font(FONT).fontSize(8.5).text(input.notes, 48, y, { width });
      y = doc.y + 8;
    }

    drawFooter(
      doc,
      `Payment is due by ${formatDate(input.dueDate)}. Pay from the resident app, or at the society office. Generated ${formatDateTime(input.generatedAt)}.`,
    );
  });
}

/** Indian-style number to words for receipts and invoices ("Twelve Thousand ... Rupees Only"). */
export function amountInWords(amount: number): string {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  const two = (n: number): string => (n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ''}`);
  const three = (n: number): string => (n >= 100 ? `${ones[Math.floor(n / 100)]} Hundred${n % 100 ? ` ${two(n % 100)}` : ''}` : two(n));

  const value = Number(amount ?? 0);
  const whole = Math.floor(Math.abs(value));
  const paise = Math.round((Math.abs(value) - whole) * 100);

  let words = '';
  const crore = Math.floor(whole / 10_000_000);
  const lakh = Math.floor((whole % 10_000_000) / 100_000);
  const thousand = Math.floor((whole % 100_000) / 1_000);
  const rest = whole % 1_000;
  if (crore) words += `${two(crore)} Crore `;
  if (lakh) words += `${two(lakh)} Lakh `;
  if (thousand) words += `${two(thousand)} Thousand `;
  if (rest) words += `${three(rest)} `;
  words = words.trim() || 'Zero';

  let out = `${words} Rupees`;
  if (paise > 0) out += ` and ${two(paise)} Paise`;
  return `${out} Only`;
}

export { money as formatMoney, formatDate, formatDateTime };
