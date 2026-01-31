# Box-Based Inventory Migration

## Overview

The inventory system has been updated to track items by **unopened boxes** only, instead of tracking individual units. This simplifies inventory management and aligns with how items are physically organized.

**NEW (Jan 2026)**: Added **open-batch migration (Option A)** to convert existing open/unreconciled counts into explicit "open batch" records and manual "Consume Box" workflow for moving sealed inventory to forward staging.

## Key Changes

### Type System (app/types.ts)
- **Added**: `unopenedBoxes: number` - Number of unopened boxes (sealed boxes in back room)
- **Added**: `itemsPerBox?: number` - Optional: how many items in one box
- **Added**: `batches[].openDate?: Date` - For tracking when a box was opened
- **Deprecated**: `totalStockQuantity`, `unopenedQuantity`, `openedQuantity`, `quantityPerUnit`, `tracksOpenStock`

### UI Components

#### Inventory Page (app/inventory/page.tsx)
- Displays box count instead of individual units
- Shows items/box when set
- Updated stock status calculations to use `unopenedBoxes`
- Stock adjustment buttons now increment/decrement boxes
- **NEW**: "Consume Box" button for back-room items to manually open boxes and create open batches

#### Add/Edit Modal (app/components/additemmodal.tsx)
- New HeroUI inputs for "Unopened Boxes" and "Items Per Box"
- Removed open/sealed box tracking UI
- Default unit type changed to "box"

#### Consume Box Modal (app/components/consume-box-modal.tsx) **NEW**
- Manual workflow for opening sealed boxes
- Select target batch or create new open batch
- Decrements `unopenedBoxes` and adds units to open batch
- Creates audit logs in `inventory_logs`

#### Statpack Check-Off Modal (app/components/statpack-checkoff-modal.tsx)
- **Updated**: Now audit-only (does not auto-consume boxes)
- Shows contextual help about manual "Consume Box" workflow
- Admins can quickly access Consume Box from inventory page

### Backend

#### Utilities (app/lib/inventory.ts, app/utils/inventoryNormalization.ts)
- Updated payload normalization to handle box-based fields
- Batch creation uses box tracking
- **NEW**: `consumeBox(itemId, boxCount, opts)` - Atomically decrements unopenedBoxes and creates/updates open batch
- **NEW**: `createOpenBatch(itemId, quantity, opts)` - Creates an open batch record
- **NEW**: `determineIsAsset(item)` - Centralized asset classification helper

## Migration Scripts

### 1. Box-Based Migration (Original)

**Location**: `scripts/migrate-to-boxes.js`

#### What it does:
1. Resets all inventory items to 0 `unopenedBoxes`
2. Sets `itemsPerBox` to null (to be filled manually)
3. Clears deprecated quantity fields

#### How to run:

```bash
# Set your Firebase credentials
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/serviceAccountKey.json"

# Run migration
node scripts/migrate-to-boxes.js
```

**IMPORTANT**: This script resets all quantities to 0. You'll need to physically count and reorganize inventory.

### 2. Open-Batch Migration (Option A) **NEW**

**Location**: `scripts/migrate-open-to-open-batches.js`

#### What it does:
1. Scans all inventory documents
2. Computes canonical physical count (batch sum OR unopenedBoxes * itemsPerBox)
3. If discrepancy exists (canonical > batch sum), creates an "open" batch with the difference
4. Skips assets and serialized items
5. Writes audit logs to `inventory_migrations` and `inventory_logs`

#### How to run:

```bash
# Set your Firebase credentials
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/serviceAccountKey.json"

# Dry run (preview changes)
node scripts/migrate-open-to-open-batches.js --dry-run

# Apply changes (requires confirmation)
node scripts/migrate-open-to-open-batches.js --force

# Options
node scripts/migrate-open-to-open-batches.js --force --userId=admin-uid --batch-size=100
```

#### Example Output (Dry Run):

```
📊 Migration Analysis:
   Total items: 150
   Items with discrepancies: 12
   Items needing open batch creation: 10
   Items skipped (assets/serialized): 2

📋 Items to migrate:

┌─────────┬────────────────────────────┬───────────┬───────────┬──────────────┬──────────────────┐
│ ID      │ Name                       │ Batch Sum │ Canonical │ Discrepancy  │ Open Batch Stock │
├─────────┼────────────────────────────┼───────────┼───────────┼──────────────┼──────────────────┤
│ abc123  │ Gauze Pads 4x4             │ 50        │ 200       │ 150          │ 150              │
│ def456  │ Nitrile Gloves (Large)     │ 0         │ 300       │ 300          │ 300              │
└─────────┴────────────────────────────┴───────────┴───────────┴──────────────┴──────────────────┘

✅ Dry run complete. No changes written.
   To apply changes, run with --force flag.
```

#### Before/After Document Example:

**Before:**
```json
{
  "id": "abc123",
  "name": "Gauze Pads 4x4",
  "unopenedBoxes": 2,
  "itemsPerBox": 100,
  "batches": [
    {
      "id": "batch-sealed-1",
      "stock": 50,
      "lotNumber": "LOT2024-01",
      "expirationDate": "2026-12-31"
    }
  ]
}
```

**After:**
```json
{
  "id": "abc123",
  "name": "Gauze Pads 4x4",
  "unopenedBoxes": 2,
  "itemsPerBox": 100,
  "batches": [
    {
      "id": "batch-sealed-1",
      "stock": 50,
      "lotNumber": "LOT2024-01",
      "expirationDate": "2026-12-31"
    },
    {
      "id": "open-1706678400-abc123",
      "stock": 150,
      "lotNumber": "OPEN",
      "openDate": "2026-01-30T12:00:00Z",
      "notes": "Converted from open/unreconciled counts (migration)"
    }
  ]
}
```

#### Rollback Plan:

If migration creates incorrect open batches:

1. Query `inventory_migrations` collection for migration records
2. For each affected item, remove the created batch by `createdBatchId`
3. Optionally restore `before` state from migration record

```javascript
// Example rollback (run in Firebase console or script)
const migrations = await db.collection('inventory_migrations')
  .where('migrationType', '==', 'open_batch_creation')
  .get();

for (const doc of migrations.docs) {
  const data = doc.data();
  const itemRef = db.collection('inventory').doc(data.itemId);
  const item = (await itemRef.get()).data();
  
  // Remove created batch
  const updatedBatches = item.batches.filter(b => b.id !== data.createdBatchId);
  await itemRef.update({ batches: updatedBatches });
}
```

## Post-Migration Steps

1. **Physical Organization**:
   - Count all unopened boxes for each item
   - Group boxes by item type

2. **Update Inventory**:
   - For each item, set `unopenedBoxes` to actual count
   - Set `itemsPerBox` if known (e.g., 100 gloves per box)
   - Update `reorderThreshold` to reflect box counts (not unit counts)

3. **Examples**:
   - **Gloves**: `unopenedBoxes: 5`, `itemsPerBox: 100`
   - **Bandages**: `unopenedBoxes: 3`, `itemsPerBox: 50`
   - **AED Pads**: `unopenedBoxes: 2`, `itemsPerBox: null` (if items/box not tracked)

## Disposables vs Assets Policy

### Disposables (everything not an asset)
- **Tracked as**: Unopened boxes in the back room only
- **When opened**: Quartermaster uses "Consume Box" button to mark box as opened and create an open batch
- **Expiration**: Only tracked while in sealed boxes; once opened, members can discard expired items and request refill
- **Location**: Back room (sealed boxes) → Forward staging (open batches)

### Assets (high-value items)
- **Tracked as**: Individual serialized items with status, maintenance reason, location, and history
- **Examples**: AEDs, radios, oxygen tanks, generators, monitors, items > $500
- **Lifecycle**: Full tracking (status, maintenance, expiration for pads/batteries)
- **Classification**: Automatic via `determineIsAsset()` helper (checks `ASSET_VALUE_THRESHOLD` and `ASSET_CATEGORIES`)

### Statpacks
- **Contain both**: Disposables and assets
- **Check-off**: Audit-only (creates `statpack_logs` but does not mutate inventory)
- **Restocking**: Members use "Consume Box" in Master Inventory when they need items from sealed boxes

## Benefits

- ✅ Simpler inventory management
- ✅ Matches physical storage (boxes on shelves)
- ✅ Reduces fat-finger errors
- ✅ Clearer reorder points
- ✅ Easier physical counts during audits
- ✅ **NEW**: Explicit open-batch model with audit trail
- ✅ **NEW**: Manual consumption workflow prevents accidental inventory decrements
- ✅ **NEW**: Centralized asset classification logic

## Backwards Compatibility

- Legacy fields (`totalStockQuantity`, etc.) are kept in the database for now
- Old data can be viewed but won't be updated
- All new entries use box-based tracking + open-batch model

## Firestore Collections Updated

- `inventory` - Item docs with `unopenedBoxes` and `batches[]` (including open batches)
- `inventory_logs` - Audit logs for consume/open batch operations
- `inventory_migrations` - Migration records with before/after snapshots
- `statpack_logs` - Statpack check-off logs (audit-only, no inventory mutation)

## Questions?

See the attached copilot instructions or reach out to the development team.
