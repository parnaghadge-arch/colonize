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
| `backend` | ✅ Complete — 187 OpenAPI paths (100% of implemented routes documented), RBAC, tenant isolation, soft deletes, audit log, transactions |
| Seed data (Green Valley Residency) | ✅ Complete — 5 towers / 20 wings / 800 units / 1500 residents / 50 staff / 10 vendors / 5 gates |
| §80 acceptance scenario | ✅ Verified end to end — `npm run e2e` → **117/117 checks, 11 scenario groups** |
| Docker + production env | ✅ Complete — `docker/Dockerfile`, `docker/docker-compose.yml`, `.env.production` |
| `apps/admin-web`, `apps/super-admin-web` | ✅ Complete — React + Vite consoles (society office / platform) |
| `apps/resident-mobile`, `apps/security-mobile` | ✅ Complete — Expo (React Native) resident + guard apps |
| Vitest unit / integration suites | ✅ Complete — 15 files / 370 tests (`npm test -w backend`) |
| Mobile contract check | ✅ Complete — `npm run contract -w backend` (36 checks) verifies every endpoint the mobile apps call, at any hour of the day |
| CI (GitHub Actions) | ✅ Complete — `.github/workflows/ci.yml`: build → typecheck → unit tests → seed → live e2e → mobile contract on every push/PR |

The backend is a fully working product surface — every endpoint listed in `/docs` is real, not stubbed.

---

## Running the complete project, step by step

Everything runs locally with **Node ≥ 20.11** and **npm ≥ 10** — no MongoDB or Redis: the
backend ships an embedded driver that persists to `backend/.runtime/`.

The order matters: **install → build shared → seed → start the API → start the clients**.
The seed must run *before* the API starts (see step 3).

### Step 1 — Install

```bash
git clone <repo> && cd colonize
npm install
```

Installs every workspace in one go: `packages/shared`, `backend`, and all four apps.

### Step 2 — Build the shared package

```bash
npm run build -w @colonize/shared
```

The seeder and the apps import the built `dist/`, so this must exist before steps 3–4.
(`npm run dev -w backend` also rebuilds it via its `predev`, but the seed needs it first.)

### Step 3 — Seed the demo society (BEFORE starting the API)

```bash
npm run seed -w backend              # ≈ 70 s the first time
npm run seed -w backend -- --force   # wipe and re-seed from scratch
```

Creates the platform, **Green Valley Residency** (5 towers / 20 wings / 800 units / 1500
residents / 50 staff / 10 vendors / 5 gates) and all demo accounts under `backend/.runtime/`.
The seed is idempotent — it refuses to run on top of an existing society unless `--force` is
given.

> ⚠️ **Why before the API:** a running API keeps tenant database handles in memory; seeding
> while it runs leaves it pointing at the old state, so logins fail with 401 until a restart.
> If the API is already up, stop it, seed, then start it again.

### Step 4 — Start the API

```bash
npm run dev -w backend               # API on http://localhost:4000
```

Verify it is alive:

- **Health** → `GET /api/health` (liveness) · `GET /api/health/ready` (readiness)
- **Swagger UI** → http://localhost:4000/docs/
- **OpenAPI 3.1 JSON** → http://localhost:4000/docs/openapi.json
- **Realtime** → Socket.IO namespace `/realtime`

### Step 5 — Start the web consoles (optional, separate terminals)

```bash
npm run dev:admin                    # society office console  → http://localhost:5173
npm run dev:super                    # platform console        → http://localhost:5174
```

Or run the API **and** both consoles in one terminal: `npm run dev` at the repo root.
Both consoles proxy `/api` to the backend, so no CORS setup or environment variables are
needed.

### Step 6 — Start the mobile apps

**Web preview (no device needed)** — run from the repo root:

```bash
npm run dev:resident                 # Expo dev server → open http://localhost:8081 in a browser
npm run dev:security                 # second terminal; its web preview is on :8082
```

**Static export** (for hosting the web build):

```bash
npm run export:web -w @colonize/resident-mobile    # → apps/resident-mobile/dist
npm run export:web -w @colonize/security-mobile    # → apps/security-mobile/dist
```

**On a device / simulator** — after `npm run dev:resident`, press `a` (Android), `i` (iOS)
or `n` (Expo Go) in the Expo terminal.

**⚠️ "Project is incompatible with this version of Expo Go"** — if your phone's Expo Go is
a different SDK than this project (SDK 54), Expo Go refuses to load the bundle. The App Store
only ever carries the *latest* Expo Go (currently SDK 57), so on a physical iOS device an
SDK-54 project can never open in Expo Go. Three ways to run this app on a device:

1. **Dev build — recommended, works on any device, ignores Expo Go entirely.** Both apps
   ship `expo-dev-client`, so a normal build *is* a native app (with a dev menu) that pairs
   with `expo start` like Expo Go does:
   ```bash
   # locally (needs Android Studio / Xcode):
   npm run android -w @colonize/security-mobile    # builds & installs a dev build
   npm run ios -w @colonize/resident-mobile        # iOS: macOS only
   # or in the cloud (needs a free EAS account — `npx eas login` first):
   cd apps/security-mobile && npx eas build --profile development --platform android   # → APK
   cd apps/resident-mobile && npx eas build --profile development --platform android   # → APK
   ```
   Then install the APK/IPA on the device, run `npm run dev -w <app>` on your machine, and
   open the app — it connects to the dev server exactly like Expo Go would.
2. **Android only: install the Expo Go build that matches SDK 54.** Older Expo Go versions
   can be sideloaded on Android: <https://expo.dev/go?sdkVersion=54&platform=android>, then
   scan the `expo start` QR as usual.
3. **iOS simulator:** install Expo Go for SDK 54 into the simulator
   (<https://expo.dev/go?sdkVersion=54&platform=ios&device=false>) and press `i`.

**API base URL** — each app resolves its backend in this order:

1. the override stored in the app's secure store (the "API server" field on the login screen),
2. `EXPO_PUBLIC_API_URL` from a `.env` file inside the app folder (inlined at bundle time),
3. a platform default — Android emulator `http://10.0.2.2:4000/api`,
   iOS simulator / web `http://localhost:4000/api`.

The defaults work for local development out of the box. If the API runs on another host
(e.g. a tablet on your LAN), create `apps/<app>/.env` with
`EXPO_PUBLIC_API_URL=http://<host>:4000/api` and restart the app.

### Step 7 — Log in and check each surface

Use the [demo logins](#demo-logins) below:

- **Resident app** — dashboard (bills, complaints, bookings), pay a bill, raise a complaint,
  book an amenity and pay the slot fee, pre-approve a visitor and share the QR pass,
  cancel a planned visit.
- **Security app** — log into a shift at a gate, approve/decline the visitor queue, scan
  entry/exit QR passes, register walk-in guests (live unit search), manual check-in/out,
  watch the on-duty board.
- **Society console (admin-web)** — full office surface: structure, residents, billing,
  helpdesk, amenities, vendors, staff.
- **Platform console (super-admin-web)** — the SaaS control plane: societies, subscriptions,
  plans.

### Step 8 — Run the test suites

With the API running (steps 3–4 done):

```bash
npm test -w backend                                  # vitest: 15 files / 370 tests
npm run e2e -w backend                               # §80 acceptance scenario: 117/117 checks
node backend/scripts/mobile-contract-check.mjs       # every endpoint the mobile apps call
npm run typecheck                                    # tsc --noEmit across all workspaces
```

---

## Building the mobile apps for Android and iOS

Both mobile apps (`apps/resident-mobile`, `apps/security-mobile`) are Expo SDK 54 /
React Native 0.81.6 (new architecture) and are production-ready for both stores.
They share one backend; the production API URL is injected at build time via
`EXPO_PUBLIC_API_URL` (see [eas.json](#build-profiles)).

**Store identity**

| App | Bundle id / package | Scheme | Notes |
| --- | --- | --- | --- |
| Colonize Resident | `com.colonize.resident` | `colonize-resident` | light theme, no camera |
| Colonize Security | `com.colonize.security` | `colonize-security` | dark theme, camera (QR scan) — `CAMERA` / `NSCameraUsageDescription` declared |

Each app ships its own 1024×1024 icon, Android adaptive icon, splash and favicon
(`apps/<app>/assets/`), and an `eas.json` with three build profiles:

| Profile | What it is | `EXPO_PUBLIC_API_URL` |
| --- | --- | --- |
| `development` | Dev client, internal, Android APK | *unset* — the platform default (emulator/host `:4000`) |
| `preview` | Internal distribution (QA on real devices), Android APK | placeholder — set to your staging API |
| `production` | Store build, `autoIncrement` (bumps `android.versionCode` / `ios.buildNumber`) | placeholder — set to your production API |

> Replace `https://api.colonize.example.com/api` in each app's `eas.json`
> `preview`/`production` profiles (or use `eas secret` / `eas env`) with the URL of your
> deployed API before building. The bundle ids assume the `com.colonize` domain is
> registered to you; change them in `app.json` before first store submission if not.

**Local development on a device / simulator**

```bash
npm run dev:resident          # or dev:security
# then in the Expo terminal:  a = Android,  i = iOS,  n = Expo Go
```

Both apps include `expo-dev-client`, so `expo run:…` (or the EAS `development` profile)
produces a **native dev build** — a real installed app that talks to `expo start`. Use that
whenever the phone's Expo Go is a different SDK than the project (Expo Go only loads its
own SDK; see Step 6 above):

```bash
cd apps/resident-mobile
npx expo run:android          # builds + installs a dev build on a connected device/emulator
npx expo run:ios              # macOS only
```

**Production builds (EAS)**

```bash
npm i -g eas-cli && eas login

# store-ready APK / AAB + IPA
eas build -p android --profile production --non-interactive   # apps/resident-mobile
eas build -p ios     --profile production --non-interactive
eas build -p all     --profile preview                          # quick QA on TestFlight / Play internal track

# store submission
eas submit -p android --profile production
eas submit -p ios     --profile production
```

Run `eas init` (or `eas link`) inside each app folder first so the EAS project id is
recorded; keep the Android keystore and iOS signing certs in EAS (`eas credentials`).
Native projects are generated at build time (EAS managed workflow) — the `android/` and
`ios/` folders in each app are git-ignored.

**Verified** — `expo prebuild` generates clean Android (Gradle) and iOS (Xcode) projects
for both apps: bundle ids, deep-link schemes, adaptive icons, camera permission + usage
string, the dark/light launch themes, and the `expo-dev-client` build properties
(`EX_DEV_CLIENT_NETWORK_INSPECTOR`) all land in the native manifests. `expo-doctor`
passes all local checks (the two remote metadata checks need network access to Expo's API).

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
| `/platform` | 12 | Super-admin: societies, onboarding, subscriptions, plans, tenants |
| `/society` | 6 | Society profile/plan/counters, audit trail, module entitlements, roles, rule settings |
| `/visitors` | 16 | Pre-approval, at-gate entry, QR passes (issue/regenerate/revoke/recurring), decisions, manual check-in/out, gate queue, entries log, summary |
| `/gate` | 4 | **Gate console**: `POST /gate/scan`, `GET /gate/queue`, exits, dashboard |
| `/guards` | 9 | Guard roster (staff CRUD scoped to `type:'SECURITY'`), shift login/logout, on-duty, assignments, `GET /guards/dashboard` |
| `/gates` | 6 | Gate/lane configuration + assignments + dashboard |
| `/bills` | 14 | Bill generation, resident `GET /bills/mine`, pay (payment intent → verify), invoice PDF, receipts, adjustment |
| `/payments` | 10 | Payment intent → verify → receipt PDF, resident history, transaction status |
| `/accounting` | 9 | Journal entries (incl. reverse + rebuild-balances), ledger, trial balance |
| `/incomes`, `/expenses` | 5 | Income and expense records, mark-expense-paid |
| `/complaints` | 12 | Complaints, assignment, status transitions (incl. `POST /:id/status`), comments, verification |
| `/work-orders`, `/service-requests` | 7 | Vendor work orders (schedule, parts, billing) and resident service requests |
| `/vendors`, `/staff` | 5 | Vendor and staff directory |
| `/amenities` | 5 | Amenity catalogue, slots + `GET /amenities/:id/availability?date=YYYY-MM-DD` |
| `/amenity-bookings` | 10 | Booking, payment linkage, calendar, entry QR, check-in/out |
| `/structure` | 5 | `GET /structure/tree`, `/structure/counts` |
| `/buildings`, `/wings`, `/floors`, `/units` | 9 | Hierarchy CRUD (incl. unit move-out) |
| `/residents`, `/unit-members`, `/family-members` | 12 | People CRUD, CSV import/template, family permissions, vehicle verification |
| `/vehicles`, `/parking-areas`, `/parking-slots` | 10 | Vehicles, parking allocation, slot release |
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
│   ├── scripts/mobile-contract-check.mjs  ← endpoint contract check for the mobile apps
│   └── tests/                         unit / integration / e2e (vitest)
├── packages/shared/         shared types, enums, PLAN_TIERS, DEFAULT_TIER_MODULES
├── apps/                    admin-web, super-admin-web (React + Vite) ·
│                            resident-mobile, security-mobile (Expo 54: app.json,
│                            eas.json, assets/ — store icons, splash, adaptive icons)
├── docker/                  Dockerfile, docker-compose.yml
├── .dockerignore
└── package.json             npm workspaces: packages/*, backend, apps/*
```

### Useful commands

```bash
npm run dev -w backend          # API with tsx watch
npm run seed -w backend         # seed / re-seed Green Valley Residency
npm run e2e -w backend          # §80 acceptance suite (117 checks)
npm run dev:admin / dev:super   # web consoles (Vite dev servers)
npm run dev:resident            # resident app (Expo) — web / Android / iOS
npm run dev:security            # security app (Expo) — web / Android / iOS
npm run build                   # shared → backend → web apps
npm run typecheck               # tsc --noEmit across all workspaces
npm run test -w backend         # vitest
npm run contract -w backend     # mobile contract check (36 checks, any hour of day)
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
