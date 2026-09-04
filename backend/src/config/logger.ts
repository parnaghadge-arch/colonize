import pino from 'pino';
import { env, isDev } from './env.js';

/**
 * Structured logging (§67).
 *
 * Redaction is mandatory: passwords, OTPs, tokens and payment secrets must never reach a
 * log sink. `pino` applies these redaction paths to every log call made with an object
 * argument, including nested request bodies captured by `pino-http`.
 */

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.currentPassword',
  '*.newPassword',
  '*.otp',
  '*.otpHash',
  '*.accessToken',
  '*.refreshToken',
  '*.refreshTokenHash',
  '*.token',
  '*.tokenHash',
  '*.signature',
  '*.pin',
  '*.pinHash',
  '*.cardNumber',
  '*.cvv',
  '*.apiKey',
  '*.secret',
  '*.gatewaySecret',
  '*.JWT_SECRET',
  '*.S3_SECRET_KEY',
  'data.otp',
  'data.password',
  'meta.devOtp',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'colonize-api', env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  formatters: {
    level: (label) => ({ level: label }),
  },
  ...(isDev && env.PRETTY_LOGS
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,service' },
        },
      }
    : {}),
});

/** Child logger bound to a request/module context. */
export const childLogger = (bindings: Record<string, unknown>) => logger.child(bindings);

/** Log a business event (never used for secrets). */
export function logEvent(
  event: string,
  data: Record<string, unknown> = {},
  level: 'info' | 'warn' | 'error' | 'debug' = 'info',
): void {
  logger[level]({ event, ...data }, event);
}
