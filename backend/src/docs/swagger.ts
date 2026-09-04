/**
 * Swagger UI + machine-readable OpenAPI document (§75).
 *
 * Two things are exposed:
 *   GET  {SWAGGER_PATH}              → interactive Swagger UI
 *   GET  {SWAGGER_PATH}/openapi.json → the raw document (for codegen, Postman, contract tests)
 *
 * The document is built from the live Zod schemas at mount time, so it cannot drift from the
 * validation the routers actually apply.
 */
import type { Express, Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { buildOpenApiDocument } from './openapi.js';

/** Built once per process; the schema surface does not change at runtime. */
let cached: Record<string, unknown> | null = null;

export function openApiDocument(): Record<string, unknown> {
  if (!cached) cached = buildOpenApiDocument();
  return cached;
}

export function mountSwagger(app: Express): void {
  if (!env.SWAGGER_ENABLED) {
    logger.info('swagger disabled (SWAGGER_ENABLED=false)');
    return;
  }

  const spec = openApiDocument();
  const base = env.SWAGGER_PATH.replace(/\/+$/, '') || '/docs';
  const pathCount = Object.keys((spec.paths as Record<string, unknown>) ?? {}).length;

  // Raw document. Served without auth so clients can generate types before they can log in;
  // it describes the contract, not any tenant's data.
  app.get(`${base}/openapi.json`, (_req: Request, res: Response) => {
    res.type('application/json').json(spec);
  });

  // No manual `/docs` → `/docs/` redirect here: Express matches `app.get('/docs')` against
  // `/docs/` too (non-strict routing), so such a handler redirects to itself forever.
  // `app.use` below already accepts both the bare and trailing-slash forms.
  app.use(
    base,
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      explorer: true,
      customSiteTitle: 'Colonize API',
      customCss: '.swagger-ui .topbar { display: none } .swagger-ui { font-family: system-ui, sans-serif }',
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
        docExpansion: 'none',
        filter: true,
        tryItOutEnabled: true,
        tagsSorter: 'alpha',
        operationsSorter: 'alpha',
      },
    }),
  );

  logger.info({ path: base, paths: pathCount }, 'swagger ui mounted');
}
