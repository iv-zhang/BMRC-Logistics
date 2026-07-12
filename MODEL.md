# MODEL.md — BMRC Logistics data model & flow trace

Read-only analysis of the current codebase (no code changed). Two parts:

1. **Firestore collections & document shapes** — every collection actually
   touched by `collection(db, …)` / `doc(db, …)`, with the field shape and the
   type that backs it.
2. **Flow traces** — step-by-step, file:line, for the five flows requested,
   each ending with a verdict on whether lots / expiration / recall / readiness
   are **first-class data**, **implicit/denormalized**, or **absent**.

The type source is [app/types.ts](app/types.ts). The runtime org config
(thresholds, categories, locations) lives in Firestore doc `org_settings/current`
with defaults in [app/config/org-config.ts](app/config/org-config.ts).

> **Naming caveat:** CLAUDE.md documents some collections under names the code
> does not actually use. The list below is what the code really reads/writes.
> Divergences are flagged inline (e.g. `buyList` not `buy_list`; there is **no**
> separate `assets` collection — assets are `inventory` docs with `isAsset`).

---

## Part 1 — Firestore collections & document shapes

### `inventory` — master items, assets, lots, variants (one big doc per SKU)
Backed by `InventoryItem` ([app/types.ts:141-312](app/types.ts#L141-L312)). This
is the central collection: consumables, assets, oxygen, and medications are **all**
`inventory` docs, discriminated by flags — there is no separate `assets`,
`medications`, or `lots` collection.

Key fields:
- **Identity/UI:** `id`, `name`, `category` (`ItemCategory`), `description`, `unit`.
- **Box-based stock:** `unopenedBoxes: number`, `itemsPerBox?`, `looseUnits?`,
  `reorderThreshold: number` (par), `maxUnits?`, `parByLocation?: Record<locId, min>`.
  Legacy: `totalStockQuantity?`.
- **Location (denormalized mirrors + structured truth):** `location: LocationType`,
  `room?: HQRoom`, `shelf?`, `bin?`, `backShelf?`, `backLevel?`, and the structured
  `storageLocation?: StorageLocationRef` (`zoneId/shelfId/level/containerId` + denorm
  names). Per CLAUDE.md, `storageLocation` is source of truth; `location`/`room`/
  `currentLocation` are mirrors kept in sync from it.
- **Lots / expiration:** `batches?: InventoryBatch[]` (the lot array — see below),
  `tracksExpiration: boolean`, `expirationDate?`, `expirationPrecision?`,
  `requiresExpirationCheck?`, `hasSecondaryExpiration?`, `daysValidAfterOpening?`.
- **Variants (sizing, distinct from lots):** `hasVariants?`, `variants?: InventoryVariant[]`
  (each can itself carry `batches?`).
- **Asset fields** (used when `isAsset`): `assetSerial?`, `barcode?`, `qr?`,
  `assignedBarcode?`, `assetCategory?`, `assetStatus?: 'Ready'|'Not Ready'|'In Use'|
  'Checked Out'`, `assetLastChecked?`, `assetNextExpiration?`, `checkedOutAt/By`,
  `assetChecks?{batteryStatus,padsSealed}`, `batteryExpiration?`, `padExpiration?`,
  `assets?: AssetInstance[]` (per-unit), `assetValue?`, `maintenance_logs?[]`,
  `verificationPolicy?: AssetVerificationRules`, `parentAssetId?`, `assignedToId?`,
  `statpackAssignment?` (bidirectional link to a pack + pocket).
- **Oxygen:** `isOxygen?`, `oxygenPsi?`, `maxOxygenPsi?`, `oxygenModel?`.
- **Medication:** `isMedication?`, `medicationInfo?: MedicationInfo`
  (`isControlled?`, `deaSchedule?`, `concentration?`, `parLevel?`, `requiresWitness?`, …).
- **Audit:** `auditVerified?: boolean` (sticky), `auditCondition?: 'Good'|'Damaged'|
  'Expired'`, `auditNotes?`, `lastAuditDate?`, `isLegacyItem?`, `isTrainer?`.
- `createdAt`, `updatedAt`.

**`InventoryBatch` (the lot entity — an embedded array element, NOT its own
collection)** ([app/types.ts:93-139](app/types.ts#L93-L139)):
`id`, `lotNumber?`, `expirationDate?`, `openDate?`, `variantId?`, `stock: number`,
`itemsPerBag?`, `bagCount?`, `looseItems?`, `status?: BatchStatus`
(`'sealed'|'open'|'depleted'|'expired'|'quarantined'`), `openedAt/By?`, `receivedAt?`,
`supplier?`, `notes?`, `requiresFIFO?`, `purchase?: PurchaseInfo`, `locations?[]`
(per-location splits), `serialized?`, `serialNumbers?: string[]`,
`assetInstances?: AssetInstance[]`.

**`AssetInstance`** (per-unit metadata, embedded in `inventory.assets[]` or
`batch.assetInstances[]`) ([app/types.ts:583-635](app/types.ts#L583-L635)):
`serial`, `id?`, `assetTag?`, `barcode?`, `qr?`, `status?`, `padExpiration?`,
`batteryExpiration?`, `lastChecked?`, `batteryStatus?`, `padsSealed?`, `oxygenPsi?`,
`nextExpiration?`, `expirationDate?`, `checkedOut/In` fields, `assignedToId?`,
`currentLocation?`, `isTrainer?`.

### `inventory_logs` — append-only change log
`InventoryLog` ([app/types.ts:702-722](app/types.ts#L702-L722)): `itemId?`, `itemName?`,
`action: string` (`'intake'`, `'consume_box'`, `'location_change'`, `'asset_checkout'`,
`'asset_checkin'`, `'issue_reported'`, `'item_remediated'`, `'create_open_batch'`,
`'batch_asset_checkout/checkin'`, `'statpack_validation_warning'`, `'audit_box_count'`, …),
`serialNumber?/serials?`, `batchId?`, `quantity?`, `boxCount?`, `unitsAdded?`,
`before/afterUnopenedBoxes?`, `userId/userName?`, `timestamp`, `location?`, `notes?`,
`newStatus?`, `details?: Record<string,any>`. Written ad-hoc, not schema-validated.

### `inventory_alerts` — restock-needed alerts
Written only by `logRestockNeeded` ([app/lib/inventory.ts:1332-1355](app/lib/inventory.ts#L1332-L1355)):
`itemId`, `itemName`, `alertType: 'restock_needed'`, `currentQuantity`, `parLevel`,
`location`, `userId/userName`, `timestamp`, `resolved: boolean`. No dedicated type.

### `auditEvents` — canonical audit ledger (camelCase)
Written by `recordAuditEvent` / `addAuditEventToBatch` in [app/lib/audit.ts](app/lib/audit.ts).
Shape (from call sites): `eventType`, `source`, `sourceId?`, `actor:{userId,userName?,userEmail?}`,
`targets?: [{collection,docId}]`, `before?`, `after?`, `details?`, `timestamp`. Every
audit-workbench action writes one of these plus the `inventory_logs` row.

### `statpacks` — stat packs (contents & compartments embedded)
`Statpack` ([app/types.ts:377-421](app/types.ts#L377-L421)): `id`, `name`,
`type: 'Primary'|'Secondary'|'Event Bag'`,
`status: 'Ready'|'Restock Needed'|'Expired Items'|'CRITICAL - EXPIRED ITEMS'|'In Use'|'Pending Initial Check'`,
`compartments: StatpackCompartment[]`, `contents: StatpackItem[]`, `isCheckedOut: boolean`,
`assignedToUserId/Name?`, `checkedOutAt?`, `lastCheckedBy/At?`, `lastAuditAt/By?`,
`currentEvent?`, `sharpsContainer?:{status:'ok'|'full'|'na',lastCheckedAt/By}`,
`assetValue?`, `currentLocation?`, `assetSerial?`, `maintenance_logs?[]`, timestamps.

**`StatpackItem`** (embedded content) ([app/types.ts:347-375](app/types.ts#L347-L375)):
`itemId`, `itemDetails?`, `variantId/Name?`, `requiredQuantity` (par),
`currentQuantity` (on-hand source of truth for consumables), `pocket?`, `compartmentId?`,
`batchId: string` (declared REQUIRED), `serialNumber?`, `assetInstanceId?`,
`expirationDate?` (copied from batch for UI), `lotNumber?`, `effectiveExpiration?`,
`requiresExpirationCheck?`, `itemValue?`, `verificationRules?`, `customWarnings?`.

**`StatpackCompartment`**: `id`, `name`, `parentPocket`, `isSealed`, `sealNumber?`,
`expirationDate?`.

### `statpack_logs` — check-off history
`StatpackLog` ([app/types.ts:436-515](app/types.ts#L436-L515)): `statpackId/Name`,
`action: 'checkout'|'checkin'|'restock'|'created'|'maintenance'|'audit'`, `pairId?`,
`quickCheckin?`, `userId/Name`, `timestamp`, `clientTimestamp?`, `notes?`,
`mismatchResolutions?`, `validationWarnings?`, `summary?{totalItems,verifiedCount,
mismatchCount,expiredCount,restockedCount,reportedCount}`, `sharpsCheck?`,
`checkEntries?[]` (rich per-item entries incl. `countedQuantity`, `ok`,
`newExpirationDate`, `oxygenPsi`, `regulatorOk`, `acknowledged`, `issue`), `issues?`,
`itemsUsed?`.

### `vehicles` — individual fleet vehicles (roster + live checkout state)
`Vehicle` ([app/types.ts:932-961](app/types.ts#L932-L961)): `name` ("Ambulance 2"),
`typeId` (a `VehicleDef.id` from org-config — vehicle *types* stay in `org_settings`),
`status: 'active'|'retired'`, `notes?`; live state `isCheckedOut` (authoritative,
statpack pattern), `activeLogId?`, `assignedToUserId/Name?`, `checkedOutAt?`;
last-known readings denormalized from the latest closed log (`lastMileage?`,
`lastFuelLevel?` 0/25/50/75/100, `lastBatteryLevel?` 0–100), `createdAt/By`,
`retiredAt/By?`. Vehicles are retired, never deleted (hard delete only when zero
logs reference them) — logs reference them. Written only via
[app/lib/vehicles.ts](app/lib/vehicles.ts).

### `vehicle_logs` — vehicle shift log (one doc per shift)
`VehicleLog` ([app/types.ts:976-1008](app/types.ts#L976-L1008)): `vehicleId/Name`
(name/type snapshotted at checkout), `vehicleTypeId`,
`status: 'open'|'closed'|'force_closed'` (created `open` at checkout, closed at
check-in; abandoned shifts stay visibly `open` until admin force-close),
`driverUserId/Name`, `crewNames?[]`, `checkoutAt`/`checkinAt?` (+ client
timestamps), `checkinUserId/Name?`, `preReadings?`/`postReadings?` (`mileage?`,
`fuelLevel?`, `batteryLevel?` — applicable fields come from the vehicle type's
reading fields, `getReadingFieldsForVehicleType` in org-config),
`preDamage?`/`postDamage?` (NEW-damage free text; non-empty also opens an
`issue_reports` doc targeting `vehicles/<id>`), `mileageMismatchAck?`, `notes?`,
`forceCloseReason?`. Vehicle doc + log row written in one transaction by
[app/lib/vehicles.ts](app/lib/vehicles.ts).

### `restock_shelves`, `restock_shelf_events`, `restock_actions`, `restock_reports`
Restock-shelf workbench ([app/restock/page.tsx](app/restock/page.tsx)). No dedicated
types in `types.ts`; shapes are inline. `restock_shelves` docs carry `createdAt` +
shelf metadata; `restock_shelf_events` rows carry `shelfId` + event data.
(CLAUDE.md's `restock_logs` name is not used in code.)

### `containers`, `shelves`, `storage_zones` — physical storage graph
`Container` ([app/types.ts:664-687](app/types.ts#L664-L687)): `id`, `name`, `shelfId?`,
`barcode?`, `isBox?`, `isSealed?`, `sealNumber?`, `sealedAt/By/ByName?`,
`boxContents?[]` (`itemId,batchId,quantity,serialNumber?`), `purchase?`.
`Shelf` ([app/types.ts:650-662](app/types.ts#L650-L662)): `id`, `name`, `zoneId?`,
`capacity?`, `barcode?`, `numberOfLevels?`, `levelLabels?[]`.
`StorageZone` ([app/types.ts:638-648](app/types.ts#L638-L648)): `id`, `name`,
`locationType: LocationType`, `room?: HQRoom`, `level?: 'upper'|'lower'`.

### `box_logs` — sealed-box seal/break events
`BoxLog` ([app/types.ts:689-699](app/types.ts#L689-L699)): `boxId`,
`action: 'sealed'|'unsealed'|'inventory_check'|'break_seal'`, `userId/Name?`, `timestamp`,
`sealIntact?`, `notes?`, `itemsCounted?: Record<itemId,number>`.

### `medication_logs` — narcotic-log-style ledger
`MedicationLog` ([app/types.ts:822-858](app/types.ts#L822-L858)): `medicationId/Name`,
`action: 'check_out'|'check_in'|'administered'|'wasted'|'expired_disposal'|
'inventory_count'|'received'`, `lotNumber`, `expirationDate`, `quantity`,
`runningCount`, `performedBy{userId,userName}`, `witness?`, `location?`, `reason?`,
`pcrNumber?`, `notes?`, `concentration?`, `route?`, `timestamp`. Written only from
[app/components/medication-cabinet-modal.tsx:214](app/components/medication-cabinet-modal.tsx#L214).

### `buyList` — admin shopping list  ⚠ code uses `buyList`, not `buy_list`
`BuyListItem` ([app/types.ts:725-743](app/types.ts#L725-L743)): `itemName`, `quantity?`,
`unit?`, `category?`, `priority`, `notes?`, `linkedInventoryId?`,
`status: 'pending'|'ordered'|'received'`, `addedBy/Name`, `addedAt`, `orderedAt?`,
`receivedAt?`, `completedBy/Name?`. Read/written at
[app/buy-list/page.tsx:102,198](app/buy-list/page.tsx#L102) and surfaced as tasks in
[app/tasks/page.tsx:124](app/tasks/page.tsx#L124).

### `tasks` — logistics task list
`TaskItem` ([app/types.ts:759-788](app/types.ts#L759-L788)): `title`, `description?`,
`definitionOfDone?`, `category: TaskCategory`, `priority`,
`status: 'backlog'|'this_cycle'|'in_progress'|'blocked'|'done'` (legacy docs may contain
`'todo'`; readernpm rs normalize it to `'backlog'`), `quantity?`, `unit?`,
`linkedInventoryId?`, `linkedBuyListId?`, `createdBy/Name`, `assignedTo/Name?`,
`dueDate?`, `completedAt/By/Name?`, timestamps.

### `team_tasks` — Logistics Committee kanban board
`TeamTask` ([app/types.ts:790-812](app/types.ts#L790-L812)): `title`, `ownerId`,
`ownerName` (denormalized from `users/{uid}.fullName`),
`status: TeamTaskStatus = 'backlog'|'this_cycle'|'in_progress'|'blocked'|'done'`,
`definitionOfDone`, `dueDate?`, `createdBy/Name`, `createdAt`,
`completedAt/By/Name?` (stamped on entering `done`, cleared on leaving). Deliberately
separate from `tasks` so committee todos never mix with buy/fix/restock ops. Owner is
always required. Read/written only from
[app/committee-board/page.tsx](app/committee-board/page.tsx) via
[app/hooks/useTeamTasks.ts](app/hooks/useTeamTasks.ts). Visibility: admins/quartermasters
plus users with `isCommitteeMember: true` (UI gating only; rules deferred to the
rules-hardening track).

### `issue_reports` — triage tickets
`IssueReport` ([app/types.ts:777-817](app/types.ts#L777-L817)): `reporter{userId,userName,
userEmail,isAnonymous}`, `target?{collection,docId}`, `type`, `priority`, `status`,
`title`, `description`, `reproductionSteps?`, `pagePath?`, `component?`, `assignedTo?`,
`comments?[]`, `attachments?[]`, `linkedAuditId?`, timestamps.

### `users`, `org_settings`, plus minor collections
- `users` — `User` ([app/types.ts:27-41](app/types.ts#L27-L41)): `fullName`, `email`,
  `role: 'admin'|'member'|'FTO'|'quartermaster'|'inventory_helper'`, `canAudit?`,
  `isCommitteeMember?` (Committee Board access for non-admins), `tutorialCompleted?`,
  timestamps.
- `org_settings/current` — runtime org config (thresholds, categories, locations,
  statpack types), merged over `DEFAULT_ORG_CONFIG` by
  [app/lib/org-config-store.ts:38-40](app/lib/org-config-store.ts#L38-L40).
- Also referenced: `purchase_history`, `purchase_requests`, `audit_locks`
  (transient/support collections, no domain type).

**Thresholds actually modeled** ([app/config/org-config.ts:310-332](app/config/org-config.ts#L310-L332)):
`assetValueThreshold: 500`, `expirationWarningDays: 90`, `o2PsiMin: 1800`,
`statpackAuditIntervalDays: 14`. There is **no** glucometer-control-test interval,
**no** AED-check interval, **no** recall/quarantine threshold.

---

## Part 2 — Flow traces

### (a) Receiving a SECOND lot of an existing SKU (different exp date)

**Entry point:** `addShipment(item, input, actor)`
[app/lib/audit-actions.ts:181-266](app/lib/audit-actions.ts#L181-L266) (Audit
workbench → Shipment action). `ShipmentInput` = `{qty, perUnit, lotNumber?,
expirationMonth?, supplier?, notes?}`.

Step-by-step:
1. `bagTracked = computeBagStock(item).hasBagTracking` — branches on whether the
   item already tracks bags (line 186).
2. `expirationDate = new Date(input.expirationMonth + '-01')` if a month string was
   given, else `undefined` (line 187-189). **No guard forcing a date for dated SKUs.**
3. **Bag-tracked branch (line 193-210):** builds a `newBatch` with a fresh
   `crypto.randomUUID()` id, its own `lotNumber`, `expirationDate`, `stock = qty*perUnit`,
   `bagCount`, `itemsPerBag`, `status:'sealed'`, and appends it with
   `arrayUnion(newBatch)`. Because the id is unique, **a distinct lot is created; the
   prior lot is untouched.** ✔ INV-3 holds for bag-tracked items.
4. **Box-tracked branch (line 211-230):** does `unopenedBoxes: increment(qty)` — the
   count is pooled onto a single scalar, **not** a per-lot quantity. A metadata batch
   is appended via `arrayUnion` **only if** `lotNumber || expirationDate` was entered,
   and that batch is written with `stock: 0` (a "tombstone" for traceability, line 219-228).
5. Writes an `inventory_logs` row `action:'intake'` (line 233-250) and an `auditEvents`
   `shipment_received` entry (line 252-265).

**Modeling verdict:**
- **Lots:** first-class **only for bag-tracked items** (each shipment = a real
  `InventoryBatch` with its own stock). For box-tracked items lots are **implicit** —
  quantity collapses into `unopenedBoxes` and the batch that is created carries
  `stock: 0`, so a second box lot's *quantity* is not separable from the first.
- **Expiration:** first-class on the batch object, but **optional** — a blank
  `expirationMonth` yields no date and (box branch) no batch at all. Two cartons with
  different exp dates persist as two batches for bag-tracked items; for box-tracked
  items both dates persist as zero-stock tombstones but their quantities do not.
- **Recall:** not involved.
- **Readiness:** not computed here.

---

### (b) Consuming / decrementing a SKU

There is no single "consume N units of SKU X, FEFO" primitive. Three distinct paths
touch on-hand quantity:

1. **`consumeBox(itemId, boxCount, opts)`**
   [app/lib/inventory.ts:1525-1601](app/lib/inventory.ts#L1525-L1601) — "open a sealed
   box." Reads the doc, guards `currentUnopened < boxCount → throw` (line 1545-1547, so
   **no underflow** on this path), then `unopenedBoxes: currentUnopened - boxCount` and
   moves `boxCount*itemsPerBox` units into an **OPEN** batch (`lotNumber:'OPEN'`), and
   logs `consume_box`. This *moves sealed→open*; it does not model field consumption of
   individual units, and it does **not** pick a lot by expiration.
2. **`submitAuditEntries(entries, …)`**
   [app/lib/audit-helpers.ts:360-489](app/lib/audit-helpers.ts#L360-L489) — the Count
   action. For a disposable it **overwrites** `unopenedBoxes: countedBoxes` (line 406-407)
   to whatever was physically counted; it does not subtract. For **bag-tracked** items it
   deliberately does **not** write the count (line 393-404) — it only stamps
   `auditVerified`, leaving batch reconciliation manual. So a real drawdown is captured
   only as a later recount, and only for box-tracked items.
3. **Statpack check-off** `logStatpackCheckOff`
   [app/lib/inventory.ts:281-656](app/lib/inventory.ts#L281-L656) — sets
   `content.currentQuantity = e.countedQuantity` per pack item (line 538-540). This is a
   **set from observed count**, not a decrement, and only mutates the embedded pack
   content, never the backing `inventory` batch.

There is **no** code path anywhere that draws `stock` down from a specific
`InventoryBatch`, and nothing references FEFO/FIFO for consumption (`requiresFIFO` on
the batch type is never read; `earliestExpiration` in
[app/lib/audit-helpers.ts:212-223](app/lib/audit-helpers.ts#L212-L223) is computed for
**display only**).

**Modeling verdict:**
- **Lots:** per-lot quantity exists as `batch.stock`, but consumption never decrements
  it — lots are **not** the unit of consumption. On-hand truth is the scalar
  `unopenedBoxes` (box items) or the sum of `batch.stock/bagCount` (bag items).
- **Underflow protection:** present on `consumeBox` (explicit throw); **absent** on the
  count/check-off paths, which are absolute overwrites, so "consumed more than on hand"
  is expressed as a low/negative-looking recount, not refused.
- **FEFO:** **absent** as an executable rule.
- **Expiration / recall / readiness:** not evaluated during consumption.

---

### (c) Marking a lot or SKU recalled

**There is no recall flow.** A full-tree search for `recall`/`quarantine` as an
*action* finds nothing that sets state:
- `BatchStatus` includes the literal `'quarantined'`
  ([app/types.ts:79](app/types.ts#L79)), and it appears as a **manual dropdown option**
  in the add/edit item form
  ([app/components/additemmodal.tsx:24,655](app/components/additemmodal.tsx#L24)) — an
  admin can hand-set one batch's `status` to `'quarantined'`.
- **Nothing consumes that status.** `getItemStatus`
  ([app/lib/item-status.ts:90-105](app/lib/item-status.ts#L90-L105)) never inspects
  `batch.status`; it only checks stock and `expirationDate`. So a `'quarantined'` batch
  still counts toward available stock and still lets a pack read "Ready."
- There is no cross-location cascade, no "recall a lot everywhere," and no linkage from
  a recalled lot to the statpacks that contain it. `StatpackItem.batchId` exists
  ([app/types.ts:357](app/types.ts#L357)) so a pack *could* be matched to a lot, but no
  code queries packs by `batchId`.

**Modeling verdict:**
- **Recall state:** **absent** as first-class data. The closest primitive is a manual,
  per-batch `status:'quarantined'` string that is **inert** — read nowhere.
- **Cascade / atomicity:** **absent** — this is a BLOCKER for INV-7 / HR-9: the concept
  cannot be expressed against the current model without adding a recall entity and
  wiring `batch.status` into `getItemStatus` and pack readiness.

---

### (d) Computing / displaying whether a Statpack is "service-ready"

Readiness is **not** a derived `service-ready` boolean. It is a stored string enum
`Statpack.status` plus two independent client-side recomputations.

**Where `status` is written** — `logStatpackCheckOff`
[app/lib/inventory.ts:576-600](app/lib/inventory.ts#L576-L600). During check-in/audit,
`deriveStatus()` returns:
```
if (anyExpired)                                   → 'Expired Items'
else if (anyShortConsumable || sharps === 'full') → 'Restock Needed'
else                                              → 'Ready'
```
where the signals are accumulated over `checkEntries` (line 524-560):
- `anyExpired` — an entry whose `newExpirationDate ?? expirationDate` is in the past,
  **or** whose reported `issue.type` is `broken`/`expired` (line 548-551).
- `anyShortConsumable` — a non-asset entry with `countedQuantity < requiredQuantity`
  and `restockStatus !== 'restocked'` (line 553-559).
- Checkout unconditionally sets `status:'In Use'` (line 583-586).

Notably, `deriveStatus` uses **only what the member entered on this check-off**. It does
**not** read AED battery/pads currency, O2 charge, glucometer control-test recency, or
recall state — none of those inputs exist in the derivation. Asset problems are surfaced
separately as `validationWarnings` by `validateStatpackAssignments`
([app/lib/inventory.ts:733-923](app/lib/inventory.ts#L733-L923)) which flags
`asset_status`/`asset_expired`, but those warnings **do not feed** `deriveStatus` or the
stored `status`.

**Where readiness is displayed** — two places recompute independently from
`contents[].expirationDate`, *not* from the stored `status` alone:
- Dashboard `getPackTier`/`getPackChips`
  [app/dashboard/page.tsx:40-66](app/dashboard/page.tsx#L40-L66): treats `'Ready'` **or**
  `'Pending Initial Check'` (with no expired content) as `ready`, and independently scans
  `pack.contents` for past `expirationDate` to add an "Expired items" chip.
- Member dashboard [app/dashboard/member-dashboard.tsx:511](app/dashboard/member-dashboard.tsx#L511)
  keys UI off `pack.status === 'Ready'`.

**Modeling verdict:**
- **Readiness:** stored as a **plain string enum**, derived only from the current
  check-off's counts/expirations + sharps flag. It is **partially derived** (expiry +
  short-count) but **not conservative**: AED/O2/glucometer/recall inputs are not part of
  the computation, and an "unknown" input does not force not-ready. `'Pending Initial
  Check'` is even shown as `ready` on the dashboard.
- **Expiration:** first-class in the derivation (past-dated content flips to
  `'Expired Items'`), but only over content the member touched this pass.
- **Recall:** **absent** from readiness entirely.
- **Lots:** not consulted for readiness beyond the content's copied `expirationDate`.

---

### (e) Post-event buy-list scan that flags an item for reorder

**There is no scan-driven or automatic reorder pipeline.** The buy list is a
**manually authored** list:

1. `analyzeRestockNeeds(items)`
   [app/lib/audit-helpers.ts:510-544](app/lib/audit-helpers.ts#L510-L544) compares
   `totalUnits` vs `reorderThreshold` and emits `RestockDecision` recommendations with an
   `urgency`. **This function only returns data for display — it never writes anything.**
2. `logRestockNeeded(...)`
   [app/lib/inventory.ts:1332-1355](app/lib/inventory.ts#L1332-L1355) writes an
   `inventory_alerts` doc, but is not called from any scan/event-close flow (it is a
   standalone helper).
3. The actual `buyList` docs are created by a human in the Buy List UI —
   `addDoc(collection(db, "buyList"), { …, status:"pending" })`
   [app/buy-list/page.tsx:198-205](app/buy-list/page.tsx#L198-L205) — with free-text
   `itemName` and optional `linkedInventoryId`. There is **no dedupe**: nothing checks
   whether an item is already `pending`/`ordered` before inserting, and there is no query
   keyed on `linkedInventoryId`.
4. `buyList` is mirrored into the Tasks view read-only
   [app/tasks/page.tsx:124-155](app/tasks/page.tsx#L124-L155).

The "post-event scan → auto-flag below-par item" behavior described in the spec does
not exist: below-par detection (`getItemStatus → 'low'`,
[app/lib/item-status.ts:101](app/lib/item-status.ts#L101)) drives status **chips** only;
it is never wired to create a `buyList` entry.

**Modeling verdict:**
- **Reorder trigger:** **absent** as an automated derivation. Below-par is computed for
  display; converting it to an order is a manual human step.
- **Dedup (INV-9):** **absent** — no guard against a SKU appearing on the list twice.
- **Lots / expiration / recall / readiness:** not involved; the buy list has no lot or
  expiration linkage and no `linkedInventoryId`-keyed lookup.

---

## Summary table — is each concept first-class?

| Concept | Status in model | Where |
|---|---|---|
| **Lot / batch** | First-class **only for bag-tracked** items (`InventoryBatch[]`). Box-tracked lots collapse into `unopenedBoxes` + `stock:0` tombstones. Never the unit of consumption. | [types.ts:93](app/types.ts#L93), [audit-actions.ts:181](app/lib/audit-actions.ts#L181) |
| **Expiration date** | First-class on batch/item, but **optional** at intake; a blank date is silently allowed. Read for status/readiness only over stocked, member-touched entries. | [item-status.ts:90](app/lib/item-status.ts#L90), [inventory.ts:548](app/lib/inventory.ts#L548) |
| **Recall state** | **Absent.** Only an inert manual `batch.status:'quarantined'` that no logic reads. No cascade. | [additemmodal.tsx:24](app/components/additemmodal.tsx#L24) |
| **Statpack readiness** | Stored **string enum**, derived from current check-off's counts+expiry+sharps only. Not conservative; ignores AED/O2/glucometer/recall/unknown inputs. | [inventory.ts:576](app/lib/inventory.ts#L576) |
| **Reorder / buy list** | **Manual.** Below-par is display-only; no auto-flag, no dedup, no lot linkage. | [buy-list/page.tsx:198](app/buy-list/page.tsx#L198), [audit-helpers.ts:510](app/lib/audit-helpers.ts#L510) |
| **FEFO consumption** | **Absent.** `requiresFIFO`/`earliestExpiration` exist but are never used to pick a lot. | [audit-helpers.ts:212](app/lib/audit-helpers.ts#L212) |
| **LAF gate for controlled items** | **Absent.** `medication_logs` supports `witness`, but no LAF entity and no receive/dispense gate. | [types.ts:822](app/types.ts#L822) |
| **`ROOM-UNIT-SHELF-BIN` location codes** | **Absent as a code scheme.** Locations are structured Firestore refs (`zoneId/shelfId/containerId`); no parse/validate-on-scan of a string code. | [types.ts:83](app/types.ts#L83) |
