# BMRC Logistics — Invariants & Human-Resilience Gap Analysis

Ground-truth spec for testing `bmrc-logistics`, **mapped to the actual schema**.
Each INV/HR rule below now names the real collection/field it applies to, is
marked **ENFORCED / PARTIAL / ABSENT**, and cites the `file:line` that enforces it
(or where enforcement would have to live). Cross-reference: [MODEL.md](MODEL.md).

> Nothing here is fixed yet — this is the gap analysis only.

## Design principles (why these rules exist)

BMRC members are not strict data-entry users. The realistic failure is a **skipped,
late, or approximate** action — not a malicious one. Every rule serves one of three
principles: **(1) Fail safe, not optimistic** — missing/unknown/stale data must
resolve to *not available* / *not service-ready*, never green. **(2) Derive, don't
assert** — availability, expiry, and readiness are *computed* from lot/maintenance
state, never a bare checkbox. **(3) Assume lossy input** — any step a member can skip
needs a reconciliation/exception surface that catches the skip.

---

## ⛔ BLOCKERS — invariants that cannot even be expressed today

These fail because the **data model lacks the concept**. Any test written against
them tests nothing until the model is extended. List these before writing tests.

| Blocker | Missing concept | Consequence |
|---|---|---|
| **B-1 (INV-7, HR-9) — No recall / quarantine state that anything reads.** | `InventoryBatch.status` includes the literal `'quarantined'` ([app/types.ts:79](app/types.ts#L79)) and it is a manual dropdown in the item editor ([app/components/additemmodal.tsx:24](app/components/additemmodal.tsx#L24)), but **no code reads `batch.status`**. `getItemStatus` ([app/lib/item-status.ts:90-105](app/lib/item-status.ts#L90-L105)) and pack readiness never consult it. There is no recall entity, no cross-location cascade, and no query of statpacks by `batchId`. | A "recalled" lot still counts as available and still lets a pack read Ready. INV-7/HR-9 are untestable until a recall state exists **and** is wired into stock + readiness. |
| **B-2 (INV-10) — No separate class vs field/event stock pools.** | `InventoryItem` has one stock dimension (`unopenedBoxes` / batch `stock`). There is no pool/purpose axis on stock or on any draw. | "Class draws must not deplete field stock" cannot be expressed — there is only one pool. |
| **B-3 (INV-11, part) — No LAF (authorization) entity or gate.** | No `LAF`/authorization concept anywhere. `medication_logs` ([app/types.ts:822-858](app/types.ts#L822)) records `witness?` for controlled meds but nothing gates *receipt or dispense* on a LAF being on file. | The legal gate in INV-11/HR-* cannot be checked; only the "immutable log" half exists. |
| **B-4 (INV-12) — No `ROOM-UNIT-SHELF-BIN` location-code scheme.** | Locations are structured Firestore refs (`StorageLocationRef` = `zoneId/shelfId/level/containerId`, [app/types.ts:83-91](app/types.ts#L83)), resolved by document ID — not a parseable string code. There is no scan-to-code parser/validator and no "reject unknown code" path. | INV-12 as written (validate `STA-Z9-99`, reject unknown) cannot be expressed against the current location model. |
| **B-5 (INV-2/3/4, box-tracked items) — Box-tracked SKUs have no per-lot quantity.** | For box-tracked items `addShipment` pools quantity onto the scalar `unopenedBoxes` via `increment()` and writes any lot/exp as a **`stock: 0` tombstone batch** ([app/lib/audit-actions.ts:211-230](app/lib/audit-actions.ts#L211-L230)). Per-lot on-hand quantity does not exist for these items. | "Sum of lot quantities == total on-hand" and "each lot has its own quantity/exp" are only expressible for **bag-tracked** items; for box-tracked items they are structurally undefined. |

> **Note on readiness (INV-8):** Statpack readiness is *not* a bare manual boolean —
> it is a stored string enum (`Statpack.status`) **derived** on each check-off by
> `deriveStatus` ([app/lib/inventory.ts:576-600](app/lib/inventory.ts#L576-L600)). So
> INV-8 is *expressible* (not a blocker), but the derivation is non-conservative and
> ignores most required inputs — see INV-8 below (PARTIAL).

---

## Tier 1 — Data-integrity invariants (INV)

| ID | Invariant (mapped to real fields) | Status | Where it is / should be enforced |
|----|-----------------------------------|--------|----------------------------------|
| INV-1 | On-hand ≥ 0; consuming more than on-hand is refused. On-hand = `inventory.unopenedBoxes` (box items) or Σ `batches[].stock`/`bagCount` (bag items). | **PARTIAL** | `consumeBox` guards `currentUnopened < boxCount → throw` ([app/lib/inventory.ts:1545-1547](app/lib/inventory.ts#L1545-L1547)) ✔. But `submitAuditEntries` overwrites `unopenedBoxes: countedBoxes` absolutely ([app/lib/audit-helpers.ts:406-407](app/lib/audit-helpers.ts#L406-L407)) and check-off sets `currentQuantity = countedQuantity` ([app/lib/inventory.ts:538-540](app/lib/inventory.ts#L538-L540)) — neither refuses over-consumption. |
| INV-2 | Σ of a SKU's `batches[].stock` equals reported total on-hand. | **PARTIAL** | Bag-tracked: `computeBagStock` sums batches so views agree by construction ([app/lib/item-status.ts:42-62](app/lib/item-status.ts#L42-L62)) ✔. Box-tracked: `unopenedBoxes` is independent of the `stock:0` tombstone batches → **cannot** reconcile (see B-5). |
| INV-3 | Receiving a new lot creates a **distinct** `InventoryBatch`; never overwrites another lot. | **PARTIAL** | Bag-tracked: `arrayUnion(newBatch)` with fresh `crypto.randomUUID()` ([app/lib/audit-actions.ts:193-210](app/lib/audit-actions.ts#L193-L210)) ✔. Box-tracked: quantity is `increment()`-pooled onto `unopenedBoxes`; only a `stock:0` metadata batch is appended ([app/lib/audit-actions.ts:211-230](app/lib/audit-actions.ts#L211-L230)) → lot B's *quantity* is not distinct. |
| INV-4 | Every lot of a dated SKU (`tracksExpiration`/`requiresExpirationCheck`) has non-null `batch.expirationDate`. | **ABSENT** | `addShipment` computes `expirationDate` only if `input.expirationMonth` given, else `undefined`, with **no guard** ([app/lib/audit-actions.ts:187-189](app/lib/audit-actions.ts#L187-L189)). `additemmodal.tsx` also allows blank. Should block/flag at intake in `addShipment` and item create. |
| INV-5 | **FEFO** — consumption draws from earliest-expiring lot first. | **ABSENT** | No consumption path decrements a specific `batch.stock`. `requiresFIFO` (batch field) is never read; `earliestExpiration` ([app/lib/audit-helpers.ts:212-223](app/lib/audit-helpers.ts#L212-L223)) is display-only. Would need a real FEFO draw in `inventory.ts`. |
| INV-6 | An expired lot is excluded from **available** quantity and cannot count toward a pack in service. | **PARTIAL** | Expired batches *flag* the item (`getItemStatus → 'expired'`, [app/lib/item-status.ts:97](app/lib/item-status.ts#L97)) and flip a pack to `'Expired Items'` ([app/lib/inventory.ts:548-551,577](app/lib/inventory.ts#L548-L551)). **But** `computeBagStock` still sums expired-batch stock into `totalItems` ([app/lib/item-status.ts:48-54](app/lib/item-status.ts#L48-L54)) → expired stock is flagged, **not excluded** from available. |
| INV-7 | Marking a lot recalled quarantines it in **every** location and flips containing packs to not-ready, atomically. | **ABSENT** | See **B-1**. No recall action; `batch.status:'quarantined'` is inert. |
| INV-8 | Statpack `service-ready` derived & conservative: no expired lot AND no recalled lot AND every SKU ≥ par AND AED battery+pads current AND O₂ present+charged AND glucometer control test in interval; any unknown → not ready. | **PARTIAL** | `deriveStatus` ([app/lib/inventory.ts:576-600](app/lib/inventory.ts#L576-L600)) covers only expired (`anyExpired`) + short-consumable (`anyShortConsumable`) + sharps-full. It **ignores** recall, AED battery/pads currency, O₂ charge, and glucometer control test, and does **not** fail-closed on unknown inputs. Asset warnings from `validateStatpackAssignments` ([app/lib/inventory.ts:733-923](app/lib/inventory.ts#L733-L923)) exist but **do not feed** `status`. Thresholds for AED/glucometer intervals don't exist ([app/config/org-config.ts:310-332](app/config/org-config.ts#L310-L332)). |
| INV-9 | A below-par SKU appears on `buyList` once; re-triggering doesn't duplicate. | **ABSENT** | `buyList` entries are added manually with no dedupe query on `linkedInventoryId`/`status` ([app/buy-list/page.tsx:198-205](app/buy-list/page.tsx#L198-L205)). Below-par detection (`getItemStatus → 'low'`, [app/lib/item-status.ts:101](app/lib/item-status.ts#L101)) never creates an order. |
| INV-10 | Class-consumable draws and field/event draws decrement their own pools. | **ABSENT** | See **B-2** — single stock dimension, no pool axis. |
| INV-11 | Epi/narcan can't be received/dispensed without a LAF on file; every txn writes an immutable log. | **PARTIAL** | Immutable-log half exists: `medication_logs` append-only ledger with `runningCount`/`witness` ([app/components/medication-cabinet-modal.tsx:192-214](app/components/medication-cabinet-modal.tsx#L192-L214)). LAF gate half is **ABSENT** (B-3) — nothing blocks receipt/dispense on authorization. |
| INV-12 | Every unit maps to one valid `ROOM-UNIT-SHELF-BIN`; scan to unknown code is rejected, not created. | **ABSENT** | See **B-4** — no code scheme. Structured `storageLocation` refs are resolved by doc ID; `moveItemLocation` reads the zone doc but doesn't reject an unknown *code* ([app/lib/audit-actions.ts:80-96](app/lib/audit-actions.ts#L80-L96)). |

---

## Tier 2 — Human-resilience requirements (HR)

| ID | Requirement (mapped) | Status | Where it is / should be |
|----|----------------------|--------|-------------------------|
| HR-1 | Receiving a dated SKU with blank `expirationDate` is blocked/flagged, never stored as never-expiring. | **ABSENT** | Same gap as INV-4 — `addShipment` silently accepts no date ([app/lib/audit-actions.ts:187-189](app/lib/audit-actions.ts#L187-L189)). No flag surfaced. |
| HR-2 | Absurd / pack-size-ambiguous quantities (3 boxes vs 3 units, 300 vs 30) trigger a confirm/flag. | **ABSENT** | `addShipment` (`qty`, `perUnit`) and `submitAuditEntries` (`countedBoxes`) accept any number with no sanity/confirm check ([app/lib/audit-actions.ts:181](app/lib/audit-actions.ts#L181), [app/lib/audit-helpers.ts:387-407](app/lib/audit-helpers.ts#L387-L407)). |
| HR-3 | Skipped post-event scan → drift surfaces on a reconciliation/exception report; dashboard shows per-SKU/pack "last verified" age, not full stock as truth. | **PARTIAL** | "Last verified" exists: `lastAuditDate` + `isAuditedThisMonth` ([app/lib/item-status.ts:142-146](app/lib/item-status.ts#L142-L146)) and pack `lastAuditAt` + `isStatpackAuditCurrent` ([app/lib/item-status.ts:159-163](app/lib/item-status.ts#L159-L163)). **But** no reconciliation/exception report ties skipped scans to stock drift; dashboard still presents stored stock as current. |
| HR-4 | Glucometer with no passing control test in interval, or AED past check, flips pack to not-ready **automatically**. | **ABSENT** | No control-test/AED-interval field or threshold; `deriveStatus` never checks them ([app/lib/inventory.ts:576-600](app/lib/inventory.ts#L576-L600)). Tied to INV-8. |
| HR-5 | Member can't mark a pack ready while it holds an expired/recalled/below-par item; readiness never a bare checkbox that overrides computed state. | **PARTIAL** | Readiness *is* derived, not a bare boolean ([app/lib/inventory.ts:576-600](app/lib/inventory.ts#L576-L600)) ✔; checkout enforces fix-or-acknowledge on expired/short (per CLAUDE.md). **But** `acknowledged` lets a member proceed past short/expired ([app/lib/inventory.ts:553-559](app/lib/inventory.ts#L553-L559)), and **recalled** is never considered (B-1). |
| HR-6 | System records the actual timestamp of a check, flags implausible back-dating, treats a gap as a gap. | **PARTIAL** | Logs stamp both `serverTimestamp()` and client `clientTimestamp` ([app/lib/inventory.ts:463-465](app/lib/inventory.ts#L463-L465)); gaps are computed (`isAuditedThisMonth`/`isStatpackAuditCurrent`). **No** back-dating implausibility check. |
| HR-7 | Items with no location / no lot / no exp (residue of skipped steps) appear on a standing exceptions report instead of vanishing. | **ABSENT** | No standing "missing-metadata" exceptions surface. `generateAuditSnapshot` computes status but no view lists items lacking `storageLocation`/`batches`/`expirationDate`. Would live alongside `getItemStatus`/audit page. |
| HR-8 | Logging the same shipment twice (two members / double-tap) is detected and de-duplicated. | **ABSENT** | `addShipment` always `arrayUnion`s a new UUID batch / `increment()`s boxes with no idempotency key or recent-duplicate check ([app/lib/audit-actions.ts:193-231](app/lib/audit-actions.ts#L193-L231)). |
| HR-9 | Acting on a recall is one action that cascades (INV-7); no manual per-location sweep. | **ABSENT** | See **B-1** / INV-7. |
| HR-10 | If no full audit/reconciliation within a configured window, dashboard flags data as stale, not current. | **PARTIAL** | Per-item/per-pack staleness helpers exist (`isAuditedThisMonth`, `isStatpackAuditCurrent`, `statpackAuditDueInDays`, [app/lib/item-status.ts:142-170](app/lib/item-status.ts#L142-L170)) and surface on `/audit`. **But** no global dashboard-level "data is stale" banner gating the whole view. |

---

## Status roll-up

| Status | INV | HR |
|---|---|---|
| **ENFORCED** | — | — |
| **PARTIAL** | INV-1, INV-2, INV-3, INV-6, INV-8, INV-11 | HR-3, HR-5, HR-6, HR-10 |
| **ABSENT** | INV-4, INV-5, INV-7, INV-9, INV-10, INV-12 | HR-1, HR-2, HR-4, HR-7, HR-8, HR-9 |

**Blocked at the model level (subset of ABSENT that can't even be expressed):**
INV-7, INV-10, INV-11 (LAF half), INV-12, HR-9 — plus box-tracked INV-2/3/4 (B-5).

No rule is fully **ENFORCED** end-to-end today. The strongest are INV-3/INV-6/INV-8
for **bag-tracked** items; the weakest structural gaps are recall (B-1), pools (B-2),
LAF (B-3), and location codes (B-4).
