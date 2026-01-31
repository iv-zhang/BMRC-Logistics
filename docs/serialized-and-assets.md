# Asset Management & Serialized Tracking

## Overview

The BMRC Logistics system now follows a professional EMS asset management model where **statpacks are treated as primary tracked assets** along with high-value equipment like AEDs, O2 tanks, and radios.

### Asset Classification

**Statpacks:**
- All statpacks are **first-class assets** with full contents tracking
- Each statpack has a computed `assetValue` (sum of all contents' values)
- Contents are stored as nested `StatpackItem[]` with `itemValue`, `serialNumber`, `batchId`, and quantity
- Statpacks appear on the Asset Management page with maintenance logs and location tracking

**High-Value Equipment (Assets):**
Items are automatically marked as `isAsset: true` if they meet any of these criteria:
- Value ≥ **$500 USD** (configurable threshold defined in `app/types.ts` as `ASSET_VALUE_THRESHOLD`)
- Category is AED, Radio, Oxygen Tank, Generator, or Monitor
- Name contains keywords: "AED", "defibrillator", "radio", "O2", "oxygen"

**Asset Features:**
- Individual serial number tracking (`assetSerial`)
- Maintenance logs (routine, repair, inspection, replacement)
- Status tracking (Ready, Not Ready, In Use)
- Current location tracking
- Monetary value (`assetValue`)
- Parent-child relationships (e.g., battery assigned to AED parent)

### Serialized Batches

Batches can be marked as `serialized: true` and contain `serialNumbers` (one ID per physical unit):
- The UI in `Add Item` → Batches allows adding serials and keeps `stock` in sync with the number of serials
- `StatpackItem` includes `serialNumber` when a serialized unit is placed into a statpack
- Asset instances can be tracked via top-level `assets[]` array or batch-level `assetInstances[]`

## Data Model

### InventoryItem Asset Fields
```typescript
{
  isAsset: boolean;              // Mark as tracked asset
  assetValue: number;            // Monetary value in USD
  assetSerial: string;           // Unique serial/tag
  assetCategory: 'AED' | 'Radio' | 'Oxygen Tank' | 'Generic';
  assetModel: string;            // Model name
  assetStatus: 'Ready' | 'Not Ready';
  currentLocation: string;       // Physical location
  maintenance_logs: Array<{...}>;
  assets: AssetInstance[];       // Per-unit tracking for serialized items
}
```

### Statpack Asset Fields
```typescript
{
  assetValue: number;            // Computed from contents
  assetSerial: string;           // Container tag
  currentLocation: string;       // Where statpack is located
  contents: StatpackItem[];      // Nested items with values
  maintenance_logs: Array<{...}>;
}
```

### StatpackItem
```typescript
{
  itemId: string;
  batchId: string;               // REQUIRED - must reference specific batch
  serialNumber?: string;         // For serialized/asset items
  itemValue?: number;            // Per-item value for total calculation
  currentQuantity: number;
  requiredQuantity: number;
  expirationDate?: Date;
  lotNumber?: string;
  // ... other fields
}
```

## Developer Workflows

### Adding High-Value Assets

1. **Via Asset Modal** (`app/components/assetmodal.tsx`):
   - Click "Add Asset" on Assets page
   - Enter name, category (AED, Radio, O2, etc.), model
   - Set asset value (e.g., $1200 for an AED)
   - Generate or enter serial number
   - Print asset tag with QR/barcode

2. **Via Inventory Modal** (`app/components/additemmodal.tsx`):
   - Add item normally
   - Toggle "Track as Asset"
   - Enter asset value
   - Select asset category
   - Add serial numbers via batches or top-level `assets[]`

### Computing Statpack Asset Value

The system automatically computes statpack value using `computeStatpackAssetValue()` from `app/lib/inventory.ts`:

```javascript
import { computeStatpackAssetValue } from '@/app/lib/inventory';

const totalValue = computeStatpackAssetValue(statpack);
// Returns sum of (itemValue * currentQuantity) for all contents
```

**When to update:** Statpack `assetValue` should be recomputed whenever:
- Contents are added/removed
- Item quantities change
- Item values are updated

### Migration Script

Run the asset migration script to:
- Mark items over threshold as assets
- Compute statpack asset values
- Validate serialized tracking
- Generate detailed report

```bash
# Dry run (preview changes)
DRY_RUN=true node scripts/migrate-to-asset-model.js

# Apply changes
node scripts/migrate-to-asset-model.js

# Custom threshold
ASSET_VALUE_THRESHOLD=1000 node scripts/migrate-to-asset-model.js
```

The script generates a JSON report with:
- New assets identified
- Statpack values updated
- Serialized asset validation issues
- Missing value warnings

## UI Components

### Assets Page (`app/assets/page.tsx`)
- Shows **both** statpacks and inventory assets in unified table
- Displays asset value, location, status, maintenance status
- Details modal shows statpack contents with per-item values
- Maintenance tracking (start/complete workflow)
- Admin-only statpack editor

### Asset Management Features
- **Maintenance Logs**: Track routine, repair, inspection, replacement
- **Status Tracking**: Ready, Not Ready, In Use, Pending Initial Check
- **Location Tracking**: Current physical location
- **Value Tracking**: Monetary value for accountability

## Best Practices

1. **Always set assetValue** for items worth $500+
2. **Use serialNumbers** for all tracked units (AEDs, O2 tanks, radios)
3. **Compute statpack values** after any content changes
4. **Record maintenance** activities in maintenance_logs
5. **Update currentLocation** when assets move
6. **Preserve asset metadata** in normalization/migration scripts

## Configuration

### Asset Value Threshold
Defined in `app/types.ts`:
```typescript
export const ASSET_VALUE_THRESHOLD = 500; // USD
```

Change this constant to adjust the automatic asset classification threshold.

### High-Value Categories
```typescript
export const ASSET_CATEGORIES = ['AED', 'Radio', 'Oxygen Tank', 'Generator', 'Monitor'];
```

Add/remove categories that should always be treated as assets regardless of value.

## Next Steps / Future Enhancements

- [ ] Enforce restock handshake: require `batchId` + `serialNumber` selection during mobile restock/move flows
- [ ] Add QR code scanning for quick asset check-in/check-out
- [ ] Implement asset recall workflow (query by serialNumber)
- [ ] Add depreciation tracking for financial reporting
- [ ] GPS tracking integration for ambulances/vehicles
- [ ] Automated maintenance reminder notifications

## Manual Test Steps

1. **Test Asset Classification:**
   - Add item with value > $500, verify `isAsset` auto-set
   - Add AED/Radio, verify marked as asset
   - Run migration script in dry-run mode

2. **Test Statpack Value:**
   - Create/edit statpack with contents
   - Verify `assetValue` computed correctly
   - Check Assets page shows correct value

3. **Test Serialized Tracking:**
   - Add batch, toggle "Serialized", add serial numbers
   - Verify stock count matches serial count
   - Add serialized item to statpack with specific serial

4. **Test Maintenance Workflow:**
   - Start maintenance on asset
   - Verify status changes
   - Complete maintenance, verify status restored

## Troubleshooting

**Q: Statpack value not updating?**
A: Ensure `itemValue` is set on `StatpackItem` entries. Run migration script to recompute.

**Q: Item not marked as asset despite high value?**
A: Check `assetValue` field is set correctly. Run migration script to auto-mark.

**Q: Serialized count mismatch?**
A: Run migration script with validation to identify issues. Ensure `serialNumbers.length === stock`.

---

For implementation questions or to request new asset tracking features, contact the dev team or update this doc with proposed changes.
```
