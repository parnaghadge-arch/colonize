/**
 * OpenAPI 3.1 document, generated from the same Zod schemas the routers validate with (§75).
 *
 * The point of deriving the spec from `@colonize/shared/validation` is that the docs cannot
 * drift from the API: a field renamed in a schema changes the contract here automatically.
 * Request bodies are converted with `io: 'input'` so fields the server defaults are not
 * advertised as required from the client.
 */
import { z } from 'zod';
import { env } from '../config/env.js';
import * as V from '@colonize/shared/validation';

export type JsonSchema = Record<string, unknown>;
type PathItem = Record<string, unknown>;

/** Convert a Zod schema to JSON Schema, degrading to a permissive object if unsupported. */
export function js(schema: z.ZodTypeAny, io: 'input' | 'output' = 'input'): JsonSchema {
  try {
    const out = z.toJSONSchema(schema, { target: 'json-schema-2020-12', io }) as JsonSchema;
    delete out.$schema;
    return out;
  } catch {
    return { type: 'object', additionalProperties: true };
  }
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/** `{ success, message, data }` — the envelope every success response uses (§52). */
function envelope(data: JsonSchema): JsonSchema {
  return {
    type: 'object',
    properties: {
      success: { const: true },
      message: { type: 'string' },
      data,
    },
    required: ['success', 'message', 'data'],
  };
}

/** `{ success, message, data: { items }, meta }` — the list envelope from `paginated()`. */
function paginated(items: JsonSchema): JsonSchema {
  return {
    type: 'object',
    properties: {
      success: { const: true },
      message: { type: 'string' },
      data: {
        type: 'object',
        properties: { items: { type: 'array', items } },
        required: ['items'],
      },
      meta: ref('PaginationMeta'),
    },
    required: ['success', 'message', 'data', 'meta'],
  };
}

const okJson = (schema: JsonSchema, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const ERROR_CODES = [
  'VALIDATION_ERROR', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'DUPLICATE',
  'RATE_LIMITED', 'TENANT_MISMATCH', 'MODULE_DISABLED', 'SUBSCRIPTION_INACTIVE',
  'PAYMENT_FAILED', 'PAYMENT_ALREADY_PROCESSED', 'INSUFFICIENT_BALANCE', 'SLOT_UNAVAILABLE',
  'DOUBLE_BOOKING', 'QR_INVALID', 'QR_EXPIRED', 'QR_ALREADY_USED', 'QR_NOT_YET_VALID',
  'QR_WRONG_SOCIETY', 'OTP_INVALID', 'OTP_EXPIRED', 'OTP_ATTEMPTS_EXCEEDED', 'OTP_COOLDOWN',
  'TOKEN_INVALID', 'TOKEN_EXPIRED', 'TOKEN_REUSED', 'ACCOUNT_LOCKED', 'ACCOUNT_INACTIVE',
  'UPLOAD_INVALID', 'UPLOAD_TOO_LARGE', 'IDEMPOTENCY_CONFLICT', 'STATE_CONFLICT',
  'DEPENDENCY_FAILED', 'UNPROCESSABLE', 'INTERNAL_ERROR',
] as const;

/** Shared error responses, attached to every operation. */
const errResponses = (...statuses: Array<[number, string]>) =>
  Object.fromEntries(
    statuses.map(([code, description]) => [
      String(code),
      { description, content: { 'application/json': { schema: ref('ApiError') } } },
    ]),
  );

const STANDARD_ERRORS = errResponses(
  [401, 'Missing, malformed or expired access token'],
  [403, 'Authenticated but lacks the permission, tenant context or module'],
  [404, 'Resource not found, or not visible to this tenant'],
  [422, 'Request body or query failed validation'],
  [429, 'Rate limit exceeded'],
);

/** Operation builder with the tenant/security conventions applied consistently. */
function op(o: {
  tag: string;
  summary: string;
  description?: string;
  operationId: string;
  body?: JsonSchema;
  params?: JsonSchema[];
  responses?: Record<string, unknown>;
  security?: unknown[];
  contentType?: string;
}): PathItem[string] {
  const operation: Record<string, unknown> = {
    tags: [o.tag],
    summary: o.summary,
    operationId: o.operationId,
    security: o.security ?? [{ bearerAuth: [] }],
    responses: o.responses ?? { 200: okJson({ type: 'object' }, 'Success'), ...STANDARD_ERRORS },
  };
  if (o.description) operation.description = o.description;
  if (o.params) operation.parameters = o.params;
  if (o.body) {
    operation.requestBody = {
      required: true,
      content: { [o.contentType ?? 'application/json']: { schema: o.body } },
    };
  }
  return operation;
}

/** Query params accepted by every generated CRUD list endpoint. */
const LIST_PARAMS: JsonSchema[] = [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 20 } },
  { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Case-insensitive substring match' },
  { name: 'sortBy', in: 'query', schema: { type: 'string' } },
  { name: 'sortDir', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } },
  { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
  { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
];

const ID_PARAM: JsonSchema = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'Prefixed document id, e.g. `unt_9f3a…`',
};

/**
 * The six routes `buildCrudRouter` registers, documented once and reused per collection.
 * Bespoke routes are added by the caller so mount order in the docs mirrors the router.
 */
function crudPaths(opts: {
  base: string;
  tag: string;
  label: string;
  create?: z.ZodTypeAny;
  update?: z.ZodTypeAny;
  extra?: Record<string, PathItem>;
  allowCreate?: boolean;
}): Record<string, PathItem> {
  const { base, tag, label, create, update, extra = {}, allowCreate = true } = opts;
  const paths: Record<string, PathItem> = {
    ...extra,
    [base]: {
      get: op({
        tag, summary: `List ${label}s`, operationId: `list${label}s`,
        description: `Paginated, tenant-scoped list. Rows are additionally filtered by the caller's unit/gate scope where the collection declares one.`,
        params: LIST_PARAMS,
        responses: { 200: okJson(paginated(ref(`${label}`)), `${label} list`), ...STANDARD_ERRORS },
      }),
      ...(allowCreate && create
        ? {
            post: op({
              tag, summary: `Create a ${label.toLowerCase()}`, operationId: `create${label}`,
              body: js(create),
              responses: { 201: okJson(envelope(ref(label)), `${label} created`), ...STANDARD_ERRORS },
            }),
          }
        : {}),
    },
    [`${base}/{id}`]: {
      parameters: [ID_PARAM],
      get: op({
        tag, summary: `Get a ${label.toLowerCase()}`, operationId: `get${label}`,
        responses: { 200: okJson(envelope(ref(label)), label), ...STANDARD_ERRORS },
      }),
      ...(update
        ? {
            patch: op({
              tag, summary: `Update a ${label.toLowerCase()}`, operationId: `update${label}`,
              description: 'Partial update. Soft-delete is performed by setting `deletedAt`.',
              body: js(update),
              responses: { 200: okJson(envelope(ref(label)), 'Updated'), ...STANDARD_ERRORS },
            }),
            put: op({
              tag, summary: `Replace a ${label.toLowerCase()}`, operationId: `replace${label}`,
              body: js(update),
              responses: { 200: okJson(envelope(ref(label)), 'Updated'), ...STANDARD_ERRORS },
            }),
          }
        : {}),
      delete: op({
        tag, summary: `Soft-delete a ${label.toLowerCase()}`, operationId: `delete${label}`,
        description: 'Sets `deletedAt` rather than removing the row, so audit history and financial references stay intact.',
        responses: { 204: { description: 'Deleted' }, ...STANDARD_ERRORS },
      }),
    },
  };
  return paths;
}

/** Entity schemas for rows the API returns. Derived from Zod where a schema exists. */
function entitySchemas(): Record<string, JsonSchema> {
  const str = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) });
  const ts = { type: ['string', 'null'], format: 'date-time' };
  const id = { type: 'string', description: 'Prefixed id' };

  const withAudit = (props: JsonSchema, extra: string[] = []) => ({
    type: 'object',
    properties: {
      _id: id,
      societyId: id,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: { type: ['string', 'null'], format: 'date-time', description: 'Set when soft-deleted' },
      ...props,
    },
    required: ['_id', 'societyId', ...extra],
  });

  return {
    PaginationMeta: {
      type: 'object',
      properties: {
        page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' },
        totalPages: { type: 'integer' }, hasNext: { type: 'boolean' }, hasPrev: { type: 'boolean' },
        sortBy: str(), sortDir: { type: 'string', enum: ['asc', 'desc'] },
      },
      required: ['page', 'limit', 'total', 'totalPages', 'hasNext', 'hasPrev'],
    },
    ApiError: {
      type: 'object',
      properties: {
        success: { const: false },
        message: str(),
        code: { type: 'string', enum: [...ERROR_CODES] },
        errors: {
          type: 'array',
          items: {
            type: 'object',
            properties: { field: str(), message: str(), code: str() },
            required: ['message'],
          },
        },
        meta: {
          type: 'object',
          properties: { requestId: str('Correlate with the `X-Request-Id` response header') },
        },
      },
      required: ['success', 'message', 'code'],
    },
    AuthTokens: {
      type: 'object',
      properties: {
        accessToken: str('Short-lived JWT — send as `Authorization: Bearer <token>`'),
        refreshToken: str('Opaque, rotating, hashed at rest and bound to the device'),
        tokenType: { type: 'string', enum: ['Bearer'] },
        expiresIn: { type: 'integer', description: 'Access token lifetime in seconds' },
      },
      required: ['accessToken', 'refreshToken', 'tokenType', 'expiresIn'],
    },
    Society: withAudit({
      name: str(), slug: str('Used to resolve `?society=slug`'), databaseName: str(),
      status: { type: 'string', enum: ['pending', 'active', 'suspended', 'archived'] },
      timezone: str(), currency: str(),
      enabledModules: { type: 'array', items: str() },
      onboarding: { type: 'object', additionalProperties: true },
    }, ['name', 'slug']),
    Building: withAudit({ name: str(), code: str(), floors: { type: 'integer' } }),
    Wing: withAudit({ name: str(), code: str(), buildingId: id }),
    Floor: withAudit({ number: { type: 'integer' }, wingId: id }),
    Unit: withAudit({
      unitNumber: str(), floorId: id, wingId: id, buildingId: id,
      type: str(), status: str(), areaSqft: { type: ['number', 'null'] },
      maintenanceRate: { type: ['number', 'null'] }, sharePercent: { type: ['number', 'null'] },
    }, ['unitNumber']),
    Resident: withAudit({
      userId: id, unitId: id, fullName: str(), relation: str(),
      status: { type: 'string', enum: ['active', 'inactive', 'moved_out'] },
    }, ['fullName']),
    FamilyMember: withAudit({ residentId: id, name: str(), relation: str(), memberKind: str() }),
    Vehicle: withAudit({ residentId: id, vehicleNumber: str(), type: str(), isPrimary: { type: ['boolean', 'null'] } }, ['vehicleNumber']),
    ParkingSlot: withAudit({ slotNumber: str(), areaId: { type: ['string', 'null'] }, unitId: { type: ['string', 'null'] }, status: str() }),
    ParkingArea: withAudit({ name: str(), kind: str(), capacity: { type: ['integer', 'null'] } }),
    Visitor: withAudit({
      name: str(), phone: { type: ['string', 'null'] }, purpose: str(),
      status: { type: 'string', enum: ['pre_approved', 'awaiting_approval', 'approved', 'denied', 'checked_in', 'checked_out', 'cancelled', 'expired', 'no_show'] },
      expectedIn: ts, expectedOut: ts, checkedInAt: ts, checkedOutAt: ts,
      pass: { type: ['object', 'null'], description: 'QR pass issued once the visitor is approved' },
    }, ['name']),
    Gate: withAudit({ name: str(), code: str(), isPrimary: { type: ['boolean', 'null'] }, status: str() }),
    Guard: withAudit({ staffId: id, userId: { type: ['string', 'null'] }, gateIds: { type: 'array', items: id } }),
    Complaint: withAudit({
      referenceNumber: str(), title: str(), category: str(),
      status: { type: 'string', enum: ['open', 'assigned', 'in_progress', 'resolved', 'closed', 'rejected', 'reopened'] },
      priority: str(), unitId: { type: ['string', 'null'] }, assignedVendorId: { type: ['string', 'null'] },
    }, ['title']),
    WorkOrder: withAudit({ referenceNumber: str(), complaintId: { type: ['string', 'null'] }, status: str(), vendorId: { type: ['string', 'null'] } }),
    ServiceRequest: withAudit({ title: str(), category: str(), status: str(), unitId: { type: ['string', 'null'] } }),
    Vendor: withAudit({ name: str(), category: str(), status: str() }, ['name']),
    Staff: withAudit({ name: str(), role: str(), department: { type: ['string', 'null'] }, status: str() }, ['name']),
    Amenity: withAudit({ name: str(), kind: str(), capacity: { type: ['integer', 'null'] }, isFree: { type: ['boolean', 'null'] } }, ['name']),
    AmenityBooking: withAudit({
      referenceNumber: str(), amenityId: id, residentId: { type: ['string', 'null'] },
      status: { type: 'string', enum: ['pending', 'confirmed', 'checked_in', 'completed', 'cancelled', 'rejected'] },
      slotStart: ts, slotEnd: ts, amount: { type: ['number', 'null'] },
      qr: { type: ['object', 'null'], description: 'Entry pass for the booking' },
    }),
    Bill: withAudit({
      invoiceNumber: str(), unitId: id, periodStart: ts, periodEnd: ts,
      status: { type: 'string', enum: ['draft', 'issued', 'partially_paid', 'paid', 'overdue', 'disputed', 'waived', 'cancelled'] },
      totalAmount: { type: 'number' }, paidAmount: { type: 'number' }, dueAmount: { type: 'number' },
      dueDate: ts, items: { type: 'array', items: { type: 'object', additionalProperties: true } },
    }, ['unitId']),
    Payment: withAudit({
      receiptNumber: { type: ['string', 'null'] }, billId: { type: ['string', 'null'] },
      amount: { type: 'number' }, method: str(),
      status: { type: 'string', enum: ['created', 'pending', 'authorized', 'captured', 'failed', 'refunded', 'cancelled'] },
      gateway: { type: ['string', 'null'] }, providerPaymentId: { type: ['string', 'null'] },
    }, ['amount']),
    Ledger: withAudit({ name: str(), type: str(), normalSide: str(), balance: { type: ['number', 'null'] } }),
    JournalEntry: withAudit({
      referenceNumber: str(), date: ts, lines: { type: 'array', items: { type: 'object', additionalProperties: true } },
      isReversed: { type: ['boolean', 'null'] },
    }),
    Expense: withAudit({ referenceNumber: str(), category: str(), amount: { type: 'number' }, status: str() }),
    Income: withAudit({ category: str(), amount: { type: 'number' }, source: { type: ['string', 'null'] } }),
    AuditLog: {
      type: 'object',
      properties: {
        _id: id, societyId: id, actorId: id, action: str(), entityType: str(), entityId: id,
        before: { type: ['object', 'null'], additionalProperties: true },
        after: { type: ['object', 'null'], additionalProperties: true },
        ip: { type: ['string', 'null'] }, userAgent: { type: ['string', 'null'] },
        createdAt: ts,
      },
      required: ['_id', 'societyId', 'action'],
    },
  };
}

/** Schemas generated straight from the shared Zod validators. */
function validationSchemas(): Record<string, JsonSchema> {
  const out: Record<string, JsonSchema> = {};
  const entries: Array<[string, z.ZodTypeAny]> = [
    ['SendOtpInput', V.sendOtpSchema],
    ['VerifyOtpInput', V.verifyOtpSchema],
    ['SelectSocietyInput', V.selectSocietySchema],
    ['LoginPasswordInput', V.loginPasswordSchema],
    ['RefreshTokenInput', V.refreshTokenSchema],
    ['ChangePasswordInput', V.changePasswordSchema],
    ['CreateSocietyInput', V.createSocietySchema],
    ['UpdateSocietyInput', V.updateSocietySchema],
    ['CreateBuildingInput', V.createBuildingSchema],
    ['UpdateBuildingInput', V.updateBuildingSchema],
    ['CreateWingInput', V.createWingSchema],
    ['CreateFloorInput', V.createFloorSchema],
    ['CreateUnitInput', V.createUnitSchema],
    ['UpdateUnitInput', V.updateUnitSchema],
    ['GenerateUnitsInput', V.generateUnitsSchema],
    ['ImportUnitsInput', V.importUnitsSchema],
    ['CreateResidentInput', V.createResidentSchema],
    ['UpdateResidentInput', V.updateResidentSchema],
    ['CreateFamilyMemberInput', V.createFamilyMemberSchema],
    ['CreateVehicleInput', V.createVehicleSchema],
    ['CreateParkingSlotInput', V.createParkingSlotSchema],
    ['AssignParkingSlotInput', V.assignParkingSlotSchema],
    ['CreatePreApprovedVisitorInput', V.createPreApprovedVisitorSchema],
    ['CreateAtGateVisitorInput', V.createAtGateVisitorSchema],
    ['DecideVisitorInput', V.decideVisitorSchema],
    ['RecordEntryInput', V.recordEntrySchema],
    ['RecordExitInput', V.recordExitSchema],
    ['ScanQrInput', V.scanQrSchema],
    ['CreateGateInput', V.createGateSchema],
    ['GuardShiftLoginInput', V.guardShiftLoginSchema],
    ['CreateComplaintInput', V.createComplaintSchema],
    ['AssignComplaintInput', V.assignComplaintSchema],
    ['ComplaintStatusChangeInput', V.complaintStatusChangeSchema],
    ['CreateWorkOrderInput', V.createWorkOrderSchema],
    ['CreateServiceRequestInput', V.createServiceRequestSchema],
    ['CreateVendorInput', V.createVendorSchema],
    ['CreateStaffInput', V.createStaffSchema],
    ['CreateAmenityInput', V.createAmenitySchema],
    ['CreateBookingInput', V.createBookingSchema],
    ['DecideBookingInput', V.decideBookingSchema],
    ['CreateBillInput', V.createBillSchema],
    ['GenerateBillsInput', V.generateBillsSchema],
    ['WaiveBillInput', V.waiveBillSchema],
    ['CreatePaymentIntentInput', V.createPaymentIntentSchema],
    ['VerifyPaymentInput', V.verifyPaymentSchema],
    ['RecordOfflinePaymentInput', V.recordOfflinePaymentSchema],
    ['RefundPaymentInput', V.refundPaymentSchema],
    ['CreateLedgerInput', V.createLedgerSchema],
    ['CreateJournalEntryInput', V.createJournalEntrySchema],
    ['CreateExpenseInput', V.createExpenseSchema],
    ['CreateIncomeInput', V.createIncomeSchema],
    ['DeviceInfoInput', V.deviceInfoSchema],
    ['AppPinInput', V.appPinSchema],
    ['VerifyAppPinInput', V.verifyAppPinSchema],
  ];
  for (const [name, schema] of entries) out[name] = js(schema, 'input');
  return out;
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, PathItem> = {};

  // ── Meta ───────────────────────────────────────────────────────────────
  paths['/api/health'] = {
    get: op({
      tag: 'Meta', summary: 'Liveness probe', operationId: 'health', security: [],
      responses: { 200: okJson(envelope({
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok'] }, uptimeSec: { type: 'number' },
          timestamp: { type: 'string', format: 'date-time' }, version: str_(),
          service: str_(), environment: str_(),
        },
        required: ['status'],
      }), 'Service is alive'), ...errResponses([503, 'Service unavailable']) },
    }),
  };
  paths['/api/health/ready'] = {
    get: op({
      tag: 'Meta', summary: 'Readiness probe', operationId: 'readiness', security: [],
      description: 'Performs a real round-trip against the platform database and reports queue depth and connected realtime clients. Returns 503 until the service can actually serve traffic.',
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Ready'), ...errResponses([503, 'A dependency is unreachable — body explains which']) },
    }),
  };
  paths['/api/meta'] = {
    get: op({
      tag: 'Meta', summary: 'Feature-detect endpoint', operationId: 'meta', security: [{}, { bearerAuth: [] }],
      description: 'Client configuration: enabled modules, module keys, permission actions, roles and error codes. Anonymous callers get the catalogue only; authenticated callers also get their own effective permissions.',
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Platform metadata'), ...STANDARD_ERRORS },
    }),
  };
  paths['/api/whoami'] = {
    get: op({
      tag: 'Meta', summary: 'Effective identity, roles, permissions and memberships', operationId: 'whoami',
      description: 'Returns what the server actually resolved for the bearer token — clients must never trust a locally stored role.',
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Identity'), ...STANDARD_ERRORS },
    }),
  };

  // ── Auth ───────────────────────────────────────────────────────────────
  const A = '/api/auth';
  paths[`${A}/send-otp`] = {
    post: op({
      tag: 'Auth', summary: 'Send a login OTP', operationId: 'sendOtp', security: [],
      description: 'Rate limited. The OTP is delivered by SMS/email and is never returned in the response body outside development.',
      body: ref('SendOtpInput'),
      responses: { 200: okJson(envelope({
        type: 'object',
        properties: {
          challengeToken: str_('Opaque token to present with the OTP'),
          channel: str_('Where the OTP was sent'),
          maskedIdentifier: str_('e.g. `+91 ••••• 43210`'),
          resendAfterSec: { type: 'integer' },
          expiresInSec: { type: 'integer' },
          ...(env.NODE_ENV === 'production' ? {} : { devOtp: { type: 'string', description: 'Development only — absent in production builds' } }),
        },
        required: ['challengeToken'],
      }), 'OTP dispatched'), ...STANDARD_ERRORS },
    }),
  };
  paths[`${A}/verify-otp`] = {
    post: op({
      tag: 'Auth', summary: 'Verify an OTP and start the session', operationId: 'verifyOtp', security: [],
      description: 'Returns either a short-lived `selectionToken` (when the identity spans several societies) or full `tokens` plus the principal. Attempts are capped; exceeding them locks the challenge.',
      body: ref('VerifyOtpInput'),
      responses: { 200: okJson({
        type: 'object',
        properties: {
          success: { const: true }, message: { type: 'string' },
          data: {
            type: 'object',
            properties: {
              step: { type: 'string', enum: ['select_society', 'authenticated'] },
              selectionToken: { type: ['string', 'null'] },
              societies: { type: 'array', items: { type: 'object', additionalProperties: true } },
              tokens: { type: ['object', 'null'], additionalProperties: true },
              principal: { type: ['object', 'null'], additionalProperties: true },
            },
            required: ['step'],
          },
        },
        required: ['success', 'data'],
      }, 'OTP accepted'), ...STANDARD_ERRORS },
    }),
  };
  paths[`${A}/select-society`] = {
    post: op({
      tag: 'Auth', summary: 'Pick a society after multi-society OTP verification', operationId: 'selectSociety', security: [],
      body: ref('SelectSocietyInput'),
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Tokens issued for the chosen society'), ...STANDARD_ERRORS },
    }),
  };
  paths[`${A}/login`] = {
    post: op({
      tag: 'Auth', summary: 'Password login', operationId: 'login', security: [],
      description: 'For society staff, admins and security guards. Failed attempts are throttled and eventually lock the account.',
      body: ref('LoginPasswordInput'),
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Authenticated'), ...STANDARD_ERRORS },
    }),
  };
  paths[`${A}/platform/login`] = {
    post: op({
      tag: 'Auth', summary: 'Super-admin login', operationId: 'platformLogin', security: [],
      description: 'Issues a platform-scoped token, which is the only credential accepted by `/api/platform/*`.',
      body: ref('LoginPasswordInput'),
      responses: { 200: okJson(envelope(ref('AuthTokens')), 'Platform session'), ...STANDARD_ERRORS },
    }),
  };
  paths[`${A}/refresh`] = {
    post: op({
      tag: 'Auth', summary: 'Rotate the refresh token', operationId: 'refresh', security: [],
      description: 'Refresh tokens rotate on every use and are bound to the device that minted them. Replaying a consumed token invalidates the whole family.',
      body: ref('RefreshTokenInput'),
      responses: { 200: okJson(envelope(ref('AuthTokens')), 'New token pair'), ...STANDARD_ERRORS },
    }),
  };
  paths[`${A}/logout`] = {
    post: op({
      tag: 'Auth', summary: 'Revoke the current session', operationId: 'logout',
      body: { type: 'object', properties: { refreshToken: { type: 'string' }, allDevices: { type: 'boolean' } } },
      responses: { 200: okJson(envelope({ type: 'object', properties: { revoked: { type: 'integer' } } }), 'Revoked'), ...STANDARD_ERRORS },
    }),
  };
  paths[`${A}/me`] = {
    get: op({
      tag: 'Auth', summary: 'Current principal', operationId: 'me',
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Principal'), ...STANDARD_ERRORS },
    }),
    patch: op({
      tag: 'Auth', summary: 'Update own profile', operationId: 'updateMe',
      body: { type: 'object', properties: { fullName: { type: 'string' }, avatarUrl: { type: 'string' } } },
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Updated'), ...STANDARD_ERRORS },
    }),
  };
  paths[`${A}/change-password`] = {
    post: op({ tag: 'Auth', summary: 'Change own password', operationId: 'changePassword', body: ref('ChangePasswordInput'),
      responses: { 200: okJson(envelope({ type: 'object' }), 'Password changed'), ...STANDARD_ERRORS } }),
  };
  paths[`${A}/forgot-password`] = {
    post: op({ tag: 'Auth', summary: 'Request a password reset', operationId: 'forgotPassword', security: [],
      body: js(V.forgotPasswordSchema),
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Reset token dispatched'), ...STANDARD_ERRORS } }),
  };
  paths[`${A}/reset-password`] = {
    post: op({ tag: 'Auth', summary: 'Complete a password reset', operationId: 'resetPassword', security: [],
      body: js(V.resetPasswordSchema),
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Password reset'), ...STANDARD_ERRORS } }),
  };
  paths[`${A}/sessions`] = {
    get: op({ tag: 'Auth', summary: 'List active sessions', operationId: 'listSessions',
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Sessions'), ...STANDARD_ERRORS } }),
  };
  paths[`${A}/sessions/{id}`] = {
    delete: op({ tag: 'Auth', summary: 'Revoke a session', operationId: 'revokeSession', params: [ID_PARAM],
      responses: { 200: okJson(envelope({ type: 'object' }), 'Revoked'), ...STANDARD_ERRORS } }),
  };
  paths[`${A}/push-token`] = {
    post: op({ tag: 'Auth', summary: 'Register a device push token', operationId: 'registerPushToken', body: js(V.deviceInfoSchema),
      responses: { 200: okJson(envelope({ type: 'object' }), 'Registered'), ...STANDARD_ERRORS } }),
    delete: op({ tag: 'Auth', summary: 'Unregister a push token', operationId: 'unregisterPushToken',
      responses: { 200: okJson(envelope({ type: 'object' }), 'Removed'), ...STANDARD_ERRORS } }),
  };
  paths[`${A}/app-pin`] = {
    post: op({ tag: 'Auth', summary: 'Set the in-app lock PIN', operationId: 'setAppPin', body: ref('AppPinInput'),
      responses: { 200: okJson(envelope({ type: 'object' }), 'PIN set'), ...STANDARD_ERRORS } }),
    delete: op({ tag: 'Auth', summary: 'Remove the in-app lock PIN', operationId: 'removeAppPin',
      responses: { 200: okJson(envelope({ type: 'object' }), 'PIN removed'), ...STANDARD_ERRORS } }),
  };
  paths[`${A}/app-pin/verify`] = {
    post: op({ tag: 'Auth', summary: 'Unlock the app with the PIN', operationId: 'verifyAppPin', body: ref('VerifyAppPinInput'),
      responses: { 200: okJson(envelope({ type: 'object' }), 'Unlocked'), ...STANDARD_ERRORS } }),
  };

  // ── Platform (super admin) ─────────────────────────────────────────────
  const P = '/api/platform/societies';
  const platformOnly = [{ platformAuth: [] }];
  paths[P] = {
    get: op({ tag: 'Platform', summary: 'List societies', operationId: 'listSocieties', security: platformOnly, params: LIST_PARAMS,
      responses: { 200: okJson(paginated(ref('Society')), 'Society list'), ...STANDARD_ERRORS } }),
    post: op({ tag: 'Platform', summary: 'Onboard a society', operationId: 'createSociety', security: platformOnly,
      description: 'Creates the society record **and provisions its dedicated database** in the same transaction, then seeds default ledgers, settings and role templates. This is what makes per-society isolation real rather than a query filter.',
      body: ref('CreateSocietyInput'),
      responses: { 201: okJson(envelope(ref('Society')), 'Society created and provisioned'), ...STANDARD_ERRORS } }),
  };
  paths[`${P}/stats/overview`] = {
    get: op({ tag: 'Platform', summary: 'Platform-wide totals', operationId: 'platformOverview', security: platformOnly,
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Counts by status, residents, units, revenue'), ...STANDARD_ERRORS } }),
  };
  paths[`${P}/{id}`] = {
    parameters: [ID_PARAM],
    get: op({ tag: 'Platform', summary: 'Get a society', operationId: 'getSociety', security: platformOnly,
      responses: { 200: okJson(envelope(ref('Society')), 'Society'), ...STANDARD_ERRORS } }),
    patch: op({ tag: 'Platform', summary: 'Update a society', operationId: 'updateSociety', security: platformOnly, body: ref('UpdateSocietyInput'),
      responses: { 200: okJson(envelope(ref('Society')), 'Updated'), ...STANDARD_ERRORS } }),
  };
  paths[`${P}/{id}/provision`] = {
    post: op({ tag: 'Platform', summary: 'Provision (or repair) the society database', operationId: 'provisionSociety', security: platformOnly,
      description: 'Idempotent: safe to re-run after a partial onboarding.',
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Provisioned'), ...STANDARD_ERRORS } }),
  };
  paths[`${P}/{id}/activate`] = {
    post: op({ tag: 'Platform', summary: 'Activate a society', operationId: 'activateSociety', security: platformOnly,
      responses: { 200: okJson(envelope(ref('Society')), 'Active'), ...STANDARD_ERRORS } }),
  };
  paths[`${P}/{id}/status`] = {
    patch: op({ tag: 'Platform', summary: 'Suspend or reinstate a society', operationId: 'setSocietyStatus', security: platformOnly,
      body: { type: 'object', properties: { status: { type: 'string', enum: ['active', 'suspended', 'archived'] }, reason: { type: 'string' } }, required: ['status'] },
      responses: { 200: okJson(envelope(ref('Society')), 'Status changed'), ...STANDARD_ERRORS } }),
  };
  paths[`${P}/{id}/onboarding`] = {
    post: op({ tag: 'Platform', summary: 'Advance onboarding state', operationId: 'advanceOnboarding', security: platformOnly,
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Onboarding step recorded'), ...STANDARD_ERRORS } }),
    patch: op({ tag: 'Platform', summary: 'Set onboarding state', operationId: 'setOnboarding', security: platformOnly,
      body: { type: 'object', additionalProperties: true },
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Updated'), ...STANDARD_ERRORS } }),
  };
  paths[`${P}/{id}/subscription`] = {
    patch: op({ tag: 'Platform', summary: 'Change the subscription plan', operationId: 'setSubscription', security: platformOnly,
      body: js(V.createSubscriptionSchema),
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Subscription updated'), ...STANDARD_ERRORS } }),
  };
  paths[`${P}/{id}/stats`] = {
    get: op({ tag: 'Platform', summary: 'Per-society usage stats', operationId: 'societyStats', security: platformOnly,
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Stats'), ...STANDARD_ERRORS } }),
  };
  paths[`${P}/{id}/admins`] = {
    get: op({ tag: 'Platform', summary: 'List society admins', operationId: 'listSocietyAdmins', security: platformOnly,
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Admins'), ...STANDARD_ERRORS } }),
    post: op({ tag: 'Platform', summary: 'Invite a society admin', operationId: 'inviteSocietyAdmin', security: platformOnly,
      body: { type: 'object', properties: { email: { type: 'string', format: 'email' }, fullName: { type: 'string' }, phone: { type: 'string' } }, required: ['email', 'fullName'] },
      responses: { 201: okJson(envelope({ type: 'object', additionalProperties: true }), 'Invited'), ...STANDARD_ERRORS } }),
  };
  paths[`${P}/{id}/audit-logs`] = {
    get: op({ tag: 'Platform', summary: 'Audit trail for a society', operationId: 'societyAuditLogs', security: platformOnly, params: LIST_PARAMS,
      responses: { 200: okJson(paginated(ref('AuditLog')), 'Audit logs'), ...STANDARD_ERRORS } }),
  };

  // ── Structure ──────────────────────────────────────────────────────────
  const S = '/api/structure';
  paths[`${S}/tree`] = {
    get: op({ tag: 'Structure', summary: 'Full building → wing → floor → unit tree', operationId: 'structureTree',
      description: 'One request instead of four nested list calls, which is what the unit-picker in the admin console and the resident app both need.',
      params: [{ name: 'depth', in: 'query', schema: { type: 'string', enum: ['buildings', 'wings', 'floors', 'units'] } }],
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Tree'), ...STANDARD_ERRORS } }),
  };
  paths[`${S}/counts`] = {
    get: op({ tag: 'Structure', summary: 'Occupancy and inventory counts', operationId: 'structureCounts',
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Counts'), ...STANDARD_ERRORS } }),
  };
  paths[`${S}/import/templates`] = {
    get: op({ tag: 'Structure', summary: 'Download the CSV/Excel import template', operationId: 'importTemplates',
      responses: { 200: { description: 'Workbook', content: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { schema: { type: 'string', format: 'binary' } } } }, ...STANDARD_ERRORS } }),
  };
  paths[`${S}/import/preview`] = {
    post: op({ tag: 'Structure', summary: 'Validate an import file without writing', operationId: 'importPreview',
      contentType: 'multipart/form-data',
      body: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, kind: { type: 'string', enum: ['buildings', 'wings', 'floors', 'units', 'residents'] } }, required: ['file', 'kind'] },
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Row-by-row validation report'), ...STANDARD_ERRORS } }),
  };
  paths[`${S}/import`] = {
    post: op({ tag: 'Structure', summary: 'Commit a validated import', operationId: 'importCommit',
      description: 'Applies the whole file atomically — a failure partway through rolls back rather than leaving a half-imported tower.',
      contentType: 'multipart/form-data',
      body: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, kind: { type: 'string', enum: ['buildings', 'wings', 'floors', 'units', 'residents'] }, dryRun: { type: 'boolean' } }, required: ['file', 'kind'] },
      responses: { 201: okJson(envelope({ type: 'object', additionalProperties: true }), 'Import result'), ...STANDARD_ERRORS } }),
  };

  Object.assign(paths, crudPaths({ base: '/api/buildings', tag: 'Structure', label: 'Building', create: V.createBuildingSchema, update: V.updateBuildingSchema }));
  Object.assign(paths, crudPaths({ base: '/api/wings', tag: 'Structure', label: 'Wing', create: V.createWingSchema, update: V.updateWingSchema }));
  Object.assign(paths, crudPaths({ base: '/api/floors', tag: 'Structure', label: 'Floor', create: V.createFloorSchema, update: V.updateFloorSchema }));
  Object.assign(paths, crudPaths({
    base: '/api/units', tag: 'Structure', label: 'Unit', create: V.createUnitSchema, update: V.updateUnitSchema,
    extra: {
      '/api/units/generate': {
        post: op({ tag: 'Structure', summary: 'Bulk-generate units for a wing/floor', operationId: 'generateUnits',
          description: 'Expands a range like `101–124` across the selected floors, honouring the configured unit types. Deterministic numbering means the same input always produces the same layout.',
          body: ref('GenerateUnitsInput'),
          responses: { 201: okJson(envelope({ type: 'object', additionalProperties: true }), 'Units generated'), ...STANDARD_ERRORS } }),
      },
    },
  }));

  // ── Residents ──────────────────────────────────────────────────────────
  Object.assign(paths, crudPaths({ base: '/api/residents', tag: 'Residents', label: 'Resident', create: V.createResidentSchema, update: V.updateResidentSchema }));
  Object.assign(paths, crudPaths({ base: '/api/family-members', tag: 'Residents', label: 'FamilyMember', create: V.createFamilyMemberSchema, update: V.updateFamilyMemberSchema }));
  Object.assign(paths, crudPaths({ base: '/api/unit-members', tag: 'Residents', label: 'UnitMember', create: V.linkMemberToUnitSchema, update: V.linkMemberToUnitSchema.partial() }));
  Object.assign(paths, crudPaths({ base: '/api/vehicles', tag: 'Residents', label: 'Vehicle', create: V.createVehicleSchema, update: V.updateVehicleSchema }));
  Object.assign(paths, crudPaths({ base: '/api/parking-areas', tag: 'Residents', label: 'ParkingArea', create: V.createParkingAreaSchema, update: V.createParkingAreaSchema.partial() }));
  Object.assign(paths, crudPaths({
    base: '/api/parking-slots', tag: 'Residents', label: 'ParkingSlot', create: V.createParkingSlotSchema, update: V.updateParkingSlotSchema,
    extra: {
      '/api/parking-slots/generate': {
        post: op({ tag: 'Residents', summary: 'Bulk-generate parking slots', operationId: 'generateParkingSlots',
          body: { type: 'object', properties: { areaId: { type: 'string' }, prefix: { type: 'string' }, from: { type: 'integer' }, to: { type: 'integer' } }, required: ['areaId', 'from', 'to'] },
          responses: { 201: okJson(envelope({ type: 'object', additionalProperties: true }), 'Slots generated'), ...STANDARD_ERRORS } }),
      },
      '/api/parking-slots/{id}/assign': {
        post: op({ tag: 'Residents', summary: 'Assign a slot to a unit or vehicle', operationId: 'assignParkingSlot', params: [ID_PARAM], body: ref('AssignParkingSlotInput'),
          responses: { 200: okJson(envelope(ref('ParkingSlot')), 'Assigned'), ...STANDARD_ERRORS } }),
      },
    },
  }));

  // ── Visitors & gate console ────────────────────────────────────────────
  const Vb = '/api/visitors';
  Object.assign(paths, crudPaths({ base: Vb, tag: 'Visitors', label: 'Visitor', create: V.createPreApprovedVisitorSchema, update: V.updateVisitorSchema }));
  paths[`${Vb}/pre-approve`] = {
    post: op({ tag: 'Visitors', summary: 'Pre-approve a visitor and mint a QR pass', operationId: 'preApproveVisitor',
      description: '**§80 step 5.** A resident pre-approves a guest; the server issues a signed, time-boxed QR pass. The QR is self-verifying, so a gate can validate it offline-tolerantly without a database round-trip for the signature.',
      body: ref('CreatePreApprovedVisitorInput'),
      responses: { 201: okJson(envelope({
        type: 'object',
        properties: {
          visitor: { type: 'object', additionalProperties: true },
          pass: {
            type: 'object',
            properties: {
              id: { type: 'string' }, token: { type: 'string', description: 'Signed payload the gate scans' },
              qrDataUrl: { type: 'string', description: 'Rendered PNG data URL, ready to display' },
              validFrom: { type: 'string', format: 'date-time' }, validUntil: { type: 'string', format: 'date-time' },
            },
            required: ['token'],
          },
        },
        required: ['visitor'],
      }), 'Visitor pre-approved with pass'), ...STANDARD_ERRORS },
    }),
  };
  paths[`${Vb}/at-gate`] = {
    post: op({ tag: 'Visitors', summary: 'Register an unannounced visitor at the gate', operationId: 'createAtGateVisitor',
      description: 'Creates the visitor in `awaiting_approval` and notifies the resident in real time. The guard holds at the gate until a decision arrives.',
      body: ref('CreateAtGateVisitorInput'),
      responses: { 201: okJson(envelope({ type: 'object', additionalProperties: true }), 'Awaiting resident approval'), ...STANDARD_ERRORS } }),
  };
  paths[`${Vb}/{id}/decide`] = {
    post: op({ tag: 'Visitors', summary: 'Approve or deny a waiting visitor', operationId: 'decideVisitor', params: [ID_PARAM],
      body: ref('DecideVisitorInput'),
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Decision recorded'), ...STANDARD_ERRORS } }),
  };
  paths[`${Vb}/{id}/check-in`] = {
    post: op({ tag: 'Visitors', summary: 'Check a visitor in', operationId: 'checkInVisitor', params: [ID_PARAM],
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Checked in'), ...STANDARD_ERRORS } }),
  };
  paths[`${Vb}/{id}/check-out`] = {
    post: op({ tag: 'Visitors', summary: 'Check a visitor out', operationId: 'checkOutVisitor', params: [ID_PARAM],
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Checked out'), ...STANDARD_ERRORS } }),
  };
  paths[`${Vb}/{id}/qr`] = {
    get: op({ tag: 'Visitors', summary: 'Re-fetch the QR pass for a visitor', operationId: 'visitorQr', params: [ID_PARAM],
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Pass'), ...STANDARD_ERRORS } }),
  };
  paths[`${Vb}/mine`] = {
    get: op({ tag: 'Visitors', summary: 'Visitors for my units', operationId: 'myVisitors', params: LIST_PARAMS,
      responses: { 200: okJson(paginated(ref('Visitor')), 'Visitors'), ...STANDARD_ERRORS } }),
  };
  paths[`${Vb}/summary`] = {
    get: op({ tag: 'Visitors', summary: 'Today-at-a-glance visitor counts', operationId: 'visitorSummary',
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Summary'), ...STANDARD_ERRORS } }),
  };
  paths['/api/visitors/entries'] = {
    get: op({ tag: 'Visitors', summary: 'Entry/exit log', operationId: 'visitorEntries', params: LIST_PARAMS,
      responses: { 200: okJson(paginated({ type: 'object', additionalProperties: true }), 'Entry log'), ...STANDARD_ERRORS } }),
  };
  paths['/api/gate/scan'] = {
    post: op({ tag: 'Gate Console', summary: 'Scan a QR pass at the gate', operationId: 'gateScan',
      description: '**§80 step 6.** The single entry point for every gate scan — visitor passes, amenity bookings, deliveries and cabs. Signature and validity window are checked server-side; the guard cannot forge a pass id. On success the entry is logged and the pass is consumed atomically, so a double-scan cannot admit the same guest twice.',
      body: ref('ScanQrInput'),
      responses: { 200: okJson(envelope({
        type: 'object',
        properties: {
          valid: { type: 'boolean' }, kind: { type: 'string', description: 'visitor | booking | delivery | cab' },
          reason: { type: ['string', 'null'], description: 'Machine-readable rejection cause when `valid` is false' },
          entity: { type: ['object', 'null'], additionalProperties: true, description: 'The visitor/booking the pass belongs to' },
          entry: { type: ['object', 'null'], additionalProperties: true, description: 'The entry-log row created' },
        },
        required: ['valid'],
      }), 'Scan evaluated'), ...STANDARD_ERRORS, ...errResponses([422, 'Pass rejected — `code` is one of the `QR_*` family']) },
    }),
  };
  paths['/api/gate/queue'] = {
    get: op({ tag: 'Gate Console', summary: 'Live queue of visitors awaiting a decision', operationId: 'gateQueue',
      description: 'Backs the guard console. Kept in sync over the `/realtime` socket so the guard sees approvals without refreshing.',
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Queue'), ...STANDARD_ERRORS } }),
  };
  paths['/api/gate/entries'] = {
    post: op({ tag: 'Gate Console', summary: 'Record a manual entry', operationId: 'recordEntry', body: ref('RecordEntryInput'),
      responses: { 201: okJson(envelope({ type: 'object', additionalProperties: true }), 'Entry logged'), ...STANDARD_ERRORS } }),
  };
  paths['/api/gate/exits'] = {
    post: op({ tag: 'Gate Console', summary: 'Record a manual exit', operationId: 'recordExit', body: ref('RecordExitInput'),
      responses: { 201: okJson(envelope({ type: 'object', additionalProperties: true }), 'Exit logged'), ...STANDARD_ERRORS } }),
  };

  // ── Gates & guards ─────────────────────────────────────────────────────
  Object.assign(paths, crudPaths({ base: '/api/gates', tag: 'Security', label: 'Gate', create: V.createGateSchema, update: V.updateGateSchema }));
  Object.assign(paths, crudPaths({ base: '/api/guards', tag: 'Security', label: 'Guard', create: V.createStaffSchema, update: V.updateStaffSchema }));
  paths['/api/guards/shift/login'] = {
    post: op({ tag: 'Security', summary: 'Start a guard shift', operationId: 'guardShiftLogin', body: ref('GuardShiftLoginInput'),
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Shift started'), ...STANDARD_ERRORS } }),
  };
  paths['/api/guards/shift/logout'] = {
    post: op({ tag: 'Security', summary: 'End a guard shift', operationId: 'guardShiftLogout',
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Shift ended'), ...STANDARD_ERRORS } }),
  };
  paths['/api/guards/dashboard'] = {
    get: op({ tag: 'Security', summary: 'Guard console dashboard', operationId: 'guardDashboard',
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Queue, pending approvals and shift state'), ...STANDARD_ERRORS } }),
  };

  // ── Helpdesk ───────────────────────────────────────────────────────────
  const C = '/api/complaints';
  Object.assign(paths, crudPaths({ base: C, tag: 'Helpdesk', label: 'Complaint', create: V.createComplaintSchema, update: V.updateComplaintSchema }));
  paths[`${C}/mine`] = { get: op({ tag: 'Helpdesk', summary: 'Complaints raised by me or my units', operationId: 'myComplaints', params: LIST_PARAMS,
    responses: { 200: okJson(paginated(ref('Complaint')), 'Complaints'), ...STANDARD_ERRORS } }) };
  paths[`${C}/{id}/assign`] = {
    post: op({ tag: 'Helpdesk', summary: 'Assign a complaint to a vendor or staff', operationId: 'assignComplaint', params: [ID_PARAM],
      description: '**§80 step 8.** Assigning raises a work order and notifies the vendor; the complaint moves to `assigned` in the same transaction.',
      body: ref('AssignComplaintInput'),
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Assigned'), ...STANDARD_ERRORS } }),
  };
  paths[`${C}/{id}/status`] = {
    patch: op({ tag: 'Helpdesk', summary: 'Move a complaint through its lifecycle', operationId: 'setComplaintStatus', params: [ID_PARAM],
      description: 'Enforces the legal transitions — a `closed` complaint cannot silently jump back to `open`, it must be reopened explicitly, and resolution requires the raiser to verify.',
      body: ref('ComplaintStatusChangeInput'),
      responses: { 200: okJson(envelope(ref('Complaint')), 'Status changed'), ...STANDARD_ERRORS } }),
  };
  paths[`${C}/{id}/verify`] = {
    post: op({ tag: 'Helpdesk', summary: 'Verify the fix as the resident', operationId: 'verifyComplaint', params: [ID_PARAM],
      description: '**§80 step 9.** The resident confirms the work was actually done; only then can it close. Rating is captured here.',
      body: js(V.complaintFeedbackSchema),
      responses: { 200: okJson(envelope(ref('Complaint')), 'Verified'), ...STANDARD_ERRORS } }),
  };
  paths[`${C}/{id}/reopen`] = {
    post: op({ tag: 'Helpdesk', summary: 'Reopen a closed complaint', operationId: 'reopenComplaint', params: [ID_PARAM],
      body: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
      responses: { 200: okJson(envelope(ref('Complaint')), 'Reopened'), ...STANDARD_ERRORS } }),
  };
  paths[`${C}/{id}/comments`] = {
    post: op({ tag: 'Helpdesk', summary: 'Add a comment or photo update', operationId: 'addComplaintComment', params: [ID_PARAM],
      body: js(V.complaintCommentSchema),
      responses: { 201: okJson(envelope({ type: 'object', additionalProperties: true }), 'Comment added'), ...STANDARD_ERRORS } }),
    get: op({ tag: 'Helpdesk', summary: 'List the conversation', operationId: 'listComplaintComments', params: [ID_PARAM],
      responses: { 200: okJson(envelope({ type: 'array', items: { type: 'object', additionalProperties: true } }), 'Comments'), ...STANDARD_ERRORS } }),
  };
  Object.assign(paths, crudPaths({ base: '/api/work-orders', tag: 'Helpdesk', label: 'WorkOrder', create: V.createWorkOrderSchema, update: V.updateWorkOrderSchema }));
  Object.assign(paths, crudPaths({ base: '/api/service-requests', tag: 'Helpdesk', label: 'ServiceRequest', create: V.createServiceRequestSchema, update: V.updateServiceRequestSchema }));
  Object.assign(paths, crudPaths({ base: '/api/vendors', tag: 'Helpdesk', label: 'Vendor', create: V.createVendorSchema, update: V.updateVendorSchema }));
  Object.assign(paths, crudPaths({ base: '/api/staff', tag: 'Helpdesk', label: 'Staff', create: V.createStaffSchema, update: V.updateStaffSchema }));

  // ── Amenities & bookings ───────────────────────────────────────────────
  Object.assign(paths, crudPaths({ base: '/api/amenities', tag: 'Amenities', label: 'Amenity', create: V.createAmenitySchema, update: V.updateAmenitySchema }));
  const B = '/api/amenity-bookings';
  Object.assign(paths, crudPaths({ base: B, tag: 'Amenities', label: 'AmenityBooking', create: V.createBookingSchema, update: V.createBookingSchema.partial() }));
  paths[`${B}/availability`] = {
    get: op({ tag: 'Amenities', summary: 'Slot availability for a date', operationId: 'bookingAvailability',
      description: 'Accounts for capacity, existing confirmed bookings and the society\'s notice period, so the app never offers a slot that will be rejected.',
      params: [{ name: 'amenityId', in: 'query', required: true, schema: { type: 'string' } }, { name: 'date', in: 'query', required: true, schema: { type: 'string', format: 'date' } }],
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Available slots'), ...STANDARD_ERRORS } }),
  };
  paths[`${B}/mine`] = {
    get: op({ tag: 'Amenities', summary: 'My bookings', operationId: 'myBookings', params: LIST_PARAMS,
      responses: { 200: okJson(paginated(ref('AmenityBooking')), 'Bookings'), ...STANDARD_ERRORS } }),
  };
  paths[`${B}/{id}/qr`] = {
    get: op({ tag: 'Amenities', summary: 'Entry QR for a confirmed booking', operationId: 'bookingQr', params: [ID_PARAM],
      description: '**§80 step 13.** Issued only once payment has settled for paid amenities.',
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Booking pass'), ...STANDARD_ERRORS } }),
  };
  paths[`${B}/{id}/decide`] = {
    post: op({ tag: 'Amenities', summary: 'Approve or reject a pending booking', operationId: 'decideBooking', params: [ID_PARAM], body: ref('DecideBookingInput'),
      responses: { 200: okJson(envelope(ref('AmenityBooking')), 'Decision recorded'), ...STANDARD_ERRORS } }),
  };
  paths[`${B}/{id}/cancel`] = {
    post: op({ tag: 'Amenities', summary: 'Cancel a booking', operationId: 'cancelBooking', params: [ID_PARAM],
      body: js(V.cancelBookingSchema),
      description: 'Releases the slot and, where the policy allows, queues a refund against the original payment.',
      responses: { 200: okJson(envelope(ref('AmenityBooking')), 'Cancelled'), ...STANDARD_ERRORS } }),
  };
  paths[`${B}/{id}/check-in`] = {
    post: op({ tag: 'Amenities', summary: 'Check in to a booked amenity', operationId: 'bookingCheckIn', params: [ID_PARAM],
      responses: { 200: okJson(envelope(ref('AmenityBooking')), 'Checked in'), ...STANDARD_ERRORS } }),
  };

  // ── Finance ────────────────────────────────────────────────────────────
  const Bi = '/api/bills';
  Object.assign(paths, crudPaths({ base: Bi, tag: 'Finance', label: 'Bill', create: V.createBillSchema, update: V.updateBillSchema }));
  paths[`${Bi}/generate`] = {
    post: op({ tag: 'Finance', summary: 'Generate maintenance bills for a period', operationId: 'generateBills',
      description: '**§80 step 10.** Computes per-unit charges from the configured heads (area-based, per-share or flat), applies arrears and late fees, creates the bills and posts the accrual journal entries in one transaction. Re-running for a period is idempotent.',
      body: ref('GenerateBillsInput'),
      responses: { 201: okJson(envelope({ type: 'object', additionalProperties: true }), 'Generated count, total raised and per-unit results'), ...STANDARD_ERRORS } }),
  };
  paths[`${Bi}/mine`] = {
    get: op({ tag: 'Finance', summary: 'Bills for my units', operationId: 'myBills', params: LIST_PARAMS,
      responses: { 200: okJson(paginated(ref('Bill')), 'Bills'), ...STANDARD_ERRORS } }),
  };
  paths[`${Bi}/summary`] = {
    get: op({ tag: 'Finance', summary: 'Collections summary for a period', operationId: 'billSummary',
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Raised, collected, outstanding'), ...STANDARD_ERRORS } }),
  };
  paths[`${Bi}/defaulters`] = {
    get: op({ tag: 'Finance', summary: 'Outstanding balances by unit', operationId: 'defaulters',
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Defaulter list'), ...STANDARD_ERRORS } }),
  };
  paths[`${Bi}/{id}/invoice`] = {
    get: op({ tag: 'Finance', summary: 'Download the invoice PDF', operationId: 'billInvoice', params: [ID_PARAM],
      responses: { 200: { description: 'Invoice PDF', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } }, ...STANDARD_ERRORS } }),
  };
  paths[`${Bi}/{id}/waive`] = {
    post: op({ tag: 'Finance', summary: 'Waive charges on a bill', operationId: 'waiveBill', params: [ID_PARAM],
      description: 'Requires the `bill:approve` permission and writes an audit entry with the reason — waivers are the classic place for leakage, so they are never silent.',
      body: ref('WaiveBillInput'),
      responses: { 200: okJson(envelope(ref('Bill')), 'Waived'), ...STANDARD_ERRORS } }),
  };
  paths[`${Bi}/{id}/dispute`] = {
    post: op({ tag: 'Finance', summary: 'Raise a dispute against a bill', operationId: 'disputeBill', params: [ID_PARAM],
      body: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
      responses: { 200: okJson(envelope(ref('Bill')), 'Disputed'), ...STANDARD_ERRORS } }),
  };

  const Py = '/api/payments';
  paths[`${Py}/intent`] = {
    post: op({ tag: 'Finance', summary: 'Create a payment intent', operationId: 'createPaymentIntent',
      description: '**§80 step 11.** Creates the gateway order and a `created` payment row. The amount is taken from the bill server-side — a client cannot pay less than what is owed by editing the request.',
      body: ref('CreatePaymentIntentInput'),
      responses: { 201: okJson(envelope({
        type: 'object',
        properties: {
          paymentId: { type: 'string' }, providerOrderId: { type: 'string' }, amount: { type: 'number' },
          currency: { type: 'string' }, keyId: { type: ['string', 'null'] }, provider: { type: 'string' },
          checkout: { type: ['object', 'null'], additionalProperties: true },
        },
        required: ['paymentId', 'providerOrderId', 'amount'],
      }), 'Intent created'), ...STANDARD_ERRORS } }),
  };
  paths[`${Py}/verify`] = {
    post: op({ tag: 'Finance', summary: 'Verify a gateway payment and apply it', operationId: 'verifyPayment',
      description: '**§80 step 12.** Re-checks the gateway signature server-side, marks the payment captured, applies it to the bill, issues a receipt number and posts the receipt journal entry — all in one transaction. Signature verification happens before the order is looked up, so an attacker cannot probe for valid order ids.',
      body: ref('VerifyPaymentInput'),
      responses: { 200: okJson(envelope({
        type: 'object',
        properties: {
          payment: { type: 'object', additionalProperties: true },
          receiptNumber: { type: ['string', 'null'] }, bill: { type: ['object', 'null'], additionalProperties: true },
        },
        required: ['payment'],
      }), 'Payment verified and posted to the ledger'), ...STANDARD_ERRORS } }),
  };
  paths[`${Py}/offline`] = {
    post: op({ tag: 'Finance', summary: 'Record a cash/cheque/NEFT payment', operationId: 'recordOfflinePayment',
      description: 'Society staff record money received outside the gateway. Posts the same ledger entries as an online payment so the books stay complete.',
      body: ref('RecordOfflinePaymentInput'),
      responses: { 201: okJson(envelope({ type: 'object', additionalProperties: true }), 'Payment recorded'), ...STANDARD_ERRORS } }),
  };
  paths[`${Py}/mine`] = {
    get: op({ tag: 'Finance', summary: 'My payment history', operationId: 'myPayments', params: LIST_PARAMS,
      responses: { 200: okJson(paginated(ref('Payment')), 'Payments'), ...STANDARD_ERRORS } }),
  };
  paths[`${Py}/summary`] = {
    get: op({ tag: 'Finance', summary: 'Collections summary', operationId: 'paymentSummary',
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'By method and period'), ...STANDARD_ERRORS } }),
  };
  paths[`${Py}/{id}/refund`] = {
    post: op({ tag: 'Finance', summary: 'Refund a payment', operationId: 'refundPayment', params: [ID_PARAM], body: ref('RefundPaymentInput'),
      description: 'Reverses the ledger entries rather than deleting them, so the audit trail shows both sides.',
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Refunded'), ...STANDARD_ERRORS } }),
  };
  paths[`${Py}/{id}/receipt`] = {
    get: op({ tag: 'Finance', summary: 'Download the receipt PDF', operationId: 'paymentReceipt', params: [ID_PARAM],
      responses: { 200: { description: 'Receipt PDF', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } }, ...STANDARD_ERRORS } }),
  };
  Object.assign(paths, crudPaths({ base: Py, tag: 'Finance', label: 'Payment', allowCreate: false }));

  paths['/api/webhooks/payments'] = {
    post: op({
      tag: 'Finance', summary: 'Gateway webhook receiver', operationId: 'paymentWebhook',
      security: [], contentType: 'application/json',
      description: 'Mounted **before** the JSON body parser so the raw bytes are available for HMAC verification. The signature is validated before any order lookup. Deliveries are processed idempotently — a gateway retry cannot double-post a receipt.',
      body: { type: 'object', additionalProperties: true },
      responses: {
        200: okJson({ type: 'object', additionalProperties: true }, 'Acknowledged'),
        ...errResponses(
          [400, 'Signature mismatch — the body is rejected before any state changes'],
          [404, 'Unknown provider order'],
        ),
      },
    }),
  };

  const Ac = '/api/accounting';
  paths[`${Ac}/trial-balance`] = {
    get: op({ tag: 'Finance', summary: 'Trial balance as at a date', operationId: 'trialBalance',
      description: 'Proves the books balance: total debits equal total credits across every ledger.',
      params: [{ name: 'asOf', in: 'query', schema: { type: 'string', format: 'date' } }],
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Trial balance'), ...STANDARD_ERRORS } }),
  };
  paths[`${Ac}/income-statement`] = {
    get: op({ tag: 'Finance', summary: 'Income statement for a period', operationId: 'incomeStatement',
      params: [{ name: 'from', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }],
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Income and expense by head'), ...STANDARD_ERRORS } }),
  };
  paths[`${Ac}/balance-sheet`] = {
    get: op({ tag: 'Finance', summary: 'Balance sheet as at a date', operationId: 'balanceSheet',
      params: [{ name: 'asOf', in: 'query', schema: { type: 'string', format: 'date' } }],
      responses: { 200: okJson(envelope({ type: 'object', additionalProperties: true }), 'Assets, liabilities and equity'), ...STANDARD_ERRORS } }),
  };
  Object.assign(paths, crudPaths({ base: `${Ac}/ledgers`, tag: 'Finance', label: 'Ledger', create: V.createLedgerSchema, update: V.updateLedgerSchema }));
  Object.assign(paths, crudPaths({ base: `${Ac}/journal-entries`, tag: 'Finance', label: 'JournalEntry', create: V.createJournalEntrySchema, allowCreate: true }));
  Object.assign(paths, crudPaths({ base: '/api/expenses', tag: 'Finance', label: 'Expense', create: V.createExpenseSchema, update: V.createExpenseSchema.partial() }));
  Object.assign(paths, crudPaths({ base: '/api/incomes', tag: 'Finance', label: 'Income', create: V.createIncomeSchema, update: V.createIncomeSchema.partial() }));

  return {
    openapi: '3.1.0',
    info: {
      title: 'Colonize — Community Management Platform API',
      version: env.VERSION,
      description: [
        'Multi-tenant society & community management API (MyGate-class).',
        '',
        '## Tenancy model',
        'Each society gets a **dedicated database**; the platform database holds only SaaS-level records',
        '(societies, subscriptions, platform users, cross-society identity). Every request is resolved to a',
        'tenant server-side from the access token and the `X-Society-Id` header — **client-supplied ids and',
        'roles are never trusted**. A token minted for society A cannot read society B even if B\'s document',
        'ids are guessed, because the query runs against a different database.',
        '',
        '## Authentication',
        'Residents log in by OTP; staff and platform users may use passwords. Access tokens are short-lived',
        'JWTs, refresh tokens are opaque, rotating and device-bound.',
        '',
        '## Conventions',
        '- Every response uses the envelope `{ success, message, data, meta? }`.',
        '- Lists are paginated and return `meta` with `total`, `totalPages`, `hasNext`, `hasPrev`.',
        '- Errors carry a stable machine-readable `code` (see the `ApiError` schema) plus `meta.requestId`.',
        '- Deletes are **soft** — `deletedAt` is set and the row keeps its audit history.',
        '- Financial and visitor flows are transactional; partial application is not observable.',
        '- Send `X-Idempotency-Key` on money-moving POSTs to make retries safe.',
        '',
        '## Realtime',
        'A Socket.IO server is mounted at `/realtime`. Rooms are `society:<id>`, `admins:<id>` and',
        '`security:<id>`; gate approvals, complaint updates and payment confirmations are pushed live.',
      ].join('\n'),
      contact: { name: 'Colonize Engineering' },
      license: { name: 'UNLICENSED — proprietary' },
    },
    servers: [
      { url: env.PUBLIC_URL || `http://localhost:${env.PORT}`, description: 'This deployment' },
      { url: 'https://api.colonize.example', description: 'Production (illustrative)' },
    ],
    tags: [
      { name: 'Meta', description: 'Health, readiness, feature detection and identity' },
      { name: 'Auth', description: 'OTP and password login, token rotation, sessions, app lock' },
      { name: 'Platform', description: 'Super-admin: society onboarding, provisioning, subscriptions' },
      { name: 'Structure', description: 'Buildings → wings → floors → units, bulk generation and import' },
      { name: 'Residents', description: 'Residents, family members, vehicles, parking' },
      { name: 'Visitors', description: 'Pre-approval, QR passes, at-gate registration, decisions' },
      { name: 'Gate Console', description: 'Guard-facing scanning and entry/exit logging' },
      { name: 'Security', description: 'Gates, guards and shift management' },
      { name: 'Helpdesk', description: 'Complaints, work orders, service requests, vendors, staff' },
      { name: 'Amenities', description: 'Amenities, slot availability, bookings and entry passes' },
      { name: 'Finance', description: 'Bills, payments, receipts, ledgers and financial statements' },
    ],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http', scheme: 'bearer', bearerFormat: 'JWT',
          description: 'Society-scoped access token from `/api/auth/*`. Must be paired with `X-Society-Id`.',
        },
        platformAuth: {
          type: 'http', scheme: 'bearer', bearerFormat: 'JWT',
          description: 'Platform-scoped token from `/api/auth/platform/login`. The only credential accepted by `/api/platform/*`.',
        },
      },
      parameters: {
        SocietyId: {
          name: 'X-Society-Id', in: 'header', required: false, schema: { type: 'string' },
          description: 'Selects the tenant for tokens that span several societies. The server validates that the token actually belongs to this society; a mismatch is a `TENANT_MISMATCH` error, never a silent fallthrough.',
        },
        DeviceId: { name: 'X-Device-Id', in: 'header', schema: { type: 'string' }, description: 'Binds refresh tokens to a device' },
        IdempotencyKey: { name: 'X-Idempotency-Key', in: 'header', schema: { type: 'string' }, description: 'Replay guard for money-moving writes' },
        RequestId: { name: 'X-Request-Id', in: 'header', schema: { type: 'string' }, description: 'Optional client trace id; the server generates one when absent and echoes it back' },
      },
      schemas: { ...entitySchemas(), ...validationSchemas() },
    },
    paths,
  };
}

function str_(description?: string): JsonSchema {
  return { type: 'string', ...(description ? { description } : {}) };
}
