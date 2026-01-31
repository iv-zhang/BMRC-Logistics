# Asset Management Quick Reference

## What Changed?

The BMRC Logistics system now follows **professional EMS asset management** practices:

✅ **Statpacks are primary assets** — treated like ambulances in a real EMS system
✅ **High-value equipment tracked** — AEDs, O2 tanks, radios (anything ≥$500)
✅ **Nested content tracking** — statpacks contain their full inventory with values
✅ **Maintenance logging** — track repairs, inspections, routine maintenance
✅ **Location tracking** — know where every asset is at all times

## Quick Commands

### Run Asset Migration
```bash
# Preview what will change (recommended first)
DRY_RUN=true node scripts/migrate-to-asset-model.js

# Apply the migration
node scripts/migrate-to-asset-model.js
```

### What the Migration Does
1. Marks inventory items over $500 as tracked assets
2. Auto-flags AEDs, O2 tanks, radios as assets
3. Computes total value for each statpack
4. Validates serial number tracking
5. Generates detailed JSON report

## Asset Value Threshold

**Default: $500 USD**

Configured in `app/types.ts`:
```typescript
export const ASSET_VALUE_THRESHOLD = 500;
```

Items meeting ANY of these criteria become tracked assets:
- Value ≥ $500
- Category: AED, Radio, Oxygen Tank, Generator, Monitor
- Name contains: "AED", "radio", "O2", "oxygen", "defibrillator"

## Key Features

### Assets Page
Navigate to `/assets` to see:
- All statpacks listed as assets
- High-value equipment (AEDs, O2, radios)
- Asset value, location, status
- Maintenance history
- Quick actions (inspect, start maintenance)

### Statpack Contents
Click "Details" on any statpack to view:
- Complete inventory of contents
- Per-item values
- Serial numbers
- Expiration dates
- Total asset value

### Maintenance Tracking
For any asset:
1. Click wrench icon → "Start Maintenance"
2. Select service type (routine, repair, inspection)
3. Enter reason and notes
4. Asset status updates automatically
5. Click checkmark when complete

## Adding New Assets

### Method 1: Asset Modal (Quick)
1. Click "Add Asset" button
2. Enter name, category, model
3. Set asset value
4. Generate/enter serial number
5. Print asset tag (QR + barcode)

### Method 2: Inventory Modal (Detailed)
1. Add item normally
2. Toggle "Track as Asset" switch
3. Enter asset value
4. Select asset category
5. Add serial numbers via batches
6. Save

## Data Fields

### Required for Assets
- `name` — Asset name
- `assetValue` — Dollar value (triggers isAsset if ≥$500)
- `assetSerial` — Unique identifier
- `currentLocation` — Where it is now

### Optional but Recommended
- `assetCategory` — AED, Radio, O2, etc.
- `assetModel` — Specific model name
- `assetStatus` — Ready, Not Ready, In Use
- `maintenance_logs` — Service history

## Statpack Value Calculation

Statpacks automatically compute `assetValue` as:
```
sum of (itemValue × currentQuantity) for all contents
```

**Example:**
```
Contents:
  - 2× AED pads @ $45 = $90
  - 1× Oxygen tank @ $300 = $300
  - 50× Gauze @ $0.50 = $25
Total: $415
```

Recompute after adding/removing items using:
```typescript
import { computeStatpackAssetValue } from '@/app/lib/inventory';
const value = computeStatpackAssetValue(statpack);
```

## Common Workflows

### Check Asset Out
1. Go to Assets page
2. Find asset in table
3. Click eye icon → "Details"
4. Note current location
5. Update location in admin tools

### Record Maintenance
1. Click wrench icon on asset
2. Fill out maintenance form
3. Submit → status changes to "Not Ready"
4. Complete work
5. Click checkmark → status returns to "Ready"

### View Statpack Contents
1. Assets page → find statpack
2. Click eye icon
3. Scroll to "Contents" section
4. See all items with values, serials, expirations

### Add Item to Statpack
1. Open statpack editor (admin only)
2. Select pocket
3. Add item with `batchId` reference
4. Include `serialNumber` for tracked assets
5. Set `itemValue` for value calculation
6. Save → `assetValue` recomputes

## Troubleshooting

### "Item not marked as asset"
✓ Check `assetValue` field is set and ≥$500
✓ Or ensure category is AED/Radio/O2
✓ Run migration script to auto-mark

### "Statpack value is zero"
✓ Ensure `StatpackItem.itemValue` is set for contents
✓ Or link to inventory items with `assetValue`
✓ Run migration to recompute

### "Serial number mismatch"
✓ Run migration script for validation report
✓ Check `serialNumbers.length === stock`
✓ Review `batches[].serialized` flag

### "Can't find asset on Assets page"
✓ Verify `isAsset: true` in Firestore
✓ Check if statpack (should always show)
✓ Run migration to auto-classify

## File Locations

- **Types**: `app/types.ts` (ASSET_VALUE_THRESHOLD, interfaces)
- **Assets Page**: `app/assets/page.tsx`
- **Asset Modal**: `app/components/assetmodal.tsx`
- **Inventory Modal**: `app/components/additemmodal.tsx`
- **Data Layer**: `app/lib/inventory.ts` (computeStatpackAssetValue)
- **Migration Script**: `scripts/migrate-to-asset-model.js`
- **Full Docs**: `docs/serialized-and-assets.md`

## Next Steps

After running migration:
1. Review generated report JSON
2. Fix any validation issues (serial mismatches)
3. Add missing `assetValue` to flagged items
4. Update asset locations in UI
5. Train team on maintenance workflow

---

**Questions?** See full documentation in `docs/serialized-and-assets.md`
