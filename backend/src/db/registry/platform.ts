import { A, B, D, N, S, X, defineCollection, ref } from './fields.js';
import type { Registry } from './fields.js';
import { ROLE_SCOPES, SOCIETY_STATUS, SUBSCRIPTION_STATUS, PLAN_TIERS, TICKET_PRIORITY, TICKET_STATUS } from '@colonize/shared';

/**
 * Platform (SaaS operator) database collections.
 *
 * These live in ONE database (`PLATFORM_DB_NAME`) because they are cross-tenant by nature:
 * the super admin must see every society, plan and subscription. Society *operational* data
 * never lives here — it lives in that society's own database.
 */
export const PLATFORM_COLLECTIONS: Registry = {
  /**
   * Users with platform-scope roles (Super Admin, Platform Admin, Support Admin,
   * Finance Admin). Society staff/residents live in the tenant `users` collection.
   */
  platform_users: defineCollection(
    'platform_users',
    {
      fullName: S({ required: true, trim: true }),
      email: S({ unique: true, sparse: true, lowercase: true, trim: true }),
      phone: S({ index: true, sparse: true, trim: true }),
      passwordHash: S({ description: 'bcrypt hash — never serialised to a client' }),
      roles: A({ description: 'Platform role keys' }),
      avatarUrl: S(),
      status: S({ enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED'], default: 'ACTIVE', index: true }),
      lastLoginAt: D(),
      mustChangePassword: B({ default: false }),
      preferences: X(),
      notes: S(),
    },
    { scope: 'platform', indexes: [{ fields: { email: 1 }, unique: true, sparse: true }] },
  ),

  /** One document per registered society — the tenant directory (§5, §41). */
  societies: defineCollection(
    'societies',
    {
      name: S({ required: true, trim: true }),
      slug: S({ required: true, unique: true, lowercase: true, trim: true, description: 'Determines the tenant database name' }),
      type: S({ enum: ['RESIDENTIAL_SOCIETY', 'APARTMENT_COMPLEX', 'GATED_COMMUNITY', 'HOUSING_SOCIETY', 'COMMERCIAL_COMMUNITY', 'MIXED_USE'], default: 'RESIDENTIAL_SOCIETY' }),
      status: S({ enum: SOCIETY_STATUS, default: 'DRAFT', index: true }),
      registrationNumber: S(),
      address: X(),
      city: S({ index: true }),
      state: S(),
      postalCode: S(),
      country: S({ default: 'India' }),
      timezone: S({ default: 'Asia/Kolkata' }),
      currency: S({ default: 'INR' }),
      contactPhone: S(),
      contactEmail: S(),
      website: S(),
      logoUrl: S(),
      location: X({ description: 'GeoJSON-ish { type: "Point", coordinates: [lng, lat] }' }),
      gstin: S(),
      pan: S(),
      totalBuildings: N({ default: 0 }),
      totalUnits: N({ default: 0 }),
      totalResidents: N({ default: 0 }),
      /** Name of the provisioned tenant database. */
      databaseName: S({ required: true }),
      /** Provisioning lifecycle for the onboarding wizard. */
      provisioning: X({
        default: () => ({
          databaseReady: false,
          rolesSeeded: false,
          settingsSeeded: false,
          ledgersSeeded: false,
          adminCreated: false,
          completedSteps: [],
          activatedAt: null,
        }),
      }),
      onboardingStep: S({ default: 'society', index: true }),
      planCode: S(),
      trialEndsAt: D(),
      activatedAt: D(),
      suspendedAt: D(),
      suspensionReason: S(),
      createdByPlatformUserId: ref('platform_users'),
      metadata: X(),
    },
    { scope: 'platform', indexes: [{ fields: { slug: 1 }, unique: true }, { fields: { status: 1, createdAt: -1 } }] },
  ),

  /** SaaS plans (§42). Module list is data, so plans are configurable from the UI. */
  subscription_plans: defineCollection(
    'subscription_plans',
    {
      code: S({ required: true, unique: true, description: 'Upper-case plan code, e.g. STANDARD' }),
      name: S({ required: true }),
      tier: S({ enum: PLAN_TIERS, default: 'BASIC' }),
      description: S(),
      basePrice: N({ default: 0 }),
      pricePerUnitPerMonth: N({ default: 0 }),
      minUnits: N({ default: 0 }),
      maxUnits: N({ default: 100000 }),
      modules: A({ description: 'Enabled ModuleKey values' }),
      limits: X({ default: () => ({}) }),
      trialDays: N({ default: 14 }),
      isActive: B({ default: true }),
      isFeatured: B({ default: false }),
      sortOrder: N({ default: 100 }),
    },
    { scope: 'platform', indexes: [{ fields: { code: 1 }, unique: true }, { fields: { isActive: 1, sortOrder: 1 } }] },
  ),

  subscriptions: defineCollection(
    'subscriptions',
    {
      societyId: ref('societies', { required: true }),
      planId: ref('subscription_plans', { required: true }),
      planCode: S({ index: true }),
      billingCycle: S({ enum: ['MONTHLY', 'QUARTERLY', 'YEARLY'], default: 'MONTHLY' }),
      status: S({ enum: SUBSCRIPTION_STATUS, default: 'TRIAL', index: true }),
      startDate: D({ required: true }),
      endDate: D({ required: true, index: true }),
      trialEndsAt: D(),
      unitsBilled: N({ default: 0 }),
      amount: N({ default: 0 }),
      currency: S({ default: 'INR' }),
      autoRenew: B({ default: true }),
      cancelledAt: D(),
      cancellationReason: S(),
      lastInvoiceAt: D(),
      metadata: X(),
    },
    { scope: 'platform', indexes: [{ fields: { societyId: 1, status: 1 } }, { fields: { endDate: 1 } }] },
  ),

  /** Platform-side payments (SaaS revenue), distinct from society maintenance payments. */
  platform_payments: defineCollection(
    'platform_payments',
    {
      societyId: ref('societies'),
      subscriptionId: ref('subscriptions'),
      invoiceNumber: S({ unique: true, sparse: true }),
      amount: N({ required: true }),
      currency: S({ default: 'INR' }),
      status: S({ enum: ['INITIATED', 'SUCCESS', 'FAILED', 'REFUNDED'], default: 'INITIATED', index: true }),
      provider: S(),
      providerPaymentId: S(),
      mode: S(),
      paidAt: D(),
      periodStart: D(),
      periodEnd: D(),
      metadata: X(),
    },
    { scope: 'platform', indexes: [{ fields: { societyId: 1, createdAt: -1 } }] },
  ),

  support_tickets: defineCollection(
    'support_tickets',
    {
      ticketNumber: S({ unique: true }),
      subject: S({ required: true }),
      body: S({ required: true }),
      priority: S({ enum: TICKET_PRIORITY, default: 'MEDIUM', index: true }),
      status: S({ enum: TICKET_STATUS, default: 'OPEN', index: true }),
      category: S(),
      societyId: ref('societies'),
      raisedByUserId: S(),
      raisedByPlatformUserId: ref('platform_users'),
      raisedByEmail: S(),
      raisedByPhone: S(),
      assignedToId: ref('platform_users'),
      attachments: A(),
      resolvedAt: D(),
      closedAt: D(),
      satisfactionRating: N(),
      lastActivityAt: D({ index: true }),
    },
    { scope: 'platform', indexes: [{ fields: { ticketNumber: 1 }, unique: true }, { fields: { status: 1, priority: 1, createdAt: -1 } }] },
  ),

  support_ticket_messages: defineCollection(
    'support_ticket_messages',
    {
      ticketId: ref('support_tickets', { required: true }),
      authorId: S({ required: true }),
      authorType: S({ enum: ['PLATFORM', 'SOCIETY', 'SYSTEM'], default: 'PLATFORM' }),
      authorName: S(),
      body: S({ required: true }),
      isInternal: B({ default: false }),
      attachments: A(),
    },
    { scope: 'platform', indexes: [{ fields: { ticketId: 1, createdAt: 1 } }] },
  ),

  /**
   * OTP requests live in the platform DB because a user authenticates *before* a society
   * context exists (§7). The code itself is stored as a hash — never in plain text (§67).
   */
  otp_requests: defineCollection(
    'otp_requests',
    {
      phone: S({ required: true, index: true }),
      email: S({ index: true }),
      purpose: S({ enum: ['LOGIN', 'PASSWORD_RESET', 'PHONE_VERIFY', 'STEP_UP'], default: 'LOGIN' }),
      otpHash: S({ required: true, description: 'SHA-256(pepper + code)' }),
      channel: S({ enum: ['FCM', 'SMS', 'EMAIL', 'WHATSAPP', 'CONSOLE'], default: 'FCM' }),
      expiresAt: D({ required: true, index: true }),
      attempts: N({ default: 0 }),
      maxAttempts: N({ default: 5 }),
      consumedAt: D(),
      sentCount: N({ default: 1 }),
      lastSentAt: D(),
      deliveryStatus: S({ default: 'QUEUED' }),
      deviceId: S(),
      ip: S(),
      societySlug: S(),
      requestId: S({ unique: true, sparse: true }),
    },
    {
      scope: 'platform',
      indexes: [
        { fields: { phone: 1, purpose: 1, createdAt: -1 } },
        { fields: { expiresAt: 1 }, expireAfterSeconds: 0 },
      ],
    },
  ),

  /** Refresh tokens / sessions for platform users (tenant sessions live in tenant DBs). */
  platform_sessions: defineCollection(
    'platform_sessions',
    {
      userId: ref('platform_users', { required: true }),
      refreshTokenHash: S({ required: true, index: true }),
      tokenFamily: S({ required: true, index: true, description: 'Rotation family — reuse revokes the whole family' }),
      deviceId: S(),
      platform: S({ default: 'web' }),
      appVersion: S(),
      osVersion: S(),
      model: S(),
      pushToken: S(),
      userAgent: S(),
      ip: S(),
      lastUsedAt: D(),
      expiresAt: D({ required: true, index: true }),
      revokedAt: D(),
      revokeReason: S(),
      isActive: B({ default: true }),
    },
    {
      scope: 'platform',
      indexes: [{ fields: { userId: 1, isActive: 1 } }, { fields: { tokenFamily: 1 } }, { fields: { expiresAt: 1 }, expireAfterSeconds: 0 }],
    },
  ),

  /** Platform-wide audit trail (society creation, plan changes, admin logins). */
  platform_audit_logs: defineCollection(
    'platform_audit_logs',
    {
      actorId: S({ index: true }),
      actorType: S({ enum: ['PLATFORM_USER', 'SYSTEM', 'SOCIETY_USER'], default: 'PLATFORM_USER' }),
      actorName: S(),
      actorRoles: A(),
      action: S({ required: true, index: true }),
      module: S({ index: true }),
      societyId: ref('societies'),
      recordId: S(),
      recordType: S(),
      oldValue: X(),
      newValue: X(),
      ip: S(),
      userAgent: S(),
      deviceId: S(),
      requestId: S(),
      severity: S({ enum: ['INFO', 'NOTICE', 'WARNING', 'CRITICAL'], default: 'INFO' }),
      status: S({ enum: ['SUCCESS', 'FAILURE'], default: 'SUCCESS' }),
      errorMessage: S(),
      tookMs: N(),
      /** Audit logs are append-only: no update or delete endpoint is exposed for them. */
    },
    {
      scope: 'platform',
      softDelete: false,
      indexes: [{ fields: { createdAt: -1 } }, { fields: { societyId: 1, createdAt: -1 } }, { fields: { actorId: 1, createdAt: -1 } }, { fields: { module: 1, action: 1 } }],
      description: 'Append-only. Immutable by design (§44).',
    },
  ),

  /** Global notification templates (a society can override any of them). */
  notification_templates: defineCollection(
    'notification_templates',
    {
      code: S({ required: true, unique: true, description: 'NotificationEvent key, or `societyId:CODE` for overrides' }),
      societyId: ref('societies', { description: 'Null = platform default template' }),
      title: S({ required: true }),
      body: S({ required: true }),
      channels: A({ default: () => ['IN_APP'] }),
      priority: S({ enum: ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'], default: 'NORMAL' }),
      variables: A(),
      deepLinkTemplate: S(),
      isActive: B({ default: true }),
      locale: S({ default: 'en-IN' }),
    },
    { scope: 'platform', indexes: [{ fields: { code: 1, societyId: 1 }, unique: true }] },
  ),

  /** Platform-wide settings: branding, defaults, feature flags (§63). */
  system_settings: defineCollection(
    'system_settings',
    {
      key: S({ required: true, unique: true }),
      value: X({ required: true }),
      description: S(),
      isPublic: B({ default: false }),
      updatedByPlatformUserId: ref('platform_users'),
    },
    { scope: 'platform', indexes: [{ fields: { key: 1 }, unique: true }] },
  ),

  /** Idempotency keys for platform-level writes (society onboarding, plan changes). */
  idempotency_keys: defineCollection(
    'idempotency_keys',
    {
      key: S({ required: true, unique: true }),
      scope: S({ required: true, description: '`platform` or the society id' }),
      userId: S(),
      method: S(),
      path: S(),
      requestHash: S(),
      status: S({ enum: ['PROCESSING', 'COMPLETED', 'FAILED'], default: 'PROCESSING' }),
      responseStatus: N(),
      responseBody: X(),
      expiresAt: D({ required: true }),
    },
    { scope: 'platform', softDelete: false, indexes: [{ fields: { key: 1, scope: 1 }, unique: true }, { fields: { expiresAt: 1 }, expireAfterSeconds: 0 }] },
  ),

  /** Background job records (§61) — queue state that must survive a restart. */
  jobs: defineCollection(
    'jobs',
    {
      name: S({ required: true, index: true }),
      queue: S({ default: 'default', index: true }),
      payload: X({ default: () => ({}) }),
      status: S({ enum: ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'], default: 'QUEUED', index: true }),
      priority: N({ default: 0 }),
      attempts: N({ default: 0 }),
      maxAttempts: N({ default: 3 }),
      scheduledFor: D({ index: true }),
      startedAt: D(),
      completedAt: D(),
      lastError: S(),
      result: X(),
      societyId: ref('societies'),
      createdBy: S(),
      idempotencyKey: S({ index: true }),
    },
    { scope: 'platform', softDelete: false, indexes: [{ fields: { status: 1, scheduledFor: 1 } }, { fields: { idempotencyKey: 1 }, unique: true, sparse: true }] },
  ),

  /**
   * Cross-society identity directory.
   *
   * Because each society has its own database, "which societies does this phone number
   * belong to?" cannot be answered from any single tenant DB. This directory is the one
   * platform-level index that makes multi-society membership (§5: "A user may belong to
   * multiple societies") and OTP login possible without scanning every tenant.
   *
   * It stores *only* the phone/email and the list of society ids — never names, units or
   * any operational data — so it cannot be used to profile residents across societies.
   */
  identity_directory: defineCollection(
    'identity_directory',
    {
      phone: S({ index: true, description: 'E.164 mobile number' }),
      email: S({ index: true, lowercase: true }),
      globalUserId: S({ index: true, description: 'Stable identity shared across societies' }),
      societyIds: A({ default: () => [], description: 'Societies where this person has an account' }),
      /** Per-society user ids, so a login can jump straight to the right tenant record. */
      memberships: A({ default: () => [], description: '[{ societyId, userId, roles, societyName, societySlug, status }]' }),
      lastSeenAt: D(),
      isBlocked: B({ default: false }),
    },
    {
      scope: 'platform',
      indexes: [
        { fields: { phone: 1 } },
        { fields: { email: 1 } },
        { fields: { globalUserId: 1 }, unique: true, sparse: true },
      ],
    },
  ),

  /** Role catalogue materialised per society; the platform copy is the editable template. */
  role_templates: defineCollection(
    'role_templates',
    {
      role: S({ required: true, unique: true }),
      label: S({ required: true }),
      scope: S({ enum: ROLE_SCOPES, required: true }),
      permissions: A({ default: () => [] }),
      isSystem: B({ default: true }),
      description: S(),
    },
    { scope: 'platform', indexes: [{ fields: { role: 1 }, unique: true }, { fields: { scope: 1 } }] },
  ),

  /**
   * Cross-tenant index of gateway orders (§29, §59).
   *
   * A provider webhook arrives with only an order/payment id and NO society token, so with
   * database-per-society there is no way to know which tenant DB to open. When an intent is
   * created we record `providerOrderId → societyId` here; the webhook looks the society up by
   * the provider's own id (never by anything the caller controls) and then opens that tenant DB.
   */
  gateway_orders: defineCollection(
    'gateway_orders',
    {
      societyId: ref('societies', { required: true, index: true }),
      paymentId: S({ required: true, index: true }),
      provider: S({ required: true }),
      providerOrderId: S({ required: true }),
      amount: N({ required: true }),
      currency: S({ default: 'INR' }),
      status: S({ enum: ['CREATED', 'PAID', 'FAILED', 'REFUNDED'], default: 'CREATED', index: true }),
      webhookReceivedAt: D(),
      lastEvent: S(),
      metadata: X(),
    },
    {
      scope: 'platform',
      indexes: [
        { fields: { providerOrderId: 1 }, unique: true },
        { fields: { societyId: 1, createdAt: -1 } },
      ],
    },
  ),
};
