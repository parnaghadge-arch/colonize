# Colonize — User Manual

Platform for housing societies, apartment complexes, gated communities and plot
developments: one control plane for the platform operator, one web console per
society, and two mobile apps — for residents and for the security guard team.

**Audience.** This manual covers all four clients and the data flows between
them:

| Client | Who uses it | What it is |
|---|---|---|
| **Super admin console** (`super-admin-web`) | The platform operator | Onboard, configure, plan and audit every society |
| **Society admin console** (`admin-web`) | The society's administrators | Run the society: structure, people, gates, services, money |
| **Resident app** (`resident-mobile`) | Owners, tenants and family members | Bills, complaints, visitors, amenities, profile |
| **Security guard app** (`security-mobile`) | Guards on duty | Gate queue, pass scanning, walk-ins, entry log |

Setup instructions for running the platform are in the repository `README.md`;
this document assumes a running deployment and explains what each client does
and how data moves through the system.

---

## 1. Roles and access

Every person in the system has a **role**, and every role has a set of
fine-grained **permissions** (`module:action`, e.g. `resident:update`). The API
checks the permission on every request, and every client hides navigation it
does not have — so what you can see is what you can do.

| Role | Where it lives | Can |
|---|---|---|
| **Platform operator / Super admin** | Platform database (not inside any society) | Onboard societies, change plans, manage society administrators, audit everything |
| **Society administrator** (`SOCIETY_ADMIN`, `CHAIRMAN`, `SECRETARY`, `TREASURER`, `COMMITTEE_MEMBER`) | The society's own database | Run the society console; the five roles above are the ones the activation guard and the administrators panel both count |
| **Resident** | Society database, linked to a unit | Use the resident app for their unit(s); family members can be granted selective permissions (approve visitors, make payments, …) |
| **Staff / guard** | Society database, linked to a gate (guards) | Use the guard app while on shift; staff attendance |
| **Vendor** | Society database | View/accept work orders issued to them, be rated after completion |

A single person can hold memberships in **multiple societies** (e.g. the
administrator of two complexes). Sign-in detects that and asks which society to
enter.

### How access is enforced, in one sentence

The API authenticates the token, loads the society from the platform database,
resolves the user's **roles** to a **permission set** (read from the society's
own `roles` collection), and refuses any request whose permission the role set
does not grant — and additionally refuses anything whose **module** is not in
the society's subscribed module list.

---

## 2. Architecture and data flow (how the pieces connect)

### 2.1 Multi-tenancy: one platform database, one database per society

```
                         ┌──────────────────────────────┐
                         │        PLATFORM DATABASE     │
                         │  societies · subscriptions   │
                         │  subscription_plans ·        │
                         │  identity_directory ·        │
                         │  platform_users ·            │
                         │  platform_audit_logs         │
                         └──────────────┬───────────────┘
                                        │ provisions + syncs
                 ┌──────────────────────┼──────────────────────┐
                 ▼                      ▼                      ▼
      ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
      │ Green Valley DB    │  │  Sunrise City DB   │  │   Plot Enclave DB  │
      │ buildings, wings,  │  │  … same schema …   │  │  … same schema …   │
      │ floors, units,     │  │                    │  │                    │
      │ residents, bills,  │  │                    │  │                    │
      │ subscriptions      │  │                    │  │                    │
      └────────────────────┘  └────────────────────┘  └────────────────────┘
```

- Each society gets **its own database** (`clnz_<slug>`), created and seeded
  the moment it is onboarded. One society's data is physically unreachable from
  another's — isolation is by database, not by a `societyId` filter.
- The **platform database** holds the cross-society facts: the society records
  (status, plan, limits, counters), the subscription plans catalogue, the
  **identity directory** (who exists in which society), platform users and the
  platform audit trail.
- The API can run against an embedded JSON datastore (default in development,
  persisted under `backend/.runtime`) or MongoDB — the schema and behaviour are
  identical.

### 2.2 The request path (every call, every client)

```
client (web console / mobile app)
   │  Bearer <JWT> + optional X-Idempotency-Key
   ▼
middleware: rate limit → CSRF → body parse → authenticate
   │  1. decode JWT (15 min access token)
   │  2. load the society from the platform DB (60 s cache)
   │  3. reject if society is not ACTIVE/ONBOARDING
   │  4. load the user from the TENANT db, resolve roles → permissions
   ▼
requireModule(...)   ← is this society subscribed to the module?
requirePermission(...) ← does the role set include module:action?
   ▼
route handler (zod-validated body) → writes to the TENANT db
   │  · audit log entry (tenant)
   │  · realtime emit to the society's Socket.IO rooms (optional)
   │  · job enqueue (notifications, sweeps) where relevant
   ▼
JSON envelope: { success, message, data, meta.requestId }
```

Key consequences you will feel as a user:

- **Module gating is per-society.** A FREE society does not see Work Orders in
  the console at all; the same administrator on a PREMIUM society does.
- **Every response carries a request id** (`X-Request-Id`) — quote it in
  support issues.
- **Rate limits** apply to login (stricter) and API; 429 responses include a
  retry window.

### 2.3 Authentication and the identity directory

Sign-in does **not** go directly to a tenant database. It goes through the
**identity directory** in the platform database — a single index answering
"which societies is this phone number / email in?"

```
login (OTP or password)
   ▼
identity_directory:  phone/email → memberships[] (societyId, userId, roles)
   ▼
for each membership: open that society's database, verify the user
   (password hash or OTP, status ACTIVE, not locked)
   ▼
0 verified  → 401 with a specific reason (see §11)
1 verified  → issue tokens + session
n verified  → "choose your society" selection (one-time selection token)
```

- **Access tokens** are short-lived (15 min); **refresh tokens** (httpOnly
  cookie on web, stored on mobile) extend the session. The console lists active
  sessions and can revoke any of them (Profile → Sessions).
- **OTP login** is the primary path for residents/guards (phone + 6-digit
  code); **password login** is available for administrators and for
  password-verified users. A phone can be verified, and a password can be set,
  changed, or recovered via the forgot-password flow (OTP-verified).
- **App PIN** (mobile): a local 4–6 digit code that gates opening the app;
  it is checked server-side against a hash on first enrollment.
- **Sign-out** (topbar button in both consoles, Profile → Sign out on mobile)
  revokes the refresh token on the server and clears local state.

### 2.4 Subscription, plans and the entitlement mirror

- Plans live in the platform's `subscription_plans` catalogue:
  **FREE · BASIC · STANDARD · PREMIUM · ENTERPRISE**, each with a module set
  and limits (`maxUnits`, `maxAdmins`, `maxGates`, SMS credits, storage).
- When the platform operator changes a plan (`PUT /platform/societies/:id/subscription`),
  the API resolves the plan and **re-syncs a mirror row inside the society's
  own database** (`subscriptions`). Authorization reads the mirror, so plan
  changes take effect immediately without a cross-database read per request.
- The 24 modules a plan can entitle a society to:

  `residents · visitorManagement · notices · complaints · serviceRequests ·
  amenities · payments · maintenanceBilling · accounting · vendorManagement ·
  workOrders · polls · events · documents · emergency · staffAttendance ·
  vehiclesParking · deliveries · cabs · advancedReports · automation ·
  communityChat · multiGate · gstBilling`

- **Society layout** (chosen at onboarding, editable later — see §5.5) adjusts
  this set: a **plot / row-house** society starts **without `multiGate`**
  (one street gate). Any module can be re-enabled later from the Plan tab.

### 2.5 Realtime

A Socket.IO server is mounted at `/realtime`. A client can subscribe only to
rooms derived from **its own** token — it can never listen to another society:

| Room | Who listens | Typical events |
|---|---|---|
| `society:<id>` | everyone in the society | notices, broadcast updates |
| `unit:<id>:<unit>` | that unit's residents/family | bills, visitor alerts, complaints |
| `admins:<id>` | administrators | new bills generated, disputes, plan changes |
| `security:<id>` | guards on duty | queue updates, walk-ins |
| `gate:<id>:<gate>` / `gate:<id>:*` | gate consoles | scan events, pass status |

When realtime is disabled the system still works; clients fall back to
refresh-on-focus.

### 2.6 Background jobs and scheduled tasks

An in-process job queue handles async work (notification delivery and related
handlers), and a scheduler runs:

| Task | When | What it does |
|---|---|---|
| `sweep` | every 5 min | Stale-visitor expiry, pass hygiene |
| `hourly` | :17 past the hour | SLA checks (complaints/service requests), reminder sweeps |
| `daily` | fixed daily time | Maintenance: apply late fees, send payment reminders, reconciliation prep |

All of these are safe to re-run; they are idempotent.

---

## 3. Super admin console

**URL:** the super-admin web app. **Login:** operator email/phone + password
(`POST /auth/platform/login`) — this is a separate login from society sign-in,
and the token carries **no society context**. Sign out is in the topbar
(permissions pill on the right) and at the sidebar footer.

Two screens: **Overview** and **Societies** (each society is one page with
six tabs).

### 3.1 Overview

Platform-level tiles: societies by status, units and residents, occupancy,
recurring revenue, recent activity. This is the answer to "how is the platform
doing?" — it reads from the platform database only.

### 3.2 Societies list

- Search by name/slug/city; filter by **status**, **plan**, **city**; sort.
- Columns: status, plan, **layout**, units, residents, database
  provisioning, onboarding step, created date.
- **Create and provision** opens the onboarding form (§5).

### 3.3 Society detail — the six tabs

| Tab | What it is |
|---|---|
| **Overview** | Live counters (units/residents/staff, occupancy, collected vs billed, open complaints, active bookings) + structure summary including **layout** |
| **Profile** | The society record — editable (§5.5), including **society layout**, **organizational type** and the **society logo** (upload any shape; the server stores a 512×512 square) |
| **Onboarding** | Current step, activation checklist, and a step recorder with **dry-run** preview (§5.3–5.4) |
| **Plan & limits** | Change tier/plan, pin a custom module set, change limits; re-syncs the tenant mirror |
| **Administrators** | Who can sign in to this society's console — invite, **edit**, **remove** (§5.6) |
| **Audit** | The platform-side audit trail for this society (who changed what, when) |

Header actions: status changes (suspend/inactive/archive/restore),
re-provision the database (idempotent — safe after a failed seed), rebuild the
login directory.

**Danger zone** (super admin only, at the bottom of the society page):

- **Clear all data** — removes units, residents, bills, visitors, guards and
  every other operational record. The society, its plan, its profile and its
  **administrator logins** stay (Society Admin, Chairman, Secretary, Treasurer,
  Committee). They sign in again with the same password. Everyone else's
  sign-in stops working.
- **Delete society** — removes the society itself, its database and those
  logins. This cannot be undone.

Both ask the operator to type the society name and a reason. The reason is
written to the platform audit trail before anything is removed.

### 3.4 What you can (and can't) change

- **Editable in Profile:** name, slug, legal name, registration, address,
  contact details, timezone, currency, GSTIN, notes, **layout**, **type**,
  **logo** (file upload or a pasted URL).
- **Not editable in Profile:** plan, limits, modules — deliberately. They live
  on the **subscription**, because that is the only place that resolves the
  plan id and re-syncs the tenant mirror. The edit form says so.
- Editing the **slug** changes URL and (future) database naming conventions;
  the existing database keeps its name.

---

## 4. Society admin console

**Login:** phone (OTP) or email (password). An account that belongs to several
societies is asked to choose one — the choice is remembered for that
device/session. **Sign out** is in the topbar (next to the plan badge) and at
the sidebar footer.

The sidebar is organized in six groups; an item appears only if the
administrator's role has the permission **and** the society's plan includes the
module:

| Group | Pages |
|---|---|
| Overview | Dashboard |
| Community | Structure · Residents · Visitors · Gate console |
| Services | Complaints · Work orders · Vendors · Staff |
| Money | Bills · Payments · Accounting |
| Facilities | Amenities · Bookings |
| Insights | Reports · Settings |

### 4.1 Dashboard

The society at a glance: occupancy, collections, open complaints, recent
activity.

### 4.2 Structure — add units, then the hierarchy

The physical hierarchy every unit hangs off: **building → (wing) → floor →
unit**. Adding units does not start there. The page asks only what the
society's layout needs:

- **Building (Tower / apartments)** — how many towers, then a row for each
  tower with how many apartments. **Same number in every tower** fills the
  rows in one click. Apartment numbers (101, 102…) are filled in. How many
  per floor is optional and stays closed unless you open it.
- **Layout (Plot / houses)** — how many plots, then a row for each plot:
  **vacant plot**, **house**, or **tower**. A tower asks how many apartments.
  **Set every plot to** covers the case where they are all the same. Above
  40 plots the form asks what most plots are, and the plot numbers that
  differ, so nobody taps 200 rows.
- **Both** — towers first, then plots. Leave a count at 0 to skip that side.

A preview sentence ("This will add 2 towers (16 apartments) and 8 houses.")
sits above the button, so nothing is saved blind. Names or plot numbers that
already exist are rejected and nothing is written.

- **Tiles** at the top: totals for buildings / wings / floors / units.
- **Buildings and wings** card: one card per building (code, unit count,
  wings as pills). Per building: **Edit** (name, code, type — TOWER /
  BUILDING / BLOCK / VILLA_ROW / COMPLEX — wings on/off, floors, units per
  floor), **Delete**, and **View units**. Per wing: edit (✎) and delete (✕)
  right on the wing pill.
- **Units** card: filter by building / wing, search by number or label;
  columns for building, wing, floor, type, status, occupancy, people
  (owners/tenants/family), outstanding amount. Per unit: **Edit** (unit
  number, floor, type — FLAT / VILLA / PENTHOUSE / SHOP / OFFICE / GARAGE /
  STUDIO / **HOUSE / BUNGALOW / BUILDING / TOWER** — status —
  VACANT / OCCUPIED / LOCKED / UNDER_MAINTENANCE — carpet area, bedrooms)
  and **Delete**. The four building-style types are for plot/row-house
  societies, where one *unit* is a whole structure standing on a plot.
- **Add one building / bulk generate** stay available for a custom case the
  short form does not cover (a wing, a shop, a one-off unit). They are not
  the normal way to form a society.
- **CSV import**: download a template, upload a spreadsheet; a **preview**
  step shows exactly what would be created before anything is written.
- Edits and deletes are permission-checked (`building:*`, `wing:*`, `unit:*`)
  and audited; the unit counters on the society record are refreshed after
  every structural change.

> **Note on "plots".** A vacant plot or a house is a unit in a building named
> *Plots* (labelled "Plot 12"). A plot that is a tower is its own building
> ("Plot 12 Tower") with apartment units inside it, numbered 101, 102….
> Nothing about billing, residents or passes treats a plot unit differently
> from a flat — only the `multiGate` module is omitted for plot societies.
> Change one plot later by editing that unit, or add more from the same form.

### 4.3 Residents — add, edit, delete

Owners, tenants and family members, always scoped to units of this society.

- **Add resident** (topbar): name, phone, email, kind (Owner/Tenant/Family/
  Company), unit (hierarchy picker), move-in date. The resident becomes the
  unit's primary contact and can sign in to the resident app by phone (OTP)
  from then on.
- **Edit** (from the resident's detail card): name, phone, email, kind, unit,
  move-in date, occupation, primary-contact flag. Saving re-syncs the login
  directory, so a changed phone/email is the new sign-in identifier.
- **Remove** (from the detail card): soft delete — the audit trail keeps the
  person, their sign-in stops working, and they no longer resolve to a unit.
  Family members' derived sign-ins stop too.
- **Detail card** shows the resident's **family members** (each with
  per-member permissions: can approve visitors, deliveries, raise complaints,
  book amenities, make payments) and **vehicles** (plate, type, make, primary).
- **CSV import** with template, **transfer** (move a resident to another
  unit), **move-out**, and **permissions** endpoints round out the module.

### 4.4 Visitors — passes and the entry log

- **Pre-approve** a visitor for a unit (name, phone, vehicle, window,
  recurring option). The resident receives a notification with a **QR pass**.
- **At-gate** walk-ins: the guard creates a pass on the spot; the owner can
  accept or reject it from their app before the car arrives.
- The **entry log** is the society's record of every arrival/exit with pass
  status; **summary** gives counts by day.
- Passes are QR-coded, scoped to a window and a vehicle, and expire stale
  automatically (the `sweep` task).

### 4.5 Gate console (admin-facing)

The same scan/queue surface the guards use, for an administrator supervising a
gate: the live **queue**, **scan** a pass (camera or typed code), decide
check-in/check-out, and see the day's **log**.

### 4.6 Services

- **Complaints**: raise (as admin) or receive from residents; category,
  priority, assign to staff/vendor, comments thread, status flow
  (open → in-progress → resolved → verified/closed), SLA tracking with
  escalation.
- **Work orders**: work issued to vendors/staff against a unit or amenity;
  status + cost; vendors can accept/complete from their vendor view.
- **Vendors**: approved service providers with contact, service area and
  **ratings** (auto-refreshed from completed work orders).
- **Staff**: society employees (including guards), roles, and **attendance**
  (guard shift logins double as attendance records).

### 4.7 Money

- **Bills**: generate for units (period, amount, due date), send, track
  payment; per bill — invoice (PDF), waive, dispute handling, late fees,
  reminders; the **defaulters** list and a **summary** tile view.
- **Payments**: online payment intents (provider integration with webhook
  verification), **offline** collections recorded manually, receipts (PDF),
  refunds.
- **Accounting**: ledgers, journal entries (with reversals), **trial balance**,
  **income statement**, **balance sheet**, and a rebuild-balances utility.

### 4.8 Facilities

- **Amenities**: the bookable facilities (courts, halls, pools…) with slots,
  pricing, calendar and availability.
- **Bookings**: approve/decide resident bookings, check-in/check-out at the
  facility, cancellations; QR per booking.

### 4.9 Insights

- **Reports**: operational and financial reporting (plan-gated).
- **Settings**: the society's own self-service profile, configurable rules
  (settings namespaces — e.g. gate rules, fee structures), module entitlements
  view, roles, and the tenant audit trail.

---

## 5. Onboarding a society (the full journey)

This is the flow the super admin runs, and it is the flow whose failures used
to end in a dead end — each step now has a visible checklist state.

### 5.1 Create and provision

The form collects:

- **Name** (auto-derives the slug), legal name, registration, city/state/
  pincode/address, timezone, currency, contact email/phone, website.
- **Logo** (optional): pick any PNG/JPEG/WebP up to 5 MB — a banner, a
  square, a circle, it doesn't matter. The server centre-crops it to a
  **512×512 square** and returns the public URL, which is written to the
  society's `logoUrl` as part of creation. The square is what every client
  later shows (super-admin list & detail, the society console sidebar, the
  mobile apps), so an off-shape upload can never distort anything.
- **Opening plan** (FREE/BASIC/STANDARD/PREMIUM/ENTERPRISE).
- **How is this society formed?** — three buttons, near the top of the form
  (not a dropdown, so none of the choices is hidden). Each button says what
  adding units will ask later:
  - **Building (Tower / apartments)** — the full module set for the plan.
    Adding units asks how many towers and how many apartments in each.
  - **Layout (Plot / houses)** — formed **without the multi-gate module** (one
    street gate); everything else as per plan. Adding units asks how many
    plots, then whether each is a vacant plot, a house, or a tower.
  - **Both** — full set. Adding units asks both. A count of 0 skips that side.
- **First administrator** (optional but strongly recommended): name, email,
  phone, and a **password set now** (a blank password creates an account
  nobody can sign in to — the form warns about this).

One call does two things atomically: writes the society record to the platform
database **and provisions its dedicated database** (schema, indexes, default
roles, ledgers, settings, subscription mirror). The response returns the
society **and** the administrator it created.

### 5.2 What "provisioned" means

Until provisioning succeeds the society has no data and cannot be used. The
Societies list shows a green **Provisioned** pill or a red **Not provisioned**
one, and the detail page has a **Re-provision** action — idempotent, safe to
retry after a failure.

### 5.3 The activation checklist

`GET /platform/societies/:id/onboarding` returns the checklist; a society is
**activatable** when every required step is done:

1. **Database provisioned**
2. **Structure declared** — at least **one unit** exists. The onboarding
   **Structure** step shows the three layout buttons again (so a wrong choice
   can be corrected before any units exist) and then the same short form the
   society admin sees — only the questions that layout needs. A dry run
   previews the sentence ("Would add 2 towers…") without writing.
3. **Administrator exists** — at least one user with an admin role
4. **Activation** — flips the society to ACTIVE, flips its PENDING
   administrators to ACTIVE, re-syncs the login directory, and completes
   onboarding.

The **Record an onboarding step** form has a **dry run** toggle: preview
exactly what a step would save (e.g. "would create 12 units") before writing.

### 5.4 Why an admin can't sign in before activation

By design: a half-built society has no usable console. If the administrator
tries to sign in early, the endpoint now says **why** instead of a generic
"invalid credentials":

> *"<Society> is still being set up — an administrator can only sign in after
> the platform operator activates the society (it needs at least one unit and
> one administrator)."*

Once activated, the same phone/email + password work immediately.

### 5.5 Editing the society afterwards (layout & type)

The **Profile** tab is now a full editor:

- **Society layout** — change Building ↔ Layout (plots / houses) ↔ Both, using
  the same three buttons as onboarding. Changing to a
  plot layout **removes the modules the layout excludes** (`multiGate`) from
  the society's module set **and re-syncs the tenant entitlement mirror**, so
  the change takes effect immediately. The response and toast name exactly
  which modules were disabled. Nothing is re-added automatically — if the
  layout change was a correction, re-enable the module from the **Plan &
  limits** tab.
- **Organizational type** — RESIDENTIAL_SOCIETY / APARTMENT_COMPLEX /
  GATED_COMMUNITY / HOUSING_SOCIETY / COMMERCIAL_COMMUNITY / MIXED_USE.
- **Logo** — upload a new image (cropped to a square by the server) or paste
  a URL; the current logo is previewed next to the picker.

> A logo change is visible on the **next request** — the platform drops the
> cached society record when the Profile is saved, so the console and mobile
> apps pick the new square up immediately after sign-in/refresh.

Every profile edit is written with an audit entry (old value → new value), and
unknown fields are rejected rather than silently dropped, so a misspelled key
cannot "save" without changing anything.

### 5.6 Managing the society's administrators

The **Administrators** tab lists every account that can sign in to this
society's console (name, email, phone, roles, status, last sign-in, and a
"must change password" marker).

- **Invite an administrator** — creates a login inside the society's own
  database (it cannot sign in anywhere else), enforcing the plan's
  `maxAdmins` limit. Requires a name, an email or phone, and a password.
- **Edit** — change name, email, phone, roles, and **reset the password**.
  Changing an email or phone is a changed sign-in identifier: the login
  directory is re-synced, so the old identifier stops resolving and the new
  one works on the next attempt.
- **Remove** — soft-deletes the administrator and re-syncs the directory.
  Guarded: removing the **last administrator of an ACTIVE society** is
  refused (409) with an explanation, because it would leave the society with
  nobody who can sign in — invite a replacement first.

---

## 6. Resident app

**Sign-in:** phone number + OTP (primary), or password when set. A phone
number that belongs to several societies is asked which one to open. The app
then shows six bottom tabs: **Home · Complaints · Bills · Amenities ·
Visitors · Profile**.

### 6.1 Home

The society's **logo** (its 512×512 square, or its first letter if it has
none) with the society name, then the greeting, **outstanding amount**,
**open complaints** and quick actions — **Raise a complaint · Pay a bill ·
Book an amenity · Invite a visitor** — plus the resident's recent complaints.

### 6.2 Bills

List of bills for the resident's units with status; **Bill detail** shows the
line items, due date, late fee if applied, and the **pay** action (online
payment intent, or a note for offline payment). Paid bills show the receipt.

### 6.3 Complaints

Raise with category, title, description, photos and the affected unit; track
status (open → in progress → resolved) and **verify** closure (verification is
what moves a complaint to closed). The detail screen carries the full comment
thread with the society.

### 6.4 Amenities & bookings

Browse bookable facilities, see live **availability** (slots by day), book a
slot, see booking status, check in with the booking **QR** at the facility,
and cancel.

### 6.5 Visitors

**Invite a visitor** (name, phone, vehicle, visit window, recurring option).
The resident gets a **QR pass** they can share; the guard scans it at the gate.
The visitor list shows each pass' lifecycle (pending → accepted → checked in →
checked out / expired / revoked).

### 6.6 Profile

Account details, the **society card** (logo, name, timezone, currency),
unit(s) and family members, **sessions** (active devices, revoke), **app PIN**
(enroll/change/remove), password management (set/change), push token
management, and **sign out**.

### 6.7 Family members

The unit's primary resident can add family members; each member gets
selectable permissions (approve visitors, approve deliveries, raise
complaints, book amenities, make payments, sign in). A family member with the
sign-in permission can log in with their own phone.

---

## 7. Security guard app

**Sign-in:** the guard's phone + OTP/password. Signing in opens **Shift**:
start a shift at an assigned gate. While on shift the app is the gate
console — four bottom tabs: **Queue · Scan · Log · Board** — plus the
**Walk-in** flow. The **Board** shows the society's logo and name above the
shift dashboard, so a guard on a shared gate device always knows which
society they are working for.

### 7.1 Shift

Start/end a shift at the gate you are assigned to. Shift logins are the
attendance record (Staff → attendance in the console). Only on-duty guards
see the console; the **Board** shows who is on duty where.

### 7.2 Queue

The live queue for the gate: pre-approved passes arriving, walk-ins awaiting
the owner's decision, vehicles with plate details. Each item can be decided
(check-in / reject) from here; queue updates arrive in realtime.

### 7.3 Scan

Point the camera at a **QR pass** (resident-shared or guard-created) or type
the pass code. The API evaluates the pass against its rules — valid window,
not expired, not already used, vehicle match, society match — and returns the
decision (allow / reject with a reason code). Check-out works the same way at
exit.

### 7.4 Walk-in

No QR? The guard registers the vehicle and contact, and the **owner's app is
notified** to accept or reject before the car reaches the gate; the guard can
also grant a pass directly. Walk-ins appear in the queue and the log.

### 7.5 Log

The entry log for the gate: every check-in/check-out with pass id, vehicle,
timestamp and decision — filterable, and the source of the day's report.

---

## 8. Data flows for the main scenarios

### 8.1 Society onboarding → activation → first admin login

```
operator fills the form (layout = Plot) ──► POST /platform/societies
   │  writes society (ONBOARDING, layout, modules minus multiGate)
   │  provisions clnz_<slug> database + seeds defaults + mirrors plan
   │  creates the admin user (status PENDING) in the tenant DB
   │  registers them in the platform identity directory
   ▼
operator records STRUCTURE (how many towers / plots, what is on each plot)
   │  creates towers, apartment numbers, houses and vacant plots
   ▼
POST /:id/activate
   │  units ≥ 1 ✓  admins ≥ 1 ✓
   │  society → ACTIVE, admin PENDING → ACTIVE, directory re-synced
   ▼
admin signs in:  directory → tenant user (ACTIVE, password ✓) → token
```

Try to sign in before activation and the message tells you exactly what is
missing (§5.4).

### 8.2 Resident onboarding and unit linkage

```
admin: Residents → Add resident (phone, unit A-1203, kind Owner)
   │  creates resident + unit membership + user (OTP-able) in the tenant DB
   │  upserts the phone into the identity directory
   ▼
resident installs the app → OTP on +91… → session for A-1203's unit
   │  every screen scopes to the unit from the token (never from the client)
   ▼
admin: transfer / move-out re-points the unit linkage (audited)
```

### 8.3 A visitor pass, end to end

```
resident: Invite visitor (window 10:00–12:00, vehicle MH12AB123)
   │  pass created (PENDING) + QR + notification to the unit room
   ▼
guard (Queue): sees the pass for the vehicle
   │  Scan → pass valid (window, vehicle, not used) → CHECKED_IN
   │  realtime: unit room (owner sees "checked in"), security room
   ▼
guard (Scan at exit): same pass → CHECKED_OUT
   ▼
sweep task expires stale passes; entry log retains the record
```

### 8.4 The billing cycle

```
admin: Bills → Generate (period, per-unit amounts)
   │  bills created + notifications to unit rooms
   ▼
resident: Bills → Pay (payment intent → provider → webhook verified)
   │  payment recorded, bill → PAID, receipt PDF, ledger entry
   ▼
daily job: late fees on overdue bills + payment reminders
   ▼
admin: Accounting — trial balance / income statement / balance sheet
```

### 8.5 A complaint with SLA

```
resident: Raise complaint (category Plumbing, unit A-1203)
   │  status OPEN, SLA clock starts (category-based)
   ▼
admin: assign to staff/vendor → IN_PROGRESS (work order optional)
   ▼
hourly job: SLA breach → escalation notification
   ▼
admin: mark RESOLVED → resident VERIFIES in the app → CLOSED
   (resident can reopen before verification if it regresses)
```

### 8.6 An amenity booking

```
resident: Amenities → Court → slot today 18:00 → Book
   │  booking PENDING/CONFIRMED per amenity rules + QR
   ▼
facility staff / admin: Bookings → check in at 18:00 with the QR
   │  check-out ends the slot
   ▼
cancellation frees the slot (availability updates in realtime)
```

### 8.7 Changing a society's layout afterwards

```
operator: Society → Profile → Edit → layout: Building → Layout (Plot / houses)
   │  multiGate dropped from modules + subscription.modules
   │  tenant mirror re-synced, society cache invalidated
   │  audit entry (old → new, modules removed)
   ▼
console: multi-gate features stop authorizing immediately
   (re-enable later from Plan & limits if the change was a correction)
```

### 8.8 Changing a society administrator

```
operator: Society → Administrators → Edit (new email, new password)
   │  tenant user updated (roles merged, passwordHash replaced)
   │  identity directory rebuilt for the society:
   │     stale identifiers pruned · new identifiers registered
   ▼
admin signs in with the new email + new password; the old email 401s
```

---

## 9. Plans and modules at a glance

| Plan | Modules |
|---|---|
| **FREE** | residents, visitorManagement, notices |
| **BASIC** | + documents, emergency, vehiclesParking |
| **STANDARD** | + complaints, serviceRequests, amenities, payments, maintenanceBilling, polls, events, staffAttendance, deliveries, cabs, multiGate |
| **PREMIUM / ENTERPRISE** | all 24 modules |

Limits scale with the plan (units, administrators, gates, SMS credits,
storage). A plot/row-house society loses `multiGate` from whichever tier it
has; the rest is unchanged. Every change is per-society and auditable.

---

## 10. Where things are visible (quick map)

| You did this | You can see it |
|---|---|
| Onboarded / activated a society | Societies list (status, onboarding column), detail header pills |
| Changed a plan | Plan & limits tab, console plan badge, module nav appearing/disappearing |
| Changed layout/type | Profile tab, header layout chip, Overview structure panel |
| Invited/edited/removed an admin | Administrators tab, platform audit trail |
| Uploaded a society logo | Super-admin list + detail thumbnails, society console sidebar, resident app (Home + Profile), security app Board — the stored file is always the 512×512 square |
| Created/edited/deleted structure | Structure page tiles + unit list, society counters |
| Added/edited/removed a resident | Residents list + detail card, resident app (for the person) |
| Approved a visitor | Entry log, visitor's app, gate queue |
| Generated bills | Bills page, resident app, Accounting statements |
| Raised/assigned a complaint | Complaints page, resident app, SLA reports |

---

## 11. Troubleshooting (the errors that mean something)

| Symptom | What it means | What to do |
|---|---|---|
| *"…is still being set up — an administrator can only sign in after the platform operator activates the society"* | Password is right; the society has no units yet or no admin yet | Finish the onboarding checklist, then activate |
| *"…has no password set yet…"* | The account exists but no password was ever set | Re-invite the person from the Administrators panel with a password |
| *"Invalid credentials"* | Wrong password, or the identifier no longer resolves (email/phone changed, account removed) | Check the identifier; re-invite if the account was removed |
| *"This account is temporarily locked"* | Too many failed attempts | Wait for the lockout to expire or ask the operator |
| *"Choose one to continue"* (login) | The account is in several societies | Pick the society for this session |
| Console missing a page | The plan doesn't include the module, or the role lacks the permission | Plan & limits tab, or ask the operator |
| *"The X plan allows N administrators"* | Plan limit reached | Upgrade the plan |
| Removing the last admin of an active society is refused | Protects against orphaning the society | Invite a replacement first |
| Layout change "disabled" a module | Expected — plot societies don't get multi-gate | Re-enable from Plan & limits if the change was a correction |
| A web console can't reach the API (CORS) | The API's allowed origins don't include the console's host | Set `CORS_ORIGINS` in the backend env (use `*` for a preview) and restart the API |

**Support data to capture:** the request id from the response header
(`X-Request-Id`), the society slug, and the user's phone (never the password).

---

## Appendix A — API surface (for integrators)

The full contract is served by the API itself at **`/docs`** (OpenAPI, 190
paths), derived from the exact validators the server enforces:

- `/auth` — OTP, password login, society selection, refresh, logout, profile,
  password reset, sessions, app PIN, push tokens
- `/platform/societies` — onboarding, onboarding steps, activation, status,
  provisioning, subscription, stats, **admins (list / invite / edit / remove)**,
  audit
- `/society` — the society's own self-service profile, settings, roles, audit
- `/structure`, `/buildings`, `/wings`, `/floors`, `/units` — the editable
  hierarchy + CSV import + bulk generate
- `/residents`, `/family-members`, `/unit-members`, `/vehicles`,
  `/parking-areas`, `/parking-slots`
- `/visitors`, `/gate` — passes, scans, queue, entry log
- `/gates`, `/guards` — gate config, assignments, shifts
- `/complaints`, `/work-orders`, `/service-requests`, `/vendors`, `/staff`
- `/amenities`, `/amenity-bookings`
- `/bills`, `/payments`, `/accounting`, `/expenses`, `/incomes`
- `/platform/uploads/logo` — society logo upload (any aspect ratio →
  512×512 square, public `logos/` key, returns the URL to store in `logoUrl`)
- `/files/*` — serves stored objects; `logos/*` keys are **unauthenticated**
  (mobile login screens), everything else needs a signed URL or platform token
- `/meta` (feature detection), `/whoami`, `/health`, `/health/ready`

All responses use the envelope `{ success, message, data, meta: { requestId } }`;
errors use `{ success: false, message, code }` with a stable error code
(`VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`,
`SOCIETY_NOT_ACTIVATED`, `PASSWORD_NOT_SET`, `MODULE_DISABLED`, …).

## Appendix B — Glossary

| Term | Meaning |
|---|---|
| **Society** | A housing society / complex / gated community / plot development — one tenant, one database |
| **Layout** | How the society is physically formed: Building (Tower / apartments) / Layout (Plot / houses) / Both |
| **Plot** | One unit in a single-floor "Plots" building; its unit type records what stands on it (House / Villa / Bungalow / Building / Tower) |
| **Logo** | The society's image, stored as a 512×512 square under a public key; shown in the super-admin panel, the society console and both mobile apps |
| **Provisioning** | Creating and seeding the society's dedicated database |
| **Identity directory** | The platform-wide index of "who is in which society" used by login |
| **Subscription mirror** | The plan record inside the society's own database that authorization reads |
| **Module** | One of the 24 feature areas a plan can entitle a society to |
| **Pass** | A time-boxed QR entry/exit authorization for a visitor |
| **Gate** | A physical entry point with an assigned guard roster |
| **Onboarding step** | SIGNUP → PROFILE → STRUCTURE → ADMIN → SETTINGS → ACTIVATION → COMPLETED |
