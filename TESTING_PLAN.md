# Testing Plan — Phase 2 Enhancements

> Covers: unit counting, itemsPerBox editing, subdivision, shelf locations, restock bins, emoji→icon, audit button placement, roster permissions.

---

## 1. Emoji → Icon Replacement

### Manual Verification
| Page | What to check | Expected |
|------|--------------|----------|
| `/audit` | Zone labels, audit mode header, restock chips, alerts | No emojis. Uses `ClipboardCheck`, `Box`, `Store`, `AlertTriangle`, `AlertOctagon`, `MapPin` icons from lucide-react |
| `/audit` (stack-audit) | System record and review summary | `Box` icon, no 📦 |
| `/inventory` | Status dots on cards, low stock alert | Colored dots (`bg-danger`/`bg-warning`/`bg-success`), no 🔴🟡🟢 emojis |
| Navbar | Desktop dropdown → Supply Audit, mobile menu | No 📋 prefix |
| `/dashboard` (admin) | Quick actions area | No "📋 Supply Audit" or "📦 Restock" buttons (removed to inventory page) |
| `audit-item-card` components | Batch info, location chips, expiry text | `Store`, `MapPin`, `Box` icons instead of 📦🏪📍 |
| `audit-helpers.ts` | Recommendation strings, console warnings | No ⚠️ in text |

### Remaining emoji (known, in secondary pages)
- Statpack checkout/checkin flows still contain ⚡✓✗ emojis — low priority, these are acceptable in interactive modal text.

---

## 2. Audit Button Placement

### Test: Admin view
1. Login as admin
2. Navigate to `/dashboard` → **Should NOT have** "Supply Audit" or "Restock" quick-action buttons
3. Navigate to `/inventory` → **Should see** a purple "Supply Audit" button with `ClipboardCheck` icon next to "Add Item"
4. Click "Supply Audit" → redirects to `/audit`

### Test: Member with canAudit=true
1. Login as a member who has `canAudit: true` in Firestore
2. Navigate to `/inventory` → **Should see** the "Supply Audit" button
3. Their member dashboard should still show the audit card (existing behavior from Phase 1)

### Test: Regular member (canAudit=false)
1. Login as regular member
2. Navigate to `/inventory` → **Should NOT see** the "Supply Audit" button

---

## 3. canAudit Toggle in Roster

### Test: Toggle audit access
1. Login as admin → `/roster`
2. Table should have 4 columns: MEMBER, CURRENT ROLE, AUDIT ACCESS, DELEGATE ROLE
3. For a regular member: AUDIT ACCESS switch should be off and toggleable
4. Toggle it on → Firestore `users/{uid}` should update with `canAudit: true`
5. Toggle it off → `canAudit: false`
6. Refresh page → state persists

### Test: Inherited access
1. For an admin user row: switch should be on and **disabled** (tooltip: "admin role always has audit access")
2. For a quartermaster row: switch should be on and **disabled**
3. For FTO / inventory_helper / member: switch should be toggleable

---

## 4. Unit Counting & itemsPerBox Editing

### Test: Add item with box tracking
1. Open inventory modal → Add Item
2. Set "Unopened Boxes" = 5, "Items Per Box" = 100, "Loose Units" = 25
3. Preview should show: **Total units: 525** (5 × 100 + 25)
4. Save item
5. Inventory card should show: **5** (large number), "Boxes" label, "100 items/box", "525 total units" (indigo text)

### Test: Edit itemsPerBox
1. Edit an existing item → change "Items Per Box" from 100 to 50
2. Save → card should update: total now = 5 × 50 + 25 = 275 total units
3. Verify the `itemsPerBox` field updated in Firestore

### Test: Loose units without itemsPerBox
1. Create item with "Unopened Boxes" = 10, no "Items Per Box", "Loose Units" = 3
2. Card should show: **10** (large), "Total Units" label, "+ 3 loose" small text

### Test: Collapsed vs expanded card view
1. Both collapsed and expanded views should show total unit count consistently

---

## 5. Back-Room Shelf/Level System

### Test: Type additions
- `InventoryItem.backShelf` (string) and `InventoryItem.backLevel` (number) exist in types.ts
- `Shelf.numberOfLevels` (number) exists in types.ts

### Test: Shelf editor (storage page)
1. Navigate to `/storage` → Shelves tab
2. Click "Add Shelf" → should see "Number of Levels" input field
3. Create shelf with name="Shelf A", levels=4 → saves to Firestore
4. Shelves table should show "Levels" column with "4"

### Test: Inventory modal back-shelf fields
1. Add/edit item → set Location=HQ, Room="Back Room"
2. **Amber box should appear** with "Back Shelf Name" and "Shelf Level" inputs
3. Set shelf="Shelf A", level=2 → save
4. Change room to "Front" → amber box should **disappear** (conditional render)

### Test: Inventory card location display
1. Item with `backShelf="Shelf A"` and `backLevel=2` should show:
   `HQ / Back Room - Top Shelf [Shelf A, Level 2]` (indigo bracket text)
2. Item without backShelf should show normal location only

---

## 6. Front Restock Bin Locations

### Test: Create restock shelf with location
1. Navigate to `/restock`
2. Create shelf form → fill name, item, location
3. Amber box should appear with "Front Room", "Front Shelf", "Level" fields
4. Fill: Room="Reception", Shelf="Wall Rack B", Level=3
5. Create → shelf card should show: `HQ — Receiving [Reception, Wall Rack B, Level 3]` (indigo text)

### Test: Edit restock shelf
1. Click edit on existing shelf → edit modal should show the 3 front location fields
2. Update frontRoom from "Reception" to "Main Hall"
3. Save → verify card updates

### Test: Member report with front location
1. Login as member → go to `/member/report`
2. Select report type "Low Stock", pick item, location="HQ/Storage"
3. Amber box should appear with Room/Shelf/Level inputs
4. Fill Room="Reception", Shelf="Wall Shelf A", Level=1
5. Submit → verify `restock_reports` document includes `frontRoom`, `frontShelf`, `frontLevel`

### Test: Issue reports display
1. Login as admin → `/issue-reports`
2. Find a restock report that has front location data
3. Location chip should show: `HQ/Storage • Receiving [Reception, Wall Shelf A, Level 1]`

---

## 7. Integration Tests

### End-to-end: Audit workflow with new fields
1. Admin sets canAudit=true for member M via roster
2. Member M logs in → sees audit card on member dashboard
3. Member M navigates to `/inventory` → sees "Supply Audit" button
4. Click → reaches `/audit` page → performs audit
5. Verify audit event stored correctly

### End-to-end: Restock with precise locations
1. Admin creates restock shelf with front location (Room="Main Hall", Shelf="Rack C", Level=2)
2. Member reports low stock for that area with matching front location
3. Admin sees report in issue-reports with location displayed
4. Admin restocks from `/restock` page → shelf updated

### Data integrity
1. After all changes, verify no Firestore schema breaks:
   - `users` docs have optional `canAudit` boolean
   - `inventory` docs have optional `looseUnits`, `backShelf`, `backLevel`
   - `shelves` docs have optional `numberOfLevels`
   - `restock_shelves` docs have optional `frontRoom`, `frontShelf`, `frontLevel`
   - `restock_reports` docs have optional `frontRoom`, `frontShelf`, `frontLevel`

---

## 8. Build Verification

| Check | Status | Notes |
|-------|--------|-------|
| TypeScript compilation | ✅ Pass | `Compiled successfully in 9.3s` |
| ESLint | ✅ No new errors | All 527 errors are pre-existing `no-explicit-any` |
| Static export | ⚠️ Pre-existing | `statpacks/checkout/[id]` missing `generateStaticParams()` — not related to these changes |

---

## 9. Automated Test Scenarios (for `scripts/test-audit-restock.cjs` extension)

```javascript
// New test cases to add to the existing 69 tests:

// T70: looseUnits defaults to 0
assert((item.looseUnits ?? 0) === 0, 'looseUnits defaults to 0');

// T71: total units calculation
const totalUnits = (item.unopenedBoxes * (item.itemsPerBox || 1)) + (item.looseUnits || 0);
assert(totalUnits === 525, 'Total units = boxes × itemsPerBox + looseUnits');

// T72: canAudit toggle
const user = { role: 'member', canAudit: true };
assert(user.canAudit === true, 'canAudit can be set on member');

// T73: admin inherits audit
const admin = { role: 'admin' };
assert(admin.role === 'admin', 'Admin always has audit access regardless of canAudit');

// T74: backShelf/backLevel optional
const itemWithBack = { backShelf: 'Shelf A', backLevel: 2 };
assert(itemWithBack.backShelf === 'Shelf A');
assert(itemWithBack.backLevel === 2);

// T75: shelf numberOfLevels
const shelf = { name: 'Shelf A', numberOfLevels: 4 };
assert(shelf.numberOfLevels === 4);

// T76: front location fields optional on restock shelf
const restockShelf = { name: 'Test', frontRoom: 'Reception', frontShelf: 'Rack A', frontLevel: 2 };
assert(restockShelf.frontRoom === 'Reception');
```

---

## Quick Smoke Test Checklist

- [ ] Login as admin → roster shows AUDIT ACCESS column
- [ ] Toggle canAudit for a member
- [ ] Admin inventory page shows "Supply Audit" button
- [ ] Admin dashboard does NOT show audit/restock buttons
- [ ] Add item with looseUnits → total units displayed correctly
- [ ] Edit item → change itemsPerBox → total updates
- [ ] Set back shelf/level on Back Room item → displays in card
- [ ] Create restock shelf with front location → displays in card
- [ ] Member reports low stock with front location → shows in issue-reports
- [ ] No emojis visible on audit page, inventory page, navbar

---

# Phase 3 — UI Overhaul, Barcode Fix, Tasks Page, Mobile

> Covers: navbar mobile menu, barcode scanner fix, tasks/buy-list page, asset/statpack admin overhaul, mobile responsiveness.

---

## 8. Mobile Navbar (`app/components/appnavbar.tsx`)

### What changed
- Added `NavbarMenuToggle` (hamburger) for mobile
- Lucide-react icons replace all @heroicons + emojis
- Mobile menu with sectioned layout (Assets, Inventory, Admin)
- "Buy List" → "Tasks & Buy List" routing to `/tasks`

### Tests
| # | Scenario | Expected |
|---|----------|----------|
| 1 | Hamburger visible <640px | ☰ icon top-left |
| 2 | Menu opens/closes on tap | Smooth slide |
| 3 | Links navigate + close menu | Correct route, menu auto-closes |
| 4 | Active link highlighted | Primary color on current route |
| 5 | Desktop layout unchanged | No hamburger >640px |
| 6 | Sign out from mobile menu | Signs out + redirects |

---

## 9. Barcode Scanner (`app/components/barcode-scanner.tsx`)

### What changed
- Camera / Manual mode toggle
- 2 consecutive identical reads required (CONFIRM_READS=2)
- `minLength` prop (default 3) rejects short garbage reads
- Visual scanning indicator (green pulse, targeting box)

### Tests
| # | Scenario | Expected |
|---|----------|----------|
| 1 | Short barcode "01" rejected | "Too short" message |
| 2 | Consecutive read required | Must read same value 2× before accepting |
| 3 | Manual entry with Enter key | Barcode assigned |
| 4 | Manual minLength check | "AB" rejected, "ABC" accepted |
| 5 | Camera fallback to manual | If no camera, auto-switches with message |
| 6 | Image upload | Photo decoded and returned |
| 7 | Modal state reset on reopen | Camera mode, no residual values |
| 8 | USB barcode scanner | Focus input, scan → value fills, Enter to confirm |

---

## 10. Tasks Page (`app/tasks/page.tsx`)

### What changed
- New `/tasks` combining buy list + todo/fix list
- Categories: Buy, Fix, Restock, Admin, Other
- Status workflow: todo → in_progress → done
- Buy list items appear automatically in "Buy List" tab
- Firestore `tasks` collection

### Tests
| # | Scenario | Expected |
|---|----------|----------|
| 1 | Page loads for admin | Stats cards + items |
| 2 | Access denied for member | "Access Denied" message |
| 3 | Add Buy task | Category="buy", quantity/unit fields visible |
| 4 | Status toggle cycle | Circle click: todo→in_progress→done→todo |
| 5 | Edit via dropdown | Modal pre-filled |
| 6 | Delete with confirmation | Firestore doc removed |
| 7 | Buy list integration | Buy list items show under "Buy List" tab |
| 8 | Buy list status sync | Marking done updates buyList collection |
| 9 | Filter + search + sort | All work correctly |

---

## 11. Asset Management Overhaul (`app/assets/page.tsx`)

### What changed
- Actions: Eye button + ⋮ dropdown (was 6-7 individual buttons)
- 🔒/🔓 → Lock/Unlock icons; ⚠️ → AlertTriangle
- Raw checkbox → HeroUI `<Checkbox>`
- Tooltips on icon buttons
- Responsive: columns hidden on mobile, overflow-x-auto

### Tests
| # | Scenario | Expected |
|---|----------|----------|
| 1 | Dropdown actions all work | Each action opens correct modal |
| 2 | Sealed/Open uses Lock icon | No emoji in statpack editor |
| 3 | Print checkbox works | HeroUI-styled, count badge updates |
| 4 | Mobile table scrolls | Horizontal scroll, hidden columns |

---

## 12. Mobile Responsiveness (All Pages)

### Tests
| # | Page | 375px width check |
|---|------|-------------------|
| 1 | Dashboard | No overflow; heading readable; logo hidden |
| 2 | Inventory | Header wraps vertically |
| 3 | Buy List | Stats cards fit; reduced padding |
| 4 | Assets | Table scrolls; fewer columns |
| 5 | Statpacks | Cards stack vertically |
| 6 | Tasks | Full functionality on mobile |

---

## 13. Cross-Cutting

- [ ] `npm run build` succeeds without errors
- [ ] No remaining emojis in modified files
- [ ] Dark mode renders correctly on all pages
- [ ] No console errors in browser dev tools
- [ ] Firestore security rules updated for `tasks` collection
