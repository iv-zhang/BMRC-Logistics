# BMRC Logistics — Comprehensive Implementation Plan v2

> Created: 2026-02-18 | Scope: Issues 1–5 | Strategy: Foundation-first, dedup, then features

---

## Executive Summary

This plan addresses five interconnected issues by first establishing a **shared foundation** (config system, unified scanning service, decomposed components) and then layering features on top. Every change is designed to eliminate duplication and make the system extensible.

### Current Duplication Audit (to be resolved)

| Duplication | Where | Resolution |
|---|---|---|
| `IssueReport` defined twice | `app/types.ts` ~L405 & ~L695 | Remove first, keep full version |
| Barcode scanning logic | 5+ components with inline scanning | New `useBarcodeScanner` hook + unified `<ScannerInput>` component |
| Auth/role fetching | Manual in assets page vs `useAuth` hook elsewhere | Use `useAuth` everywhere |
| Statpack editor | Duplicated between `assets/page.tsx` & `statpacks/page.tsx` | Extract `<StatpackEditor>` component |
| Date normalization | 4+ locations | Single `normalizeDate()` in `app/utils/dates.ts` |
| `isAsset` classification | Inline checks vs `classifyItem()` in lib | Always use `classifyItem()` from lib |
| Asset page monolith | 1,967 lines in one file | Decompose into 6+ focused components |

---

## Phase 0: Foundation — Configurable System (Issue 5)

**Goal:** Make the entire platform customizable without code changes.

### 0.1 Create `app/config/org-config.ts`
A single source of truth for all organization-specific values currently hardcoded.

```
export interface OrgConfig {
  org: { name, shortName, logo, timezone }
  locations: { id, name, type, rooms[] }[]
  vehicleTypes: { id, name, icon, hasStatpacks }[]  // ambulance, ebike, utv, etc.
  assetCategories: { id, name, icon, verificationFields[] }[]
  statpackTypes: { id, name, pockets[] }[]
  pocketDefinitions: { id, label, icon, defaultPosition }[]
  thresholds: { assetValueThreshold, lowStockPercent, expirationWarningDays }
  roles: { id, label, permissions[] }[]
  verificationFieldDefs: { id, label, type, unit?, min?, max?, required? }[]
}
```

**Key principle:** Every dropdown, category list, location picker, and threshold reads from this config. Adding a new vehicle type or location = one config entry, zero code changes.

### 0.2 Create `app/config/verification-fields.ts`
Define all possible item-specific verification fields:
- `expiration_date` — date picker, required for meds
- `battery_level` — slider 0-100%, for AEDs
- `o2_psi` — number input 0-2200, for O2 tanks
- `serial_scan` — barcode scanner, for serialized assets
- `condition` — good/damaged/expired toggle
- `seal_intact` — boolean, for sealed items
- `lot_number` — text, for batch-tracked items

### 0.3 Create `app/hooks/useOrgConfig.ts`
Hook that provides typed config access with future support for Firestore-stored overrides:
```
const { locations, assetCategories, getVerificationFields } = useOrgConfig();
```

### 0.4 Migrate hardcoded values
- Replace `LocationType`, `HQRoom` literals in types.ts with config-driven values
- Replace `ASSET_CATEGORIES` const with config-driven list
- Replace hardcoded pocket definitions with config
- Replace all inline threshold checks with config values

### Files created/modified:
- **NEW:** `app/config/org-config.ts`
- **NEW:** `app/config/verification-fields.ts`
- **NEW:** `app/hooks/useOrgConfig.ts`
- **MOD:** `app/types.ts` — reference config types
- **MOD:** All components using hardcoded categories/locations

---

## Phase 1: Unified Scanning Service (Issue 1)

**Goal:** One scanning abstraction used everywhere. Scan a barcode → assign it to an asset (no generation).

### 1.1 Create `app/hooks/useBarcodeScanner.ts`
Unified hook that wraps `@zxing/library` with:
- Camera-based scanning (reuses logic from `barcode-scanner.tsx`)
- Manual text input fallback
- Consecutive-read confirmation (already in barcode-scanner, standardize)
- GS1 barcode parsing (reuse from `app/lib/gs1.ts`)
- Returns `{ startScan, stopScan, lastCode, isScanning, inputMode }`

### 1.2 Create `app/components/scanner-input.tsx`
Reusable UI component that replaces all inline scanning UI:
```
<ScannerInput
  onScan={(code) => ...}
  placeholder="Scan or type barcode..."
  allowManual={true}
  allowCamera={true}
  autoFocus={true}
/>
```
This component combines the camera viewfinder, manual text input, and image upload from `barcode-scanner.tsx` into a single drop-in component.

### 1.3 Refactor `app/components/barcode-scanner.tsx`
Keep as the low-level camera component but have `ScannerInput` be the public API. Remove duplicated scanning logic from:
- `app/assets/page.tsx` (inline scanner)
- `app/components/assetmodal.tsx` (external tag assignment)
- `app/assets/checkout/page.tsx` (asset lookup)
- `app/statpacks/checkout/page.tsx` (statpack lookup)
- `app/statpacks/checkin/page.tsx` (statpack lookup)

### 1.4 Scan-to-Assign workflow for assets
Instead of generating barcodes, the `AssetModal` flow becomes:
1. Admin creates/edits an asset
2. Admin clicks "Assign Barcode Tag" → opens `ScannerInput`
3. Admin scans the physical barcode on the asset
4. System checks for duplicates via `assignExternalBarcodeTag()`
5. Barcode is stored on the asset document
6. All future scans of that barcode resolve to this asset

**Remove:** Auto-generate serial/barcode/QR UUID buttons from `AssetModal` (keep manual entry as fallback).

### Files created/modified:
- **NEW:** `app/hooks/useBarcodeScanner.ts`
- **NEW:** `app/components/scanner-input.tsx`
- **MOD:** `app/components/barcode-scanner.tsx` — simplify to pure camera component
- **MOD:** `app/components/assetmodal.tsx` — remove auto-gen, add scan-to-assign
- **MOD:** `app/assets/page.tsx` — use `ScannerInput`
- **MOD:** `app/assets/checkout/page.tsx` — use `ScannerInput`
- **MOD:** `app/statpacks/checkout/page.tsx` — use `ScannerInput`
- **MOD:** `app/statpacks/checkin/page.tsx` — use `ScannerInput`

---

## Phase 2: Asset ↔ Statpack Integration (Issue 2)

**Goal:** Bidirectional visibility — see an asset's statpack location (including pocket) from asset view, and see all assets in a statpack from statpack view.

### 2.1 Enhance data model
Add to `InventoryItem` / asset instances:
```typescript
statpackAssignment?: {
  statpackId: string;
  statpackName: string;
  pocket: StatpackPocket;        // which pocket it goes in
  compartmentLabel?: string;     // e.g., "Top flap"
  positionIndex?: number;        // order within pocket
  assignedAt: Timestamp;
  assignedBy: string;
}
```
Add to `StatpackItem`:
```typescript
assetInstanceId?: string;       // links to specific instance
assetVerificationRules?: AssetVerificationRules;
```

### 2.2 Create `app/components/asset-statpack-badge.tsx`
Visual badge shown on asset cards/rows:
- Shows statpack name + pocket icon (e.g., "MRC1 → Main Pocket")
- Clickable → navigates to statpack detail with that pocket highlighted
- Shows "Unassigned" state for assets not in any statpack

### 2.3 Create `app/components/statpack-asset-summary.tsx`
Panel within statpack editor showing all assets:
- Grouped by pocket
- Each asset shows: name, serial, status, last verified date
- Quick-action buttons: verify, swap, remove
- Visual indicator if asset is missing, expired, or needs maintenance

### 2.4 Enhance `assignAssetToStatpack()` in `app/lib/inventory.ts`
Currently sets `assignedStatpack` on the inventory item. Enhance to:
1. Also store the pocket assignment on both sides
2. Update `StatpackItem` with `assetInstanceId`
3. Create audit event linking both documents
4. Validate no double-assignment (asset can only be in one statpack)

### 2.5 Bidirectional navigation
- **Asset view → Statpack:** Click badge → opens statpack detail with pocket highlighted
- **Statpack view → Asset:** Click asset in contents → opens asset detail modal
- **Both views** show the same assignment data, kept in sync via the shared Firestore documents

### Files created/modified:
- **NEW:** `app/components/asset-statpack-badge.tsx`
- **NEW:** `app/components/statpack-asset-summary.tsx`
- **MOD:** `app/types.ts` — add `statpackAssignment` to `InventoryItem`
- **MOD:** `app/lib/inventory.ts` — enhance `assignAssetToStatpack()`
- **MOD:** `app/assets/page.tsx` — show badge on asset rows
- **MOD:** `app/statpacks/page.tsx` — show asset summary in editor

---

## Phase 3: Streamlined Asset Verification & Checkout (Issue 3)

**Goal:** Admin can scan 10 radios in rapid succession to check them all out. Minimal clicks.

### 3.1 Create `app/components/batch-asset-checkout.tsx`
New "Batch Checkout" mode on the asset checkout page:
1. Admin selects checkout purpose (Training, Event, Maintenance)
2. Admin enters who/where/when
3. **Continuous Scan Mode:** Scanner stays active. Each scan:
   - Beeps/vibrates on successful read
   - Shows asset name + thumbnail in a running list
   - Auto-adds to checkout batch
   - Shows running count ("7/10 radios scanned")
4. Admin reviews list, confirms checkout
5. Single batch Firestore transaction checks out all assets

**Key UX:** Scanner does NOT close between scans. Visual + audio feedback per scan. One confirm button at the end.

### 3.2 Create `app/components/batch-asset-checkin.tsx`
Mirror of batch checkout for returns:
1. Admin enters context
2. Continuous scan mode with per-asset condition check (Good/Damaged)
3. Optional quick-note per asset
4. Batch checkin transaction

### 3.3 Enhance `app/assets/checkout/page.tsx`
Add toggle between:
- **Single Asset Mode** (current flow, simplified)
- **Batch Mode** (new `BatchAssetCheckout` component)

### 3.4 Optimize Firestore operations
- `checkoutAsset()` and `checkinAsset()` currently handle one asset at a time
- Create `batchCheckoutAssets()` and `batchCheckinAssets()` that use a single Firestore batch/transaction for all assets in the batch

### Files created/modified:
- **NEW:** `app/components/batch-asset-checkout.tsx`
- **NEW:** `app/components/batch-asset-checkin.tsx`
- **MOD:** `app/assets/checkout/page.tsx` — add batch mode toggle
- **MOD:** `app/lib/inventory.ts` — add batch operations
- **MOD:** `app/components/asset-verification-modal.tsx` — simplify single-asset flow

---

## Phase 4: Member Statpack Checkout Asset Verification (Issue 4)

**Goal:** When a member checks out a statpack and reaches an asset item, they can scan its barcode to verify it's the right one, then confirm item-specific properties.

### 4.1 Enhance pocket checkout flow in `statpacks/checkout/page.tsx`
Current flow: member selects statpack → selects pockets → checks items off.
New flow adds per-item verification for assets:

1. Member reaches an asset item in the checklist (e.g., "Epipen")
2. UI shows: **"Scan to verify"** button + manual fallback
3. Member scans the epipen barcode
4. System matches scanned code to expected asset assignment
5. ✅ Match → auto-fills verification, shows green checkmark
6. ❌ Mismatch → warning: "Expected Epipen #EPI-003, scanned Epipen #EPI-007"
7. After scan match, show **item-specific verification fields** based on config:
   - Epipen: expiration date confirmation
   - O2 Tank: PSI level reading
   - AED: battery level indicator
   - Radio: power-on check
8. Member confirms → item marked as verified

### 4.2 Create `app/components/asset-verify-step.tsx`
Reusable component for the per-item asset verification:
```
<AssetVerifyStep
  expectedAsset={statpackItem}
  verificationFields={['expiration', 'serial_scan']}
  onVerified={(result) => markItemDone(item)}
  onSkip={() => markItemSkipped(item)}
/>
```
Renders:
- Scanner input for barcode matching
- Dynamic verification fields from config
- Pass/fail indicators
- Skip option (with warning logged)

### 4.3 Admin Audit Mode
For semi-regular statpack and asset audits:
1. Admin opens audit from statpack or asset view
2. **Scan-and-go mode:** continuous scanner
3. Each scan identifies the asset and auto-populates its audit entry
4. Shows checklist of items per pocket with scan status
5. Unscanned items flagged as "Not verified"
6. Batch submit audit results

Enhance existing `AuditCheckModal` to support this flow.

### 4.4 Enhance `validateStatpackCheckout()` in `app/lib/inventory.ts`
Add verification result tracking:
- Store which items were scan-verified vs manually confirmed vs skipped
- Track item-specific readings (PSI, battery %, expiration confirmed)
- Flag any discrepancies for admin review

### Files created/modified:
- **NEW:** `app/components/asset-verify-step.tsx`
- **MOD:** `app/statpacks/checkout/page.tsx` — integrate asset verification step
- **MOD:** `app/statpacks/checkin/page.tsx` — integrate asset verification on return
- **MOD:** `app/components/audit-check-modal.tsx` — add scan-and-go mode
- **MOD:** `app/lib/inventory.ts` — enhance validation tracking

---

## Phase 5: Component Decomposition & Cleanup

**Goal:** Break monolithic pages into maintainable components.

### 5.1 Decompose `app/assets/page.tsx` (1,967 lines → ~6 files)

| New Component | Lines | Responsibility |
|---|---|---|
| `app/assets/components/asset-table.tsx` | ~300 | Filterable/sortable asset table |
| `app/assets/components/asset-detail-modal.tsx` | ~250 | Single asset detail view + tabs |
| `app/assets/components/asset-maintenance.tsx` | ~200 | Maintenance start/complete workflow |
| `app/assets/components/statpack-editor-panel.tsx` | ~350 | Shared statpack contents editor |
| `app/assets/components/asset-filters.tsx` | ~100 | Filter bar (category, status, location) |
| `app/assets/page.tsx` | ~300 | Page shell, data loading, state orchestration |

### 5.2 Decompose `app/statpacks/page.tsx` (1,169 lines → ~4 files)

| New Component | Lines | Responsibility |
|---|---|---|
| `app/statpacks/components/statpack-list.tsx` | ~250 | Card grid with status badges |
| `app/statpacks/components/statpack-detail-modal.tsx` | ~300 | Single statpack detail + QR |
| `app/statpacks/components/statpack-actions.tsx` | ~150 | Checkout/checkin/maintenance buttons |
| `app/statpacks/page.tsx` | ~250 | Page shell, data loading |

### 5.3 Extract shared `StatpackEditor` component
Used by both assets page and statpacks page. Single source of truth for:
- Pocket-filtered content list
- Drag-to-reorder
- Add/remove/edit items
- Asset attachment
- Compartment management

### 5.4 Consolidate date utilities
Move all date normalization to `app/utils/dates.ts`:
- `normalizeDate()` — parse any date format
- `formatRelative()` — "2 hours ago"
- `isExpired()` / `isExpiringSoon()` — config-driven warning window
- Remove duplicates from `lib/statpack-log-utils.ts`, `utils/firestore.ts`, etc.

### 5.5 Fix type duplications
- Remove duplicate `IssueReport` from `app/types.ts`
- Ensure `classifyItem()` is the single `isAsset` check everywhere

---

## Dependency Graph

```
Phase 0 (Config) ──────────────────────────┐
Phase 1 (Scanner) ─────────────────────────┤
                                           ├──▶ Phase 2 (Integration)
                                           ├──▶ Phase 3 (Batch Checkout)
                                           ├──▶ Phase 4 (Member Verify)
                                           └──▶ Phase 5 (Decomposition)
```

Phases 0 and 1 are independent foundations. Phases 2-4 build on them. Phase 5 runs throughout.

---

## Implementation Order

1. **Phase 0.1–0.3** — Config system + hook
2. **Phase 5.5** — Fix type duplications (quick win)
3. **Phase 1.1–1.2** — Scanner hook + ScannerInput component
4. **Phase 1.3** — Refactor existing scanner usages
5. **Phase 1.4** — Scan-to-assign in AssetModal
6. **Phase 2.1–2.2** — Data model + badge component
7. **Phase 2.3–2.5** — Asset summary + bidirectional nav
8. **Phase 3.1–3.4** — Batch checkout/checkin
9. **Phase 4.1–4.4** — Member verification flow
10. **Phase 5.1–5.4** — Decomposition (can be done incrementally)

---

## Risk Mitigation

| Risk | Mitigation |
|---|---|
| Firestore batch limits (500 ops) | Chunk batch operations, add retry logic |
| Camera permissions on mobile | Graceful fallback to manual input in `ScannerInput` |
| Config migration breaking existing data | Config values match current hardcoded values exactly |
| Large page decomposition causing regressions | Test each extraction independently before moving to next |
| Barcode scanning reliability | Consecutive-read confirmation + manual fallback always available |
