# Vendor/Purchase Tracking Feature Implementation

## Overview
Added vendor and purchase tracking to disposable inventory items, enabling price comparison across suppliers when running low on stock.

## Implementation Date
January 31, 2026

## Changes Summary

### 1. Type Definitions (`app/types.ts`)
- **Added `PurchaseInfo` interface** with the following fields:
  - `supplierName?: string` - Vendor/supplier name
  - `supplierId?: string` - Optional supplier ID for reference
  - `pricePerUnit?: number` - Unit price for comparison
  - `currency?: string` - Currency (defaults to USD)
  - `quantityReceived?: number` - Quantity in this purchase
  - `unitOfMeasure?: string` - Unit type (box, each, case, etc.)
  - `purchaseOrderId?: string` - PO number
  - `invoiceRef?: string` - Invoice reference
  - `receivedAt?: Timestamp | Date` - Receipt timestamp
  - `notes?: string` - Additional notes

- **Updated `InventoryBatch` interface** to include `purchase?: PurchaseInfo`
- **Updated `Container` interface** to include `purchase?: PurchaseInfo` for sealed boxes

### 2. Inventory Helpers (`app/lib/inventory.ts`)
Updated the following functions to accept and persist purchase metadata:

- `sealContainerAsBox()` - Now accepts optional `purchase` parameter
- `consumeBox()` - Accepts `purchase` in options, propagates to created/updated batches
- `createOpenBatch()` - Accepts `purchase` in options, attaches to batch record

All functions preserve purchase info when creating or updating batches.

### 3. UI Components

#### `app/components/additemmodal.tsx`
- Added purchase info fields to batch editing section:
  - Supplier Name
  - Price Per Unit
  - Currency
  - PO / Invoice #
- Fields appear alongside existing batch metadata (lot number, expiration, etc.)
- Purchase info is optional and won't block quick data entry

#### `app/components/consume-box-modal.tsx`
- Added collapsible "Add Purchase Info" section
- Includes fields for:
  - Supplier Name
  - Price Per Unit (USD)
  - PO / Invoice #
- Purchase data is attached to newly created open batches
- All fields are optional to avoid workflow friction

#### `app/components/purchase-history.tsx` (NEW)
- Displays batch-level purchase history for an inventory item
- Shows all batches with vendor info, sorted by received date (newest first)
- Highlights cheapest supplier with a green badge
- Displays:
  - Supplier name
  - Price per unit
  - Quantity received
  - Receipt date
  - PO/Invoice numbers
  - Current stock levels
- Empty state when no purchase data available

### 4. Migration Scripts

#### `scripts/normalize-inventory.js`
- Updated to preserve `purchase` fields when normalizing batches
- Ensures `pricePerUnit` and `quantityReceived` are converted to numbers

#### `scripts/migrate-open-to-open-batches.js`
- Updated to set `purchase: null` for migrated batches (no historical vendor data)
- Preserves schema consistency for future vendor tracking

## Usage

### Recording Purchase Info (New Items)
1. Open "Add Item" modal in inventory
2. Navigate to batch editor section
3. Fill in purchase fields:
   - Supplier Name (e.g., "Medline", "Henry Schein")
   - Price Per Unit (numeric, e.g., 2.50)
   - Currency (defaults to USD)
   - PO / Invoice # (optional reference)

### Recording Purchase Info (Consuming Boxes)
1. Open a sealed box via "Consume Box" action
2. Click "Add Purchase Info" button
3. Enter supplier, price, and PO details
4. Confirm to create open batch with vendor metadata

### Viewing Purchase History
Import and use the `PurchaseHistory` component:

```tsx
import PurchaseHistory from '@/app/components/purchase-history';

<PurchaseHistory inventoryId={item.id} />
```

The component will:
- Fetch and display all batches with purchase info
- Highlight the cheapest supplier
- Show purchase details in an organized card layout

## Data Model

### Batch with Purchase Info (Firestore Document)
```json
{
  "id": "batch-abc123",
  "lotNumber": "LOT-2024-001",
  "stock": 50,
  "expirationDate": "2025-12-31T00:00:00.000Z",
  "receivedAt": "2024-01-15T10:30:00.000Z",
  "purchase": {
    "supplierName": "Medline",
    "pricePerUnit": 2.45,
    "currency": "USD",
    "quantityReceived": 50,
    "unitOfMeasure": "box",
    "purchaseOrderId": "PO-2024-0042",
    "invoiceRef": "INV-987654",
    "receivedAt": "2024-01-15T10:30:00.000Z",
    "notes": "Bulk order - negotiated discount"
  }
}
```

## Benefits

1. **Price Comparison**: Easily identify cheapest suppliers when reordering
2. **Historical Reference**: Track pricing trends over time
3. **Procurement Optimization**: Make data-driven decisions for bulk orders
4. **Audit Trail**: Complete record of where items were sourced
5. **Budget Planning**: Better cost estimates for future purchases

## Future Enhancements

1. **Analytics Dashboard**: Aggregate purchase data across items
2. **Supplier Profiles**: Dedicated supplier management with contact info
3. **Auto-Suggestions**: Recommend cheapest supplier when stock is low
4. **Export Reports**: Generate procurement reports for accounting
5. **Price Alerts**: Notify when better pricing is available

## Technical Notes

- All purchase fields are optional to maintain workflow flexibility
- Firestore `Timestamp` types are properly handled for date comparisons
- Migration scripts ensure backward compatibility with existing data
- Empty/null purchase fields are gracefully handled in UI components
- Type safety enforced throughout with TypeScript interfaces

## Testing Checklist

- [x] PurchaseInfo type compiles without errors
- [x] Inventory helpers accept and persist purchase metadata
- [x] AddItemModal renders purchase fields correctly
- [x] ConsumeBoxModal collects and submits purchase info
- [x] PurchaseHistory component displays data correctly
- [x] Migration scripts preserve purchase fields
- [x] No TypeScript errors in modified files
- [ ] Manual UI testing in dev environment
- [ ] Firestore data validation
- [ ] Edge case handling (null/undefined values)

## Related Files

### Core Implementation
- `app/types.ts` - Type definitions
- `app/lib/inventory.ts` - Data persistence
- `app/components/additemmodal.tsx` - Batch purchase entry
- `app/components/consume-box-modal.tsx` - Box opening with purchase
- `app/components/purchase-history.tsx` - Display component

### Migration Scripts
- `scripts/normalize-inventory.js`
- `scripts/migrate-open-to-open-batches.js`

---

**Implementation completed**: January 31, 2026  
**Status**: ✅ Complete - Ready for testing
