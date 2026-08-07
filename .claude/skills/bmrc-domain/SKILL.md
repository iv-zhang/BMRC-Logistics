---
name: bmrc-domain
description: >
  Data model, stock math, and hard invariants for the BMRC Logistics app.
  USE THIS SKILL before touching anything that reads or writes inventory,
  batches/lots, stock counts, item status, expiration, locations, assets, or
  Firestore documents — including bug fixes that "just" change a number.
  Keywords: inventory, stock, batch, lot, expiration, expired, quantity,
  on-hand, available, location, zone, shelf, container, asset, Firestore,
  data model, invariant, status, low stock, out of stock, quarantine, recall.
---

# BMRC Domain Model & Invariants

This app tracks EMS medical supplies. Wrong stock math means a crew opens a bag
in the field and the epinephrine isn't there, or is expired. The invariants
below are enforced by an emulator test suite (`npm run test:invariants`,
INV-1 … INV-12) and by design decisions baked into `app/lib/`. **Never regress
them, and never re-implement the math they protect — import it.**

## Single sources of truth (import, never re-implement)

| Question | Answer lives in |
|---|---|
| How much stock does this item have? | `computeBagStock()` — `app/lib/item-status.ts` |
| What status chip does it get? | `getItemStatus()` — `app/lib/item-status.ts` |
| Where is it? (display string) | `displayLocation()` — `app/lib/item-status.ts` |
| Is it an asset? | `determineIsAsset()` — `app/lib/inventory.ts` |
| Is it audit-verified this cycle? | `isAuditedThisMonth()` / `isStatpackAuditCurrent()` — `app/lib/item-status.ts` |
| Thresholds / expiry windows | `getThresholds()` — `app/lib/org-config-store.ts` (see the **bmrc-org-config** skill) |

If a page shows a count or a status chip computed any other way, that is a bug.
The inventory page, audit page, and dashboard must all agree because they all
import from `item-status.ts`.

## The two stock models

`InventoryItem` (defined in `app/types.ts`) supports two mutually exclusive
tracking modes. `computeBagStock()` picks the mode automatically:

1. **Bag/lot-tracked** — any batch in `item.batches[]` has `bagCount > 0` or
   `itemsPerBag > 0`. Stock lives **per batch**: `bagCount * itemsPerBag +
   looseItems`. Batches carry `lotNumber`, `expirationDate`, `status`
   (`'quarantined'` for recalls). Batches are the source of truth.
2. **Box-tracked** — item-level `unopenedBoxes`, `itemsPerBox`, `looseUnits`.
   Stock pools on the item; batches exist only as **zero-stock "tombstones"**
   that preserve the lot/expiry paper trail for shipments.

### Physical vs. available — the most important distinction in the codebase

`computeBagStock()` returns both:

- `totalItems` — **physical** on-hand: everything on the shelf, *including*
  expired and quarantined lots. Inventory/audit UIs showing "what is physically
  here" use this.
- `availableItems` — **deployable**: has stock AND not past `expirationDate`
  AND not `status === 'quarantined'`. Every readiness, low-stock, out-of-stock,
  buy-list, or pack-fill decision uses this — **never** `totalItems`. An item
  whose only lot is expired must read `out`, not `ok` (INV-6, INV-7).

### Status precedence

`getItemStatus()`: `expired > out > low > expiring > ok`.
- `expired` only if a batch **with stock** (`batchHasStock()`) has a past
  `expirationDate`. Zero-stock tombstone batches must never flag an item
  expired forever (this was a real bug — see DATA-7 comment in the file).
- Oxygen items (`isOxygen`) skip stock statuses (they're PSI-tracked assets).
- `low` when `0 < availableItems <= item.reorderThreshold`.
- `expiring` window comes from `getThresholds().expirationWarningDays`.

## Location model (structured is truth, legacy is mirror)

`item.storageLocation: StorageLocationRef` (`{ zoneId, zoneName, shelfId,
shelfName, level, containerId, containerName }`, `app/types.ts:83`) is the
**single source of truth** for where an item lives. Legacy `location` / `room`
and asset `currentLocation` are **denormalized mirrors, synced FROM the
structured ref — never the reverse.** Invariants (all enforced in
`app/lib/audit-actions.ts` and the Storage Management editors):

- Every move goes through `moveItemLocation()` / `moveItemsBulk()`. They
  resolve the destination zone doc (`storage_zones/{zoneId}`) and write
  `location`, `room`, and `currentLocation` to match — so legacy filters still
  find a moved item. **Never write `storageLocation` with a raw `updateDoc`.**
- A move to a `zoneId` with no zone doc is **rejected with a throw** (INV-12).
  Never silently write a phantom location.
- Renaming a zone/shelf/container propagates the new denormalized name to every
  referencing item (batched query on `storageLocation.{zoneId|shelfId|containerId}`).
- Deleting a shelf/container clears dangling refs on affected items first.
- `StorageZone.level?: 'upper' | 'lower'` is the building floor. Zones are
  edited in `/storage`, not `/settings`.

## Asset model

- `determineIsAsset()` (`app/lib/inventory.ts:1499`) treats an item as an asset
  on **any** asset signal: serial, status, asset category, `assets[]`,
  `maintenance_logs`, `isOxygen` — not just `assetValue ≥ threshold`.
- Assets are **status-tracked, never counted**. In pack check-offs, entries
  with `serialNumber`/`assetInstanceId` are excluded from quantity math.
- `InventoryItem.isTrainer` marks training gear (trainer AEDs, manikins) —
  still an asset, but filtered out of every deployable/readiness view.

## Two-pool stock model (back reserve / front shelf)

A **different axis** from bag- vs. box-tracking above: every consumable also
splits into two pools.

- **Back reserve** — the item's batch/box counts (`batches[]`, or
  `unopenedBoxes`/`looseUnits`). This is what `computeBagStock().availableItems`
  returns and the **only** pool that drives `getItemStatus` (ok/low/out/
  expired/expiring) and reordering. An item with a full front shelf but an
  empty back room still correctly reads `out` — the shelf is never a substitute
  for reserve in that math, **on purpose** (see the comment at `getItemStatus`
  in `app/lib/item-status.ts`).
- **Front shelf** — `InventoryItem.shelfQuantity`, the deployed pool members
  actually grab from day to day. It is deliberately **not event-tracked**:
  general members won't reliably log every unit they take, so instead of
  instrumenting consumption, roughly weekly someone physically counts the shelf
  and that count **re-anchors** `shelfQuantity` to reality.
  `lastShelfCheckAt`/`lastShelfCheckBy` stamp the check; `isShelfCheckCurrent()`
  (`app/lib/item-status.ts`) tests it against
  `getThresholds().shelfCheckIntervalDays` (default 7).
- **`refillShelf()`** (`app/lib/restock-actions.ts`, pool math in
  `app/lib/stock-pools.ts`) is a **transfer, never a stock creation**. It moves
  units reserve→shelf via `consumeReserveUnits` (FEFO,
  loose-before-breaking-bags/boxes, clamped to what reserve actually has) and
  either increments `shelfQuantity` (plain refill) or, when `observedShelfQty`
  is passed, **SETS** it to `observedShelfQty + consumed` (the weekly
  re-anchor). A check can also run with no transfer at all (`qty: 0` +
  `observedShelfQty`) to record a count without touching reserve. UI:
  `RefillModal` / `ShelfSweepModal` in `app/restock/page.tsx`.
- **Do not conflate this with the deferred class-use vs. field/event stock-pool
  gap** (D-11, "Known open design gaps" in `CLAUDE.md`). That gap is about
  *which reserve* a draw comes from; this split is about
  *deployed-but-uncounted* vs. *counted-and-available* stock **within** a single
  reserve.

## Audit cycles

- **Supplies: monthly calendar cycle.** An item is verified only if
  `lastAuditDate` falls in the current calendar month (`isAuditedThisMonth`).
  The sticky `auditVerified` boolean is meaningless across months — never
  trust it alone.
- **Statpacks: biweekly.** `isStatpackAuditCurrent()` checks age against
  `getThresholds().statpackAuditIntervalDays`.

## Firestore conventions

Collections: `inventory` (the central collection — consumables, assets, oxygen
and medications are **all** `inventory` docs discriminated by flags; there is
**no** separate `assets` collection), `inventory_logs`, `inventory_alerts`,
`statpacks`, `statpack_logs`, `vehicles`, `vehicle_logs`, `restock_shelves`,
`restock_shelf_events`, `restock_actions`, `restock_reports`, `auditEvents`
(camelCase — the audit ledger, written by `app/lib/audit.ts`), `issue_reports`,
`buyList` (camelCase — **not** `buy_list`), `tasks`, `users`, `storage_zones`,
`shelves`, `containers`, `box_logs`, `medication_logs`, `org_settings`,
`laf_records`, `reconciliation_exceptions`, `events` (+ `teams[]`),
`shift_requests`, `notifications`. Shapes are in `MODEL.md`.

Rules that bite:

- **Firestore rejects `undefined` field values.** Wrap every write payload in
  `removeUndefined()` / `deepRemoveUndefined()` from `app/lib/audit.ts`.
- **Timestamps hydrate to `Date` on read.** Firestore returns `Timestamp`
  objects; the pure helpers (`computeBagStock`, `getItemStatus`, …) expect
  `Date`. Every read path must call `.toDate()` (see `hydrate()` in
  `scripts/emulator/harness.ts` for the canonical deep-conversion).
- All reads are real-time `onSnapshot` listeners — there is no REST layer.
- Meaningful writes are **triple writes**: the domain change + a log row
  (`inventory_logs` / `statpack_logs` / …) + an `auditEvents` ledger entry, so
  usage metrics stay derivable. See the **bmrc-audit-workbench** skill.
- Multi-doc consistency uses Firestore transactions or `writeBatch` (500-op
  limit); `logStatpackCheckOff` is the reference transaction.

## The Tier-1 invariant contract (INV-1 … INV-12)

Tested by `scripts/emulator/invariants/inv-XX.test.ts`. Any change touching
stock, lots, or locations must keep these green (`npm run test:invariants`):

1. Over-consumption is refused, never underflowed (no negative stock).
2. Lot-sum equals total on-hand.
3. A second lot does not overwrite the first.
4. A dated SKU cannot receive a lot with no expiration.
5. FEFO — draws take the earliest-expiring lot first.
6. Expired lots are excluded from available quantity.
7. A recall quarantines a lot everywhere and flips affected packs.
8. Readiness is derived and conservative (never hardcoded green).
9. A below-par SKU appears on the buy list only once.
10. Class/training draws do not deplete the field pool.
11. Controlled-substance receipt is LAF-gated and logged.
12. A scan to an unknown location code is rejected.

## Before you ship a data-touching change

1. Does any new count/status math live outside `item-status.ts`? Move it there.
2. Did you write `storageLocation` without syncing mirrors? Use `moveItemLocation`.
3. Did you use `totalItems` where a decision needed `availableItems`?
4. Run `npm run test:invariants` (and `npm run test:properties` if you touched
   `computeBagStock`/`getItemStatus`). See the **bmrc-testing** skill.
