---
name: bmrc-audit-workbench
description: >
  The supply audit workbench (/audit) and its write helpers for BMRC
  Logistics. USE THIS SKILL when touching the audit page, audit actions
  (count, move, shipment, report, fixed), inventory_logs, the auditEvents
  ledger, receiving shipments, moving/relocating items, issue reports on
  inventory, restock analysis, or audit permissions/locks. Keywords: audit,
  supply audit, count, move, relocate, shipment, receive, receiving, report
  missing broken expired, fixed, refill, inventory_logs, auditEvents, ledger,
  zone lock, canUserAudit, audit snapshot, restock needs.
---

# BMRC Audit Workbench (`/audit`)

The audit page is deliberately **orderless** — members act on whatever is
physically in front of them, in any order. There is no linear item-by-item
wizard; do not add one. Tapping an item card (or scanning a barcode) opens
`app/components/audit-action-drawer.tsx` with five actions.

## The five actions and their write helpers

| Action | What it does | Helper |
|---|---|---|
| **Count** | Boxes/units + condition entry | `submitAuditEntries` — `app/lib/audit-helpers.ts:360` |
| **Move** | Structured zone→shelf→level→container, or quick area | `moveItemLocation` / `moveItemsBulk` — `app/lib/audit-actions.ts` |
| **Shipment** | New sealed batch / box increment | `addShipment` — `app/lib/audit-actions.ts:187` |
| **Report** | Missing/broken/expired → issue report + `auditCondition` stamp | `reportItemIssue` — `app/lib/audit-actions.ts:338` |
| **Fixed** | Refill/change-out/repair record; clears the condition flag | `recordItemFix` — `app/lib/audit-actions.ts:414` |

All write helpers live in `app/lib/audit-actions.ts` and
`app/lib/audit-helpers.ts`. **New audit behavior goes in those files, not in
components** — the emulator tests exercise the lib layer directly.

## The triple-write rule (non-negotiable)

Every audit action writes **three things**:

1. The inventory change itself (item/batch fields).
2. An `inventory_logs` row (who/what/when, `action` slug, `details`).
3. An `auditEvents` ledger entry via `recordAuditEvent()` /
   `addAuditEventToBatch()` (`app/lib/audit.ts`).

Usage metrics, exception reports, and reconciliation all derive from these.
An action that skips a log or ledger write silently breaks analytics — treat a
missing write as a bug even if the UI looks right. Wrap payloads in
`removeUndefined()` (Firestore rejects `undefined`).

## Shipment semantics (`addShipment`)

- **Bag-tracked items** get a new **sealed batch** — batches are their stock
  source of truth (a second lot must never overwrite the first, INV-3; a
  dated SKU must not accept a lot without an expiration, INV-4).
- **Box-tracked items** get an atomic `unopenedBoxes` increment **plus a
  zero-stock metadata batch** when lot/expiry was recorded — the "tombstone"
  that keeps the paper trail without affecting stock or expiry status (see
  the **bmrc-domain** skill).

## Moves

`moveItemLocation(item, dest, actor, note?)` is the only sanctioned way to
change where an item lives. It resolves the destination zone doc, **rejects
unknown zone IDs** (INV-12), and syncs the legacy `location`/`room` and asset
`currentLocation` mirrors. `moveItemsBulk(items, dest, actor, note?)` is the
bulk path. Never `updateDoc` a `storageLocation` directly.

## Report / Fixed lifecycle

- `reportItemIssue` creates a tracked `issue_reports` doc and stamps
  `auditCondition` on the item so it surfaces as an exception.
- `recordItemFix` records the remediation (`'refilled' | 'replaced' |
  'fixed'`) and **clears** the condition flag. The pair must stay symmetric —
  a new report field needs a corresponding clear in the fix path.

## Sessions, permissions, snapshots

- **Permission:** `canUserAudit()` (`app/lib/audit-helpers.ts:43`) — admins/
  quartermasters always; others need the `canAudit` flag, granted via
  `setAuditPermission` (surfaced in `audit-permission-modal.tsx`).
- **Zone locks:** `acquireZoneLock` / `releaseZoneLock` prevent two members
  from auditing one zone simultaneously. Respect them in any new bulk flow.
- **Snapshots:** `generateAuditSnapshot()` builds the page's item state; note
  it ignores zero-stock tombstone batches for expiry, same as
  `getItemStatus`. Restock suggestions come from `analyzeRestockNeeds()`.
- **Cycle:** supplies are verified per **calendar month**
  (`isAuditedThisMonth`); count submissions stamp `lastAuditDate`. Statpack
  audits (biweekly) are a separate flow — see **bmrc-statpack-flows**.

## Extending the workbench — checklist

1. New action or field → helper function in `audit-actions.ts` /
   `audit-helpers.ts` with the triple write; drawer UI in
   `audit-action-drawer.tsx` calls the helper.
2. Keep helpers callable headless (plain args, no React) so emulator tests
   can drive them.
3. Run `npm run test:invariants` — INV-1/2/3/4/12 directly exercise these
   paths — and drive the drawer on `npm run dev:emulator`.
4. UI changes: follow the **bmrc-ui** skill; `audit-item-card.tsx` and the
   drawer are the canonical patterns.
