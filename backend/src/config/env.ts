import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

/**
 * Environment configuration (§68).
 *
 * Precedence (first wins): real environment variables → `.env` → `.env.<NODE_ENV>`.
 * A user's local `.env` therefore overrides the committed `.env.<NODE_ENV>` defaults;
 * the mode file is the fallback, not the authority. Note: env files are read once at
 * process start — edit one and restart the API for the change to take effect.
 * Nothing is hard-coded: every provider is selected by an env var so the same image runs
 * in development, staging and production.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = path.resolve(here, '..', '..');
export const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');

function loadEnvFiles(): void {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const candidates = [
    path.join(BACKEND_ROOT, '.env'),
    path.join(BACKEND_ROOT, `.env.${nodeEnv}`),
    path.join(REPO_ROOT, '.env'),
    path.join(REPO_ROOT, `.env.${nodeEnv}`),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) dotenv.config({ path: file, override: false });
  }
}

loadEnvFiles();

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase())));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production', 'staging']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PRETTY_LOGS: booleanish.default(false),

  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),
  API_PREFIX: z.string().default('/api'),
  /** Advertised in `/api/health` and the OpenAPI document. */
  VERSION: z.string().default('1.0.0'),
  /**
   * Externally reachable origin. When set it becomes the OpenAPI `servers[0].url`, which is what
   * makes "Try it out" work behind the sandbox/reverse-proxy preview host instead of pointing at
   * the container's own localhost.
   */
  PUBLIC_URL: z.string().optional(),
  /** Path the Swagger UI is mounted at. */
  SWAGGER_PATH: z.string().default('/docs'),
  TRUST_PROXY: booleanish.default(true),
  /**
   * JSON body ceiling. Sized for the CSV import wizard, which accepts a pasted spreadsheet of
   * up to 4 MB; Express's 100 kb default would reject a legitimate 800-unit import.
   */
  BODY_LIMIT: z.string().default('6mb'),

  /* ---- database ------------------------------------------------------- */
  /**
   * DB_DRIVER:
   *   - `mongo`     → real MongoDB (Mongoose). Production / Docker.
   *   - `embedded`  → in-process engine with Mongo query semantics. Local dev & CI where
   *                   no mongod is reachable. Same schemas, same business code.
   */
  DB_DRIVER: z.enum(['mongo', 'embedded']).default('embedded'),
  DATABASE_URL: z.string().default('mongodb://127.0.0.1:27017'),
  PLATFORM_DB_NAME: z.string().default('colonize_platform'),
  TENANT_DB_PREFIX: z.string().default('colonize_s_'),
  EMBEDDED_DATA_DIR: z.string().default(path.join(BACKEND_ROOT, '.runtime', 'data')),
  EMBEDDED_PERSIST: booleanish.default(true),
  /** Dev only: spin up a real mongod via mongodb-memory-server (needs a downloadable binary). */
  USE_MEMORY_MONGO: booleanish.default(false),

  /* ---- auth / tokens -------------------------------------------------- */
  JWT_SECRET: z.string().min(16).default('dev-only-insecure-access-secret-change-me'),
  JWT_REFRESH_SECRET: z.string().min(16).default('dev-only-insecure-refresh-secret-change-me'),
  JWT_EXPIRES_IN: z.string().default('20m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),
  JWT_ISSUER: z.string().default('colonize.platform'),
  JWT_AUDIENCE: z.string().default('colonize.clients'),
  /** QR / pass signing key — separate from JWT so a leak does not compromise sessions. */
  QR_SIGNING_SECRET: z.string().min(16).default('dev-only-insecure-qr-secret-change-me'),
  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(3600).default(30),
  /** In non-production the OTP is returned in `meta.devOtp` so flows are testable. */
  EXPOSE_DEV_OTP: booleanish.default(true),
  SESSION_MAX_ACTIVE_DEVICES: z.coerce.number().int().min(1).max(100).default(10),
  APP_PIN_ENABLED: booleanish.default(true),

  /* ---- providers (abstractions) --------------------------------------- */
  SMS_PROVIDER: z.enum(['console', 'twilio', 'msg91', 'gupshup', 'textlocal']).default('console'),
  EMAIL_PROVIDER: z.enum(['console', 'smtp', 'ses', 'sendgrid']).default('console'),
  PUSH_PROVIDER: z.enum(['console', 'fcm', 'expo']).default('console'),
  WHATSAPP_PROVIDER: z.enum(['disabled', 'console', 'gupshup', 'twilio', 'meta_cloud']).default('console'),
  PAYMENT_PROVIDER: z.enum(['mock', 'razorpay', 'stripe', 'cashfree', 'paytm']).default('mock'),
  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  QUEUE_DRIVER: z.enum(['memory', 'redis']).default('memory'),
  CACHE_DRIVER: z.enum(['memory', 'redis']).default('memory'),
  REDIS_URL: z.string().optional(),

  FCM_SERVER_KEY: z.string().optional(),
  FCM_PROJECT_ID: z.string().optional(),
  EXPO_PUSH_TOKEN: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('Colonize <no-reply@colonize.app>'),
  SMS_SENDER_ID: z.string().default('COLONZ'),
  SMS_API_KEY: z.string().optional(),

  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('ap-south-1'),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_PUBLIC_URL: z.string().optional(),
  S3_FORCE_PATH_STYLE: booleanish.default(false),

  LOCAL_STORAGE_DIR: z.string().default(path.join(BACKEND_ROOT, '.runtime', 'storage')),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(200).default(10),
  ALLOWED_UPLOAD_MIME: z
    .string()
    .default(
      'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,application/pdf,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ),

  PAYMENT_MOCK_ENABLED: booleanish.default(true),
  /** `razorpay` | `mock` | `none`. `mock` is used whenever no live provider is configured. */
  PAYMENT_GATEWAY: z.enum(['razorpay', 'mock', 'none']).default('mock'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  RAZORPAY_BASE_URL: z.string().default('https://api.razorpay.com/v1'),
  /** HMAC key for the deterministic in-process provider used in dev/CI. */
  MOCK_GATEWAY_SECRET: z.string().default('colonize-mock-gateway-secret-change-me'),
  PAYMENT_WEBHOOK_SECRET: z.string().default('dev-webhook-secret'),

  /* ---- platform behaviour --------------------------------------------- */
  CORS_ORIGINS: z.string().default('*'),
  RATE_LIMIT_ENABLED: booleanish.default(true),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(600),
  SCHEDULER_ENABLED: booleanish.default(true),
  JOBS_ENABLED: booleanish.default(true),
  REALTIME_ENABLED: booleanish.default(true),
  SWAGGER_ENABLED: booleanish.default(true),
  AUDIT_ENABLED: booleanish.default(true),
  IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(86400),
  DEFAULT_TIMEZONE: z.string().default('Asia/Kolkata'),
  DEFAULT_CURRENCY: z.string().default('INR'),
  WEB_ADMIN_URL: z.string().default('http://localhost:5173'),
  WEB_SUPER_ADMIN_URL: z.string().default('http://localhost:5174'),
  MOBILE_SCHEME: z.string().default('colonize'),
  SEED_ON_START: booleanish.default(false),
  DEMO_MODE: booleanish.default(true),

  /* ---- seed / demo credentials ------------------------------------------ */
  /**
   * Credentials for the accounts the seeder creates. Defaults are deliberately well-known and
   * documented: they exist so a reviewer can log in and exercise the §80 scenario immediately.
   * Override all of them in any environment reachable from the internet — and note the seeder
   * refuses to run at all when NODE_ENV=production unless SEED_ALLOW_PRODUCTION is set.
   */
  SEED_SUPER_ADMIN_EMAIL: z.string().default('superadmin@colonize.local'),
  SEED_SUPER_ADMIN_PASSWORD: z.string().default('Colonize@Super1'),
  SEED_SOCIETY_ADMIN_EMAIL: z.string().default('admin@greenvalley.local'),
  SEED_SOCIETY_ADMIN_PASSWORD: z.string().default('GreenValley@1'),
  SEED_SOCIETY_ADMIN_PHONE: z.string().default('+919800000001'),
  SEED_DEMO_RESIDENT_PHONE: z.string().default('+919800000101'),
  SEED_GUARD_PHONE: z.string().default('+919800000901'),
  SEED_GUARD_PASSWORD: z.string().default('Guard@1234'),
  SEED_ALLOW_PRODUCTION: booleanish.default(false),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // Fail fast & loud: a mis-typed env var must never silently become a production bug.
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = result.data;

  const isProd = env.NODE_ENV === 'production';
  const insecureDefaults = [
    env.JWT_SECRET.startsWith('dev-only'),
    env.JWT_REFRESH_SECRET.startsWith('dev-only'),
    env.QR_SIGNING_SECRET.startsWith('dev-only'),
  ];
  if (isProd && insecureDefaults.some(Boolean)) {
    throw new Error(
      'Refusing to start in production with default secrets. Set JWT_SECRET, JWT_REFRESH_SECRET and QR_SIGNING_SECRET.',
    );
  }
  if (isProd && env.DB_DRIVER === 'embedded') {
    throw new Error('Refusing to run the embedded database driver in production. Set DB_DRIVER=mongo.');
  }
  if (isProd && env.EXPOSE_DEV_OTP) {
    throw new Error('Refusing to expose development OTPs in production. Set EXPOSE_DEV_OTP=false.');
  }
  if (env.STORAGE_PROVIDER === 's3' && (!env.S3_BUCKET || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY)) {
    throw new Error('STORAGE_PROVIDER=s3 requires S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY.');
  }

  return env;
}

export const env: Env = parseEnv();

export const isProd = env.NODE_ENV === 'production';
export const isDev = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';

export const corsOrigins = (): string[] | '*' => {
  const raw = env.CORS_ORIGINS.trim();
  if (raw === '*' || raw === '') return '*';
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
};

/** Database name for a society (per-tenant database isolation, §4). */
export function tenantDbName(societySlug: string): string {
  const safe = societySlug.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${env.TENANT_DB_PREFIX}${safe}`.slice(0, 60);
}
