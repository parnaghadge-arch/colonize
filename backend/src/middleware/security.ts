import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { corsOrigins, env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { RATE_LIMIT_BUCKETS } from '@colonize/shared';
import { fail } from '../utils/response.js';

/**
 * Transport & input security (§51).
 *
 *  • secure headers via helmet (HSTS, no sniffing, frame denial, referrer policy)
 *  • CORS driven by CORS_ORIGINS, credentials allowed for the cookie-based web consoles
 *  • request-id on every response for support correlation
 *  • NoSQL operator injection defence: keys starting with `$` or containing `.` are stripped
 *    from body/query/params before any handler sees them (this is the protection that
 *    `express-mongo-sanitize` would provide, reimplemented because Express 5 makes
 *    `req.query` a getter and the package mutates it)
 *  • CSRF: double-submit cookie check for cookie-authenticated state-changing web requests
 *  • rate limiting per bucket (auth, OTP, generic API, writes, uploads, emergency, export)
 */

export function requestId(): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && /^[\w.-]{6,80}$/.test(incoming)
      ? incoming
      : crypto.randomUUID();
    (req as Request & { id?: string }).id = id;
    req.headers['x-request-id'] = id;
    res.setHeader('X-Request-Id', id);
    next();
  };
}

export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        // Swagger UI needs inline styles/scripts; it is only mounted when SWAGGER_ENABLED.
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: env.SWAGGER_ENABLED ? ["'self'", "'unsafe-inline'"] : ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    hsts: env.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
  });
}

export function corsPolicy() {
  const origin = corsOrigins();
  return cors({
    origin: origin === '*' ? true : origin,
    credentials: true,
    exposedHeaders: ['X-Request-Id', 'Content-Disposition', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-Id',
      'X-Society-Id',
      'X-Device-Id',
      'X-Platform',
      'X-App-Version',
      'X-Idempotency-Key',
      'X-CSRF-Token',
      'X-Access-Token',
    ],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 86400,
  });
}

/** Strip Mongo operators / dotted keys from untrusted input. */
export function sanitiseValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return undefined;
  if (Array.isArray(value)) return value.map((v) => sanitiseValue(v, depth + 1));
  if (value instanceof Date) return value;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (key.startsWith('$')) continue; // drop operator injection
      if (key.includes('.') && key !== '_id') continue; // drop path injection
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      out[key] = sanitiseValue(val, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') {
    // Neutralise the most common XSS payloads in stored text without mangling normal prose.
    return value.replace(/<\s*\/?\s*(script|iframe|object|embed|link|meta)\b[^>]*>/gi, '');
  }
  return value;
}

export function sanitiseInput(): (req: Request, _res: Response, next: NextFunction) => void {
  return (req, _res, next) => {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      Object.defineProperty(req, 'body', {
        value: sanitiseValue(req.body),
        writable: true,
        configurable: true,
      });
    }
    Object.defineProperty(req, 'query', {
      value: sanitiseValue(req.query) ?? {},
      writable: true,
      configurable: true,
    });
    Object.defineProperty(req, 'params', {
      value: sanitiseValue(req.params) ?? {},
      writable: true,
      configurable: true,
    });
    next();
  };
}

/**
 * CSRF protection for cookie-authenticated web sessions.
 * Mobile apps use bearer tokens (not cookies) and are therefore exempt.
 * The web consoles must send `X-CSRF-Token` equal to the `csrf_token` cookie value.
 */
export function csrfProtection(): (req: Request, res: Response, next: NextFunction) => void {
  const safe = new Set(['GET', 'HEAD', 'OPTIONS']);
  return (req, res, next) => {
    if (safe.has(req.method)) return next();
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
    // Bearer-token requests are not subject to CSRF.
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) return next();
    if (!cookies.access_token) return next();

    const cookieToken = cookies.csrf_token;
    const headerToken = req.headers['x-csrf-token'];
    if (!cookieToken || typeof headerToken !== 'string' || cookieToken !== headerToken) {
      return fail(res, 403, 'CSRF token missing or invalid', [], 'CSRF_FAILED');
    }
    return next();
  };
}

/** Issue the CSRF cookie pair on every response that does not have one yet. */
export function csrfCookie(): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
    if (!cookies.csrf_token) {
      res.cookie('csrf_token', crypto.randomBytes(24).toString('hex'), {
        httpOnly: false, // the SPA must be able to read it and echo it in a header
        sameSite: 'lax',
        secure: env.NODE_ENV === 'production',
        maxAge: 86400_000,
      });
    }
    next();
  };
}

function limiterResponse(res: Response, message: string): void {
  res.status(429).json({ success: false, message, code: 'RATE_LIMITED' });
}

function buildLimiter(name: string, windowMs: number, max: number, message: string) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => !env.RATE_LIMIT_ENABLED || env.NODE_ENV === 'test',
    keyGenerator: (req) => {
      // Prefer the authenticated user so one noisy client cannot lock out a shared NAT IP.
      const userId = req.ctx?.principal?.userId;
      if (userId) return `${name}:user:${userId}`;
      return `${name}:ip:${ipKeyGenerator(req.ip ?? '0.0.0.0')}`;
    },
    handler: (req, res) => {
      logger.warn({ limit: name, ip: req.ip, user: req.ctx?.principal?.userId }, 'rate limit exceeded');
      limiterResponse(res, message);
    },
  });
}

export const rateLimiters = {
  /** Generic API traffic. */
  api: buildLimiter('api', env.RATE_LIMIT_WINDOW_MS, env.RATE_LIMIT_MAX, 'Too many requests. Please slow down.'),
  /** Any state-changing endpoint. */
  write: buildLimiter('write', RATE_LIMIT_BUCKETS.WRITE.windowMs, RATE_LIMIT_BUCKETS.WRITE.max, 'Too many write requests. Please slow down.'),
  /** Login endpoints (password + OTP verify). */
  auth: buildLimiter('auth', RATE_LIMIT_BUCKETS.AUTH.windowMs, RATE_LIMIT_BUCKETS.AUTH.max, 'Too many sign-in attempts. Please try again later.'),
  /** OTP sending — the most abused endpoint on any platform. */
  otpSend: buildLimiter('otp-send', RATE_LIMIT_BUCKETS.OTP_SEND.windowMs, RATE_LIMIT_BUCKETS.OTP_SEND.max, 'Too many OTP requests. Please wait a minute.'),
  otpVerify: buildLimiter('otp-verify', RATE_LIMIT_BUCKETS.OTP_VERIFY.windowMs, RATE_LIMIT_BUCKETS.OTP_VERIFY.max, 'Too many OTP attempts. Please wait a minute.'),
  upload: buildLimiter('upload', RATE_LIMIT_BUCKETS.UPLOAD.windowMs, RATE_LIMIT_BUCKETS.UPLOAD.max, 'Too many uploads. Please wait a minute.'),
  emergency: buildLimiter('emergency', RATE_LIMIT_BUCKETS.EMERGENCY.windowMs, RATE_LIMIT_BUCKETS.EMERGENCY.max, 'Too many emergency alerts. If this is a real emergency, call your society security desk.'),
  export: buildLimiter('export', RATE_LIMIT_BUCKETS.EXPORT.windowMs, RATE_LIMIT_BUCKETS.EXPORT.max, 'Too many export requests. Please wait a few minutes.'),
  /** Webhooks come from providers, so they are keyed on the provider secret check instead. */
  webhook: buildLimiter('webhook', 60_000, 600, 'Too many webhook calls.'),
};

export function commonMiddleware() {
  return [
    requestId(),
    securityHeaders(),
    corsPolicy(),
    compression(),
    cookieParser(),
    csrfCookie(),
    sanitiseInput(),
  ];
}
