---
name: run-bmrc-logistics
description: Build, launch, and drive the BMRC Logistics web app. Use to run, start, serve, screenshot, or smoke-test the app locally, or to confirm a UI change works against seeded data. Boots Next.js against the Firestore emulator and drives it with Playwright — no production data touched.
---

# Run BMRC Logistics

BMRC Logistics is a **Next.js 16 (App Router, static export) + Firebase** web app.
There is no server backend — the browser talks to Firestore directly via
`onSnapshot` listeners. To run it safely you point it at the **Firestore
emulator** (seeded with representative data) instead of production; the app's
`firebase.ts` auto-wires the emulator when `NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST`
is set (see `dev:emulator` in `package.json`).

The agent path is a Playwright **smoke driver** that boots the emulator-backed dev
server, seeds it, visits the main pages, and writes screenshots. It lives beside
this file:

- Driver spec: `.claude/skills/run-bmrc-logistics/smoke.spec.ts`
- Driver config: `.claude/skills/run-bmrc-logistics/smoke.config.ts`
- Screenshots land in: `.claude/skills/run-bmrc-logistics/screenshots/`

All paths below are relative to the repo root (`<unit>/`).

## Prerequisites

Already satisfied on this machine; the exact tools/versions used:

```bash
node -v          # v24.2.0
firebase --version   # 14.12.1  (firebase-tools; provides the Firestore emulator)
```

The Firestore emulator needs a JRE (`java`) on PATH — `firebase emulators:exec`
downloads the emulator jar on first run. `.env.local` (Firebase web config)
already exists and is git-ignored; do not commit it.

## Setup

```bash
npm install                       # deps are in package.json; node_modules already present here
npx playwright install chromium   # Playwright browser for the driver (idempotent)
```

## Run (agent path — the driver)

One command. It starts the Firestore **and Auth** emulators
(`demo-bmrc-logistics`), seeds them via the project's `e2e/global-setup.ts`
(dataset + a signed-in-able admin user), boots `next dev` pointed at those
emulators, drives the pages, and screenshots them. Nothing can reach
production — the project id is `demo-*`.

```bash
firebase emulators:exec --only firestore,auth --project demo-bmrc-logistics \
  "npx playwright test --config=.claude/skills/run-bmrc-logistics/smoke.config.ts"
```

> Note the `--only firestore,auth` — the Auth emulator is required for the
> signed-in tests. Omitting `,auth` leaves the auth-gated pages on the login
> screen (and `seed-auth-user` self-skips). The older `--only firestore` still
> works for the role-gated-only pages.

Expected tail:

```
  ✓  1 …smoke.spec.ts › statpacks renders seeded packs
  ✓  2 …smoke.spec.ts › sidebar keeps Clear test role reachable under a member override
  ✓  3 …smoke.spec.ts › buy-list renders
  ✓  4 …smoke.spec.ts › assets page renders merged statpacks (signed in)
  ✓  5 …smoke.spec.ts › dashboard is auth-gated (shows login)
  5 passed
✔  Script exited successfully (code 0)
```

Then look at the screenshots in `.claude/skills/run-bmrc-logistics/screenshots/`:
`statpacks.png`, `buy-list.png`, `assets.png` (the merged Asset Management page,
statpacks folded in — reached via a real signed-in session), and
`dashboard-login.png` (the auth gate for an unauthenticated visit).

**Auth — how the gate is now opened.** `firebase.ts` wires the Auth emulator
whenever the Firestore emulator is on (gated so prod and the Node-only Firestore
test runs are untouched). `scripts/emulator/seed-auth-user.ts` (run from
`global-setup` when `FIREBASE_AUTH_EMULATOR_HOST` is present) creates
`smoke-admin@example.com` / `test1234` with a matching admin `users/{uid}` doc.
The `signIn(page)` helper in `smoke.spec.ts` drives the real `/login` form with
those creds, so `onAuthStateChanged` fires with a real user and admin-gated pages
render. Use `signIn(page)` before `shoot(...)` for any auth-gated page; skip it
(and keep the `bmrc_role_override` flag) for role-gated-only pages.

**To drive a different page:** add a case to `smoke.spec.ts` using the `shoot()`
helper, e.g. `await signIn(page); await shoot(page, '/inventory', 'inventory')`,
then re-run the command above.

## Run (human path — real Firebase)

To see the **auth-gated** admin pages (dashboard, inventory, audit) with real
data you must be a signed-in Firebase user, which means pointing at production:

```bash
npm run dev      # next dev against .env.local (REAL Firestore) → http://localhost:3000
```

Open the browser, sign in at `/login` with a real BMRC account, Ctrl-C to stop.
This writes to production — prefer the emulator driver for anything automated.

## Gotchas

- **The auth gate (now solved via the Auth emulator).** Pages that call
  `onAuthStateChanged` and `router.push('/login')` without a signed-in Firebase
  user — **dashboard, inventory, audit, assets** — used to be unreachable under
  the emulator. They're now reachable: `firebase.ts` wires the Auth emulator
  alongside Firestore, `global-setup` seeds an admin account, and `signIn(page)`
  logs in through the real `/login` form. **Call `signIn(page)` before visiting an
  auth-gated page**, and run with `--only firestore,auth`. The
  `bmrc_role_override` localStorage flag still only sets the *role*
  (`useUserRole`) and never creates a `user`, so it alone does not satisfy the
  gate — it's a complement to `signIn`, not a replacement. Role-gated-only pages
  (**statpacks, buy-list, `/statpacks/check-off?id=…&mode=…`**) still render
  without signing in. The `dashboard-login` case deliberately does *not* sign in,
  to keep documenting the unauthenticated gate.
  - **Note:** an active `bmrc_role_override` makes `useUserRole` expose a role
    without the real `users/{uid}` fields, which re-triggers the first-login
    tutorial overlay. For a clean signed-in shot either rely on the seeded admin
    doc (no override) or dismiss the overlay (`Skip Tutorial`), as the `assets`
    case does.
- **`networkidle` never fires.** Firestore keeps long-lived listener sockets open,
  so the driver waits on `load` + a fixed `waitForTimeout(2500)`, not
  `networkidle`.
- **Strict-mode text matches.** Pack names appear both on a card and in the
  "expiring items" banner, so `getByText('MRC1 Primary')` matches twice — the
  driver uses `.first()`.
- **Benign hydration warning.** In dev the app logs a React "Hydration failed"
  warning (theme/localStorage-driven first paint); it self-heals on the client and
  is not a crash. Don't gate the driver on zero page-errors.
- **`reuseExistingServer: false` is deliberate.** A stale `next dev` on :3000 built
  without the emulator env would make the browser read **production** Firestore.
  The config always boots a fresh server.
- **Screenshots are byte-identical when a page redirects.** dashboard/inventory/
  audit all produce the same login PNG — that's the gate, not a driver bug.

## Test

```bash
npm run test          # audit/restock integration (scripts/test-audit-restock.cjs)
```

Emulator-backed suites (invariants / properties / semester simulation / e2e) are
wired too — see `bmrc-testing` skill and the `test:*` scripts in `package.json`.

## Troubleshooting

- **`No tests found`** — Playwright's positional path filter only matches inside
  `testDir`. Run the driver via `--config=.claude/skills/run-bmrc-logistics/smoke.config.ts`
  (which sets `testDir` to the skill dir); don't pass the spec path to the repo's
  default config.
- **`__dirname is not defined`** — the repo is `"type": "module"`; the config
  derives its dir from `import.meta.url`, not `__dirname`. (Already handled.)
- **`npm run build` fails** with a TypeScript error in
  `scripts/emulator/run-properties.ts` (`Element implicitly has an 'any' type …`).
  This is a **pre-existing** repo issue: `next build` type-checks the emulator
  scripts too. It does **not** affect running the app via the dev/driver path. Fix
  that type error before relying on the static-export build.
- **Emulator port 8080 in use** — a previous `firebase emulators:exec` didn't shut
  down. Find and kill the stray process, or wait for it to exit; the wrapper stops
  the emulator itself on clean completion.
