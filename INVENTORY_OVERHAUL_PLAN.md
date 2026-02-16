# Inventory System Overhaul — Implementation Plan

> **Goal**: Transform the inventory system from a generic stock-counter into a disposables-focused, batch-aware, bag-tracking platform that integrates tightly with Storage Management for locations and supports a prospective "initial inventory → bagging → box-opening" workflow.

---

## 1. Problem Summary

| Pain point | Current state | Desired state |
|---|---|---|
| **Batch logic** | Batches exist but are flat: one stock number, no per-batch status, no real "bag" concept | Multiple batches per item, each with: **bag count**, **items per bag**, **lot #**, **expiration**, **status** (Sealed / Open / Depleted), **received date** |
| **Items per bag variability** | `itemsPerBox` is global on the item | Each batch can have its own `itemsPerBag` — because the supplier may change quantities between orders |
| **Statpack Quick Add** | Inventory modal has a section to import items from a statpack | Remove entirely — once items leave back storage they're tracked by the statpack page, not the inventory page |
| **Supply Ledger** | Navbar shows "Supply Ledger" linking to `/audit/events` | Remove nav link. Warnings about statpack contents belong in the statpack page logs, not a separate ledger |
| **Modal complexity** | Add/edit modal has asset fields, AED units, statpack quick-add, oxygen sliders, open/close box tracking, variants — most don't apply to disposables | Streamlined: disposables-only modal with sections: **Basic Info → Location (from storage) → Batches → Notes**. Asset editing stays on the Asset page |
| **Location management** | Location is a hardcoded enum (`HQ`, `CPR Closet`, `Shed`) with free-text shelf | Location picker reads live from `storage_zones` → `shelves` → `containers` Firestore collections, so adding a new shelf in Storage Management auto-appears in inventory |
| **Statpack vs Asset pages** | Both show similar tabular lists; assets page duplicates statpack editing | **Statpack page** = pack management, checklists, checkout/checkin, log history. **Asset page** = high-value equipment tracking, maintenance logs, barcode assignment, condition monitoring |
| **Prospective workflow** | No guided flow for initial inventory | Support: (1) catalog what you have, (2) receive & create batches, (3) subdivide into bags, (4) consume a bag (mark as opened → decrement) |

---

## 2. Type System Changes — `app/types.ts`

### 2a. `InventoryBatch` — Add batch-level status and bag tracking

```typescript
// ADDITIONS to InventoryBatch:
export type BatchStatus = 'sealed' | 'open' | 'depleted' | 'expired' | 'quarantined';

export interface InventoryBatch {
  // ... existing fields kept ...
  
  /** How this specific batch is packaged (supplier may vary between orders) */
  itemsPerBag?: number;
  /** Number of sealed bags in this batch (source-of-truth count) */
  bagCount?: number;
  /** Number of loose individual items not in a complete bag */
  looseItems?: number;
  /** Lifecycle status of this batch */
  status?: BatchStatus;
  /** When this batch was opened (first bag unsealed) */
  openedAt?: Date;
  /** Who opened this batch */
  openedBy?: string;
}
```

### 2b. `InventoryItem` — Clean up deprecated fields

- **Keep**: `id`, `name`, `category`, `description`, `reorderThreshold`, `batches[]`, `tracksExpiration`, `isOxygen`/`oxygenPsi`/`maxOxygenPsi`, `isAsset`, `createdAt`, `updatedAt`, `unit`
- **DEPRECATE** (stop writing, ignore on read): `unopenedBoxes`, `itemsPerBox`, `looseUnits`, `totalStockQuantity`, `unopenedQuantity`, `openedQuantity`, `quantityPerUnit`, `tracksOpenStock`, `hasSecondaryExpiration`, `secondaryExpirationDays`, `openedAt`
- **Computed at read time**: `totalBags` = sum of `batch.bagCount` across all non-depleted batches; `totalLoose` = sum of `batch.looseItems`; `totalUnits` = sum of `(batch.bagCount × batch.itemsPerBag) + batch.looseItems` for non-depleted batches
- **Location fields**: replace hardcoded `location`/`room`/`shelf`/`backShelf`/`backLevel` with:

```typescript
/** Reference to a storage zone, shelf, or container from Storage Management */
export interface StorageLocationRef {
  zoneId?: string;
  zoneName?: string;   // denormalized for display
  shelfId?: string;
  shelfName?: string;  // denormalized
  level?: number;      // which level on the shelf
  containerId?: string;
  containerName?: string; // denormalized
}
```

Add `storageLocation?: StorageLocationRef` on `InventoryItem`. Keep legacy `location`/`room`/`shelf` for migration compat but stop writing them for new items.

### 2c. Remove `InventoryVariant` from active use

Variants were for sizing (S/M/L) but that doesn't apply to disposable EMS supplies. Instead, different sizes = different inventory items. Remove the variant UI and variant-related code paths from the modal. Keep the type for backwards compat but stop rendering/writing it.

---

## 3. Inventory Page Overhaul — `app/inventory/page.tsx`

### 3a. Remove
- **Debug panel** (batch mismatch sync) — move to an admin-only settings page later
- **Variant stock ±** buttons — variants deprecated
- **Asset grid** rendering in expanded cards — assets are on the assets page
- **`totalStockQuantity`** reliance — compute totals from batches
- **`handleRestockForward`** — forward restocking is a statpack page concern
- **`syncMismatches`** — deprecated
- **Duplicated variant rendering** (there are two identical variant blocks in the expanded view — remove both)

### 3b. Redesign card layout
Each inventory item card shows:

```
┌────────────────────────────────────────────────────────┐
│ [Category Chip]  Item Name             [Status Chip]   │
│ 📍 HQ / Back Room / Shelf A, Level 2                  │
│                                                        │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐               │
│  │ 12 Bags │  │ 3 Loose │  │ 1203 ea │  Par: 5 bags  │
│  │ sealed  │  │  items  │  │  total  │               │
│  └─────────┘  └─────────┘  └─────────┘               │
│                                                        │
│  [▾ 3 Batches]  [Edit] [Open Bag]                     │
└────────────────────────────────────────────────────────┘
```

Expanded batch section (click ▾):

```
│  Batch: Lot#A2024  │ Exp: 2026-08 │ Status: Sealed  │
│  5 bags × 100/bag  │ Received: Jan 2025              │
│  Batch: Lot#A2023  │ Exp: 2025-12 │ Status: Open    │
│  2 bags × 100/bag + 47 loose │ Opened: Dec 2024     │
```

### 3c. "Open Bag" action
When user clicks "Open Bag" on a card:
1. FIFO: select the oldest non-depleted batch
2. Decrement `bagCount` by 1
3. Add `itemsPerBag` to `looseItems` on that batch
4. If `bagCount` reaches 0 and `looseItems` > 0, set status = `open`
5. If both reach 0, set status = `depleted`
6. Log to `inventory_logs`

### 3d. "Consume Items" action
When loose items are used (member takes gauze pads from an open bag):
1. Prompt for quantity consumed
2. Decrement `looseItems` on the oldest open batch
3. If `looseItems` reaches 0 and `bagCount` = 0, mark batch `depleted`
4. Log to `inventory_logs`

### 3e. Location display
Read `storageLocation` and display: `{zoneName} / {shelfName}, Level {level}` or fallback to legacy `location / room / shelf`.

---

## 4. Add/Edit Item Modal Overhaul — `app/components/additemmodal.tsx`

### 4a. Remove entirely
- **Statpack Quick Add** section (lines ~1000-1070 in current file)
- **Asset fields** (isAsset toggle, asset value, asset category, AED units, serial fields) — assets are managed on the assets page
- **Variant management** (add/remove/reorder variants)
- **Open/close box tracking** (tracksOpenStock, open/close actions)
- **"Current Stock" legacy input** (totalStockQuantity) — total is computed from batches
- **Statpack footer button** ("Add Selected from Statpack")

### 4b. New modal structure (4 sections)

**Section 1 — Basic Info**
- Name (with duplicate detection — keep existing fuzzy logic)
- Category (Select from ItemCategory)
- Unit type (e.g., "box", "bag", "each")
- Description (Textarea)
- SKU / Barcode (optional, collapsible)
- Reorder threshold
- Require expiration confirmation toggle

**Section 2 — Location (Storage-linked)**
- Zone picker: `<Select>` populated from `storage_zones` collection
- Shelf picker: `<Select>` filtered by selected zone, from `shelves` collection  
- Level picker: `<Select>` with options 1..N based on `shelf.numberOfLevels`
- Container picker (optional): `<Select>` filtered by selected shelf, from `containers` collection
- All selects use `onSnapshot` for real-time data

**Section 3 — Batches**
- "Add Batch" button
- Each batch card:
  - Lot # (Input)
  - Expiration date (Input type=date)  
  - Number of bags (Input type=number)
  - Items per bag (Input type=number) — **per-batch, not per-item**
  - Loose items (Input type=number, default 0)
  - Status (Select: Sealed / Open / Depleted / Expired / Quarantined)
  - Received date (Input type=date)
  - Notes (Input)
  - Purchase info (collapsible): supplier, price, PO#
  - Location splits (if batch is spread across spots): keep existing per-batch location rows but use storage pickers
- Calculated total at bottom: `Σ (bagCount × itemsPerBag + looseItems)` across all batches

**Section 4 — Special Tracking (collapsible)**
- Oxygen toggle + PSI slider (only when isOxygen)
- Reagent toggle + days-valid-after-opening (only when isReagent)

### 4c. Submit logic
- Compute `totalUnits` from batches
- Write `storageLocation` from the selected zone/shelf/level/container
- Write `batches[]` with all per-batch data including `itemsPerBag`, `bagCount`, `looseItems`, `status`
- Do NOT write deprecated fields (`unopenedBoxes`, `itemsPerBox`, `totalStockQuantity`, etc.)

---

## 5. Supply Ledger Removal

### 5a. `app/components/appnavbar.tsx`
- Remove the "Supply Ledger" nav item from both desktop and mobile menus (lines ~156-166, 216, 350)
- The `/audit/events` page itself can remain for direct URL access but is no longer in navigation

### 5b. Warnings → Statpack logs
- Any low-stock or expiration warnings that currently appear in the supply ledger should instead be surfaced:
  - On the inventory card itself (chips: "Low Stock", "Expiring Soon", "Expired")
  - On the statpack page log history for packs that contain affected items
  - Not as a standalone ledger page

---

## 6. Storage-Based Location System

### 6a. Shared hook: `app/hooks/useStorageLocations.ts` (new)
```typescript
export function useStorageLocations() {
  // Returns { zones, shelves, containers, loading }
  // Real-time onSnapshot listeners on storage_zones, shelves, containers
  // Provides helper: getShelvesForZone(zoneId), getContainersForShelf(shelfId), getLevelsForShelf(shelfId)
}
```

### 6b. Reusable component: `app/components/storage-location-picker.tsx` (new)
- Cascading selects: Zone → Shelf → Level → Container
- Used in: add/edit item modal, batch location rows, any future location-selection UI
- When a zone/shelf changes in Storage Management, the picker auto-updates via onSnapshot

---

## 7. Statpack vs Asset Page Differentiation

### 7a. Statpack page (`app/statpacks/page.tsx`) — Focused on pack management
- **Keep**: Pack list, bag visualizer, content editor, checkout/checkin, log history, QR codes, barcode scanning
- **Remove**: Any inventory editing or stock management that overlaps with the inventory page
- **Add**: Surface warnings about items inside statpacks (expiring, low stock in back room) directly in the pack card — these warnings come from reading the linked inventory items' batch data

### 7b. Asset page (`app/assets/page.tsx`) — Focused on high-value equipment
- **Keep**: Asset list with status, maintenance logs, barcode assignment/scanning, print labels, condition monitoring
- **Remove**: Statpack content editor (duplicated from statpack page), statpack compartment display
- **Clarify tabs**: 
  - Tab 1: **Equipment** — AEDs, radios, O2 tanks (inventory items where `isAsset=true`)
  - Tab 2: **Statpacks** — statpack containers themselves (the bag as an asset, not its contents)
  - Tab 3: **Maintenance** — maintenance log timeline across all assets

---

## 8. Prospective Workflow Support

The system now supports this operational flow:

```
1. CATALOG      →  Create items in inventory with basic info + category
2. RECEIVE      →  Add a batch when supplies arrive (lot#, exp, bag count, items/bag)
3. LOCATE       →  Assign the batch to a storage location (zone/shelf/level)
4. BAG/SUBDIVIDE→  If you're re-bagging, update the batch: set custom itemsPerBag + bagCount
5. CONSUME      →  "Open Bag" marks one bag consumed; items move to looseItems
6. AUDIT        →  Use Supply Audit to verify counts match physical inventory
```

---

## 9. Execution Order

| Phase | Files | Description |
|---|---|---|
| **A** | `app/types.ts` | Add `BatchStatus`, `StorageLocationRef`, batch-level `itemsPerBag`/`bagCount`/`looseItems`/`status` |
| **B** | `app/hooks/useStorageLocations.ts`, `app/components/storage-location-picker.tsx` | New shared hook + picker component |
| **C** | `app/components/additemmodal.tsx` | Full rewrite: remove statpack quick-add, asset fields, variants; add batch manager with bags, storage picker |
| **D** | `app/inventory/page.tsx` | Rewrite cards: batch-aware totals, Open Bag/Consume actions, storage location display, remove debug panel/variants/asset grid |
| **E** | `app/components/appnavbar.tsx` | Remove Supply Ledger nav link |
| **F** | `app/statpacks/page.tsx` | Add inventory item warnings to pack cards; remove any inventory editing overlap |
| **G** | `app/assets/page.tsx` | Remove statpack content editing; clarify tabs (Equipment / Statpacks / Maintenance) |
| **H** | Build + lint verification | `npx next build`, `npx eslint app/` |

---

## 10. Migration Notes

- **Existing items with `unopenedBoxes`/`itemsPerBox`**: During read, if no batches exist, synthesize a virtual batch: `{ bagCount: item.unopenedBoxes, itemsPerBag: item.itemsPerBox, looseItems: item.looseUnits, status: 'sealed' }`
- **Existing items with `batches[]` but no `bagCount`**: Treat `batch.stock` as `bagCount` with `itemsPerBag: 1` (each unit is one bag)
- **`totalStockQuantity`**: Stop writing; compute from batches on read
- **`location`/`room`/`shelf`**: Keep reading for display if `storageLocation` is not set; stop writing for new items
- A migration script in `scripts/` can be added later to back-fill `storageLocation` and `bagCount` on existing items

---

## 11. HeroUI Component Usage

All UI should use HeroUI components consistently:

| UI Element | HeroUI Component |
|---|---|
| Buttons | `Button` with `color`, `variant`, `startContent` (lucide icon) |
| Form inputs | `Input` with `label`, `variant="bordered"`, `description` |
| Selects/Dropdowns | `Select` + `SelectItem` |
| Toggle switches | `Switch` |
| Cards | `Card` + `CardBody` + `CardHeader` |
| Chips/Tags | `Chip` with `color`, `variant` |
| Tables | `Table` + `TableHeader` + `TableColumn` + `TableBody` + `TableRow` + `TableCell` |
| Modals | `Modal` + `ModalContent` + `ModalHeader` + `ModalBody` + `ModalFooter` |
| Tabs | `Tabs` + `Tab` |
| Progress | `Progress` for stock level bars |
| Dividers | `Divider` |
| Tooltips | `Tooltip` |
| Spinners | `Spinner` |

No raw `<button>`, `<input>`, `<select>`, or `<table>` elements. No emojis for icons — use `lucide-react` icons.
