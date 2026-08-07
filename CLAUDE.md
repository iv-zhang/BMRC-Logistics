# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start dev server (Next.js)
npm run build        # Production build
npm run lint         # ESLint
npm run test         # Run audit/restock integration test (scripts/test-audit-restock.cjs)
npm run dev:sandbox  # Emulator sandbox: boots firestore+auth emulators, seeds data + one login per role, runs dev server (see SANDBOX.md)
```

**Safe manual testing (`npm run dev:sandbox`)** runs the whole app on the throwaway `demo-bmrc-logistics` **emulator** — it can never touch the real project (the guard in `scripts/emulator/guard.ts` hard-aborts on a prod-shaped config). Logins seeded by `scripts/emulator/seed-auth-user.ts`: `admin@ / qm@ / member@ / fto@ / medops@bmrc.test`, all password `test1234`. Use this to test roles/permissions without risking live data. A cloud staging project (`bmrc-staging`) exists for genuine per-role login testing on real Firebase — seed with `npm run seed:staging`, run with `npm run dev:staging`, see [STAGING.md](STAGING.md). See [SANDBOX.md](SANDBOX.md).

Migration scripts run against live Firestore; always pass `--dry-run` first:
```bash
npm run migrate:batch-locations       # --dry-run by default
npm run migrate:normalize-inventory   # --dry-run by default
```

Firebase environment variables are required in `.env.local` (`NEXT_PUBLIC_FIREBASE_*`). The file already exists; do not commit it.

## Workflow

**Plan first, then delegate implementation to conserve tokens.** For any non-trivial change or fix, the default flow is:
1. **Produce an implementation plan and get it manually reviewed/approved before writing code.** State the files to touch, the approach, and any decisions that need a call. Do not start editing until the user approves. (Skip the approval gate only for truly trivial one-liners or when the user explicitly says "just do it".)
2. **Implement approved changes via Sonnet and/or Haiku subagents at low and/or medium effort whenever possible**, to maximize token efficiency — reserve the top-tier model for planning, cross-file reasoning, and the integration/verification pass. Split work across subagents on **strictly non-overlapping file sets** so parallel runs are safe; the orchestrator handles any intentional cross-file seams itself after the agents land.
3. Match effort to difficulty: Haiku/low for mechanical edits (mechanical refactors, wiring, copy, obvious fixes), Sonnet/medium for logic with local reasoning. Escalate only when a subagent reports it can't complete the task within scope.

**Never commit or push unless the user explicitly asks.** Make and verify changes in the working tree and report what changed; leave `git commit`/`git push` for an explicit instruction. This overrides any default "commit when done" behavior.

**Verification is tiered — do not run the expensive tier by default.** The emulator smoke driver (`run-bmrc-logistics` skill) boots Firebase emulators, a dev server, and Playwright; it burns a large number of tokens per run. Run it **only immediately before a commit**, or when the user explicitly asks to see the app driven.

| When | Run |
|---|---|
| After any change (default) | `npx tsc --noEmit`, `npm run lint` on touched files |
| Before reporting a feature done | `npm run build`, `npm run test` |
| Immediately before a commit, or on request | the `run-bmrc-logistics` emulator smoke driver |

When the expensive tier has not been run, **say so explicitly** — report the change as built-and-typechecked but not runtime-verified rather than implying it was driven end-to-end. Write smoke cases for new surfaces as you go so the pre-commit run actually covers them; just don't execute the driver until then.

## Architecture

> **Design decisions & rationale:** [decisions.md](decisions.md) records *why* the
> deliberate choices below were made (config-as-data, two-pool stock, orderless audit,
> derived pack/attendance status, the deferred stock-pool/per-lot gaps, the events/medops
> model, etc.). If a change would undo something there, treat it as **stop-and-ask**, not a
> bug to patch. See also [invariants.md](invariants.md), [FINDINGS.md](FINDINGS.md),
> [MODEL.md](MODEL.md).

### Framework & Stack
- **Next.js 16** App Router — all routes live under `app/`, no `src/` directory.
- **Firebase**: Firestore (real-time `onSnapshot` listeners everywhere, no REST layer), Firebase Auth.
- **HeroUI** (`@heroui/react`) for all UI components; **Tailwind CSS 4** for utility classes; **Lucide React** for icons.
- **`next-themes`** for dark/light mode; theme wrapping lives in `app/providers.tsx`.

### Auth & Roles
`app/hooks/useUserRole.tsx` is the single source of auth state. It combines Firebase Auth with a Firestore `users/{uid}` doc fetch to expose `{ user, userData, role, effectiveUid, loading }`.

Role values: `'admin' | 'quartermaster' | 'inventory_helper' | 'FTO' | 'fto_intern' | 'medops' | 'member'`

**`fto_intern`** is the training tier below `FTO` (decisions.md D-30): same cert gating and permissions as `FTO`, but an intern may only fill the supernumerary FTO-intern team slot or a plain EMT slot — never the FTO slot — and gets no attendance-recording powers.

The admin check used throughout the app:
```ts
const isAdmin = role === 'admin' || role === 'quartermaster';
```

**`medops` is intentionally NOT `isAdmin`** (see [decisions.md](decisions.md) D-13): it is a reduced-admin role for running events/roster that must never see logistics surfaces. The event-manager gate is a separate `isEventManagerRole(role)` = `admin | quartermaster | medops` (in `app/lib/events.ts`). Gate event/roster surfaces on that, never on `isAdmin`.

**`effectiveUid`** = the active test-identity uid when a test identity is set, else the real auth uid. Every **user-scoped read/write** (personal history, shift requests, actor attribution) must key on `effectiveUid`, not the raw auth uid — otherwise test identities aren't actually separate (decisions.md D-18). Writes still run under the real Firebase Auth session.

For local testing there are two overrides (watched via the `bmrc-role-changed` custom event + `storage` events): `localStorage.bmrc_role_override` (legacy — a bare role string) and `localStorage.bmrc_test_identity` (a seeded `__test_*` uid → full identity override; seeded by `seedTestUsers()` in `app/lib/test-identity.ts`).

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
| `/roster` | Member roster (admin/quartermaster/**medops**); click-row `MemberDetailModal` for role/cert/status edits |
| `/storage` | Storage zone/shelf/container management |
| `/events` | Shift-signup board; member request + manager (`isEventManagerRole`) staffing, attendance, hours |
| `/history` | A member's own statpack activity + shift history (scoped by `effectiveUid`) |
| `/profile` | Certifications + "Volunteer Record" (shifts/attendance/hours from `getMemberShiftStats`) |
| `/stats` | Tile-based dashboards (Usage / Purchasing / Staffing / Calls); arrangeable canvas, cross-filtering |

### Shared Components
Key reusable components in `app/components/`:
- `appnavbar.tsx` — global nav; assets/statpacks admin links are gated with `{isAdmin && ...}`
- `statpack-checkoff-modal.tsx` — shared between admin full-pack audits and member pocket verification; `skipLogging={true}` + `pocketName` props put it in pocket mode
- `panel-shell.tsx` — shared chrome for every pop-out (inventory/audit/receive/event/vehicle/stats/committee). Renders **drawer** (right sheet) or **center** (modal) only, chosen by the user's `usePanelMode()` preference (`app/hooks/usePanelMode.tsx`, localStorage `bmrc_panel_mode`, live via the `bmrc-panel-mode-changed` event). The `dropdown` preference is **not** an overlay here — PanelShell maps it to center; only the inventory **list** renders a real inline dropdown (see [D-25](decisions.md)). A `forceMode` prop pins one position regardless of preference (the event drawer uses `forceMode="modal"`).
- `onboarding-tour.tsx` + `app/lib/tutorial-tours.ts` — role-aware first-login tour (replaces the old `tutorial-overlay.tsx`). Spotlights real on-screen elements matched by `data-tour="<key>"` (only nav items + the member dashboard's `checkout`/`checkin` cards carry anchors); marks `tutorialCompleted` when done, replayable via the `bmrc-replay-tutorial` window event. See [D-26](decisions.md) for the anchoring rules — do not add `click-target` steps or point at elements that only exist for other roles/viewports.

### Dashboard Layout (differs from other pages)
`app/dashboard/page.tsx` is a full-viewport app shell, not a document page:
- Uses the standard blue gradient (`bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800`) as the page wrapper, same as other pages.
- Has a compact `h-[54px]` sticky header at `z-20` with `bg-content1/80 backdrop-blur-md`.
- No standard page header block (`text-2xl` title + stats row). Content starts immediately after the sticky header.
- Uses **`framer-motion`** (`AnimatePresence` + `motion.div`) for the inline statpack detail expand panel. No other page uses framer-motion.
- Section cards have a `bg-content2` header stripe pattern with a scrollable body capped at `maxHeight: 256`.
- Statpack tiles are in a horizontal scroll row (`overflow-x-auto`, `scrollbarWidth: 'thin'`).

### Inventory Scroll Rule
On desktop (`md:` and up) `/inventory` is a **fixed-height app shell**: the page wrapper is `md:h-screen md:overflow-hidden`, and the item list (list view) / table body (table view) is the **only** scroll region. The filter sidebar, page title, and search/toolbar row stay pinned in view.

Never solve sidebar overflow with `sticky` or by scrolling the `<aside>` itself — `sticky` clips the bottom of a tall sidebar with no way to reach it, and scrolling the aside creates a second competing scroll area. The correct fix is to keep the sidebar **short enough to fit one viewport** (it is deliberately dense: `p-3` cards, `text-[13px]` rows). The one bounded exception is the category list, which may scroll internally if the org has more categories than fit.

Below `md`, the page reverts to a single unified page scroll with the filters in a collapsible disclosure — so every height/overflow class in this layout must be `md:`-prefixed.

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

The shared check-off **page** is the single verification flow for members and admins. `app/components/statpack-checkoff-modal.tsx` is retired except one flow that still needs a `maintenance` mode the page lacks (`statpacks/page.tsx` `openMaintenance`); `seal-check-modal.tsx`/`asset-verify-step.tsx` were deleted as dead code. The pocket-by-pocket asset audit in `assets/page.tsx` was removed — `openStatpackAudit` had zero call sites, so the pocket-picker modal, its `maintenance`-mode checkoff modal, and `AssetAttachModal` were all unreachable.

### Events / Shift-Signup (`/events`, `/roster`, `/profile`, `/history`)
Members request team slots; managers (`isEventManagerRole` = admin/quartermaster/**medops**) staff them. Lib: `app/lib/events.ts`, `app/lib/notifications.ts`, `app/lib/certifications.ts`; UI: `app/events/page.tsx` + `app/components/events/*`. Collections: `events` (each has `teams: EventTeam[]`; one team = 1 FTO + 2–4 EMT slots + an optional single **FTO intern**), `shift_requests`, `notifications`. Design rationale in [decisions.md](decisions.md) D-13…D-19 and D-29/D-30 — the load-bearing rules:
- **medops ≠ isAdmin** (D-13): manages events/roster only, never logistics. It **does** see and retroactively edit attendance (D-29) — that's event operations, not logistics.
- **FTO Intern is supernumerary** (D-30): `hasFtoIntern?: boolean` + `ftoInternSlot?: TeamSlot` on `EventTeam`, max one, default **on** for new teams (`undefined` on a legacy doc = off). An intern shadows the FTO for field experience, so they are an *addition* — **never** count them in staffing math or fill fractions (`teamFilledCount` reports `intern` separately for this reason). Only `fto_intern` (or a manager) may take the slot; interns may never take the FTO slot.
- **Cert gating** (D-14): `canSignUpForShifts` needs unexpired EMT **and** CPR (dates only). `org_settings.requireCertsForShiftSignup` (default true) is a kill switch; when on with no certs entered, all signup is blocked by design (inline amber reason on the disabled button).
- **Experience is derived, not a dropdown** (D-15): computed from `User.memberStatus` (`new|probationary|general`, default `general`) + `User.joinedTerm`, editable in the roster modal by admin/qm **or medops**. Requests denormalize both; `formatMemberExperience` renders. `canRequestRole`: FTO-role → FTO+EMT slots; `fto_intern` → intern+EMT slots; else EMT only. Bulk import from the roster spreadsheet is a future TODO.
- **Attendance = check-in stamp; lateness derived** (D-16): `AttendanceRecord = { checkedInAt?, shiftEndAt?, minutesLate?, leftEarly?, minutesEarly?, exception?: 'no_show'|'excused', … }`. Times are **stamped by button press, never typed** — tapping **Check in** IS the arrival time, tapping **Check out** IS the departure. `minutesLate` derives from the call time, `leftEarly`/`minutesEarly` from the end time with **no grace window** (unset when the event has no `endTime`). Live path: `checkInMember` / `checkOutMember`. `recordAttendance(request, patch, actor)` is the **manager-only retro-edit** path; it clears exception when `checkedInAt` is set and vice versa.
- **FTO starts the shift; retro edits are manager-only** (D-29): `getAttendanceAccess()` in `event-utils.ts` is the single source of attendance permissions — never re-derive role checks in the drawer. The assigned FTO must check **themselves** in before any other row unlocks, acts on **their own team only** (including a team-scoped `endEventShifts(eventId, actor, teamIds)`), and sees a **read-only** panel once the event is past (`isEventPast`). Only admin/quartermaster/**medops** get retroactive time/status edits — the only place time inputs exist.
- **Shift hours** (D-17): shift ends via per-event **End shift** (`endEventShifts`) OR auto on statpack check-in — `logStatpackCheckOff` captures the pack's `currentEventId` before clearing it and calls `endEventShifts` best-effort *outside* the transaction. Hours = `shiftEndAt − checkedInAt` (`shiftHours`). Stats via `getMemberShiftStats` (shifts/checkedIn/lateCount/totalMinutesLate/noShow/excused/hours, all-time + semester) on `/profile` and `/roster`.
- **Notifications are in-app broadcasts** (D-19): `requestShift` + the notify modal write `notifications` docs (`broadcast`) to managers + the team FTO. No email — static export has no mail server.
- **Statpack↔event correlation**: checkout picks an event; threaded through `logStatpackCheckOff` → `StatpackLog.eventId/eventName` + `Statpack.currentEvent(Id)`, cleared on check-in.
- **Org config** (`/settings` "Events & Venues"): `venues`, `eventTypes`, `semesterStartDate` (drives "this semester" stats). Getters `getVenues/getEventTypes/getSemesterStart`.
- **Gotcha**: `deepRemoveUndefined` (`app/lib/audit.ts`) preserves Firestore `Timestamp`s (previously rebuilt them into plain maps, breaking `createEvent` dates); `toJsDate` also coerces legacy `{seconds,nanoseconds}` maps. `scripts/repair-event-dates.cjs` (dry-run default) repairs old broken docs.

### Statistics Dashboards (`/stats`)
Four dashboards of hand-written **tiles** on a drag/resize canvas — Tableau's *dashboard*, not
its *authoring tool*. There is no field picker, no "Show Me", and no generic query engine; see
[decisions.md](decisions.md) **D-27** before adding one.

- **Tiles** are React components registered in `app/components/stats/tile-registry.tsx`
  (`ALL_TILES` / `TILE_REGISTRY`), grouped per dashboard in
  `app/components/stats/tiles/{procurement,consumption,staffing}.tsx`. A tile is a pure function
  of `(data, filters)` → chart: it must never fetch, and talks to the rest of the dashboard only
  via `onCrossFilter`. Tile ids are `<dashboard>.<name>` and **must** match `DEFAULT_LAYOUTS` in
  `app/lib/dashboards.ts` — a mismatch renders nothing, silently
  (`assertDefaultLayoutsResolve()` logs it in dev).
- **Metrics** live in `app/lib/stats/{procurement,consumption,staffing,restock}.ts`, all pure
  `(StatsData, StatsFilterState, tileId?)` selectors, with shared helpers + the `StatsData`
  bundle in `app/lib/stats/shared.ts`. **Unknown aggregates return `null`, never `0`** — a
  fabricated zero is indistinguishable from a real one on a chart.
- **Charts** are Recharts, wrapped once in `app/components/stats/chart-kit.tsx`
  (`BarChartTile`/`LineChartTile`/`AreaChartTile`/`ScatterChartTile`/`HistogramTile`/`DonutTile`/
  `FunnelTile`/`KpiTile`/`DataTable`/`EmptyState`). Colors resolve from HeroUI's `--heroui-*` CSS
  vars so both themes work with no JS. Never import Recharts directly in a tile.
- **Cross-filtering**: a tile emits a `CrossFilter`; every *other* tile narrows while the source
  highlights (`passesCrossFilters(fields, filters, own)`). A record lacking the filtered
  dimension is **not** excluded — so a vendor filter can't blank an events chart. Active filters
  are always visible and removable on the filter shelf.
- **Layout persistence**: `dashboards` collection via `app/lib/dashboards.ts` — a personal doc
  (`<uid>__<key>`) wins over the org-published one (`published__<key>`), else `DEFAULT_LAYOUTS`.
  `layoutIsValid` clamps corrupt layouts to the default rather than crashing.
- **Role gating is per dashboard**: `staffing`/`calls` use `isEventManagerRole` (medops must
  reach them), `procurement`/`consumption` stay admin/QM. Do **not** collapse these to one
  `isAdmin` check (D-13). `useStatsData` loads only the active dashboard's collections and
  tolerates a denied read per-dataset, so a gated collection degrades one tile, not the page.
- **Layout rule**: desktop is a fixed-height shell (`md:h-screen md:overflow-hidden`) with the
  canvas as the only scroll region — same rule as `/inventory`. Below `md`, tiles stack and
  drag/resize are disabled.
- **Calls has no data yet.** `Event.callTime` is a report-for-duty time, *not* a 911 call. Call
  metrics wait on an ESO/NEMSIS import (D-28, `app/lib/calls/nemsis-map.ts`); the dashboard shows
  an honest "not connected" state instead of blank charts.
- **No shelf-drift tile** — the data isn't persisted. See the comment in `consumption.ts` §5.

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

### Two-pool stock model (back reserve / front shelf)
Every consumable `InventoryItem` splits into two pools:
- **Back reserve** — the item's batch/box counts (`batches[]` bag-tracking, or `unopenedBoxes`/`looseUnits`). This is what `computeBagStock().availableItems` returns and is the ONLY pool that drives `getItemStatus` (ok/low/out/expired/expiring) and reordering decisions. An item with a full front shelf but an empty back room still correctly reads `out` — the shelf is never a substitute for reserve in that math, on purpose (see the comment at `getItemStatus` in `app/lib/item-status.ts`).
- **Front shelf** — `InventoryItem.shelfQuantity`, the deployed pool members actually grab from day to day. It is deliberately **not event-tracked**: general members won't reliably log every unit they take off the shelf, so instead of instrumenting consumption, roughly weekly someone physically counts the shelf and the count **re-anchors** `shelfQuantity` to reality (`lastShelfCheckAt`/`lastShelfCheckBy` stamp the check; `isShelfCheckCurrent()` in `app/lib/item-status.ts` checks that stamp against `THRESHOLDS.shelfCheckIntervalDays`, default 7).
- `refillShelf()` (`app/lib/restock-actions.ts`, pool math in `app/lib/stock-pools.ts`) is a **transfer**, never a stock creation: it moves units from reserve to shelf via `consumeReserveUnits` (FEFO, loose-before-breaking-bags/boxes, clamped to what reserve actually has) and either increments `shelfQuantity` (plain refill) or, when `observedShelfQty` is passed, SETS it to `observedShelfQty + consumed` (the weekly re-anchor). A check can also happen with no transfer at all (`qty: 0` + `observedShelfQty` set) to record a count without touching reserve. See `app/restock/page.tsx` (`RefillModal`, `ShelfSweepModal`) for the UI.
- **This is a different axis from the deferred class-use vs. field/event stock-pool gap** listed under "Known open design gaps" below — do not conflate the two. That gap is about *which reserve* a draw comes from (class training vs. field deployment); the front-shelf/back-reserve split here is about *deployed-but-uncounted* vs. *counted-and-available* stock within a single reserve.

### Firestore Collections (what the code actually reads/writes — see MODEL.md for shapes)
`inventory` (central collection — consumables, assets, oxygen, and medications are all `inventory` docs discriminated by flags; there is **no** separate `assets` collection), `inventory_logs`, `inventory_alerts`, `auditEvents` (audit ledger — camelCase, written by `app/lib/audit.ts`), `statpacks`, `statpack_logs`, `vehicles` (individual fleet vehicles — roster + live checkout state), `vehicle_logs` (one doc per shift, written with the vehicle doc in one transaction by `app/lib/vehicles.ts`), `restock_shelves`, `restock_shelf_events`, `restock_actions`, `restock_reports`, `storage_zones`, `shelves`, `containers`, `box_logs`, `medication_logs`, `buyList` (camelCase — **not** `buy_list`), `tasks`, `issue_reports`, `users`, `org_settings`, `laf_records`, `reconciliation_exceptions`, `events` (+ `teams[]`), `shift_requests`, `notifications`, `purchases` (order-level cost; `app/lib/purchases.ts`), `purchase_history`, `purchase_requests`, `exchange_bags`, `exchange_bag_events`, `restock_categories`, `team_tasks`, `dashboards` (saved /stats layouts)

### Known open design gaps (do not silently "fix")
Two schema decisions are deliberately deferred, tracked in [decisions.md](decisions.md) (D-11/D-12), `FINDINGS.md`, and `invariants.md`:
- **No stock-pool axis** distinguishing class-use stock from field/event stock.
- **No real per-lot quantity for box-tracked SKUs** — quantity is pooled onto `unopenedBoxes` with a zero-stock metadata batch standing in for the lot.

If a task touches either, flag it as an open design question and ask before assuming there's a bug to patch — changing this without a decision would change how on-hand counts are computed.

### Shared Status Logic
`app/lib/item-status.ts` is the single source of truth for stock math (`computeBagStock`), item status (`getItemStatus`: expired > out > low > expiring > ok), location display (`displayLocation`), expiry formatting, and the monthly audit cycle (`isAuditedThisMonth` — an item is "verified" only if `lastAuditDate` falls in the current calendar month; the sticky `auditVerified` boolean must not be trusted alone). Expiration windows come from `THRESHOLDS` in org-config. Category badge colors live in `app/components/category-badge.tsx`. Location filter dropdowns derive from `getInventoryAreaOptions()` in org-config — never hardcode location lists in pages.

### Business Logic Helpers
`app/lib/` contains pure helpers for audits (`audit.ts`, `audit-helpers.ts`), statpack operations (`statpacks.ts`), inventory (`inventory.ts`), logging (`logs.ts`), reporting (`reports.ts`), and PDF/label printing (`print.ts`).
