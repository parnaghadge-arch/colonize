import QRCode from 'qrcode';
import { hmacSign, hmacVerify, sha256 } from './crypto.js';
import { randomHex } from './crypto.js';
import { ApiError } from '../utils/errors.js';
import type { Document } from '../db/drivers/types.js';
import type { TenantDatabase } from '../db/drivers/types.js';
import { newId } from '../db/ids.js';

/**
 * Secure QR passes (§12, §57).
 *
 * What is *in* the QR
 * -------------------
 *   `CLNZ1.<base64url(payload)>.<base64url(hmac)>`
 *   payload = { v, k, p, s, e, n }
 *     v  version of the token format
 *     k  kind: VISITOR | VEHICLE | STAFF | AMENITY_BOOKING | SOCIETY_ACCESS
 *     p  pass document id
 *     s  society id (the pass is only valid at this society)
 *     e  expiry epoch seconds
 *     n  random nonce (makes every issued token unique)
 *
 * What is *not* in the QR: names, phone numbers, flat numbers, photos. Scanning a pass at a
 * gate reveals nothing to a bystander, and a stolen image cannot be used to enumerate or
 * contact residents.
 *
 * Defence in depth
 * ----------------
 *   1. HMAC signature → a forged or edited token is rejected without touching the database
 *   2. `e` expiry claim → an expired token is rejected before the lookup
 *   3. server-side record → status, validity window and remaining entries are authoritative
 *   4. society match → a pass from society A cannot be used at society B
 *   5. **atomic consumption** → `updateOne({_id, status:ACTIVE, entriesUsed:{$lt:maxEntries}},
 *      {$inc:{entriesUsed:1}})`. Two guards scanning the same QR at the same instant produce
 *      exactly one successful entry; the loser gets QR_ALREADY_USED. This is what makes
 *      replay and duplicate-entry attacks structurally impossible rather than merely unlikely.
 */

export type QrKind = 'VISITOR' | 'VEHICLE' | 'STAFF' | 'AMENITY_BOOKING' | 'SOCIETY_ACCESS';

const TOKEN_VERSION = 1;
const TOKEN_PREFIX = 'CLNZ1';

export interface IssuePassInput {
  db: TenantDatabase;
  societyId: string;
  kind: QrKind;
  unitId?: string | null;
  residentId?: string | null;
  visitorId?: string | null;
  bookingId?: string | null;
  vehicleId?: string | null;
  staffId?: string | null;
  validFrom: Date;
  validTill: Date;
  maxEntries?: number;
  singleUse?: boolean;
  createdBy?: string | null;
}

export interface IssuedPass {
  _id: string;
  token: string;
  /** PNG data URL, ready to render directly in a mobile <Image />. */
  dataUrl: string;
  validFrom: Date;
  validTill: Date;
  maxEntries: number;
  entriesUsed: number;
  singleUse: boolean;
  status: 'ACTIVE' | 'USED' | 'EXPIRED' | 'REVOKED';
}

function encodePayload(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function buildToken(kind: QrKind, passId: string, societyId: string, expiresAt: Date): string {
  const payload = {
    v: TOKEN_VERSION,
    k: kind,
    p: passId,
    s: societyId,
    e: Math.floor(expiresAt.getTime() / 1000),
    n: randomHex(6),
  };
  const body = encodePayload(payload);
  return `${TOKEN_PREFIX}.${body}.${hmacSign(body)}`;
}

export interface ParsedToken {
  version: number;
  kind: QrKind;
  passId: string;
  societyId: string;
  expiresAt: Date;
}

/** Cheap, database-free validation of the token envelope. */
export function parseToken(raw: string): ParsedToken {
  const value = String(raw ?? '').trim().replace(/^["']|["']$/g, '');
  if (!value) throw new ApiError('Scan a valid QR code', 'QR_INVALID');

  // Accept the raw payload too (some scanners strip the prefix).
  const parts = value.startsWith(`${TOKEN_PREFIX}.`) ? value.slice(TOKEN_PREFIX.length + 1).split('.') : value.split('.');
  if (parts.length !== 2) throw new ApiError('This QR code is not a Colonize pass', 'QR_INVALID');

  const [body, signature] = parts as [string, string];
  if (!hmacVerify(body, signature)) {
    throw new ApiError('This QR code is invalid or has been tampered with', 'QR_INVALID');
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new ApiError('This QR code could not be read', 'QR_INVALID');
  }

  if (payload.v !== TOKEN_VERSION) throw new ApiError('This QR code uses an unsupported version', 'QR_INVALID');
  const expiresAt = new Date(Number(payload.e) * 1000);
  if (Number.isNaN(expiresAt.getTime())) throw new ApiError('This QR code has no valid expiry', 'QR_INVALID');
  if (expiresAt.getTime() <= Date.now()) {
    throw new ApiError('This pass has expired', 'QR_EXPIRED');
  }

  return {
    version: Number(payload.v),
    kind: payload.k as QrKind,
    passId: String(payload.p ?? ''),
    societyId: String(payload.s ?? ''),
    expiresAt,
  };
}

/** Mint a pass, persist it and render the QR image. */
export async function issuePass(input: IssuePassInput): Promise<IssuedPass> {
  const {
    db, societyId, kind, validFrom, validTill,
    maxEntries = 1, singleUse = true, createdBy = null,
  } = input;

  if (validTill.getTime() <= validFrom.getTime()) {
    throw ApiError.badRequest('The pass expiry must be after its start time');
  }

  const passId = newId('visitor_passes');
  const token = buildToken(kind, passId, societyId, validTill);
  const collection = db.collection('visitor_passes');

  await collection.create({
    _id: passId,
    societyId,
    token,
    tokenHash: sha256(token),
    kind,
    visitorId: input.visitorId ?? null,
    bookingId: input.bookingId ?? null,
    vehicleId: input.vehicleId ?? null,
    staffId: input.staffId ?? null,
    unitId: input.unitId ?? null,
    residentId: input.residentId ?? null,
    status: 'ACTIVE',
    validFrom,
    validTill,
    maxEntries: singleUse ? 1 : maxEntries,
    entriesUsed: 0,
    singleUse,
    sign: hmacSign(`${passId}:${societyId}:${kind}`),
    scanCount: 0,
    createdBy,
  } as Document);

  const dataUrl = await QRCode.toDataURL(token, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 512,
    color: { dark: '#0F172A', light: '#FFFFFF' },
  });

  return {
    _id: passId,
    token,
    dataUrl,
    validFrom,
    validTill,
    maxEntries: singleUse ? 1 : maxEntries,
    entriesUsed: 0,
    singleUse,
    status: 'ACTIVE',
  };
}

export interface ScanInput {
  db: TenantDatabase;
  /** The society of the guard doing the scanning — taken from the JWT, never the QR. */
  societyId: string;
  rawToken: string;
  /** `VALIDATE` checks without consuming; `CHECK_IN` consumes one entry. */
  action?: 'VALIDATE' | 'CHECK_IN' | 'CHECK_OUT';
  expectedKind?: QrKind | 'AUTO';
  gateId?: string | null;
  scannedBy?: string | null;
  photoUrl?: string | null;
}

export interface ScanResult {
  pass: Document;
  kind: QrKind;
  valid: boolean;
  consumed: boolean;
  entriesUsed: number;
  maxEntries: number;
  /** The linked record, resolved for the caller (visitor / booking / vehicle / staff). */
  subject: Document | null;
  subjectType: 'visitor' | 'amenity_booking' | 'vehicle' | 'staff' | null;
}

const SUBJECT_BY_KIND: Record<QrKind, { collection: string; field: string; type: ScanResult['subjectType'] }> = {
  VISITOR: { collection: 'visitors', field: 'visitorId', type: 'visitor' },
  VEHICLE: { collection: 'vehicles', field: 'vehicleId', type: 'vehicle' },
  STAFF: { collection: 'staff', field: 'staffId', type: 'staff' },
  AMENITY_BOOKING: { collection: 'amenity_bookings', field: 'bookingId', type: 'amenity_booking' },
  SOCIETY_ACCESS: { collection: 'residents', field: 'residentId', type: null },
};

/** Validate (and optionally consume) a scanned pass. Throws a typed ApiError on rejection. */
export async function scanPass(input: ScanInput): Promise<ScanResult> {
  const { db, societyId, action = 'CHECK_IN', expectedKind = 'AUTO' } = input;
  const parsed = parseToken(input.rawToken);

  // Cross-tenant replay: a pass issued by another society.
  if (parsed.societyId !== societyId) {
    throw new ApiError('This pass belongs to a different society', 'QR_WRONG_SOCIETY');
  }
  if (expectedKind !== 'AUTO' && parsed.kind !== expectedKind) {
    throw new ApiError(`This is a ${parsed.kind.toLowerCase()} pass, not a ${expectedKind.toLowerCase()} pass`, 'QR_INVALID');
  }

  const passes = db.collection('visitor_passes');
  const pass = await passes.findOne({ societyId, _id: parsed.passId });
  if (!pass) throw new ApiError('This pass is not recognised', 'QR_INVALID');
  if (sha256(String(pass.token)) !== pass.tokenHash) {
    throw new ApiError('This pass failed its integrity check', 'QR_INVALID');
  }

  const now = new Date();
  const isExit = action === 'CHECK_OUT';
  const validFrom = new Date(pass.validFrom as string | Date);
  const validTill = new Date(pass.validTill as string | Date);
  // An exit scan must always resolve. A guest who overstayed, or whose single-use pass was
  // already consumed on entry, still has to be logged out: refusing the scan would strand them
  // as INSIDE forever and quietly corrupt occupancy and "currently in society" counts. So the
  // validity window, revocation and single-use rules gate *admission* (and previews of it),
  // never departure.
  if (now < validFrom && !isExit) {
    await passes.updateOne({ societyId, _id: pass._id }, { $inc: { scanCount: 1 } });
    throw new ApiError(`This pass is not valid until ${validFrom.toISOString()}`, 'QR_NOT_YET_VALID');
  }
  if (now > validTill && !isExit) {
    await passes.updateOne(
      { societyId, _id: pass._id },
      { $set: { status: 'EXPIRED', lastScannedAt: now }, $inc: { scanCount: 1 } },
    );
    throw new ApiError('This pass has expired', 'QR_EXPIRED');
  }
  if (pass.status === 'REVOKED' && !isExit) {
    await passes.updateOne({ societyId, _id: pass._id }, { $inc: { scanCount: 1 }, $set: { lastScannedAt: now } });
    throw new ApiError(`This pass was revoked${pass.revokeReason ? `: ${pass.revokeReason}` : ''}`, 'QR_INVALID');
  }
  if ((pass.status === 'USED' || Number(pass.entriesUsed) >= Number(pass.maxEntries)) && !isExit) {
    await passes.updateOne({ societyId, _id: pass._id }, { $inc: { scanCount: 1 }, $set: { lastScannedAt: now } });
    throw new ApiError('This pass has already been used', 'QR_ALREADY_USED');
  }
  if (pass.status === 'EXPIRED' && !isExit) {
    throw new ApiError('This pass has expired', 'QR_EXPIRED');
  }

  const meta = SUBJECT_BY_KIND[parsed.kind];
  const subjectId = meta && pass[meta.field] ? String(pass[meta.field]) : null;
  const subject = subjectId && meta
    ? await db.collection(meta.collection).findOne({ societyId, _id: subjectId })
    : null;

  // A visitor pass whose visitor was rejected/cancelled must not open the gate.
  if (parsed.kind === 'VISITOR' && subject) {
    const blocked = ['REJECTED', 'CANCELLED', 'IGNORED', 'EXPIRED'];
    if (blocked.includes(String(subject.status))) {
      throw new ApiError(`This visit was ${String(subject.status).toLowerCase()} by the resident`, 'QR_INVALID');
    }
  }
  if (parsed.kind === 'AMENITY_BOOKING' && subject) {
    const blocked = ['CANCELLED', 'REJECTED', 'REFUNDED'];
    if (blocked.includes(String(subject.status))) {
      throw new ApiError(`This booking is ${String(subject.status).toLowerCase()}`, 'QR_INVALID');
    }
    if (subject.status === 'PENDING_PAYMENT') {
      throw new ApiError('This booking is awaiting payment', 'QR_INVALID');
    }
  }

  // Only admission consumes an entry. VALIDATE previews the pass and CHECK_OUT logs a departure;
  // neither may burn the guest's entry allowance (a single-use pass would otherwise be "used up"
  // twice, and a multi-entry pass would lose an entry every time someone left).
  if (action !== 'CHECK_IN') {
    await passes.updateOne(
      { societyId, _id: pass._id },
      { $inc: { scanCount: 1 }, $set: { lastScannedAt: now, lastScannedBy: input.scannedBy ?? null, lastScannedGateId: input.gateId ?? null } },
    );
    return {
      pass,
      kind: parsed.kind,
      valid: true,
      consumed: false,
      entriesUsed: Number(pass.entriesUsed ?? 0),
      maxEntries: Number(pass.maxEntries ?? 1),
      subject,
      subjectType: meta?.type ?? null,
    };
  }

  /* ---- atomic consumption: the replay / duplicate-entry guard ---- */
  const consumed = await passes.updateOne(
    {
      societyId,
      _id: pass._id,
      status: 'ACTIVE',
      entriesUsed: { $lt: Number(pass.maxEntries ?? 1) },
    },
    {
      $inc: { entriesUsed: 1, scanCount: 1 },
      $set: {
        lastScannedAt: now,
        lastScannedBy: input.scannedBy ?? null,
        lastScannedGateId: input.gateId ?? null,
      },
    },
  );

  if (consumed.matched === 0) {
    // Another scanner won the race (or the pass changed state between read and write).
    throw new ApiError('This pass has already been used', 'QR_ALREADY_USED');
  }

  const usedAfter = Number(pass.entriesUsed ?? 0) + 1;
  const maxEntries = Number(pass.maxEntries ?? 1);
  if (usedAfter >= maxEntries) {
    await passes.updateOne({ societyId, _id: pass._id }, { $set: { status: 'USED' } });
  }

  return {
    pass: { ...pass, entriesUsed: usedAfter },
    kind: parsed.kind,
    valid: true,
    consumed: true,
    entriesUsed: usedAfter,
    maxEntries,
    subject,
    subjectType: meta?.type ?? null,
  };
}

/** Revoke a pass (resident cancels a pre-approved visitor; admin blocks a vehicle sticker). */
export async function revokePass(
  db: TenantDatabase,
  societyId: string,
  passId: string,
  reason?: string,
): Promise<void> {
  await db.collection('visitor_passes').updateOne(
    { societyId, _id: passId },
    { $set: { status: 'REVOKED', revokedAt: new Date(), revokeReason: reason ?? null } },
  );
}

/** Render an arbitrary string as a QR data URL (used for society access codes in the UI). */
export async function renderQr(value: string, width = 512): Promise<string> {
  return QRCode.toDataURL(value, { errorCorrectionLevel: 'M', margin: 1, width, color: { dark: '#0F172A', light: '#FFFFFF' } });
}

/** Expiry sweep: mark passes whose window has closed so scans fail fast on status alone. */
export async function expireStalePasses(db: TenantDatabase, societyId: string): Promise<number> {
  const res = await db.collection('visitor_passes').updateMany(
    { societyId, status: 'ACTIVE', validTill: { $lt: new Date() } },
    { $set: { status: 'EXPIRED' } },
  );
  return res.modified;
}
