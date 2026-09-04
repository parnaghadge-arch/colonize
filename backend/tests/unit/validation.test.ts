import { describe, expect, it } from 'vitest';
import {
  availabilityQuerySchema,
  createBookingSchema,
  createComplaintSchema,
  createPaymentIntentSchema,
  createPreApprovedVisitorSchema,
  createUnitSchema,
  createVehicleSchema,
  emailSchema,
  generateBillsSchema,
  gstinSchema,
  hhmmSchema,
  idSchema,
  ifscSchema,
  listQuerySchema,
  loginPasswordSchema,
  moneySchema,
  panSchema,
  passwordSchema,
  phoneSchema,
  pincodeSchema,
  scanQrSchema,
  sendOtpSchema,
  vehicleNumberSchema,
  verifyPaymentSchema,
} from '@colonize/shared/validation';

/**
 * The API boundary contract (§66).
 *
 * Every request body is validated by one of these schemas before a handler runs, and the
 * OpenAPI document is generated *from* them, so the docs can never drift from the code.
 * Two properties matter most here:
 *   1. Indian domain formats are accepted in the shapes people actually type them in
 *   2. **unknown keys are stripped** — a client cannot smuggle `societyId`, `_id` or `status`
 *      into a create payload and escalate itself
 */

describe('phone numbers', () => {
  it.each(['9876543210', '+919876543210', '+91 98765 43210', '00919876543210'])(
    'accepts %j',
    (value) => {
      expect(phoneSchema.safeParse(value).success).toBe(true);
    },
  );

  it('rejects something too short to be a mobile number', () => {
    const result = phoneSchema.safeParse('12345');
    expect(result.success).toBe(false);
  });

  it('rejects letters with a helpful message', () => {
    const result = phoneSchema.safeParse('abcdefghij');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toMatch(/valid mobile/i);
  });
});

describe('Indian document formats (§59 GST invoicing)', () => {
  it('accepts a 15-character GSTIN and rejects shorter or junk values', () => {
    expect(gstinSchema.safeParse('27ABCDE1234F1Z5').success).toBe(true);
    expect(gstinSchema.safeParse('27ABCDE1234F1Z').success).toBe(false);
    expect(gstinSchema.safeParse('INVALID').success).toBe(false);
  });

  it('accepts a PAN in its exact 5-4-1 shape', () => {
    expect(panSchema.safeParse('ABCDE1234F').success).toBe(true);
    expect(panSchema.safeParse('ABCD1234E').success).toBe(false);
  });

  it('accepts an IFSC only when the fifth character is zero', () => {
    expect(ifscSchema.safeParse('HDFC0001234').success).toBe(true);
    expect(ifscSchema.safeParse('HDFC1001234').success).toBe(false);
    expect(ifscSchema.safeParse('HDFC00123').success).toBe(false);
  });

  it('accepts a six-digit PIN code only', () => {
    expect(pincodeSchema.safeParse('411001').success).toBe(true);
    expect(pincodeSchema.safeParse('41100').success).toBe(false);
    expect(pincodeSchema.safeParse('4110011').success).toBe(false);
  });

  it('accepts a vehicle plate however it is typed', () => {
    expect(vehicleNumberSchema.safeParse('MH31AB1234').success).toBe(true);
    expect(vehicleNumberSchema.safeParse('mh 31 ab 1234').success).toBe(true);
    expect(vehicleNumberSchema.safeParse('XYZ').success).toBe(false);
  });
});

describe('credentials', () => {
  it('requires a password of at least 8 characters with a letter and a number', () => {
    expect(passwordSchema.safeParse('Resident@123').success).toBe(true);
    expect(passwordSchema.safeParse('short').success).toBe(false);
    expect(passwordSchema.safeParse('NoDigitsHere!').success).toBe(false);
  });

  it('reports the specific rule that failed', () => {
    const short = passwordSchema.safeParse('short');
    if (!short.success) expect(short.error.issues[0]!.message).toMatch(/at least 8 characters/i);
    const noDigit = passwordSchema.safeParse('NoDigitsHere!');
    if (!noDigit.success) expect(noDigit.error.issues[0]!.message).toMatch(/letter and one number/i);
  });

  it('lowercases an email so lookups are case-insensitive', () => {
    const result = emailSchema.safeParse('Ravi@Example.com');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe('ravi@example.com');
  });

  it('rejects a malformed email', () => {
    expect(emailSchema.safeParse('not-an-email').success).toBe(false);
  });

  it('requires a login identifier long enough to be an email or a phone', () => {
    expect(loginPasswordSchema.safeParse({ identifier: 'admin@greenvalley.local', password: 'GreenValley@1' }).success).toBe(true);
    expect(loginPasswordSchema.safeParse({ identifier: 'a', password: 'b' }).success).toBe(false);
    expect(loginPasswordSchema.safeParse({}).success).toBe(false);
  });
});

describe('record ids', () => {
  it('accepts prefixed application ids', () => {
    expect(idSchema.safeParse('soc_AXavMVdBycyDSNyAJ6').success).toBe(true);
    expect(idSchema.safeParse('unt_1').success).toBe(true);
  });

  it('rejects an empty id', () => {
    const result = idSchema.safeParse('');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toMatch(/required/i);
  });

  it('rejects an absurdly long id instead of passing it to the database', () => {
    expect(idSchema.safeParse('a'.repeat(80)).success).toBe(false);
  });
});

describe('times and money', () => {
  it('accepts 24-hour HH:mm only', () => {
    expect(hhmmSchema.safeParse('09:30').success).toBe(true);
    expect(hhmmSchema.safeParse('23:59').success).toBe(true);
    expect(hhmmSchema.safeParse('24:00').success).toBe(false);
    expect(hhmmSchema.safeParse('9:30').success).toBe(false);
  });

  it('rejects a negative amount', () => {
    const result = moneySchema.safeParse(-5);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toMatch(/negative/i);
  });

  it('accepts a positive amount including paise', () => {
    expect(moneySchema.safeParse(1500.5).success).toBe(true);
    expect(moneySchema.safeParse(0).success).toBe(true);
  });
});

describe('pagination input', () => {
  it('caps the page size at the maximum', () => {
    expect(listQuerySchema.safeParse({ page: '2', limit: '9999' }).success).toBe(false);
    expect(listQuerySchema.safeParse({ page: '2', limit: '50' }).success).toBe(true);
  });
});

describe('mass-assignment protection', () => {
  it('strips an injected societyId and _id from a unit creation', () => {
    const result = createUnitSchema.safeParse({
      buildingId: 'bld_1',
      unitNumber: 'A-101',
      societyId: 'soc_someoneElsesSociety',
      _id: 'unt_forgedByClient',
      ownerCount: 999,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).not.toHaveProperty('societyId');
    expect(result.data).not.toHaveProperty('_id');
    expect(result.data).not.toHaveProperty('ownerCount');
    expect(result.data.buildingId).toBe('bld_1');
  });

  it('strips an injected status so a resident cannot file an already-resolved complaint', () => {
    const result = createComplaintSchema.safeParse({
      category: 'PLUMBING',
      title: 'Leaking tap',
      description: 'Water leaking from the kitchen tap since this morning.',
      status: 'RESOLVED',
      societyId: 'soc_injected',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).not.toHaveProperty('status');
    expect(result.data).not.toHaveProperty('societyId');
  });

  it('strips an undeclared payment method from a payment intent', () => {
    const result = createPaymentIntentSchema.safeParse({
      amount: 1500,
      purpose: 'MAINTENANCE',
      billId: 'bil_1',
      method: 'FREE_MONEY',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).not.toHaveProperty('method');
    expect(Object.keys(result.data).sort()).toEqual(['amount', 'billId', 'purpose']);
  });

  it('applies server-side defaults rather than trusting the client to send them', () => {
    const result = createUnitSchema.safeParse({ buildingId: 'bld_1', unitNumber: 'A-101' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe('VACANT');
    expect(result.data.type).toBe('FLAT');
    expect(result.data.occupancyType).toBe('VACANT');
  });
});

describe('the §80 acceptance payloads', () => {
  it('validates an OTP request and defaults the channel and purpose', () => {
    const result = sendOtpSchema.safeParse({ phone: '9876543210' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toHaveProperty('purpose');
  });

  it('validates a gate scan and rejects a token too short to be a pass', () => {
    expect(scanQrSchema.safeParse({ token: 'CLNZ1.abcdefgh.def', mode: 'VISITOR', action: 'CHECK_IN' }).success).toBe(true);
    expect(scanQrSchema.safeParse({ token: 'x' }).success).toBe(false);
    expect(scanQrSchema.safeParse({}).success).toBe(false);
  });

  it('accepts the visitor pre-approval shape the resident app sends', () => {
    const result = createPreApprovedVisitorSchema.safeParse({
      visitorName: 'Guest Person',
      visitorPhone: '9876543210',
      visitDate: '2026-03-15',
      expectedArrival: '10:00',
      purpose: 'GUEST',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.visitorType).toBe('GUEST');
    expect(result.data.numberOfVisitors).toBe(1);
    expect(result.data.generateQrPass).toBe(true);
  });

  it('requires both an amenity and an ISO date for an availability lookup', () => {
    expect(availabilityQuerySchema.safeParse({ amenityId: 'amn_1', date: '2026-03-15' }).success).toBe(true);
    expect(availabilityQuerySchema.safeParse({ date: '2026-03-15' }).success).toBe(false);
    const badDate = availabilityQuerySchema.safeParse({ amenityId: 'amn_1', date: '15/03/2026' });
    expect(badDate.success).toBe(false);
    if (!badDate.success) expect(badDate.error.issues[0]!.message).toMatch(/YYYY-MM-DD/);
  });

  it('requires a period and a due date to generate bills', () => {
    expect(generateBillsSchema.safeParse({ period: '2026-03', dueDate: '2026-03-15', scope: 'UNITS', unitIds: ['unt_1'] }).success).toBe(true);
    expect(generateBillsSchema.safeParse({ period: '2026-03' }).success).toBe(false);
    expect(generateBillsSchema.safeParse({}).success).toBe(false);
  });

  it('defaults the charge composition when generating a bill run', () => {
    const result = generateBillsSchema.safeParse({ period: '2026-03', dueDate: '2026-03-15', scope: 'ALL' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.includeFixedCharges).toBe(true);
    expect(result.data.dryRun).toBe(false);
  });

  it('accepts only known payment purposes', () => {
    const result = createPaymentIntentSchema.safeParse({ amount: 1500, purpose: 'MAINTENANCE_BILL' });
    expect(result.success).toBe(false);
    expect(createPaymentIntentSchema.safeParse({ amount: 1500, purpose: 'AMENITY_BOOKING' }).success).toBe(true);
  });

  it('requires the gateway fields needed to verify a payment', () => {
    expect(verifyPaymentSchema.safeParse({}).success).toBe(false);
    expect(Object.keys(verifyPaymentSchema.shape)).toEqual(
      expect.arrayContaining(['paymentId', 'gatewayPaymentId', 'gatewayOrderId', 'signature']),
    );
  });

  it('requires the slot details to book an amenity', () => {
    expect(createBookingSchema.safeParse({}).success).toBe(false);
    expect(Object.keys(createBookingSchema.shape)).toEqual(
      expect.arrayContaining(['amenityId', 'date', 'startTime']),
    );
  });

  it('requires a vehicle number to register a vehicle', () => {
    expect(createVehicleSchema.safeParse({ type: 'CAR', ownerName: 'Ravi' }).success).toBe(false);
  });
});
