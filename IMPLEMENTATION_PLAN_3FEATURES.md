# Implementation & Testing Plan: 3 Features

## Feature 1: Fix Statpack Configuration Modal Pocket Bugs

### Problem
- The pocket dropdown on each item in the editor defaults to showing "Main" regardless of actual pocket value.
- The top-level pocket filter (`selectedPocketView`) filters the view, but when adding a new item via "Add Item", the new item always gets `pocket: 'main'` hardcoded — it ignores the `attachPocket` dropdown AND the `selectedPocketView`.
- The `attachPocket` dropdown near "Add Item" exists but is **not wired** into `addNewContentItem()` — that function hardcodes `pocket: 'main'`.
- When attaching an asset, `attachPocket` is used, but only as a `string` cast — works but isn't connected to `selectedPocketView`.

### Root Causes
1. `addNewContentItem()` hardcodes `pocket: 'main'` instead of using `attachPocket` or `selectedPocketView`.
2. The pocket-selector dropdown next to "Contents" label (`attachPocket`) and the visual bag-pocket-selector (`selectedPocketView`) are independent — changing one doesn't sync the other.
3. No visual feedback about which pocket a newly added item belongs to.

### Fix Plan
- **Wire `addNewContentItem` to use `selectedPocketView`** (when not 'all') or fall back to `attachPocket`.
- **Sync the two pocket selectors**: when `selectedPocketView` changes via bag visualizer click, update `attachPocket` to match (and vice versa).
- **Remove the separate `attachPocket` dropdown** and unify to a single pocket selector (the visual bag + a dropdown that stays synced).
- **When the view is filtered to a pocket, new items auto-get that pocket**.

### Edge Cases to Stress-Test
- Adding item when view = 'all' → should use dropdown pocket
- Adding item when view = 'side_left' → new item should be 'side_left'
- Changing pocket via item-level dropdown → item should move out of filtered view
- Drag reorder within a filtered pocket → should not corrupt items in other pockets
- Switching pocket filter after adding items → items should appear in correct pocket
- Adding asset attachment when pocket filter is active → asset gets correct pocket

### Testing
- Manual: Toggle through pocket views, add items, verify pocket assignment
- Manual: Reorder items within filtered pocket, switch to 'all', verify order preserved
- Manual: Change item pocket via dropdown while in filtered view, verify it disappears from view

---

## Feature 2: Admin Warnings/Popups for Statpack Items

### Problem
Admins need to attach custom warnings to specific items in a statpack that appear during checkout verification. Example: "Verify glucose strips and glucometer are same brand."

### Design
- Add `customWarnings` field to `StatpackItem` in types.ts
- In the statpack editor (sortable-statpack-list), add UI for admins to add/edit/remove warnings per item
- During checkout (statpack-checkoff-modal), display these warnings prominently and require acknowledgment
- Warnings have: `message` (string), `severity` ('info' | 'warning' | 'critical'), `requiresAcknowledgment` (boolean)

### Implementation
1. **Types**: Add `customWarnings?: StatpackWarning[]` to `StatpackItem`
2. **Editor UI**: Add warning editor in the Accordion section of each sortable item
3. **Checkout UI**: Show warnings prominently per item, require checkbox acknowledgment for critical ones
4. **Firestore save**: Include `customWarnings` in `buildStatpackUpdate` whitelist

### Testing
- Add a warning to an item → save → reload → verify warning persists
- Checkout with warning → verify popup/banner appears
- Critical warning → must be acknowledged before submission
- Multiple warnings on same item → all displayed
- Warning on item in specific pocket → only shows when verifying that pocket

---

## Feature 3: Admin Buy List

### Problem
Admins need a quick way to add items to a "shopping list" as they walk through storage and notice things that need purchasing.

### Design
- New Firestore collection: `buyList`
- Each doc: `{ id, itemName, quantity?, notes?, category?, priority, addedBy, addedByName, addedAt, status: 'pending' | 'ordered' | 'received', completedAt? }`
- New page: `/app/buy-list/page.tsx` with full CRUD
- Quick-add button accessible from inventory pages and navbar
- Admin-only feature

### Implementation
1. **Types**: Add `BuyListItem` interface
2. **Page**: Full buy list management page with add/edit/delete/status
3. **Navbar link**: Add "Buy List" to admin nav items
4. **Quick-add modal**: Reusable modal for fast item entry
5. **Firestore**: Real-time listener on `buyList` collection

### Testing
- Add item → verify in list
- Mark as ordered → verify status change
- Mark as received → verify completed
- Delete item → verify removal
- Sort by priority → verify ordering
- Quick-add from different pages → verify works
