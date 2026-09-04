import { randomBytes } from 'node:crypto';

/**
 * Identifier generation.
 *
 * Ids are prefixed so a leaked id is self-describing (`vis_9xK…` is obviously a visitor) and
 * so a cross-collection mix-up fails loudly instead of silently matching the wrong document.
 * The alphabet is URL-safe base62-ish; 18 chars ≈ 107 bits of entropy.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZabcdefghijkmnopqrstuvwxyz';

export function randomToken(size = 18): string {
  const bytes = randomBytes(size);
  let out = '';
  for (let i = 0; i < size; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

const ID_PREFIXES: Record<string, string> = {
  // platform
  platform_users: 'pu',
  societies: 'soc',
  subscription_plans: 'pln',
  subscriptions: 'sub',
  platform_payments: 'ppay',
  support_tickets: 'tkt',
  support_ticket_messages: 'tktm',
  otp_requests: 'otp',
  platform_sessions: 'pses',
  platform_audit_logs: 'paud',
  notification_templates: 'ntpl',
  system_settings: 'set',
  idempotency_keys: 'idem',
  jobs: 'job',
  role_templates: 'rtpl',
  // tenant: identity
  users: 'usr',
  identities: 'idn',
  sessions: 'ses',
  roles: 'rol',
  society_settings: 'set',
  // hierarchy
  buildings: 'bld',
  wings: 'wng',
  floors: 'flr',
  units: 'unt',
  unit_members: 'umem',
  residents: 'res',
  family_members: 'fam',
  vehicles: 'veh',
  parking_areas: 'pka',
  parking_slots: 'pks',
  // security
  gates: 'gat',
  guard_assignments: 'gasm',
  guard_shift_logs: 'glog',
  visitors: 'vis',
  visitor_passes: 'pas',
  visitor_entries: 'ent',
  deliveries: 'dlv',
  cab_entries: 'cab',
  cab_access: 'caba',
  // staff
  staff: 'stf',
  staff_attendance: 'att',
  vendors: 'vnd',
  // help desk
  complaints: 'cmp',
  complaint_comments: 'cmc',
  service_requests: 'srq',
  work_orders: 'wko',
  // amenities
  amenities: 'amn',
  amenity_slots: 'ams',
  amenity_bookings: 'bkg',
  // community
  notices: 'ntc',
  events: 'evt',
  event_registrations: 'evr',
  polls: 'pol',
  poll_options: 'pop',
  poll_votes: 'pvt',
  // finance
  maintenance_bills: 'bil',
  bill_items: 'bit',
  payments: 'pay',
  payment_transactions: 'ptx',
  ledgers: 'ldg',
  journal_entries: 'jne',
  expenses: 'exp',
  incomes: 'inc',
  // documents / notifications / emergency / audit
  documents: 'doc',
  document_acknowledgements: 'ack',
  notifications: 'ntf',
  push_tokens: 'psh',
  emergency_alerts: 'emg',
  audit_logs: 'aud',
  counters: 'cnt',
  conversations: 'cnv',
  messages: 'msg',
  report_jobs: 'rpt',
};

export function idPrefix(collectionName: string): string {
  return ID_PREFIXES[collectionName] ?? collectionName.slice(0, 3);
}

/** `newId('visitors')` → `vis_8Kd2Mq…` */
export function newId(collectionName: string, size = 18): string {
  return `${idPrefix(collectionName)}_${randomToken(size)}`;
}

/** 32-byte hex token used for QR passes and password-reset links. */
export function secureToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}
