---
name: bmrc-testing
description: >
  How to run, extend, and trust the BMRC Logistics test suites, and how to
  verify a change end-to-end against the Firestore emulator. USE THIS SKILL
  before shipping any behavior change, when asked to run/write/fix tests, when
  adding an invariant, or when you need a safe local environment with seeded
  data. Keywords: test, tests, emulator, invariant, property test, fast-check,
  semester simulation, seed, verify, npm run test, playwright, e2e, firebase
  emulators, demo-bmrc-logistics, guard, reseed.
---

# BMRC Testing & Verification

The test suite is the enforcement arm of the Tier-1 invariants (see
**bmrc-domain**). It runs against the **Firestore emulator** with a hard guard
that refuses production-shaped config — you cannot hurt live data from the
test commands, and you must never try to test against live data any other way.

## The tiers (what to run when)

| Command | What it is | When to run |
|---|---|---|
| `npm run test` | Offline pure-logic tests (`scripts/test-audit-restock.cjs`), no Firebase | Always — it's seconds |
| `npm run test:invariants` | INV-1…12 integration suites against the emulator, driving the **real** `app/lib` helpers | Any change to stock, lots, locations, receiving, packs |
| `npm run test:properties` | fast-check property tests: an oracle `Ledger` model + real-code conformance for `computeBagStock`/`getItemStatus` | Any change to `item-status.ts` math |
| `npm run test:simulation` | 15-week semester sim with injected member sloppiness (TRUTH vs SYSTEM worlds); asserts invariants hold and problems surface on exception reports | Changes to receiving, check-off, reconciliation, dashboards |
| `npm run test:emulator` | seed + all three of the above | Before shipping anything data-touching |
| `npm run test:e2e` | Playwright against the emulator | UI flow changes |

Also unit tests in `app/lib/__tests__/` (O₂ checkout/validation).

`npm run build` + `npm run lint` are part of "done" for every change — the
static export build catches routing violations dev mode tolerates.

## How the emulator harness works

- Everything runs through `firebase emulators:exec --project
  demo-bmrc-logistics` (Firestore on `127.0.0.1:8080`, emulator UI on `:4000`
  when using `npm run emulator`).
- `scripts/emulator/guard.ts` runs **first** (via the harness import chain)
  and hard-exits on any production-shaped config — no emulator host, non
  `demo-*` project, real credentials. If you see the red "ABORTED" banner,
  your env is wrong, not the guard.
- `scripts/emulator/harness.ts` exposes the shared toolkit: the app's real
  `db`, `hydrate()` (deep Timestamp→Date), `getInventory`/`getPack`/`getAll`
  readers, `reseed()`, and a tiny console test framework.
- `scripts/emulator/seed.ts` defines the canonical fixture world and stable
  `IDS` (e.g. `IDS.epi`, `IDS.glucose`, `IDS.gauze`). Every suite gets a
  **fresh seed** — never write order-dependent suites.

**Import order matters:** every test file must import the harness (or
`./guard`) before anything that touches `@/firebase`, so the guard normalizes
env before the Firestore client initializes.

## Recipe: add an invariant test (INV-13)

1. Create `scripts/emulator/invariants/inv-13.test.ts`:

```ts
import { defineInvariant, reseed, getInventory, IDS } from '../harness';
import { someHelper } from '@/app/lib/audit-actions'; // drive REAL app code

defineInvariant('INV-13', 'One-line statement of the rule', async (t) => {
  // seed is already fresh; act via the real lib helper, then assert on Firestore
  await t.rejects(someHelper(/* illegal op */), 'illegal op is refused');
  const item = await getInventory(IDS.epi);
  t.equal(item.batches.length, 2, 'no lot was lost');
  t.ok(cond, 'message', 'detail shown on failure');
});
```

2. Register it in `scripts/emulator/run-invariants.ts` (`import
   './invariants/inv-13.test';` — order = INV id).
3. Run `npm run test:invariants`.

`T` API: `t.ok(cond, msg)`, `t.equal(actual, expected, msg)`,
`await t.rejects(promise, msg)` (passes iff the operation is **refused**),
`await t.resolves(promise, msg)`, `t.note(msg)`. Exit code is non-zero on any
failure — CI-friendly.

Key testing principle here: **tests drive the real `app/lib` helpers through
the real Firestore client**, then assert on the resulting docs. Don't test a
reimplementation, and don't mock Firestore.

## Manual verification (drive the actual app)

1. `npm run dev:emulator` — Next dev server pointed at the emulator
   (`NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`). Requires the
   emulator running (`npm run emulator` in another terminal, or it's already
   up from `emulators:exec`).
2. `npm run seed` — load the canonical fixture world.
3. Log in / fake roles with `localStorage.bmrc_role_override` (see
   **bmrc-new-page**). Inspect raw docs in the emulator UI at
   `http://127.0.0.1:4000`.
4. Drive the actual flow you changed end-to-end (e.g. a full checkout →
   check-in cycle), and confirm the derived surfaces — dashboard counts,
   status chips, logs — moved with it.

A change is "verified" when: lint + build pass, the relevant test tier is
green, and you have driven the affected flow against the emulator and watched
the data land correctly. Report exactly which of these you did.
