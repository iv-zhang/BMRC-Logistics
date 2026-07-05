---
name: bmrc-migrations
description: >
  Safe handling of live Firestore data in BMRC Logistics — migration scripts,
  backfills, schema changes, and one-off data fixes. USE THIS SKILL whenever a
  task involves running or writing anything in scripts/ against real data,
  changing a document schema, renaming fields, backfilling, normalizing, or
  "fixing data". These scripts touch production; there is no undo.
  Keywords: migration, migrate, backfill, normalize, schema change, data fix,
  dry-run, dry run, scripts, firestore.rules, production data, .env.local,
  service account, rename field.
---

# BMRC Migrations & Live-Data Discipline

The Firestore behind this app is **production for an active EMS corps** — no
staging copy, no point-in-time restore. Migration scripts in `scripts/` run
against it directly. Treat every one like surgery.

## Iron rules

1. **`--dry-run` first, always.** The npm entries are dry-run by default:
   `npm run migrate:batch-locations`, `npm run migrate:normalize-inventory`.
   Read the full dry-run output and reconcile every reported change against
   expectations **before** running with writes enabled. If you can't explain
   a line, stop.
2. **Never let a test or experiment touch live data.** Anything exploratory
   runs on the emulator (`npm run test:emulator` infra — see **bmrc-testing**;
   `scripts/emulator/guard.ts` shows what "production-shaped config" means).
3. **Do not run a live-write migration without the user explicitly asking for
   this specific run.** Propose, show the dry-run, wait.
4. `.env.local` holds the `NEXT_PUBLIC_FIREBASE_*` credentials. It exists;
   never commit it, never print its values.
5. Validate after writing: `scripts/validate-inventory-doc.js` and
   `scripts/check-inventory-mismatches.js` are the existing consistency
   checkers. Run the relevant one after any inventory-shaped migration.

## Writing a new migration script

Model on `scripts/normalize-inventory.cjs` / `scripts/migrate-batch-locations.js`.
Required properties:

- **Dry-run is the default**; writes require an explicit `--apply` (or
  equivalent) flag. Wire the npm script to the dry-run form.
- **Idempotent** — running twice must be a no-op the second time. Select docs
  by the *condition being fixed*, not by a list you computed earlier.
- **Log every change**: doc ID, field, before → after. In dry-run, print
  exactly what *would* be written. End with a summary count.
- **Batched writes** — Firestore caps a `WriteBatch` at 500 ops; chunk and
  commit incrementally so a crash mid-run leaves a resumable state (which
  idempotency then handles).
- **Preserve the paper trail.** If the change is semantically an inventory
  action, also write the matching `inventory_logs` / `auditEvents` rows (see
  **bmrc-audit-workbench**); if it's pure schema normalization, don't fake
  history.
- Name it after what it does, add a header comment stating purpose, the shape
  it migrates FROM/TO, and the date.

## Schema changes: migrate vs. tolerate

Prefer **tolerant readers** over migrations. The codebase already tolerates
legacy shapes (legacy `location`/`room` mirrors beside `storageLocation`;
box-tracked vs bag-tracked stock; string-or-Timestamp dates via hydration).
A migration is warranted only when tolerance would spread conditionals across
many call sites, and even then the reader should stay tolerant until a
verification pass shows zero legacy docs remain.

When you add a field: give it a safe default at the read/hydration layer, and
remember Firestore rejects `undefined` on write (`removeUndefined()` in
`app/lib/audit.ts`). When you rename config-driven strings (categories,
sites), note that saved records are **not** relabeled (v1 soft-warning, see
**bmrc-org-config**) — display code must tolerate old values, or you write a
relabeling migration under the rules above.

## Rehearse on the emulator

Before proposing a live run, rehearse: start `npm run emulator`, seed with
`npm run seed` (extend `scripts/emulator/seed.ts` with a fixture doc in the
legacy shape if needed), point the script at the emulator (set
`FIRESTORE_EMULATOR_HOST=127.0.0.1:8080` and the `demo-bmrc-logistics`
project), run it for real there, and inspect results in the emulator UI
(`http://127.0.0.1:4000`). Only then show the user the production dry-run.
