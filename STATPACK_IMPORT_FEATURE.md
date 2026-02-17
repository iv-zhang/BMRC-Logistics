# Google Sheets Import Feature for Statpacks

## Overview

The **Statpack Import from Google Sheets** feature allows rapid bulk configuration of statpack contents by pasting tab-separated data directly from Google Sheets. This eliminates manual entry of individual items and streamlines statpack setup.

## Quick Start

### 1. Prepare your Google Sheet

Create a spreadsheet with your statpack contents. Expected format:

| Item Name | Quantity | (optional columns) | Pocket |
|-----------|----------|-------------------|--------|
| Gauze 4x4 | 10       |                   | main   |
| Tourniquet | 2       |                   | front  |
| Glucometer | 1       |                   | left   |

**Format requirements:**
- Tab-separated or comma-separated values
- Column 1: Item name (from your inventory)
- Column 2: Quantity (numeric)
- Optional middle columns: ignored during parsing
- Last column: Pocket location (`main`, `front`, `left`, `right`)
- Pocket values are auto-normalized (e.g., "Front" → `front_aux`, "Left" → `side_left`)

### 2. Copy and paste into the import dialog

1. Open the **Statpack Editor** modal
2. Click the **📄 Import from Sheets** button
3. Paste your copied data into the text area
4. Click **Parse & Preview**

### 3. Review and confirm

- **Preview Step**: Verify parsed rows and inventory matches
  - Green checkmarks = high-confidence matches
  - Orange warnings = lower-confidence matches
  - Verify matches are correct; if not, you can manually select alternatives in the next step
  
- **Batch Assignment Step**: System automatically assigns appropriate batches
  - Sealed batches preferred over open batches
  - Non-expired batches prioritized by expiration date
  
- **Confirmation Step**: Final review with batch IDs and expiration dates visible

### 4. Import

Click **Import Items** to add all items to the statpack contents. They will be appended to existing items.

## Implementation Details

### Files Created

#### 1. [app/lib/statpack-import.ts](app/lib/statpack-import.ts)
Core parsing and enrichment logic:
- `parseSheetPaste()`: Parses TSV/CSV input into `ParsedSheetRow[]`
- `normalizePocket()`: Maps user-friendly pocket names to `StatpackPocket` enum
- `itemNameSimilarity()`: Fuzzy matching for inventory items (0–1 score)
- `confidenceFromSimilarity()`: Confidence levels for UI display
- `convertToStatpackItems()`: Final conversion to `StatpackItem[]` with validation

#### 2. [app/components/statpack-import-modal.tsx](app/components/statpack-import-modal.tsx)
HeroUI-styled modal component with multi-step workflow:
- **Step 1 (Paste)**: Text input for pasted data
- **Step 2 (Preview)**: Table showing parsed items, names, quantities, and pocket assignments
- **Step 3 (Auto-Batch)**: System assigns batches based on availability and expiration
- **Step 4 (Confirm)**: Final review before import

Features:
- Automatic inventory loading on first use
- Live parsing feedback with error handling
- Batch assignment from available sealed/open batches
- Expiration date display for final review
- Full HeroUI component consistency

### Integration

Added to [app/statpacks/page.tsx](app/statpacks/page.tsx):
- Import button in the editor modal's contents section
- `handleImportComplete()` handler appends imported items to existing contents
- Modal state managed with `useDisclosure()`

## Feature Behavior

### Parsing

1. **Delimiter detection**: Tries tab first, falls back to comma
2. **Column inference**:
   - Column 1 = item name
   - Column 2 = quantity (if numeric)
   - Last column = pocket
3. **Empty rows**: Skipped automatically
4. **Pocket normalization**:
   - "front" / "Front" / "front_aux" → `front_aux`
   - "left" / "Left" / "side_left" → `side_left`
   - "right" / "Right" / "side_right" → `side_right`
   - "main" or default → `main`

### Inventory Matching

- Fuzzy string matching using character overlap heuristic
- Confidence levels:
  - **High** (≥0.8 similarity): Exact or near-exact name match
  - **Medium** (0.6–0.8): Substring match or ~60% character overlap
  - **Low** (>0 similarity): Partial match
  - **None** (no match found): User must manually select from available inventory

### Batch Assignment

- For each matched inventory item, system searches for available batches
- **Batch eligibility**:
  - Status: `sealed` or `open` (not depleted/expired)
  - Expiration: Must be in the future
- **Preference order**:
  1. Sealed batches (preferred for fresh stock)
  2. Then by expiration date (earliest first)

### Validation

Before import, the system validates:
- All rows have matched inventory items
- All items have assigned batch IDs
- Batch IDs exist on matched items
- No missing required fields

Errors are displayed with row numbers and descriptions.

## Example Workflow

### Input Sheet
```
Gauze 4x4          10    main
Tourniquets        2     front
Glucose Strips     1     left
AED Pads           1     main
```

### Parse Output
```
Row 1: "Gauze 4x4" (qty 10, main) → Match: "4x4 Gauze" (high confidence)
Row 2: "Tourniquets" (qty 2, front_aux) → Match: "CAT Tourniquet" (medium confidence)
Row 3: "Glucose Strips" (qty 1, side_left) → Match: "Glucose Strips (50/box)" (high confidence)
Row 4: "AED Pads" (qty 1, main) → Match: "Zoll AED Pads" (high confidence)
```

### Batch Assignment
```
Row 1: batch_sealed_001 (expires 2025-12-31)
Row 2: batch_sealed_002 (expires 2025-11-15)
Row 3: batch_open_003 (expires 2025-10-30)
Row 4: batch_sealed_004 (expires 2026-03-01)
```

### Result
All 4 items imported into statpack with correct quantities, pockets, and batch references.

## Error Handling

Common errors and solutions:

| Error | Cause | Solution |
|-------|-------|----------|
| "No valid rows found" | Empty paste or wrong format | Verify data copied from Sheets, check delimiter |
| "No inventory match" | Item name not in database | Check inventory for similar names; may need manual entry first |
| "No batch assigned" | Item has no available batches | Add batches to inventory item first, or use existing batch manually |

## Type Definitions

All import types are defined in [app/lib/statpack-import.ts](app/lib/statpack-import.ts):

```typescript
interface ParsedSheetRow {
  rawName: string;
  quantity: number;
  pocket: string;
  rawPocket: string;
  lineNum: number;
}

interface EnrichedSheetRow extends ParsedSheetRow {
  matchedItemId?: string;
  matchedItemName?: string;
  matchedItemCategory?: string;
  batchId?: string;
  compartmentId?: string;
  normalizedPocket: StatpackPocket;
  confidence: 'high' | 'medium' | 'low' | 'none';
  error?: string;
}
```

## UI Components Used

- `Modal` / `ModalContent` / `ModalHeader` / `ModalBody` / `ModalFooter`: Main dialog
- `Button`: Action buttons (Parse, Assign, Import, Back, Cancel)
- `Textarea`: Paste area for sheet data
- `Table` / `TableHeader` / `TableColumn` / `TableBody` / `TableRow` / `TableCell`: Data preview tables
- `Chip`: Status/confidence badges
- `Card` / `CardBody`: Error message display
- `Spinner`: Loading state during inventory fetch and batch assignment
- `Divider`: Visual separation in modal footer

## Future Enhancements

Possible improvements:
1. **Manual batch selection UI**: Allow users to override automatic batch assignment
2. **Duplicate detection**: Warn if items already exist in statpack
3. **Template generator**: Provide downloadable sheet templates
4. **Batch import**: Import multiple statpacks in one session
5. **Undo/rollback**: Ability to remove imported items before save
6. **Item creation flow**: Auto-create missing inventory items from paste

## Testing

To test the feature:

1. **Happy path**: Paste standard TSV data, verify all steps complete
2. **Fuzzy matching**: Test with partial/misspelled item names
3. **Edge cases**:
   - Empty paste
   - Wrong column order
   - Mixed delimiters
   - Missing batches
   - Expired batches
4. **UI validation**: Verify error messages are clear and actionable

## Performance Notes

- Inventory loaded once per session (cached in component state)
- Similarity matching is O(n*m) where n=rows, m=inventory items
  - Typical: <100ms for 500 items and 50 rows
  - Optimization: Could use trie or Levenshtein if needed for larger inventories
- Batch assignment searches linearly; acceptable for typical use

## See Also

- [Statpack Types](app/types.ts) — `StatpackItem`, `StatpackPocket`, `InventoryItem`, `InventoryBatch`
- [Statpack Editor](app/statpacks/page.tsx) — Integration point
- [HeroUI Components](https://heroui.com/) — UI framework used
