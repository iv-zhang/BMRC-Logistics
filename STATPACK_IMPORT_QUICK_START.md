# Statpack Import: Quick Reference

## 🚀 How to Use

### Step 1: Prepare Your Data
Copy data from Google Sheets in this format:
```
Item Name          Quantity    Pocket
Gauze 4x4          10          main
Tourniquets        2           front
Glucose Strips     1           left
```

### Step 2: Import
1. Open **Statpack Editor** → Select a statpack
2. Click **📄 Import from Sheets** button
3. Paste your data
4. Follow the 4-step workflow

### Step 3: Review & Confirm
- Check parsed items and matches
- Verify batch assignments
- Confirm expiration dates
- Click **Import Items**

## 📁 Files Overview

| File | Purpose | Size |
|------|---------|------|
| [app/lib/statpack-import.ts](app/lib/statpack-import.ts) | Core parsing + matching logic | 200 LOC |
| [app/components/statpack-import-modal.tsx](app/components/statpack-import-modal.tsx) | HeroUI modal UI + workflow | 480 LOC |
| [app/statpacks/page.tsx](app/statpacks/page.tsx) | Integration point (modified) | +25 LOC |

## 🎯 Key Functions

**[app/lib/statpack-import.ts](app/lib/statpack-import.ts):**
- `parseSheetPaste(text)` → `ParsedSheetRow[]`
- `normalizePocket(raw)` → `StatpackPocket`
- `itemNameSimilarity(query, item)` → 0-1 score
- `convertToStatpackItems(rows)` → `StatpackItem[]`

**[app/components/statpack-import-modal.tsx](app/components/statpack-import-modal.tsx):**
- 4-step modal component
- Auto-inventory loading
- Fuzzy matching display
- Batch assignment

## ✨ Features

✅ **Fuzzy Name Matching** — Partial/misspelled names found  
✅ **Auto Batch Assignment** — Smart batch selection by status & expiration  
✅ **Multi-Step UX** — Parse → Preview → Confirm → Import  
✅ **Error Handling** — Line-specific validation  
✅ **HeroUI Consistency** — Matches existing design  
✅ **Type Safe** — Full TypeScript  

## 📊 What Gets Imported

For each row in your sheet:
- **itemId** — matched from inventory
- **requiredQuantity** — from column 2
- **pocket** — normalized from last column
- **batchId** — auto-assigned
- **expirationDate** — from batch

## 🔍 Matching Algorithm

**Pocket Mapping:**
- "front" / "Front" → `front_aux`
- "left" / "Left" → `side_left`
- "right" / "Right" → `side_right`
- "main" or default → `main`

**Item Matching:**
- Exact match: 1.0 confidence → **High**
- Substring match: 0.85 confidence → **Medium**
- Partial overlap: >0 confidence → **Low**
- No match: → **None** (user must select)

**Batch Selection:**
1. Prefer `sealed` over `open` batches
2. Filter out `depleted`, `expired`
3. Sort by expiration date (earliest first)
4. Use first available batch

## ⚠️ Common Issues

| Issue | Solution |
|-------|----------|
| "No valid rows found" | Check copy format is tab/comma-separated |
| Item not matched | Add to inventory first, or check spelling |
| No batch available | Add batches to inventory item |
| Import fails validation | Resolve all rows before confirming |

## 🏗️ Architecture

```
User copies Google Sheet data
         ↓
[Statpack Import Modal]
  ↓         ↓        ↓
Parse    Preview  Confirm
  ↓
[statpack-import.ts] - Core logic
  ├─ parseSheetPaste() - TSV/CSV parsing
  ├─ normalizePocket() - Enum mapping
  ├─ itemNameSimilarity() - Fuzzy match
  └─ convertToStatpackItems() - Final conversion
  ↓
Append to statpack.contents
  ↓
Save to Firestore
```

## 📝 Data Format

**TSV (Tab-Separated):**
```
Item Name[TAB]Quantity[TAB]Pocket
```

**CSV (Comma-Separated):**
```
Item Name,Quantity,Pocket
```

**Auto-Detection:** Component tries tab first, then comma.

## 🔗 Related Files

- [Statpack Types](app/types.ts) — `StatpackItem`, `StatpackPocket`
- [Inventory Types](app/types.ts) — `InventoryItem`, `InventoryBatch`
- [Statpack Editor](app/statpacks/page.tsx) — Integration point
- [HeroUI Docs](https://heroui.com) — Component reference

## 🧪 Testing

**Happy Path:**
```
1. Copy valid data from sheet
2. Paste into modal
3. All rows parse correctly
4. Batches auto-assign
5. Confirm and import ✓
```

**Edge Cases:**
- Empty paste
- Wrong delimiters
- Unmatched items
- Missing batches
- Expired batches

## 📦 Deployment

**Status:** ✅ Ready  
**Breaking Changes:** None  
**New Dependencies:** None  
**Configuration:** None required  

Just deploy the three files and the feature is live.

## 🚀 Future Ideas

- Manual batch selection UI
- Duplicate detection
- Bulk statpack import
- Item creation from paste
- Undo/rollback items

---

**Need help?** See [STATPACK_IMPORT_FEATURE.md](STATPACK_IMPORT_FEATURE.md) for detailed docs.
