# Colonize — Community Management Platform

A multi-tenant SaaS platform for residential societies, apartment complexes and gated
communities (MyGate-style): residents, owners, tenants, family members, security guards,
committee members, vendors and staff — with visitor management, complaints/service requests,
maintenance billing and payments, amenity bookings, and a super-admin SaaS control plane.

**Stack:** Node 20+ / Express / TypeScript (ESM) backend, MongoDB with **database-per-society**
tenant isolation, Redis for cache/queue, React + Vite web apps, Expo (React Native) mobile apps.
No Next.js anywhere.

---

## Current status

| Area | State |
| --- | --- |
| `packages/shared` | ✅ Complete — shared types, enums, plan tiers, module keys |
| `backend` | ✅ Complete — 137 OpenAPI paths, RBAC, tenant isolation, soft deletes, audit log, transactions |
| Seed data (Green Valley Residency) | ✅ Complete — 5 towers / 20 wings / 800 units / 1500 residents / 50 staff / 10 vendors / 5 gates |
| §80 acceptance scenario | ✅ Verified end to end — `npm run e2e` → **117/117 checks, 11 scenario groups** |
| Docker + production env | ✅ Complete — `docker/Dockerfile`, `docker/docker-compose.yml`, `.env.production` |
| `apps/admin-web`, `apps/super-admin-web` | ⏳ Not started |
| `apps/resident-mobile`, `apps/security-mobile` | ⏳ Not started |
| Vitest unit / integration suites | ⏳ Not started (the E2E acceptance suite above is the current coverage) |

The backend is a fully working product surface — every endpoint listed in `/docs` is real, not stubbed.

---

## Quick start (development)

Requirements: **Node ≥ 20.11**, **npm ≥ 10**. No MongoDB or Redis needed for local development —
the backend ships an embedded driver that persists to `backend/.runtime/`.

```bash
git clone <repo> && cd colonize
npm install                      # installs all workspaces

cd backend
npm run dev                      # API on http://localhost:4000
```

Then open:

- **Swagger UI** → http://localhost:4000/docs/
- **OpenAPI 3.1 JSON** → http://localhost:4000/docs/openapi.json
- **Health** → `GET /api/health` (liveness) · `GET /api/health/ready` (readiness)
- **Realtime** → Socket.IO namespace `/realtime`

Seed the demo society (takes ~70s the first time; idempotent afterwards):

```bash
npm run seed                     # add --force to re-seed from scratch
```

---

## Demo logins

Produced by the seed. All credentials come from `SEED_*` environment variables — nothing is
hard-coded in the application.

| Role | Identifier | Password |
| --- | --- | --- |
| Super admin (platform) | `superadmin@colonize.local` | `Colonize@Super1` |
| Society admin (Green Valley) | `admin@greenvalley.local` | `GreenValley@1` |
| Demo resident | `+919800000101` | `Resident@123` (or OTP) |
| Demo gate guard | `+919800000901` | `Guard@1234` |

**OTP login** — `POST /api/auth/send-otp` with `{ phone, channel: "CONSOLE", purpose: "LOGIN" }`,
then `POST /api/auth/verify-otp`. In development the generated code is returned in the response
as `meta.devOtp` (`EXPOSE_DEV_OTP=true`); in production it is delivered over SMS/WhatsApp/email only.

> ⚠️ OTP endpoints enforce a per-number cooldown and a one-hour lockout after repeated failures.
> Use different numbers from the seeded pool rather than hammering one.

**Password login** — `POST /api/auth/login` with `{ identifier, password }` (identifier is an
email or phone). Super admin uses `POST /api/auth/platform/login`.

---

## Acceptance suite (§80 scenario)

The spec's section 80 defines the end-to-end acceptance scenario. It is implemented as a
runnable suite that drives the real HTTP API with no mocks:

```bash
cd backend
npm run e2e
```

It covers, in order:

1. Platform boot, health and OpenAPI contract
2. Super-admin onboarding of a society (provisions a **separate database**)
3. Society structure: buildings → wings → floors → units → parking slots
4. Resident signup / OTP login / family members / vehicles
5. Visitor pre-approval → QR pass → **gate scan → entry → exit**
6. Complaint → vendor assignment → work order → resolution → resident verification
7. Maintenance bill generation → payment → ledger entries → PDF invoice/receipt
8. Amenity availability → booking → payment → auto-confirm → entry QR → gate scan
9. Per-society data isolation (a token from society A cannot read society B; → 403 `TENANT_MISMATCH`)
10. Cross-cutting guarantees (structured 404s, validation errors, NoSQL-injection rejection,
    correlation ids, security headers, OpenAPI derived from the real Zod validators)

Result: **PASS — 117/117 checks green across 11 scenario groups.**

---

## API surface

All routes are mounted under the `/api` prefix and documented in OpenAPI 3.1.

| Group | Paths | What it does |
| --- | --- | --- |
| `/auth` | 16 | OTP, password login, refresh, logout, platform (super-admin) login |
| `/platform` | 11 | Super-admin: societies, onboarding, subscriptions, plans, tenants |
| `/visitors` | 11 | Visitor pre-approval, passes, QR, history |
| `/gate` | 4 | **Gate console**: `POST /gate/scan`, `GET /gate/queue` |
| `/guards` | 5 | Guard shifts, patrols, guard console |
| `/bills` | 9 | Bill generation, resident `GET /bills/mine`, invoice PDF |
| `/payments` | 9 | Payment intent → verify → receipt PDF, resident history |
| `/accounting` | 7 | Journal entries, ledger, trial balance |
| `/incomes`, `/expenses` | 4 | Income and expense records |
| `/complaints` | 8 | Complaints, assignment, status transitions, comments, verification |
| `/work-orders`, `/service-requests` | 4 | Vendor work orders and resident service requests |
| `/vendors`, `/staff` | 4 | Vendor and staff directory |
| `/amenities` | 2 | Amenity catalogue + `GET /amenities/:id/availability?date=YYYY-MM-DD` |
| `/amenity-bookings` | 8 | Booking, payment linkage, entry QR |
| `/structure` | 5 | `GET /structure/tree`, `/structure/counts` |
| `/buildings`, `/wings`, `/floors`, `/units` | 9 | Hierarchy CRUD |
| `/residents`, `/unit-members`, `/family-members` | 6 | People CRUD |
| `/vehicles`, `/parking-areas`, `/parking-slots` | 8 | Vehicles and parking allocation |
| `/gates` | 2 | Gate/lane configuration |
| `/whoami` | 1 | Session context: user, society, membership, permissions, enabled modules, client hints |
| `/meta`, `/health`, `/webhooks` | 4 | Metadata, health probes, payment gateway webhooks |

### Authorization model

- **Never trust client-supplied identity.** Roles and permissions are resolved server-side from
  the token plus the tenant's membership records; `x-society-id` is verified against the token and
  a mismatch returns `403 TENANT_MISMATCH`.
- Middleware chain: `authenticate({ clientScopes })` → `requireTenantContext` →
  `requirePermission(...)` → `requireModule(key)`.
- **Module gating by plan tier** — `FREE` (3 modules), `BASIC` (6), `STANDARD` (17),
  `PREMIUM`/`ENTERPRISE` (all 24). `GET /whoami` returns `enabledModules` so clients can hide
  what the society has not subscribed to.
- Records are **unit-scoped** where applicable: residents see their own unit's data, not the
  whole society's.
- All writes go through an **audit log**; financial and visitor flows run inside **transactions**.
- Deletes are **soft deletes** — no hard removal of society data.

---

## Data architecture

```
colonize_platform          ← super-admin / SaaS data
  societies, subscription_plans, platform_users, tenants …

colonize_s_<societyId>     ← ONE DATABASE PER SOCIETY
  units, residents, visitors, bills, payments, complaints, …
```

Onboarding a society provisions its own database and records the name on the platform society
document. All tenant queries go through a scope-aware schema registry
(`getCollectionForScope`) and a database manager (`databases.forSocietyId(id, { provision })`,
`.platform()`, `.tenantDb(id)`, `.flush()`, `.closeAll()`).

Two interchangeable drivers sit behind one interface:

| `DB_DRIVER` | Use | Notes |
| --- | --- | --- |
| `embedded` | local development, CI, previews | file-backed store in `backend/.runtime/data`; zero external services |
| `mongo` | staging, production | real MongoDB; **must be a replica set** for transactions |

The `Collection<T>` interface is identical for both: `create`, `findOne`, `find`, `findById`,
`countDocuments`, `updateOne`, `updateMany`, `aggregate`, `findOneAndUpdate`, `findByIdAndUpdate`.
Object ids are generated by `newId(collectionName)` with a readable prefix (`soc_`, `usr_`, `inv_`, …).

Reference numbers come from per-society counters: `nextReference(db, societyId, kind, year?, pad?)`
for `INV`, `RCP`, `CMP`, `WO`, `SRQ`, `JE`, `BKG`, `TCK`, `EXP`.

---

## Configuration

`backend/src/config/env.ts` holds the single Zod-validated config object (~95 variables).
Loading order: `.env` → `.env.<NODE_ENV>`, searched in `backend/` then the repo root.
Anything missing falls back to a typed default, and an invalid value fails fast at boot.

| File | Purpose |
| --- | --- |
| `backend/.env.example` | Documented template — copy to `.env` and fill in. All optional vars are commented out so copying cannot blank a default. |
| `backend/.env.development` | Development profile: embedded driver, dev OTP, permissive CORS. Matches the built-in defaults. |
| `backend/.env.production` | Production profile: Mongo + Redis, dev OTP disabled, demo mode off, placeholder secrets. |

Secrets are **never** committed. `.gitignore` covers `.env*` and `backend/.runtime/`.

**Production refuses to boot with default secrets.** Before deploying, replace every
`REPLACE_ME_…` value:

```bash
openssl rand -hex 32      # run once per secret
```

---

## Production deployment (Docker)

```bash
npm run docker:up          # docker compose -f docker/docker-compose.yml up -d --build
npm run docker:down
```

The compose file starts three services:

- **`mongo`** — `mongo:7` initialised as a single-node replica set (`rs0`). This is required,
  not optional: financial and visitor flows use transactions. The healthcheck self-initiates
  the replica set before the API is allowed to start.
- **`redis`** — `redis:7-alpine` with AOF persistence, for cache and the job queue.
- **`api`** — the built backend, served by `dist/server.js`. It reads
  `backend/.env.production` via `env_file`, then overrides the connection strings with
  Docker service discovery (`mongodb://mongo:27017/?replicaSet=rs0`, `redis://redis:6379`).
  Starts only after both dependencies report healthy.

One-shot seeder, under the `tools` profile so it never runs on a normal `up`:

```bash
docker compose -f docker/docker-compose.yml --profile tools run --rm seed
```

`docker/Dockerfile` is a multi-stage build: install deps → compile TypeScript → prune dev
dependencies → copy into a slim, **non-root** (uid 1001) runtime image with a `node-fetch`
healthcheck against `/api/health/ready`. PDFs use built-in Helvetica fonts, so no font assets
are baked in. Volumes: `mongo-data`, `redis-data`, `api-runtime`.

---

## Repository layout

```
colonize/
├── backend/
│   ├── src/
│   │   ├── config/          env.ts (Zod), httpLogger.ts
│   │   ├── db/              drivers, manager, scope-aware registry, migrations, seed/
│   │   ├── middleware/      authenticate, validate, tenant context, permissions, modules, CSRF
│   │   ├── modules/         auth, structure, societies, residents, visitors, amenities,
│   │   │                    gates, helpdesk, finance, platform, _shared/crud.ts …
│   │   ├── services/        receipts & invoices (PDF), notifications, payments, counters
│   │   ├── realtime/        Socket.IO gateway (/realtime)
│   │   ├── jobs/            scheduler (node-cron) + queue workers
│   │   ├── docs/            openapi.ts, swagger.ts
│   │   ├── app.ts, server.ts
│   ├── scripts/e2e-acceptance.mjs     ← the §80 acceptance suite
│   └── tests/                         unit / integration / e2e (vitest)
├── packages/shared/         shared types, enums, PLAN_TIERS, DEFAULT_TIER_MODULES
├── apps/                    admin-web, super-admin-web, resident-mobile, security-mobile
├── docker/                  Dockerfile, docker-compose.yml
├── .dockerignore
└── package.json             npm workspaces: packages/*, backend, apps/*
```

### Useful commands

```bash
npm run dev -w backend          # API with tsx watch
npm run seed -w backend         # seed / re-seed Green Valley Residency
npm run e2e -w backend          # §80 acceptance suite (117 checks)
npm run build                   # shared → backend → web apps
npm run typecheck               # tsc --noEmit across all workspaces
npm run test -w backend         # vitest
npm run db:provision -w backend # provision a single society database
```

> Always run TypeScript through the workspace script (`npm run build -w backend`). A bare
> `npx tsc` picks up a different configuration and produces misleading errors.

---

## Design rules

These are enforced by the codebase, not just documented:

1. **Never use Next.js.** Web apps are React + Vite; mobile apps are Expo/React Native.
2. **Never hard-code society data or business rules.** Fees, slots, grace periods, plan tiers and
   permissions are all per-tenant configuration.
3. **Never trust client-supplied ids or roles.** Every id is re-verified against the tenant
   database and the caller's membership before use.
4. **No fake functionality.** If a button exists in a client, the endpoint behind it is real.
5. **Strict per-society isolation** at the database level, plus tenant checks in middleware.
6. **Soft deletes and audit logs** on society data; **transactions** on money and gate movements.
