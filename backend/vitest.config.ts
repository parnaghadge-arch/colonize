import path from 'node:path';
import os from 'node:os';
import { defineConfig } from 'vitest/config';

/**
 * Test configuration.
 *
 *  • `tests/unit`        — pure logic: ids, crypto, QR tokens, serialisation, CSV, money, dates.
 *                          No database, no HTTP, no timers. Runs in about a second.
 *  • `tests/integration` — the real embedded driver: CRUD, counters, per-society isolation.
 *                          Writes to a throwaway directory, never to backend/.runtime.
 *
 * The §80 end-to-end acceptance suite lives outside vitest (`scripts/e2e-acceptance.mjs`,
 * `npm run e2e`) because it drives the live HTTP API across every module.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      // Keep integration tests off the developer's real runtime data.
      EMBEDDED_DATA_DIR: path.join(os.tmpdir(), `colonize-vitest-${process.pid}`),
      EMBEDDED_PERSIST: 'false',
      EXPOSE_DEV_OTP: 'true',
      PAYMENT_GATEWAY: 'mock',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/docs/**', 'src/db/scripts/**'],
    },
  },
});
