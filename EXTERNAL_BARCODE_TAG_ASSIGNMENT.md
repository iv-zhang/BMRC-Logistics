# External Barcode Tag Assignment Feature

## Overview

This feature allows authorized users (admin, quartermaster, inventory_helper) to scan purchased asset tags with pre-printed barcodes and assign them to inventory assets. Tags can be reassigned if they wear off or need replacement, with full audit trail preservation.

## Key Features

1. **Scan & Assign**: Use mobile phone camera to scan external barcode tags
2. **Duplicate Detection**: Warns when barcode is already assigned to another asset
3. **Override Option**: Allows duplicate assignment with explicit confirmation
4. **Audit Trail**: Records all assignments and reassignments in history
5. **Multiple Entry Points**: Available in asset modal and quick-assign on assets page
6. **Role Gating**: Only admin/quartermaster/inventory_helper can assign tags

## Implementation Details

### Schema Changes (app/types.ts)

Added to both `InventoryItem` and `AssetInstance` types:

```typescript
// External barcode assigned from purchased asset tags
assignedBarcode?: string | null;

// History of all barcode assignments/reassignments for audit trail
barcodeHistory?: Array<{
  value: string;
  assignedAt: Date | FieldValue;
  assignedBy?: { id?: string; name?: string };
}>;
```

### Backend Helper (app/lib/inventory.ts)

New function: `assignBarcode(params)`

**Parameters:**
- `itemId`: Firestore doc ID of the inventory item
- `barcode`: The external barcode value from purchased tag
- `user`: User performing the assignment (id, fullName)
- `serial`: Optional asset instance serial (for multi-instance assets)
- `options.allowDuplicate`: When true, allows duplicate assignment

**Returns:**
```typescript
{
  success: boolean;
  message: string;
  isDuplicate?: boolean;
  duplicateItem?: { id: string; name: string; serial?: string };
  action?: 'assign' | 'reassign';
}
```

**Process:**
1. Validates barcode is not empty
2. Checks for duplicates across all inventory items and instances
3. If duplicate found and not allowed, returns warning with duplicate info
4. If allowed (or no duplicate), performs assignment in transaction:
   - Pushes previous barcode to `barcodeHistory` (if reassigning)
   - Sets new `assignedBarcode`
   - Creates `inventory_logs` entry (action: `barcode_assign` or `barcode_reassign`)
   - Records audit event

### UI Components

#### 1. Asset Modal (app/components/assetmodal.tsx)

**New Section: "External Asset Tag"**
- "Scan Tag" button (only visible for saved assets)
- Shows current assigned barcode as green chip
- Displays scanned barcode with "Assign to Asset" button
- Shows duplicate warning with "Assign Anyway" or "Cancel" options
- Displays barcode assignment history (last 3 entries)

#### 2. Assets Page (app/assets/page.tsx)

**Quick-Assign Button**
- Package icon button in actions column
- Only visible for inventory assets
- Only shown to admin/quartermaster/inventory_helper roles
- Opens scanner modal directly
- Handles assignment with same duplicate detection flow

#### 3. Asset History (app/components/asset-history.tsx)

**Enhanced Log Display**
- Shows `barcode_assign` and `barcode_reassign` events
- Displays new barcode value in monospace font with secondary background
- Shows previous barcode when reassigning
- Color-coded with secondary chip

## User Workflow

### Assigning a Tag (Asset Modal)

1. Open asset in edit mode
2. Scroll to "External Asset Tag" section
3. Click "Scan Tag" button
4. Scanner modal opens - use camera or upload image
5. Barcode is detected and displayed
6. Click "Assign to Asset"
7. If duplicate:
   - Warning shows which asset already has this barcode
   - Choose "Assign Anyway" to override or "Cancel"
8. Success message confirms assignment
9. History section updates with new entry

### Quick-Assign (Assets Page)

1. Navigate to Assets page (/assets)
2. Find inventory asset row
3. Click Package icon button (blue/secondary color)
4. Scanner opens immediately
5. Scan barcode
6. Confirmation modal shows asset name and scanned barcode
7. Click "Assign to Asset"
8. Handle duplicate warning if needed
9. Success message confirms assignment

### Reassigning a Tag

**Scenario**: Tag wore off, need to stick a new one

1. Follow same process as initial assignment
2. System detects previous barcode exists
3. Previous barcode is automatically moved to `barcodeHistory`
4. New barcode becomes current `assignedBarcode`
5. Inventory log shows `barcode_reassign` action
6. History preserves both old and new barcodes with timestamps

## Role Permissions

| Role | Can Assign Tags | Can View History | Can Override Duplicates |
|------|----------------|------------------|------------------------|
| Admin | ✅ | ✅ | ✅ |
| Quartermaster | ✅ | ✅ | ✅ |
| Inventory Helper | ✅ | ✅ | ✅ |
| FTO | ❌ | ✅ (read-only) | ❌ |
| Member | ❌ | ✅ (read-only) | ❌ |

## Duplicate Policy

**Default: Warn & Allow Override**

When a barcode is already assigned:
1. System queries all `inventory` documents for matching `assignedBarcode`
2. Also checks all `assets[]` instances for matching `assignedBarcode`
3. If found on different asset/instance, shows warning modal with:
   - Asset name that currently has the barcode
   - Serial number (if applicable)
   - "Assign Anyway" button (requires explicit click)
   - "Cancel" button

**Why allow duplicates?**
- Physical tags might be reused after asset is retired
- Scanning errors might cause accidental matches
- Admin override needed for emergency situations

## Database Schema

### InventoryItem Document
```javascript
{
  // ... existing fields ...
  assignedBarcode: "ABC123XYZ",
  barcodeHistory: [
    {
      value: "OLD789DEF",
      assignedAt: Timestamp,
      assignedBy: { id: "user123", name: "John Doe" }
    },
    {
      value: "ABC123XYZ",
      assignedAt: Timestamp,
      assignedBy: { id: "user123", name: "John Doe" }
    }
  ]
}
```

### InventoryLog Document (barcode_assign)
```javascript
{
  itemId: "inv_abc123",
  itemName: "AED Unit 3",
  action: "barcode_assign",
  serialNumber: "AED-003",
  userId: "user123",
  userName: "John Doe",
  timestamp: Timestamp,
  details: {
    newBarcode: "ABC123XYZ",
    previousBarcode: null
  },
  notes: "Assigned barcode ABC123XYZ"
}
```

### InventoryLog Document (barcode_reassign)
```javascript
{
  itemId: "inv_abc123",
  itemName: "AED Unit 3",
  action: "barcode_reassign",
  serialNumber: "AED-003",
  userId: "user456",
  userName: "Jane Smith",
  timestamp: Timestamp,
  details: {
    newBarcode: "NEW456GHI",
    previousBarcode: "ABC123XYZ"
  },
  notes: "Reassigned barcode from ABC123XYZ to NEW456GHI"
}
```

## Migration Considerations

### Existing Assets
- No automatic backfill required
- `assignedBarcode` defaults to `null`
- `barcodeHistory` defaults to empty array
- Assign tags as needed when physical tags are applied

### Optional Backfill Script
If you want to populate `barcodeHistory` from existing `barcode` field:

```javascript
// scripts/backfill-barcode-history.js
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

async function backfillBarcodeHistory() {
  const snap = await db.collection('inventory').get();
  const batch = db.batch();
  let count = 0;

  snap.docs.forEach(doc => {
    const data = doc.data();
    if (data.barcode && !data.assignedBarcode) {
      batch.update(doc.ref, {
        assignedBarcode: data.barcode,
        barcodeHistory: [{
          value: data.barcode,
          assignedAt: admin.firestore.Timestamp.now(),
          assignedBy: { id: 'system', name: 'System Migration' }
        }]
      });
      count++;
    }
  });

  if (count > 0) {
    await batch.commit();
    console.log(`Backfilled ${count} assets`);
  }
}

backfillBarcodeHistory().catch(console.error);
```

## Testing Checklist

- [x] Types compile without errors
- [x] Build succeeds with no TypeScript errors
- [x] assignBarcode function handles duplicates correctly
- [x] Scanner modal opens and closes properly
- [x] Duplicate warning displays correct asset info
- [x] Override button assigns despite duplicate
- [x] History shows assignment events
- [x] Role gating prevents member access
- [x] Quick-assign button only shows for inventory assets
- [x] Reassignment preserves old barcode in history

## Manual Testing Steps

1. **Basic Assignment**
   - Open an asset in edit mode
   - Click "Scan Tag"
   - Scan or upload barcode image
   - Verify barcode displays correctly
   - Click "Assign to Asset"
   - Check success message
   - Refresh page, verify `assignedBarcode` saved

2. **Duplicate Detection**
   - Assign barcode "TEST123" to Asset A
   - Open Asset B
   - Try to assign same barcode "TEST123"
   - Verify warning shows Asset A name
   - Click "Cancel" - verify nothing changed
   - Try again, click "Assign Anyway"
   - Verify both assets now have "TEST123"

3. **Reassignment**
   - Assign barcode "FIRST" to an asset
   - Assign barcode "SECOND" to same asset
   - Check history shows both entries
   - Verify `assignedBarcode` is "SECOND"
   - Check inventory log has `barcode_reassign` entry

4. **Quick-Assign**
   - Go to /assets page
   - Find inventory asset row
   - Click Package icon
   - Scan barcode
   - Verify assignment completes
   - Check asset detail shows new barcode

5. **Role Permissions**
   - Log in as member
   - Verify Package button hidden
   - Verify "Scan Tag" button hidden in asset modal
   - Log in as admin
   - Verify buttons visible and functional

## Future Enhancements

1. **Batch Assignment**: Scan multiple tags and assign to multiple assets at once
2. **Tag Printing**: Generate and print barcode labels from assigned codes
3. **Mobile App**: Dedicated mobile app for faster tag scanning
4. **NFC Support**: Support NFC tags in addition to barcodes
5. **Retirement Tracking**: Mark tags as retired when asset is decommissioned
6. **Tag Inventory**: Track purchased tag stock (unused tags)
7. **Analytics**: Dashboard showing tag assignment stats

## Troubleshooting

### Scanner not working
- Check browser permissions for camera access
- Try image upload instead of camera
- Ensure barcode is Code128, QR, or UPC format

### Duplicate not detected
- Check that previous assignment used `assignedBarcode` field
- Verify transaction completed (check inventory_logs)
- Clear browser cache and reload

### Assignment fails silently
- Check browser console for errors
- Verify user is authenticated
- Check Firestore security rules allow write to `assignedBarcode`

### History not showing
- Refresh asset modal after assignment
- Check that `barcodeHistory` array exists in Firestore doc
- Verify inventory_logs collection has entries

## Security Considerations

### Firestore Security Rules (Recommended)

```javascript
// Allow write to assignedBarcode and barcodeHistory only for authorized roles
match /inventory/{itemId} {
  allow update: if request.auth != null &&
    (
      // Only these fields can be updated via barcode assignment
      request.resource.data.diff(resource.data).affectedKeys()
        .hasOnly(['assignedBarcode', 'barcodeHistory', 'updatedAt']) &&
      // User must have authorized role
      get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role 
        in ['admin', 'quartermaster', 'inventory_helper']
    );
}
```

## File Locations

- **Types**: `app/types.ts` (lines ~135-145, ~425-435)
- **Backend**: `app/lib/inventory.ts` (lines ~1325-1590)
- **Asset Modal**: `app/components/assetmodal.tsx`
- **Assets Page**: `app/assets/page.tsx`
- **History Component**: `app/components/asset-history.tsx`
- **Scanner Component**: `app/components/barcode-scanner.tsx` (existing)

## Summary

The External Barcode Tag Assignment feature is now fully implemented with:
- ✅ Schema fields for assigned barcode and history
- ✅ Backend transaction-based assignment with duplicate detection
- ✅ Two UI entry points (asset modal + quick-assign)
- ✅ Warn & allow override duplicate policy
- ✅ Complete audit trail in logs and history
- ✅ Role-based access control
- ✅ Build passes with no TypeScript errors

Ready for deployment and testing in production environment.
