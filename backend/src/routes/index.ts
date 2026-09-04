import { Router } from 'express';
import { z } from 'zod';
import authRouter from '../modules/auth/authRouter.js';
import societiesRouter from '../modules/societies/societiesRouter.js';
import { structureRouter, buildingsRouter, wingsRouter, floorsRouter, unitsRouter } from '../modules/structure/structureRouter.js';
import {
  residentsRouter,
  familyMembersRouter,
  vehiclesRouter,
  parkingAreasRouter,
  parkingSlotsRouter,
  unitMembersRouter,
} from '../modules/residents/residentsRouter.js';
import { visitorsRouter, gateConsoleRouter } from '../modules/visitors/visitorsRouter.js';
import { gatesRouter, guardsRouter } from '../modules/gates/gatesRouter.js';
import {
  complaintsRouter,
  workOrdersRouter,
  serviceRequestsRouter,
  vendorsRouter,
  staffRouter,
} from '../modules/helpdesk/helpdeskRouter.js';
import { amenitiesRouter, amenityBookingsRouter } from '../modules/amenities/amenitiesRouter.js';
import {
  billsRouter,
  paymentsRouter,
  accountingRouter,
  expensesRouter,
  incomesRouter,
} from '../modules/finance/financeRouter.js';
import { authenticate, requireTenantContext } from '../middleware/authenticate.js';
import { asyncHandler } from '../middleware/errors.js';
import { validate } from '../middleware/validate.js';
import { ok } from '../utils/response.js';
import { queueStats } from '../jobs/queue.js';
import { connectedClients } from '../realtime/gateway.js';
import { databases } from '../db/manager.js';
import { env } from '../config/env.js';

/**
 * The whole tenant + platform API surface, mounted under `env.API_PREFIX` (default `/api`).
 *
 * Route ownership follows the spec's own vocabulary so the mobile and web clients can be
 * written against the documented paths (§75):
 *
 *   /auth                  sign-in, OTP, tokens, profile            (§7, §52)
 *   /platform/societies    super-admin society management           (§41, §45, §46)
 *   /structure             the hierarchy as a tree + CSV import     (§9, §10)
 *   /buildings /wings /floors /units                                (§9, §10)
 *   /residents /family-members /unit-members                        (§11, §12)
 *   /vehicles /parking-areas /parking-slots                         (§13, §19)
 *   /visitors              pre-approval, passes, lifecycle          (§16, §17, §18)
 *   /gate                  the guard's scan + queue console         (§19, §57)
 *   /gates /guards         gate config and shift rostering          (§20, §56)
 *   /complaints /work-orders /service-requests                      (§23, §24, §31)
 *   /vendors /staff                                                 (§25, §26, §54)
 *   /amenities /amenity-bookings                                    (§22, §57)
 *   /bills /payments /accounting /expenses /incomes                 (§27–§29, §43, §59)
 *
 * Gateway webhooks are NOT mounted here: they need the raw request bytes for HMAC
 * verification, so `app.ts` mounts them before the JSON body parser.
 */
export const apiRouter: Router = Router();

/* ---------------------------------- meta ----------------------------------- */

/**
 * Liveness and readiness for the container orchestrator (§71).
 *
 * `/health` answers without touching any datastore so a restarted pod is not killed while the
 * database is still warming up; `/health/ready` proves the platform database is reachable,
 * which is the condition that actually matters before traffic is routed here.
 */
apiRouter.get('/health', (_req, res) => {
  res.status(200).json({
    success: true,
    message: 'OK',
    data: {
      status: 'ok',
      service: 'colonize-api',
      version: '1.0.0',
      environment: env.NODE_ENV,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    },
  });
});

apiRouter.get(
  '/health/ready',
  asyncHandler(async (_req, res) => {
    // A real round-trip: an unreachable platform database means this instance cannot serve
    // any tenant, so it must report not-ready and be pulled from the load balancer.
    const platform = await databases.platform();
    const societies = await platform.collection('societies').countDocuments({});
    res.status(200).json({
      success: true,
      message: 'Ready',
      data: {
        status: 'ready',
        driver: env.DB_DRIVER,
        societies,
        queue: queueStats(),
        realtimeClients: await connectedClients(),
        timestamp: new Date().toISOString(),
      },
    });
  }),
);

/**
 * What this deployment can do, so a client can feature-detect instead of hard-coding (§42).
 * Modules are subscription-gated per society, so the authenticated answer reflects that
 * society's plan rather than the platform's full catalogue.
 */
apiRouter.get(
  '/meta',
  authenticate({ optional: true }),
  asyncHandler(async (req, res) => {
    const ctx = (req as unknown as { society?: { id: string; name: string } }).society;
    let enabledModules: string[] = [];
    let society = null;
    if (ctx?.id) {
      const c = requireTenantContext(req);
      enabledModules = Array.from(c.enabledModules).sort();
      society = { id: c.society.id, name: c.society.name, slug: c.society.slug, timezone: c.society.timezone, currency: c.society.currency };
    }
    return ok(res, {
      apiPrefix: env.API_PREFIX,
      version: '1.0.0',
      society,
      enabledModules,
      realtime: { enabled: env.REALTIME_ENABLED, path: '/realtime' },
      demoMode: env.DEMO_MODE,
      endpoints: {
        auth: '/auth',
        platform: '/platform/societies',
        structure: '/structure',
        residents: '/residents',
        visitors: '/visitors',
        gate: '/gate',
        complaints: '/complaints',
        amenities: '/amenities',
        bills: '/bills',
        payments: '/payments',
        accounting: '/accounting',
      },
    }, 'Platform metadata');
  }),
);

/** Echo the caller's identity and resolved permissions — useful when wiring a new client. */
apiRouter.get(
  '/whoami',
  authenticate(),
  validate(z.object({}), 'query'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    return ok(res, {
      user: {
        id: c.principal.userId,
        fullName: c.principal.fullName,
        email: c.principal.email,
        phone: c.principal.phone,
        avatarUrl: c.principal.avatarUrl,
        roles: c.principal.roles,
        scope: c.principal.scope,
      },
      society: c.society
        ? { id: c.society.id, name: c.society.name, slug: c.society.slug, timezone: c.society.timezone, currency: c.society.currency }
        : null,
      membership: {
        unitIds: c.membership.unitIds,
        primaryUnitId: c.membership.primaryUnitId,
        residentId: c.membership.residentId,
        staffId: c.membership.staffId,
        vendorId: c.membership.vendorId,
        gateIds: c.membership.gateIds,
      },
      permissions: Array.from(c.principal.permissions).sort(),
      enabledModules: Array.from(c.enabledModules).sort(),
      clientHints: {
        isResidentScope: c.principal.isResidentScope,
        isStaffScope: c.principal.isStaffScope,
        isSecurityScope: c.principal.isSecurityScope,
        isVendorScope: c.principal.isVendorScope,
        isPlatformUser: c.principal.isPlatformUser,
      },
    }, 'Authenticated');
  }),
);

/* ----------------------------------- auth ----------------------------------- */

apiRouter.use('/auth', authRouter);

/* --------------------------- super-admin (platform) -------------------------- */

apiRouter.use('/platform/societies', societiesRouter);

/* -------------------------------- structure --------------------------------- */

apiRouter.use('/structure', structureRouter);
apiRouter.use('/buildings', buildingsRouter);
apiRouter.use('/wings', wingsRouter);
apiRouter.use('/floors', floorsRouter);
apiRouter.use('/units', unitsRouter);

/* -------------------------------- residents --------------------------------- */

apiRouter.use('/residents', residentsRouter);
apiRouter.use('/family-members', familyMembersRouter);
apiRouter.use('/unit-members', unitMembersRouter);
apiRouter.use('/vehicles', vehiclesRouter);
apiRouter.use('/parking-areas', parkingAreasRouter);
apiRouter.use('/parking-slots', parkingSlotsRouter);

/* -------------------------------- visitors ---------------------------------- */

apiRouter.use('/visitors', visitorsRouter);
// The guard's console: one camera endpoint for every pass kind, plus the live gate queue.
apiRouter.use('/gate', gateConsoleRouter);

/* ------------------------------ gates & guards ------------------------------- */

apiRouter.use('/gates', gatesRouter);
apiRouter.use('/guards', guardsRouter);

/* -------------------------------- help desk --------------------------------- */

apiRouter.use('/complaints', complaintsRouter);
apiRouter.use('/work-orders', workOrdersRouter);
apiRouter.use('/service-requests', serviceRequestsRouter);
apiRouter.use('/vendors', vendorsRouter);
apiRouter.use('/staff', staffRouter);

/* -------------------------------- amenities --------------------------------- */

apiRouter.use('/amenities', amenitiesRouter);
apiRouter.use('/amenity-bookings', amenityBookingsRouter);

/* --------------------------------- finance ---------------------------------- */

apiRouter.use('/bills', billsRouter);
apiRouter.use('/payments', paymentsRouter);
apiRouter.use('/accounting', accountingRouter);
apiRouter.use('/expenses', expensesRouter);
apiRouter.use('/incomes', incomesRouter);

export default apiRouter;
