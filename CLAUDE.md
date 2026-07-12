# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start dev server (Next.js)
npm run build        # Production build
npm run lint         # ESLint
npm run test         # Run audit/restock integration test (scripts/test-audit-restock.cjs)
```

Migration scripts run against live Firestore; always pass `--dry-run` first:
```bash
npm run migrate:batch-locations       # --dry-run by default
npm run migrate:normalize-inventory   # --dry-run by default
```

Firebase environment variables are required in `.env.local` (`NEXT_PUBLIC_FIREBASE_*`). The file already exists; do not commit it.

## Workflow

**Never commit or push unless the user explicitly asks.** Make and verify changes in the working tree and report what changed; leave `git commit`/`git push` for an explicit instruction. This overrides any default "commit when done" behavior.

## Architecture

### Framework & Stack
- **Next.js 16** App Router — all routes live under `app/`, no `src/` directory.
- **Firebase**: Firestore (real-time `onSnapshot` listeners everywhere, no REST layer), Firebase Auth.
- **HeroUI** (`@heroui/react`) for all UI components; **Tailwind CSS 4** for utility classes; **Lucide React** for icons.
- **`next-themes`** for dark/light mode; theme wrapping lives in `app/providers.tsx`.

### Auth & Roles
`app/hooks/useUserRole.tsx` is the single source of auth state. It combines Firebase Auth with a Firestore `users/{uid}` doc fetch to expose `{ user, userData, role, loading }`.

Role values: `'admin' | 'quartermaster' | 'inventory_helper' | 'FTO' | 'member'`

The admin check used throughout the app:
```ts
const isAdmin = role === 'admin' || role === 'quartermaster';
```

For local testing, set `localStorage.bmrc_role_override` to any role string; the hook listens for the `bmrc-role-changed` custom event and `storage` events to pick it up immediately.

### Configuration (runtime-overridable, admin-editable)
Org configuration is **data, not code**. It loads from a single Firestore doc `org_settings/current` and falls back to the defaults in `app/config/org-config.ts` (which is now the DEFAULTS/seed + type source, not the live source of truth).

- **`app/config/org-config.ts`** — `DEFAULT_ORG_CONFIG` + the type interfaces. The exported helper functions (`getInventoryAreaOptions`, `getAssetCategoryConfig`, `getStatpackTypeConfig`, `getLocationConfig`, `getRoomNames`, etc.) read the **runtime** config, so overrides flow through everywhere they're already called. The raw constant exports (`THRESHOLDS`, `LOCATIONS`, …) are defaults only.
- **`app/lib/org-config-store.ts`** — the runtime singleton + Firestore I/O. Pure lib code (e.g. `item-status.ts`, `inventory.ts`) reads live values via getters like `getThresholds()` / `getAssetCategoriesRuntime()` — **never** the frozen constants. Write API: `saveOrgConfig(patch, actor)` (merge-write), `resetOrgConfigToDefaults(actor)`, plus `subscribeOrgConfig` / `seedOrgConfigIfMissing`.
- **`OrgConfigProvider`** (wired in `app/providers.tsx`) subscribes to the doc and seeds it from defaults if missing. **`useOrgConfig()`** (`app/hooks/useOrgConfig.ts`) exposes the live merged config to components (adds `loading`); it falls back to defaults if no provider, so it never throws. Prefer the hook in components and the getters in lib — do **not** import the frozen constants for live reads. Anything read at module scope (e.g. `const X = getInventoryAreaOptions()`) must move into render to stay reactive.
- **What's editable:** `org`, `locations` (+rooms), `vehicles`, `assetCategories` (+their checks), `statpackTypes` (+pockets), `itemCategories`, `thresholds`. **Code-owned (not in the doc):** `VERIFICATION_FIELDS` (the check-field palette) and `ROLES`. Physical **zones/shelves/containers/floors** are edited in Storage Management (`/storage`), not here.
- **`/settings`** — the admin/quartermaster-only, form-based editor for all of the above (`app/settings/page.tsx` + `app/components/settings/*`). Non-technical: no JSON. This is how you move HQ (rooms/floors), retune thresholds, or rebrand for another agency without a deploy. Renaming a category/site here does **not** relabel already-saved records (v1 soft-warning).

### Type System
`app/types.ts` defines all domain types: `User`, `InventoryItem`, `Statpack`, `StatpackItem`, `StatpackLog`, `AssetInstance`, `InventoryBatch`, `StorageZone`, `Shelf`, `Container`, `IssueReport`, `BuyListItem`, `TaskItem`, `MedicationLog`, etc.

### Key Page Areas

| Route | Purpose |
|---|---|
| `/dashboard` | Splits into `member-dashboard.tsx` vs. admin view based on role |
| `/statpacks` | Admin statpack list |
| `/statpacks/checkout` | Member pack selection for checkout (then navigates to check-off) |
| `/statpacks/checkin` | Member pack selection for check-in (then navigates to check-off) |
| `/statpacks/check-off` | Unified pocket-by-pocket verification page (checkout / checkin / audit); receives `?id=<packId>&mode=<mode>` query params |
| `/statpacks/[id]` | Admin statpack detail/edit |
| `/assets` | Admin asset management |
| `/inventory` | Admin inventory management |
| `/restock` | Restock shelf management |
| `/member/report` | Member issue report form |
| `/audit` | Admin audit tools |
| `/roster` | Admin member roster |
| `/storage` | Storage zone/shelf/container management |

### Shared Components
Key reusable components in `app/components/`:
- `appnavbar.tsx` — global nav; assets/statpacks admin links are gated with `{isAdmin && ...}`
- `statpack-checkoff-modal.tsx` — shared between admin full-pack audits and member pocket verification; `skipLogging={true}` + `pocketName` props put it in pocket mode
- `tutorial-overlay.tsx` — first-login onboarding overlay (6 steps); marks `tutorialCompleted` on the user doc when finished

### Dashboard Layout (differs from other pages)
`app/dashboard/page.tsx` is a full-viewport app shell, not a document page:
- Uses the standard blue gradient (`bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800`) as the page wrapper, same as other pages.
- Has a compact `h-[54px]` sticky header at `z-20` with `bg-content1/80 backdrop-blur-md`.
- No standard page header block (`text-2xl` title + stats row). Content starts immediately after the sticky header.
- Uses **`framer-motion`** (`AnimatePresence` + `motion.div`) for the inline statpack detail expand panel. No other page uses framer-motion.
- Section cards have a `bg-content2` header stripe pattern with a scrollable body capped at `maxHeight: 256`.
- Statpack tiles are in a horizontal scroll row (`overflow-x-auto`, `scrollbarWidth: 'thin'`).

### Inventory Sidebar Scroll Rule
The inventory sidebar (and any sidebar-filter layout) must NOT use `sticky` positioning, `max-h`, or `overflow-y-auto`. The sidebar scrolls with the page as a single unified scroll. `sticky` clips the bottom of a tall sidebar with no way to reach it; `overflow-y-auto` fixes the clip but creates a second scroll area. Both are wrong. The sidebar element is simply `<aside className="w-64 flex-none flex flex-col gap-4">`.

### Statpack Checkout / Check-in / Audit Flow
All three modes share one page: `app/statpacks/check-off/page.tsx` (static route). The checkout and check-in list pages (`/statpacks/checkout`, `/statpacks/checkin`) let the member pick a pack, then navigate to `/statpacks/check-off?id=<packId>&mode=<checkout|checkin>`. The admin detail page (`/statpacks/[id]`) links to `?mode=audit`.

The check-off page reads `id` and `mode` from `window.location.search` (not `useSearchParams` — avoids Suspense) and manages the full pocket-by-pocket flow locally before calling `logStatpackCheckOff` once at the end.

**`output: export` routing constraint:** All pack IDs are Firestore runtime IDs not known at build time, so dynamic `[id]/checkoff` routes cannot work. The pattern is: static route + query params. Always use `/statpacks/check-off?id=${packId}&mode=${mode}` — never a nested `[id]` segment — when navigating to the verification flow.

Audit mode logs `action: 'audit'` (never `'checkout'`) via `logStatpackCheckOff` — it stamps `lastAuditAt`/`lastAuditBy` on the pack without taking ownership. Statpack audits run on a biweekly cadence (`THRESHOLDS.statpackAuditIntervalDays`, checked by `isStatpackAuditCurrent` in `app/lib/item-status.ts`) and are surfaced on the `/audit` Statpacks tab.

**Check-off persists state (not logging-only).** `logStatpackCheckOff` (in `app/lib/inventory.ts`) writes the pack, not just a `statpack_logs` row, inside its transaction:
- `StatpackItem.currentQuantity` is the source of truth for on-hand consumables and is written from each entry's `countedQuantity`. The check-off page **initializes counts from `currentQuantity`** (fallback `requiredQuantity`), so a depleted pack the last crew didn't restock shows depleted to the next crew. **Assets are excluded** (entries with `serialNumber`/`assetInstanceId` are status-tracked, never counted).
- Restock model: consumables have **no linked shelf/inventory count** — "restock" sets that item's `currentQuantity` back to par and updates status; nothing is decremented (back-room→shelf replenishment is a human process; errors are caught by the next crew or the admin audit).
- Pack `status` is **derived** on check-in/audit (not hardcoded `Ready`): expired/reported → `Expired Items`; short-not-restocked or sharps full → `Restock Needed`; else `Ready`. Checkout → `In Use`.
- Entered expirations (`newExpirationDate`) persist onto contents; expiration is validated against today (a past month is not "satisfied"); O₂ PSI + regulator and AED checks are captured. Checkout enforces **fix-or-acknowledge** on expired/short items. Sharps container is a pack-level check (`Statpack.sharpsContainer`). A "Report" creates a tracked `issue_reports` doc (target `statpacks/<id>`).
- Usage/turnover analytics derive from `statpack_logs` on `/statpacks/stats` (`app/lib/statpack-stats.ts`).

The shared check-off **page** is the single verification flow for members and admins. `app/components/statpack-checkoff-modal.tsx` is retired except two flows that still need a `maintenance` mode the page lacks (`statpacks/page.tsx` `openMaintenance`, and the pocket-by-pocket asset audit in `assets/page.tsx`); `seal-check-modal.tsx`/`asset-verify-step.tsx` were deleted as dead code.

### Audit Workbench (`/audit`)
The audit page is deliberately **orderless** — members act on whatever is physically in front of them, in any order. There is no linear item-by-item wizard. Tapping any item card (or scanning a barcode) opens `app/components/audit-action-drawer.tsx` with five actions: **Count** (boxes/units + condition, submits via `submitAuditEntries`), **Move** (structured zone→shelf→level→container or quick area), **Shipment** (new sealed batch / box increment), **Report** (missing/broken/expired → issue report + `auditCondition` stamp), and **Fixed** (refill/change-out/repair record, clears the condition flag). The write helpers live in `app/lib/audit-actions.ts`; every action writes the inventory change + an `inventory_logs` row + an `auditEvents` ledger entry so usage metrics stay derivable. Shipment semantics: bag-tracked items get a sealed batch (batches are their stock source of truth); box-tracked items get an atomic `unopenedBoxes` increment plus a zero-stock metadata batch when lot/expiry was recorded.

### Location Model (single source of truth)
`storageLocation: StorageLocationRef` (structured zone → shelf → level → container) is the source of truth for where an item lives. Legacy `location`/`room` and asset `currentLocation` are **denormalized mirrors** kept in sync FROM the structured location — never the reverse. Invariants enforced in code (do not regress):
- `moveItemLocation` / `moveItemsBulk` (`app/lib/audit-actions.ts`) resolve the destination zone doc and write `location`/`room` (and asset `currentLocation`) to match, so legacy room/location filters still find a moved item. `moveItemsBulk(items, dest, actor, note?)` is the bulk path.
- Renaming/reassigning a zone, shelf, or container (Storage Management editors) **propagates** the new denormalized name to every referencing inventory item via a batched query on `storageLocation.{zoneId|shelfId|containerId}`.
- Deleting a shelf/container **clears the dangling refs** on affected items first (never orphans them).
- `StorageZone.level?: 'upper' | 'lower'` models the building floor. Zones are created/edited in Storage Management (`/storage`, Add Zone → `zone-editor.tsx`).
- `InventoryItem.isTrainer` marks non-deployable training gear (trainer AEDs, manikins); it is still an asset but filtered out of deployable views.
- `determineIsAsset` (`app/lib/inventory.ts`) treats an item as an asset on any asset signal (serial, status, category, `assets[]`, `maintenance_logs`, `isOxygen`), not only `assetValue ≥ threshold`.
- Expiry checks in `getItemStatus` / `generateAuditSnapshot` ignore zero-stock (tombstone) batches, so a depleted lot's date can't mark an item permanently expired.

### Firestore Collections (what the code actually reads/writes — see MODEL.md for shapes)
`inventory` (central collection — consumables, assets, oxygen, and medications are all `inventory` docs discriminated by flags; there is **no** separate `assets` collection), `inventory_logs`, `inventory_alerts`, `auditEvents` (audit ledger — camelCase, written by `app/lib/audit.ts`), `statpacks`, `statpack_logs`, `vehicles` (individual fleet vehicles — roster + live checkout state), `vehicle_logs` (one doc per shift, written with the vehicle doc in one transaction by `app/lib/vehicles.ts`), `restock_shelves`, `restock_shelf_events`, `restock_actions`, `restock_reports`, `storage_zones`, `shelves`, `containers`, `box_logs`, `medication_logs`, `buyList` (camelCase — **not** `buy_list`), `tasks`, `issue_reports`, `users`, `org_settings`, `laf_records`, `reconciliation_exceptions`

### Known open design gaps (do not silently "fix")
Two schema decisions are deliberately deferred, tracked in `FINDINGS.md`/`invariants.md`:
- **No stock-pool axis** distinguishing class-use stock from field/event stock.
- **No real per-lot quantity for box-tracked SKUs** — quantity is pooled onto `unopenedBoxes` with a zero-stock metadata batch standing in for the lot.

If a task touches either, flag it as an open design question and ask before assuming there's a bug to patch — changing this without a decision would change how on-hand counts are computed.

### Shared Status Logic
`app/lib/item-status.ts` is the single source of truth for stock math (`computeBagStock`), item status (`getItemStatus`: expired > out > low > expiring > ok), location display (`displayLocation`), expiry formatting, and the monthly audit cycle (`isAuditedThisMonth` — an item is "verified" only if `lastAuditDate` falls in the current calendar month; the sticky `auditVerified` boolean must not be trusted alone). Expiration windows come from `THRESHOLDS` in org-config. Category badge colors live in `app/components/category-badge.tsx`. Location filter dropdowns derive from `getInventoryAreaOptions()` in org-config — never hardcode location lists in pages.

### Business Logic Helpers
`app/lib/` contains pure helpers for audits (`audit.ts`, `audit-helpers.ts`), statpack operations (`statpacks.ts`), inventory (`inventory.ts`), logging (`logs.ts`), reporting (`reports.ts`), and PDF/label printing (`print.ts`).
