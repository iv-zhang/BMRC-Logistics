# FINDINGS — BMRC Logistics invariant & human-resilience gaps

Synthesis of every failing invariant and human-resilience gap found across the test
layers, each tagged by severity, with a `file:line` to fix and a one-line
reproduction. See [invariants.md](invariants.md) for the spec and [MODEL.md](MODEL.md)
for the data-model trace.

## ✅ Resolution status (12 of 14 fixed & verified)

The invariant suite went from **18/39 → 38/40 passing**; property suite is fully green
(incl. the two shrunk counterexamples now holding); the semester simulation now reports
**0 Tier-1 violations** under the same sloppiness.

| Finding | Status | Verified by |
|---|---|---|
| #1 recall cascade + quarantine excluded | ✅ Fixed | INV-7 (5/5), INV-8; `app/lib/recall.ts`, `item-status.ts` |
| #2 blank-expiration blocked at intake | ✅ Fixed | INV-4 (2/2); `audit-actions.ts` |
| #3 readiness conservative (recall/expiry/AED/glucometer/unknown) | ✅ Fixed | INV-8 (8/8); `inventory.ts` `deriveStatus` |
| #4 expired excluded from available (`availableItems`) | ✅ Fixed | INV-6 (3/3), P3 property; `item-status.ts` |
| #5 reconciliation/exceptions surface | ✅ Fixed | new `app/reconciliation/` + `app/lib/reconciliation.ts` |
| #6 double-shipment de-dup | ✅ Fixed | P4 sim (0 slipped through); `audit-actions.ts` |
| #7 phantom location rejected | ✅ Fixed | INV-12 (2/2); `audit-actions.ts` |
| #8 FEFO consumption (`consumeSku`) | ✅ Fixed | INV-5 (4/4); `inventory.ts` |
| #9 buy-list de-dup | ✅ Fixed | INV-9 (1/1); `app/lib/buy-list.ts` |
| #11 `consumeBox` undefined-notes crash | ✅ Fixed | INV-10 runs; `inventory.ts` |
| #12 LAF gate on controlled receipt | ✅ Fixed | INV-11 (2/2); `app/lib/laf.ts` |
| #14 `Pending Initial Check` not "ready" | ✅ Fixed | `dashboard/page.tsx` |
| **#10 stock pools (class vs field)** | ⏸ **Deferred** | INV-10 still 1/2 — needs a data-model decision (see below) |
| **#13 per-lot quantity for box-tracked SKUs** | ⏸ **Deferred** | INV-2 still 1/2 — needs a data-model decision (see below) |

**Why #10 and #13 are deferred (not skipped):** both require a schema decision that's
tied to how you'll actually enter real HQ stock — #10 needs a `pool` axis on stock (is a
SKU one pool split by location, or genuinely separate stock?), and #13 needs box-tracked
items to carry real per-lot quantities instead of the `unopenedBoxes` scalar + `stock:0`
tombstone. Doing either blindly would change how on-hand counts are computed right before
you load real values. Recommend deciding these together when you model the real inventory.

The findings below are the original report (pre-fix), kept for traceability.

**Severity key**
- **CRITICAL** — an expired, recalled, or never-expiring item can reach a Statpack shown as service-ready.
- **HIGH** — silent stock drift / false-green readiness from a skipped member step.
- **MEDIUM** — inefficiency or waste (avoidable expiry, stockouts, double orders).
- **LOW** — UX / cosmetic.

**Evidence layers** (how each finding was proven):
- **P2** = per-invariant integration tests, real code vs emulator (`scripts/emulator/invariants/*`), `npm run test:invariants`.
- **P3** = fast-check property tests with shrunk counterexamples (`scripts/emulator/run-properties.ts`), `npm run test:properties`.
- **P4** = semester sloppiness simulation (`scripts/emulator/semester-sim.ts`), `npm run test:simulation`.
- **P5** = Playwright e2e against the running app + emulator (`e2e/*`), `npm run test:e2e`.

Raw P2 result: **18 checks pass / 21 fail**; only INV-1 and INV-3 pass fully. P3: reference oracle green (0 failures over 500-run sequences), 2 real-code properties shrink to minimal counterexamples. P4: 587-unit drift, 36 units expired-unused, 2 derived Tier-1 violations, reconciliation catches 21/21 induced problems while the app surfaces 0.

---

## Ranked findings

| # | Sev | Finding | Fix location | One-line repro | Proven |
|---|-----|---------|--------------|----------------|--------|
| 1 | **CRITICAL** | **Recall/quarantine is inert.** `getItemStatus` never reads `batch.status`, so a recalled lot stays *available* and any Statpack holding it stays `Ready`. No recall action exists to cascade across MRC1/MRC2/HQ. | [item-status.ts:90-105](app/lib/item-status.ts#L90-L105) (exclude `status==='quarantined'`); [inventory.ts:576-600](app/lib/inventory.ts#L576-L600) (readiness must consider recall); **new** recall action needed | Set a lot `status:'quarantined'` → `getItemStatus` still `'ok'`, MRC1/MRC2 still `'Ready'` | P2 INV-7 (0/5), INV-8; P3 INV-7 counterexample `[{stock:1,recalled:true}]` |
| 2 | **CRITICAL** | **Blank expiration = silent "never expires."** A dated SKU can be received with no exp date; the lot is stored and never flags expired, so it can sit in a `Ready` pack indefinitely. | [audit-actions.ts:187-189](app/lib/audit-actions.ts#L187-L189) (block/flag when `item.tracksExpiration` and no `expirationMonth`) | Receive epi via Shipment with the month field blank → lot persisted with no `expirationDate` | P2 INV-4 (0/2), HR-1; P4 (blank-exp lots) |
| 3 | **CRITICAL** | **Readiness ignores life-safety asset currency.** `deriveStatus` only checks entered expiry + short count + sharps. Expired AED pads, an AED past battery, or a glucometer with no in-interval control test leave the pack `Ready`. Unknown/uncounted input also stays `Ready` (not fail-safe). | [inventory.ts:576-600](app/lib/inventory.ts#L576-L600) (fold in AED/O2/glucometer currency + fail-closed on unknown); no control-test/AED thresholds exist in [org-config.ts:310-332](app/config/org-config.ts#L310-L332) | Audit MRC1 with a lapsed glucometer control test / expired AED pads → `status` stays `Ready` | P2 INV-8 (4/8) |
| 4 | **CRITICAL** | **Expired stock counted as available.** `computeBagStock` sums expired-dated batches into on-hand; expiry is *flagged* but not *excluded*, so availability and any consumer of it overstate deployable stock. | [item-status.ts:42-105](app/lib/item-status.ts#L42-L105) (exclude expired lots from `totalItems`/available) | A batch dated in the past with stock 1 → `computeBagStock().totalItems` includes it | P2 INV-6 (1/2); P3 INV-6 counterexample `[{stock:1,expDays:-1},{stock:1,expDays:0}]` |
| 5 | **HIGH** | **No reconciliation / exceptions surface for skipped steps.** A skipped post-event buy-list scan leaves system stock high; the dashboard keeps showing stock that isn't there (false green). No standing report of drift, orphaned (no-location/no-exp) items, or staleness. | **new** reconciliation report; staleness helpers exist unused at dashboard level ([item-status.ts:142-170](app/lib/item-status.ts#L142-L170)) | Consume a SKU without logging → dashboard shows full stock; nothing flags the drift | P4 (587-unit drift; 21/21 caught by reconciliation, 0 surfaced by app); HR-3/HR-7/HR-10 |
| 6 | **HIGH** | **Double-logged shipment inflates stock, no de-dup.** `addShipment` always appends a new lot / increments boxes; two members recording one delivery doubles on-hand with no idempotency check. | [audit-actions.ts:193-231](app/lib/audit-actions.ts#L193-L231) (idempotency key / recent-duplicate guard) | Two members record the same delivery → stock counted twice | P4 (double-logged shipments); HR-8 |
| 7 | **HIGH** | **Location scan accepts phantom codes.** `moveItemLocation` resolves the destination zone by id; a non-existent zone is silently written to the item instead of rejected, creating a phantom location. | [audit-actions.ts:80-116](app/lib/audit-actions.ts#L80-L116) (reject when the zone doc doesn't exist) | Move gauze to `zoneId:'STA-Z9-99'` → item stored with the bogus zone | P2 INV-12 (0/2) |
| 8 | **MEDIUM** | **No FEFO consumption → avoidable expiry.** Nothing decrements lot stock in earliest-expiry order (no lot-level consume exists), so fresh stock is used while older lots quietly expire. | **new** FEFO consume path in [inventory.ts](app/lib/inventory.ts); `requiresFIFO` field is never read | Two epi lots, older expiring sooner; there is no operation that draws the older lot first | P2 INV-5 (1/4); P4 (36 units expired unused) |
| 9 | **MEDIUM** | **Buy list has no de-dup → double orders.** The same below-par SKU can be added to `buyList` repeatedly; no query guards against an existing pending/ordered entry, and there is no auto-reorder. | [buy-list/page.tsx:198-205](app/buy-list/page.tsx#L198-L205) (guard on `linkedInventoryId` + open status) | Add the same item to the buy list twice → two open entries | **P5 e2e (real UI: Expected 1, Received 2)**; P2 INV-9 (0/1) |
| 10 | **MEDIUM** | **No pool separation (class vs field/event).** Stock has a single pool; a class draw is prevented from depleting field stock only because an admin manually made two docs, not by any enforced pool axis. | data-model change (add a pool dimension); [types.ts:141](app/types.ts#L141) | A single SKU used for both class and field has one pool; a class draw reduces field availability | P2 INV-10 (1/2) |
| 11 | **MEDIUM** | **`consumeBox` throws on a missing note.** It writes `notes: opts?.notes` (possibly `undefined`) straight into an `inventory_logs` doc; the Firestore SDK rejects `undefined`, so a no-note consume fails. | [inventory.ts:1585-1598](app/lib/inventory.ts#L1585-L1598) (drop undefined via `removeUndefined`) | `consumeBox(id, 1, { userId, userName })` (no `notes`) → `addDoc` rejects `Unsupported field value: undefined` | Surfaced by P2 INV-10 (errored until a note was supplied) |
| 12 | **MEDIUM** | **Controlled items not LAF-gated.** Epi/narcan can be received/dispensed with no LAF on file; only the immutable log half exists. | **new** LAF gate before receive/dispense; `medication_logs` records witness but no authorization ([types.ts:822](app/types.ts#L822)) | Delete the epi LAF record, receive epi → succeeds | P2 INV-11 (1/2) |
| 13 | **MEDIUM** | **Box-tracked lots have no per-lot quantity.** For box-tracked SKUs, receiving pools quantity onto `unopenedBoxes` and writes a `stock:0` tombstone lot, so "Σ lots == total" and per-lot exp/quantity can't hold. | [audit-actions.ts:211-230](app/lib/audit-actions.ts#L211-L230); [item-status.ts:42-62](app/lib/item-status.ts#L42-L62) | For gauze (box-tracked), `computeBagStock.totalItems`=600 but Σ batch stock=0 | P2 INV-2 (1/2) |
| 14 | **LOW** | **`Pending Initial Check` reads as ready.** The dashboard tier treats a never-checked pack as `ready`, so a pack that has never been verified can look green. | [dashboard/page.tsx:46](app/dashboard/page.tsx#L46) | A pack with `status:'Pending Initial Check'` renders in the ready tier | Code review (dashboard tier logic) |

---

## True bugs vs design inefficiencies

**True bugs** — existing code mishandles a concept it already has (fixable in place):

- **#1** `getItemStatus` ignores the `batch.status` field it is handed ([item-status.ts:90](app/lib/item-status.ts#L90)).
- **#4** `computeBagStock` counts expired-dated batches as available ([item-status.ts:42-105](app/lib/item-status.ts#L42-L105)).
- **#3 (unknown-input half)** `deriveStatus` is not fail-safe: uncounted input stays `Ready` ([inventory.ts:553-559](app/lib/inventory.ts#L553-L559)).
- **#7** `moveItemLocation` writes an unresolved zone id instead of rejecting ([audit-actions.ts:80-116](app/lib/audit-actions.ts#L80-L116)).
- **#11** `consumeBox` passes `undefined` into an `addDoc` payload ([inventory.ts:1585-1598](app/lib/inventory.ts#L1585-L1598)).
- **#14** dashboard tier maps `Pending Initial Check` → ready ([dashboard/page.tsx:46](app/dashboard/page.tsx#L46)).
- **#2** intake accepts a blank expiration for a dated SKU ([audit-actions.ts:187-189](app/lib/audit-actions.ts#L187-L189)).

**Design inefficiencies / missing concepts** — the data model lacks the concept, so a fix is new modeling, not a line change (BLOCKERS in [invariants.md](invariants.md)):

- **#1** recall/quarantine cascade entity (B-1).
- **#3** AED/O2/glucometer currency inputs + thresholds feeding readiness (HR-4).
- **#5** reconciliation/exceptions + staleness surface (HR-3/7/10).
- **#6** shipment idempotency (HR-8).
- **#8** FEFO lot-level consumption (INV-5).
- **#9** buy-list de-dup / auto-reorder (INV-9).
- **#10** stock pool axis (B-2).
- **#12** LAF authorization gate (B-3).
- **#13** per-lot quantity for box-tracked SKUs (B-5).

---

## Fix priority

1. **Recall (#1)** and **blank-exp (#2)** and **asset-currency readiness (#3)** — the three ways an unsafe item reaches a `Ready` pack. Do these first; they're the CRITICAL readiness lies.
2. **Expired-as-available (#4)** — one-line-ish guard in `computeBagStock`/`getItemStatus` with wide blast radius (fixes a real bug feeding #3).
3. **Reconciliation surface (#5)** + **shipment de-dup (#6)** + **phantom location (#7)** — stop false-green from skipped/duplicated/fumbled steps.
4. The MEDIUM waste items (**#8-#13**) — FEFO, buy-list de-dup, pools, `consumeBox` bug, LAF, box-lot quantity.
5. **#14** cosmetic.
