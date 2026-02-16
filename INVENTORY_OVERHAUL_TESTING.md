# Inventory Overhaul — Testing Plan

> Stress tests, edge-case coverage, screenshot-verified HeroUI checks, and batch logic validation.

---

## Testing Philosophy

Every test category below includes:
1. **Happy path** — the expected flow works correctly
2. **Edge cases** — boundary values, empty states, missing data
3. **Stress tests** — large quantities, rapid actions, concurrent edits
4. **Screenshot verification** — visual confirmation that HeroUI components render correctly (no raw HTML, no emojis, proper dark mode)

---

## T1. Batch Model & Bag Tracking

### T1.1 Create item with single batch
1. Add Item → Name: "4×4 Gauze", Category: Trauma
2. Add Batch: Lot#=`LOT-2025A`, Exp=`2026-08-01`, Bags=10, Items/Bag=100, Status=Sealed
3. Save → verify card shows: **10 bags**, **1000 total units**, status chip "Sealed"
4. Open Firestore → verify `batches[0]` has `bagCount: 10`, `itemsPerBag: 100`, `looseItems: 0`, `status: 'sealed'`

**📸 Screenshot check**: Card uses `Chip` for status, `Card`/`CardBody` for layout, lucide `Box` icon — no raw elements

### T1.2 Create item with multiple batches (different items/bag)
1. Add Item → Name: "Nitrile Gloves"
2. Batch 1: Lot#=`A`, Exp=`2026-01`, Bags=5, Items/Bag=100, Status=Sealed
3. Batch 2: Lot#=`B`, Exp=`2026-06`, Bags=8, Items/Bag=**200** (new supplier)
4. Save → card shows: **13 bags**, **2100 total units** (5×100 + 8×200)
5. Expanded batch view shows both batches with their own items/bag values

### T1.3 Open Bag (FIFO)
1. Item has 2 batches: Batch A (exp 2025-12, 3 bags×50) and Batch B (exp 2026-06, 5 bags×100)
2. Click "Open Bag" → should open from Batch A (oldest expiration, FIFO)
3. After: Batch A = 2 bags, 50 loose items. Batch B = unchanged
4. Repeat 3 more times → Batch A: 0 bags, 50 loose, status changes to `open`
5. Open one more → now pulls from Batch B (Batch A has no more bags)

**Edge case**: What if all batches are `depleted`? → "Open Bag" button should be disabled with tooltip "No sealed bags available"

### T1.4 Consume Items
1. Item has 1 batch: 0 bags, 47 loose items, status=open
2. Click "Consume Items" → enter 10 → loose becomes 37
3. Consume 37 more → loose becomes 0, status auto-changes to `depleted`
4. Verify `inventory_logs` entry with action `consume_items`, quantity 37

**Edge case**: Try to consume more than available → prompt should cap at max available

### T1.5 Empty item (zero batches)
1. Create item with no batches → card shows "0 bags, 0 units"
2. "Open Bag" and "Consume" buttons should be disabled
3. Edit item → add a batch → save → buttons become active

### T1.6 Batch status transitions
| From | Action | To |
|------|--------|----|
| sealed | Open Bag (first) | sealed (if bags > 0 remain) |
| sealed | Open last bag | open |
| open | Consume items | open (if loose > 0) |
| open | Consume last items | depleted |
| sealed/open | Past expiration date | expired (computed on read) |
| any | Admin marks quarantined | quarantined |

### T1.7 Stress test: 50 batches on one item
1. Create item with 50 batches (script or CSV import)
2. Verify card performance — no lag when expanding/collapsing
3. Verify scrolling in batch list (max-height with overflow-y-auto)
4. Verify total computation accuracy across all 50

### T1.8 Stress test: Rapid Open Bag clicks
1. Item has 20 bags in oldest batch
2. Click "Open Bag" 10 times rapidly (debounce test)
3. Verify exactly 10 bags consumed, not more (optimistic UI should queue)
4. Verify Firestore writes are consistent (no negative bag counts)

---

## T2. Add/Edit Item Modal

### T2.1 Statpack Quick Add is GONE
1. Open "Add Item" modal
2. **Verify**: No "Statpack Quick Add" section exists
3. **Verify**: No "Statpack ID" input field
4. **Verify**: No "Add Selected from Statpack" button in footer

**📸 Screenshot check**: Modal should have clean sections: Basic Info → Location → Batches → Notes

### T2.2 Asset fields are GONE
1. Open "Add Item" modal
2. **Verify**: No "Asset" toggle/switch
3. **Verify**: No "Asset Value (USD)" input
4. **Verify**: No "Asset Category" dropdown
5. **Verify**: No "AED Units" section
6. **Verify**: No "Asset Serial #" input
7. If editing an existing asset item, modal shows info banner: "This item is an Asset. Edit it from the Assets page."

### T2.3 Variant fields are GONE
1. Open "Add Item" modal
2. **Verify**: No "Variants" toggle
3. **Verify**: No drag-and-drop variant reordering
4. **Verify**: No "+ Add Variant" button

### T2.4 Storage-linked location picker
1. Open "Add Item" → Location section
2. Zone dropdown: should list all zones from `storage_zones` collection (e.g., "HQ / Back", "CPR Closet")
3. Select "HQ / Back" → Shelf dropdown auto-filters to shelves in that zone
4. Select "Shelf A" → Level dropdown shows 1..N based on `shelf.numberOfLevels`
5. Container dropdown (optional) filters to containers on that shelf
6. Save → Firestore doc has `storageLocation: { zoneId, zoneName, shelfId, shelfName, level, containerId, containerName }`

**Edge case**: No zones in system → show "No storage zones configured. Go to Storage Management to add zones."

**📸 Screenshot check**: All dropdowns use HeroUI `Select`/`SelectItem`. No raw `<select>` elements.

### T2.5 Batch section
1. Click "Add Batch" → new batch card appears with: Lot#, Expiration, Bags, Items/Bag, Loose, Status, Received, Notes
2. Fill in batch → verify calculated total updates live
3. Add second batch → total updates to sum of both
4. Remove a batch → total decreases
5. Save → all batch data persisted correctly

### T2.6 Edit existing item
1. Open edit modal for item with 3 batches
2. All batch data pre-populated correctly (lot, exp, bags, items/bag, status)
3. Modify one batch → save → verify Firestore update
4. Location picker pre-selects the item's current storage location

### T2.7 Duplicate detection still works
1. Start typing an existing item name → "Similar items found" banner appears
2. Click "Prefill" → fields populate from existing item
3. Verify it doesn't interfere with batch editing

---

## T3. Inventory Page Cards

### T3.1 Card layout verification
For each item type, verify the card renders correctly:

| Item type | Expected display |
|---|---|
| Normal disposable with batches | Bag count + loose + total, batch expansion |
| Oxygen tank | PSI gauge + pressure bar |
| No batches (empty item) | "0 bags, 0 units" in muted text |
| Expired batch(es) | Red "Expired" chip on card |
| Low stock | Orange "Low Stock" chip |
| Item with storage location | Location displayed as "Zone / Shelf, Level N" |
| Legacy item (no storageLocation) | Falls back to `location / room / shelf` display |

**📸 Screenshot check**: Every card uses `Card`/`CardBody`, `Chip` for status, `Progress` for stock bars, `Button` for actions. No raw HTML.

### T3.2 Debug panel removed
1. Navigate to `/inventory`
2. **Verify**: No green/red "batch mismatches" debug panel at top
3. **Verify**: No "Sync totals" button

### T3.3 Search and filter
1. Search "gauze" → only gauze items shown
2. Filter by category "Trauma" → correct filter
3. Filter by location → uses storage zones, not hardcoded locations
4. Clear filters → all items shown

### T3.4 CSV export includes batch data
1. Export CSV
2. Verify columns include: `itemId, itemName, batchId, lotNumber, expirationDate, bagCount, itemsPerBag, looseItems, batchStatus`
3. Multiple rows per item (one per batch)

---

## T4. Supply Ledger Removal

### T4.1 Navbar verification
1. Login as admin → check desktop navbar
2. **Verify**: No "Supply Ledger" tab/link
3. Check mobile hamburger menu
4. **Verify**: No "Supply Ledger" menu item

### T4.2 Direct URL still works
1. Navigate directly to `/audit/events`
2. Page should still load (not removed, just de-linked from nav)

---

## T5. Storage-Based Location System

### T5.1 Hook functionality
1. `useStorageLocations()` returns zones, shelves, containers with real-time updates
2. Add a new zone in `/storage` → it appears in the inventory modal zone picker immediately (no refresh)
3. Delete a shelf → it disappears from the inventory modal shelf picker

### T5.2 Cascading selects
1. Select zone "HQ / Back" → shelf dropdown shows only shelves in that zone
2. Select shelf "Shelf A" → level dropdown shows 1..4 (if shelf has 4 levels)
3. Change zone → shelf/level/container reset to unselected

### T5.3 Edge: Deleted zone/shelf on existing item
1. Item references a zone that was deleted
2. Card should show fallback text: "Unknown zone" or the denormalized zone name
3. Edit modal should indicate the zone no longer exists (warning text)

---

## T6. Statpack vs Asset Page Distinction

### T6.1 Statpack page
1. Navigate to `/statpacks`
2. **Verify present**: Pack cards, bag visualizer, content editor, checkout/checkin, log history, QR, barcode scan
3. **Verify**: Warnings about expiring items inside packs appear on pack cards
4. **Verify absent**: No direct inventory stock editing (no ± buttons for inventory counts)

### T6.2 Asset page
1. Navigate to `/assets`
2. **Verify present**: Asset table, maintenance logs, barcode assignment, condition monitoring, status updates
3. **Verify absent**: No statpack content editor (no drag-and-drop compartment items)
4. **Verify tabs**: Equipment / Statpacks (as containers) / Maintenance

**📸 Screenshot check**: Both pages use distinct HeroUI layouts. Asset page is table-focused, statpack page is card-focused.

---

## T7. HeroUI Component & Icon Verification

### T7.1 Global component audit
For every page modified, verify:

| Check | Pass criteria |
|---|---|
| No raw `<button>` | All buttons are `<Button>` from `@heroui/react` |
| No raw `<input>` | All inputs are `<Input>` from `@heroui/react` |
| No raw `<select>` | All dropdowns are `<Select>` + `<SelectItem>` |
| No raw `<table>` | All tables use `<Table>` + related components |
| No emojis for icons | All icons are from `lucide-react` or `@heroicons/react` |
| Dark mode works | Toggle theme → all components render correctly |
| Mobile responsive | Resize to 375px width → no horizontal overflow |

### T7.2 Icon inventory
Every icon used should come from lucide-react:

| Icon | Usage |
|---|---|
| `Box` / `Boxes` | Batch/bag indicators |
| `Package` / `PackageOpen` | Open bag, consume |
| `MapPin` | Location display |
| `ClipboardCheck` | Audit button |
| `Plus` / `Minus` | Add/remove actions |
| `Search` | Search input |
| `Filter` | Filter toggle |
| `Edit2` | Edit button |
| `Trash2` | Delete button |
| `ChevronDown` | Expand/collapse |
| `AlertTriangle` | Warnings |
| `Calendar` / `CalendarClock` | Expiration dates |
| `Store` | Storage locations |
| `Wind` | Oxygen items |

**📸 Screenshot**: Capture the inventory page, add modal, and batch expansion to verify no emojis and consistent icon usage.

---

## T8. Prospective Workflow (End-to-End)

### T8.1 Initial inventory scenario
*Simulates: Admin opens the back room, wants to catalog everything on the shelves.*

1. Go to `/storage` → create zones: "HQ / Back Room", "CPR Closet"
2. Create shelves: "Shelf A" (4 levels), "Shelf B" (3 levels) in zone "HQ / Back Room"
3. Go to `/inventory` → Add Item: "4×4 Gauze Pads", Category: Trauma
4. Location: HQ / Back Room → Shelf A → Level 2
5. Add Batch: No lot# yet, Exp=`2026-08`, Bags=12, Items/Bag=100, Status=Sealed
6. Save → card appears with correct location and batch info

### T8.2 Receiving new shipment
1. Edit "4×4 Gauze Pads"
2. Add new Batch: Lot#=`SHIP-2025-02`, Exp=`2027-01`, Bags=20, Items/Bag=**50** (new supplier, different pack size), Status=Sealed
3. Save → card now shows 32 bags, 2200 total units (12×100 + 20×50)

### T8.3 Re-bagging / subdivision
1. Admin wants to re-bag: takes 5 bags of 100 and splits into 10 bags of 50
2. Edit batch 1: change Bags from 12→7, keep items/bag=100 (removed 5 bags)
3. Add new Batch: Bags=10, Items/Bag=50, Status=Sealed (the re-bagged units)
4. Total should remain the same: (7×100) + (20×50) + (10×50) = 700 + 1000 + 500 = 2200

### T8.4 Daily consumption
1. "Open Bag" on gauze → oldest batch (batch 1, exp 2026-08) opens
2. Batch 1: 6 bags, 100 loose items
3. "Consume Items" → consume 30 → batch 1: 6 bags, 70 loose
4. Next day: "Consume Items" → consume 70 → batch 1: 6 bags, 0 loose
5. Status should change based on remaining bags + loose count

### T8.5 Audit verification
1. Click "Supply Audit" on inventory page
2. Audit page loads with all items and their batch data
3. Count matches physical inventory → mark as verified
4. Mismatch found → record discrepancy in audit notes

---

## T9. Stress Tests

### T9.1 Large inventory (200+ items)
1. Import CSV with 200 items, each having 3-5 batches
2. Page load time < 3 seconds
3. Search/filter response < 500ms
4. No console errors or React rendering warnings

### T9.2 Rapid batch operations
1. Open 20 bags in sequence (click Open Bag 20 times with ~500ms between clicks)
2. All 20 operations succeed
3. Final bag count is exactly original - 20
4. No duplicate `inventory_logs` entries

### T9.3 Concurrent edits
1. Open same item in two browser tabs
2. Tab 1: Open Bag → Tab 2: also Open Bag
3. Both should succeed; final bag count = original - 2
4. Real-time listener in both tabs updates after each operation

### T9.4 Empty/null field handling
1. Create item with all optional fields empty (no lot#, no exp, no notes)
2. Save successfully → no Firestore errors
3. Edit → all fields show as empty (not "null" or "undefined" strings)
4. Add a batch with only bag count, nothing else → saves correctly

---

## T10. Migration Compatibility

### T10.1 Legacy items without batches
1. Existing item has `unopenedBoxes: 5`, `itemsPerBox: 100`, no `batches[]`
2. Inventory page synthesizes a virtual batch: bagCount=5, itemsPerBag=100, status=sealed
3. Card displays correctly: 5 bags, 500 total units
4. "Open Bag" works on the synthesized batch and persists real batch data

### T10.2 Legacy items with old batches (no bagCount)
1. Existing item has `batches[{stock: 50, lotNumber: 'A'}]`
2. System reads `stock` as `bagCount` with `itemsPerBag: 1`
3. Card shows: 50 bags, 50 total units
4. Edit → shows batch with bagCount=50, items/bag=1

### T10.3 Legacy location fields
1. Item has `location: 'HQ'`, `room: 'Back Room'`, `shelf: 'Top Shelf'`, no `storageLocation`
2. Card shows: "HQ / Back Room - Top Shelf" (legacy fallback)
3. Edit → location picker shows no zone selected (or attempts to match)
4. Save with storage picker → writes `storageLocation`, keeps legacy fields for backwards compat

---

## Quick Smoke Test Checklist

- [ ] Add item modal: no statpack quick-add section visible
- [ ] Add item modal: no asset toggle/fields visible
- [ ] Add item modal: storage location picker works (zone → shelf → level)
- [ ] Add item modal: batch section with bags/items-per-bag/status works
- [ ] Inventory card: shows bag count + total units computed from batches
- [ ] Inventory card: "Open Bag" decrements oldest batch bag count
- [ ] Inventory card: "Consume Items" decrements loose items
- [ ] Inventory card: storage location displayed correctly
- [ ] Inventory card: expired batch shows red chip
- [ ] Navbar: no "Supply Ledger" link
- [ ] Asset page: no statpack content editor
- [ ] Statpack page: shows warnings for expiring inventory items
- [ ] All pages: no emojis, only lucide-react icons
- [ ] All pages: HeroUI components only (no raw HTML form elements)
- [ ] Dark mode: all modified pages render correctly
- [ ] Mobile: no horizontal overflow on 375px width
- [ ] Build: `npx next build` compiles without new errors
- [ ] Lint: `npx eslint app/` introduces zero new errors
