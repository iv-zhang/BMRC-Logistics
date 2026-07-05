---
name: bmrc-debugging
description: >
  Symptom → cause → fix playbook for BMRC Logistics. USE THIS SKILL when
  investigating a bug, wrong number, wrong status, missing item, stale
  config, permission weirdness, build failure, crash, or console error —
  before proposing a fix. It maps the recurring failure classes of this
  codebase to their real causes. Keywords: bug, debug, broken, wrong count,
  wrong status, not updating, missing, stale, error, crash, undefined,
  Timestamp, permission denied, build fails, investigate, root cause.
---

# BMRC Debugging Playbook

Work the playbook before inventing a theory: most "new" bugs here are a known
failure class. Reproduce on the emulator (`npm run dev:emulator` +
`npm run seed` — see **bmrc-testing**), never by poking production. Inspect
raw docs in the emulator UI (`http://127.0.0.1:4000`).

## Wrong numbers / wrong status

| Symptom | Likely cause | Fix |
|---|---|---|
| Two pages disagree on stock or status chip | One of them re-implemented the math locally | Both must import `computeBagStock` / `getItemStatus` from `app/lib/item-status.ts` |
| Item shows expired though the expired lot is used up | Zero-stock **tombstone batch** carries the old expiration | Expiry checks must filter with `batchHasStock()` (see **bmrc-domain**) |
| Item reads `ok` but its only stock is expired/quarantined | Decision used `totalItems` (physical) instead of `availableItems` (deployable) | Use `availableItems` for any readiness decision |
| Pack shows full/Ready right after a heavy call | Pack status hardcoded or `currentQuantity` not written | Status must be derived in `logStatpackCheckOff`; see **bmrc-statpack-flows** |
| "Verified" audit state wrong at month rollover | Trusted the sticky `auditVerified` boolean | Verified = `isAuditedThisMonth(lastAuditDate)`; statpacks use `isStatpackAuditCurrent` |
| Oxygen tank flagged out-of-stock | O₂ is PSI/status-tracked, not counted | `getItemStatus` special-cases `isOxygen`; don't count it |

## Items lost or duplicated

| Symptom | Likely cause | Fix |
|---|---|---|
| Moved item vanished from a location/room filter (or shows in two places) | `storageLocation` written directly; legacy `location`/`room`/`currentLocation` mirrors not synced | All moves go through `moveItemLocation` / `moveItemsBulk` (`app/lib/audit-actions.ts`) |
| Items reference a zone/shelf that doesn't exist | Rename/delete bypassed the Storage Management editors' propagation | Editors propagate renames and clear refs before delete — restore that path, then write a cleanup consistent with **bmrc-migrations** |
| A received lot replaced an existing one | Shipment write bypassed `addShipment` | INV-3; use `addShipment` (bag: new sealed batch; box: `unopenedBoxes` increment + tombstone) |

## Stale or ignored configuration

| Symptom | Likely cause | Fix |
|---|---|---|
| Admin edits in `/settings` don't show without reload (or ever) | Config read at **module scope**, or from frozen constants (`THRESHOLDS`, `LOCATIONS`) | Read via `useOrgConfig()` / store getters **inside render**; see **bmrc-org-config** |
| Deleted all entries of a config list; defaults came back | `pickArray` merge: empty array falls back to defaults | By design — empty lists are not configurable |
| Old category/site names on old records after a rename | Renames don't relabel saved records (v1) | Tolerate unknown strings in display code |

## Crashes & console errors

| Error | Cause | Fix |
|---|---|---|
| `Unsupported field value: undefined` on write | Firestore rejects `undefined` | Wrap payload in `removeUndefined()` / `deepRemoveUndefined()` (`app/lib/audit.ts`) |
| `date.getTime is not a function` / dates render as objects | Firestore `Timestamp` passed where `Date` expected | `.toDate()` on read; deep-hydrate like `hydrate()` in `scripts/emulator/harness.ts` |
| `useSearchParams() should be wrapped in a suspense boundary` (build) | Static export doesn't allow it | Read `window.location.search` in an effect (see **bmrc-new-page**) |
| Build error about dynamic route / `generateStaticParams` | Added a `[id]` segment for runtime Firestore IDs | Static route + `?id=` query params |
| `Unknown storage zone '<id>' — scan to a non-existent location is refused` | Working as intended (INV-12) | Fix the caller's zone id; never bypass the check |
| Emulator tests print red "ABORTED — PRODUCTION FIRESTORE CONFIG DETECTED" | Ran outside `firebase emulators:exec` / wrong project | Use the npm `test:*` scripts; the guard is correct |

## Auth / permission weirdness

- Wrong nav or missing pages for a user → check `localStorage.bmrc_role_override`
  first; it silently overrides the real role (sidebar has a toggle that sets it).
- Admin check is exactly `role === 'admin' || role === 'quartermaster'` — a
  page checking only `'admin'` breaks quartermasters.
- Audit access is role **or** the per-user `canAudit` flag (`canUserAudit`).
- `org_settings` write warnings for members are expected (seed is swallowed).

## UI rendering

Black-screen dark mode, gradient/loading flashes, sidebar clipping, phone
overflow → these are design-system violations; open the **bmrc-ui** skill
(its five rules + responsive section) rather than patching symptoms.

## When it's genuinely new

1. Reproduce on the emulator with seeded data; find the smallest failing flow.
2. Read the doc trail: the domain doc + its `inventory_logs`/`statpack_logs`
   row + `auditEvents` entry. A missing row tells you which write path was
   bypassed (triple-write rule, **bmrc-audit-workbench**).
3. Check whether an invariant test already encodes the expectation
   (`scripts/emulator/invariants/`) — run `npm run test:invariants`.
4. Fix in `app/lib/` (not in a component), then add the missing INV test so
   the class of bug stays dead (recipe in **bmrc-testing**).
