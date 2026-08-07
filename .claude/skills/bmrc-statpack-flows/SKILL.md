---
name: bmrc-statpack-flows
description: >
  The statpack lifecycle for BMRC Logistics — checkout, check-in, audit, and
  the unified check-off page. USE THIS SKILL when touching anything under
  /statpacks, the check-off flow, pack status, pack contents/pockets, pack
  restock, expiration entry, sharps checks, oxygen/AED checks, statpack logs,
  or usage stats. Keywords: statpack, stat pack, checkout, check-in, checkin,
  check-off, pocket, pack status, In Use, Ready, Restock Needed, sharps,
  oxygen PSI, AED, pairId, statpack_logs, audit mode, par level.
---

# BMRC Statpack Flows

Statpacks are the medical bags crews take on shift. A member checks a pack
**out** (pocket-by-pocket verification), uses it, checks it back **in**
(re-verification + restock), and admins **audit** packs on a biweekly cadence.
Getting this wrong means a crew deploys with a depleted or expired pack.

## One page, three modes

All three flows share **one static page**: `app/statpacks/check-off/page.tsx`.

- `/statpacks/checkout` and `/statpacks/checkin` are pack-picker list pages;
  picking a pack navigates to `/statpacks/check-off?id=<packId>&mode=<checkout|checkin>`.
- The admin detail page (`/statpacks/[id]`) links to `?mode=audit`.
- The page reads `id` and `mode` from **`window.location.search`** — not
  `useSearchParams` (avoids a Suspense boundary under static export).

**Routing constraint (do not fight it):** the app builds with
`output: 'export'` (see `next.config.ts`), and pack IDs are Firestore runtime
IDs unknown at build time — so a dynamic `[id]/checkoff` segment cannot work.
The pattern is always *static route + query params*:
`/statpacks/check-off?id=${packId}&mode=${mode}`. Never add a nested `[id]`
segment for this flow.

The page manages the whole pocket-by-pocket flow **locally** and calls
`logStatpackCheckOff` (`app/lib/inventory.ts:349`) **once at the end**.

## `logStatpackCheckOff` — what it actually writes

It is not logging-only. Inside its transaction it writes the **pack** and a
`statpack_logs` row:

- **`StatpackItem.currentQuantity` is the source of truth for on-hand
  consumables** and is written from each entry's `countedQuantity`. The
  check-off page initializes counts from `currentQuantity` (fallback
  `requiredQuantity`), so a pack the last crew left depleted shows depleted to
  the next crew.
- **Assets are excluded from counting.** Entries with `serialNumber` /
  `assetInstanceId` are status-tracked (condition, battery, pads, PSI), never
  quantity-counted.
- **Restock model:** consumables have **no linked shelf/inventory count**.
  "Restock" sets that item's `currentQuantity` back to par and updates status;
  nothing is decremented anywhere. Back-room→shelf replenishment is a human
  process; errors surface at the next crew's checkout or the admin audit.
- **Pack `status` is derived** on check-in/audit — never hardcoded:
  expired/reported item → `Expired Items`; short-not-restocked or sharps
  full → `Restock Needed`; else `Ready`. Checkout always → `In Use`.
- Entered expirations (`newExpirationDate`) **persist onto the pack contents**
  and clear that item's expired state. Expiration is validated against today —
  a past month is *not* "satisfied".
- O₂ PSI + regulator (`oxygenPsi`, `regulatorOk`) and AED checks
  (`assetCheckResult`) are captured per entry.
- **Checkout enforces fix-or-acknowledge** on expired/short items: the member
  either fixes it (restock / new expiration) or explicitly acknowledges
  (`acknowledged` + `acknowledgeReason`). Silent pass-through is a regression.
- **Sharps container** is a pack-level check (`Statpack.sharpsContainer`,
  passed as `sharpsCheck: { status: 'ok' | 'full' | 'na' }`).
- A **"Report"** on an item creates a tracked `issue_reports` doc targeting
  `statpacks/<id>` (entry `issue: { type: 'missing' | 'broken' | 'expired' }`).
- `pairId` links a checkout to its matching check-in (resolved by
  `resolveStatpackPairId`); `quickCheckin: true` marks "nothing used" quick
  check-ins for admin visibility.

## Audit mode

- Logs `action: 'audit'` — **never** `'checkout'`. It stamps `lastAuditAt` /
  `lastAuditBy` on the pack **without taking ownership**.
- Cadence is biweekly: `getThresholds().statpackAuditIntervalDays`, checked by
  `isStatpackAuditCurrent()` (`app/lib/item-status.ts`). Overdue packs surface
  on the `/audit` Statpacks tab.

## Related surfaces

- **Stats:** usage/turnover analytics derive entirely from `statpack_logs`
  (`app/lib/statpack-stats.ts`, shown at `/statpacks/stats`). Log-row shape
  changes must keep those derivations working. `app/lib/logs.ts` has the
  pairing/duration helpers (`pairStatpackLogs`, `calculateEventDuration`).
- **Pack types/pockets** are org-config (`statpackTypes` with `pockets` — see
  the **bmrc-org-config** skill), editable in `/settings`.
- **`statpack-checkoff-modal.tsx` is retired** except **one** flow that still
  needs its `maintenance` mode, which the page lacks: `statpacks/page.tsx`
  (`openMaintenance`). Do not build new features on the modal; extend the page.
  `seal-check-modal.tsx` / `asset-verify-step.tsx` were deleted as dead code,
  and the pocket-by-pocket asset audit in `assets/page.tsx` was **removed** —
  `openStatpackAudit` had zero call sites, so the pocket-picker modal, its
  `maintenance`-mode checkoff modal, and `AssetAttachModal` were all
  unreachable. Don't reintroduce them.
- Asset assignment to packs: `assignAssetToStatpack` /
  `unassignAssetFromStatpack` / `validateStatpackAssignments` in
  `app/lib/inventory.ts`.
- The checkout/checkin/check-off routes have their own sticky footers and are
  listed in `NO_BOTTOM_NAV_PATHS` (`app/components/sidebar-layout.tsx`) to
  suppress the mobile bottom nav.

## Extending the flow — checklist

1. New per-item check? Add the field to the `checkEntries` element type in
   `logStatpackCheckOff` params, persist it in the entry mapping *and* onto
   pack contents if it's state (follow `newExpirationDate`), and wire the UI
   into the check-off page (all modes that need it).
2. Does the pack status derivation need to consider it? Update the derived
   status logic in `logStatpackCheckOff` — never set status from the UI.
3. Strip `undefined` values (Firestore rejects them) — the existing entry
   mapping already does; keep new fields inside it.
4. Verify all three modes with `npm run dev:emulator` + `npm run seed`, and
   run `npm run test:emulator` (the semester simulation exercises check-offs).
