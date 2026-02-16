# Implementation Plan — Inventory Enhancements

## Overview

This plan covers the following feature requests:

1. **Individual unit counting** — Show total units (boxes × itemsPerBox), not just box count
2. **Editable `itemsPerBox`** — Allow admin to change when supplier changes package sizes
3. **Subdivision** — Break unopened boxes into smaller units for lower-volume operations
4. **Know what you have left** — Estimated remaining inventory from box counts + usage
5. **Back-room shelf/level locations** — Track which shelf and level each item is on, with CRUD
6. **Front restock bin locations** — Room, shelf, level for restock bins in the front
7. **Issue report location integration** — When members report low stock in front, include bin location
8. **Replace ALL emojis** with HeroUI / lucide-react icons across the entire site
9. **Audit button placement** — Admin: only on inventory page. Members with `canAudit`: on their dashboard
10. **Roster permissions** — Grant `canAudit` from the Roster tab (not a separate modal)

---

## 1. Replace All Emojis with Icons

**Files affected:**
- `app/components/appnavbar.tsx` — "📋 Supply Audit" in dropdown + mobile menu
- `app/audit/page.tsx` — Zone labels (📦, 🏪, ⏩, 🩺, 🏚️, 🏢), audit mode header (📋), system info (📦, 🏪), restock chips (🚨, ⚠️)
- `app/components/audit-item-card.tsx` — 📦 and 🏪 in disposable card, ⚠️ expiry, 📍 location
- `app/inventory/page.tsx` — Status emojis (🔴, 🟡, 🟢), ⚠️ alerts
- `app/audit/stack-audit-client.tsx` — 📦 system count
- `app/dashboard/page.tsx` — "📋 Supply Audit" and "📦 Restock" buttons
- `app/lib/audit-helpers.ts` — ⚠️ in recommendation strings

**Icon mapping:**
| Emoji | Replacement | Import |
|-------|------------|--------|
| 📋 | `<ClipboardCheck size={16} />` | lucide-react |
| 📦 | `<Box size={16} />` or `<Package size={16} />` | lucide-react |
| 🏪 | `<Store size={16} />` | lucide-react |
| ⏩ | `<FastForward size={16} />` | lucide-react |
| 🩺 | `<Stethoscope size={16} />` | lucide-react |
| 🏚️ | `<Warehouse size={16} />` | lucide-react |
| 🏢 | `<Building2 size={16} />` | lucide-react |
| 🔴 | Red dot `<span className="w-2 h-2 rounded-full bg-danger inline-block" />` | CSS |
| 🟡 | Yellow dot same pattern | CSS |
| 🟢 | Green dot same pattern | CSS |
| 🚨 | `<AlertOctagon size={14} />` | lucide-react |
| ⚠️ | `<AlertTriangle size={14} />` | lucide-react |
| 📍 | `<MapPin size={14} />` | lucide-react |

---

## 2. Fix Audit Button Placement

**Admin dashboard (`app/dashboard/page.tsx`):**
- REMOVE the "📋 Supply Audit" and "📦 Restock" quick-access buttons from header
- The dashboard should focus on fleet readiness and alerts (which it already does)

**Inventory page (`app/inventory/page.tsx`):**
- ADD a "Start Audit" button in the header area (next to "Add Item")
- Only visible when `isAdmin` or user `canAudit`
- Links to `/audit`

**Member dashboard (`app/dashboard/member-dashboard.tsx`):**
- KEEP the existing audit card in Quick Actions (already correctly implemented)
- Only shows for members with `canAudit` or admin/quartermaster/inventory_helper

---

## 3. Add `canAudit` Toggle to Roster Page

**Roster page (`app/roster/page.tsx`):**
- Add a 4th column: "AUDIT ACCESS" with a HeroUI `Switch` component
- When toggled, updates `canAudit` boolean on the user's Firestore document
- Visual indicator: Switch is on (green) = has audit access
- No separate modal needed — inline control in the table

**Remove standalone modal usage:**
- The `AuditPermissionModal` in `app/audit/page.tsx` can remain as a secondary admin tool
- Primary permission management moves to Roster

---

## 4. Editable `itemsPerBox`

**Type changes:** None needed — `itemsPerBox` already exists on `InventoryItem`

**Inventory add/edit modal (`app/components/additemmodal.tsx`):**
- Ensure `itemsPerBox` is an editable numeric input field
- Label: "Items per Box/Bag"
- Helper text: "How many individual units come in one sealed box/bag"

**Inventory cards (`app/inventory/page.tsx`):**
- Show calculated total: `{unopenedBoxes} boxes × {itemsPerBox} = {total} units`
- This gives the admin immediate visibility into total unit count

**Audit views:**
- Already show `itemsPerBox` info — ensure it's prominent

---

## 5. Back-Room Shelf/Level Location System

**Type additions (`app/types.ts`):**
```typescript
// Add to InventoryItem:
backShelf?: string;   // Which shelf in back room (e.g., "Shelf A")
backLevel?: number;   // Which level on that shelf (1 = bottom, 2, 3...)
```

**Existing infrastructure:** `app/storage/page.tsx` already manages zones, shelves, and containers. We extend this:

**Storage page enhancements:**
- Shelves already have `name` and `zoneId` — add `levels?: number` field to track how many levels
- When creating a shelf, allow specifying number of levels

**Inventory modal (`app/components/additemmodal.tsx`):**
- Add shelf and level pickers
- Shelf picker: dropdown populated from `shelves` collection (filtered by Back Room zone)
- Level picker: numeric (1, 2, 3...) based on selected shelf's level count

**Inventory cards:**
- Show shelf + level location: "Back Room → Shelf A, Level 2"

---

## 6. Front Restock Bin Locations

**Restock shelf enhancements (`restock_shelves` collection):**
- Add fields: `room`, `shelfName`, `level`
- Update create/edit forms to include these fields

**Restock page (`app/restock/page.tsx`):**
- Add Room, Shelf, Level inputs to the shelf creation form
- Display in shelf cards: "Front → Shelf B, Level 1"

**Issue reports integration:**
- When a member reports low stock, include the restock bin's full location
- Display in report cards: "Location: Front, Shelf B, Level 1"

---

## 7. Issue Report Location Integration

**Member report page (`app/member/report/page.tsx`):**
- When reporting low stock items, auto-populate location from the restock shelf's data
- Or allow selecting location from a dropdown of known restock bins

**Issue reports page (`app/issue-reports/page.tsx`):**
- Display location data in the report cards (already shows location for restock reports)
- Add location to the combined report view

---

## 8. Subdivision Feature (Future Enhancement)

The subdivision concept (breaking a box into smaller bags/units) maps to the existing "consume box" flow:
- `consumeBox()` already decrements `unopenedBoxes` and creates open batch units
- The open batch units represent items moved to the front

For "further dividing into smaller units," we can:
- Add a "Split Box" action that creates multiple smaller batches from one box
- Track `looseUnits` as a computed value from open batches
- Show estimated remaining: `(unopenedBoxes × itemsPerBox) + looseUnits`

This is a larger feature and can be Phase 2 after the core location and UI fixes.

---

## Execution Order

1. ✅ **Emojis → Icons** (quick, broad impact, no logic changes)
2. ✅ **Audit button placement** (small, focused change)
3. ✅ **Roster `canAudit` toggle** (small, focused change)
4. ✅ **`itemsPerBox` editing + unit count display** (type already exists)
5. ✅ **Back-room shelf/level** (type + UI additions)
6. ✅ **Front restock bin locations** (extends existing restock shelves)
7. ✅ **Issue report location integration** (display enhancement)
8. 🔄 **Build & lint verification**
9. 📝 **Testing plan**
