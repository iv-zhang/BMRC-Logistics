# Asset Checkout Quick Start Guide

## For Members

### How to Check Out an Asset

1. **Navigate**: Go to `/assets/checkout` on the app
2. **Scan**: 
   - Click "Open Scanner"
   - Point phone camera at asset's barcode or QR code
   - Scan reads the code automatically
3. **Confirm**: 
   - Asset details pop up
   - Enter location where you'll use it (e.g., "Vehicle 1")
   - (Optional) Add a note
   - Click "Confirm Checkout"
4. **Done**: Asset is now checked out to you with timestamp recorded

### How to Check In an Asset

1. **Navigate**: Go to `/assets/checkout`
2. **Scan**: 
   - Click "Open Scanner"
   - Point camera at barcode/QR code
   - Asset appears with "Checkin" button
3. **Confirm**: 
   - Select location where you're returning it (e.g., "Equipment Room")
   - (Optional) Add note about condition
   - Click "Confirm Checkin"
4. **Done**: Asset is available for next user, checkin logged

### Manual Search (if scanner unavailable)

1. **Navigate**: Go to `/assets/checkout`
2. **Search**: Use search box to find asset by:
   - Asset name (e.g., "Radio Unit 5")
   - Serial number
   - Barcode
   - QR code content
3. **Select**: Click "Checkout" or "Checkin" button
4. **Confirm**: Enter location and confirm

---

## For Admins

### Creating Assets with Barcodes/QR Codes

1. **Go to Assets**: Navigate to `/assets` page
2. **Add Asset**: Click "Add Asset" button
3. **Fill Details**:
   - Name: "Radio Unit 5"
   - Category: "Radio"
   - Model: (optional)
4. **Generate Tag**: 
   - Click "Generate" to create auto UUID
   - Barcode preview appears
   - QR code preview appears
5. **Print Label**: 
   - Click "Print" button
   - Prints barcode + QR code label
   - Affix to physical asset
6. **Or Manual Tags**:
   - Type custom barcode/QR in fields
   - At least one required (enforced on save)
7. **Save**: Click "Add Asset"

### Finding Who Used an Asset

1. **Go to Assets**: Navigate to `/assets` page
2. **Find Asset**: Search for asset in list
3. **Edit**: Click pencil icon to open asset details
4. **View History**: Scroll to "Recent Activity" section
5. **See Last User**: 
   - First entry shows most recent checkout/checkin
   - Username shows who has it (if checked out)
   - Timestamp shows exact date & time
   - Location shows where member said they'd use/return it
6. **Contact**: Use username to look up member contact info and ask about asset

### Example History Entry
```
Action: asset_checkout
User: Sarah Chen
Timestamp: Jan 30, 2026 2:45:32 PM
Location: Vehicle 1
Notes: Assigned to Shift A
```

### Edit Asset Later

1. **Go to Assets**: Navigate to `/assets` page
2. **Find Asset**: Search in list
3. **Edit**: Click pencil icon
4. **Update**: 
   - Change barcode/QR if needed
   - Update status (e.g., mark "Not Ready" if needs service)
   - Change location
   - Add notes
5. **View Activity**: Scroll down to see all checkout/checkin events
6. **Save**: Click "Save"

---

## Database Queries

### Get All Checkouts of a Specific Asset

```javascript
import { collection, query, where, orderBy, getDocs } from 'firebase/firestore';
import { db } from '@/firebase';

const assetId = 'abc123';
const q = query(
  collection(db, 'inventory_logs'),
  where('itemId', '==', assetId),
  orderBy('timestamp', 'desc')
);
const snap = await getDocs(q);

snap.docs.forEach(doc => {
  const event = doc.data();
  console.log(`${event.action} by ${event.userName} at ${event.timestamp}`);
});
```

### Get All Checkouts by a User

```javascript
const userId = 'user-123';
const q = query(
  collection(db, 'inventory_logs'),
  where('userId', '==', userId),
  where('action', '==', 'asset_checkout'),
  orderBy('timestamp', 'desc')
);
const snap = await getDocs(q);

snap.docs.forEach(doc => {
  const event = doc.data();
  console.log(`${event.itemName} checked out at ${event.timestamp}`);
});
```

### Find Assets Checked Out Right Now

```javascript
const q = query(
  collection(db, 'inventory'),
  where('assetStatus', '==', 'Checked Out'),
  orderBy('checkedOutAt', 'desc')
);
const snap = await getDocs(q);

snap.docs.forEach(doc => {
  const asset = doc.data();
  console.log(`${asset.name} checked out by ${asset.checkedOutBy}`);
});
```

---

## Troubleshooting

### Scanner Not Working
- **Issue**: Camera permission denied
- **Fix**: Allow browser to access camera (check browser settings)
- **Workaround**: Use manual search box instead

### Asset Not Found When Scanning
- **Issue**: Scanned code doesn't match any asset
- **Fix**: Ensure barcode/QR code matches the `barcode` or `qr` field in asset doc
- **Fix**: Try searching manually by serial number instead

### Can't Save Asset (validation error)
- **Issue**: "Please provide either a Barcode or QR Code"
- **Fix**: Enter value in at least one of these fields: Barcode OR QR Code

### Wrong Asset Checked Out
- **Issue**: Scan matched multiple assets
- **Fix**: Select the correct asset from the popup list

### Timestamp Wrong
- **Issue**: Checkout timestamp doesn't match member's report
- **Fix**: Server timestamps are authoritative (member's device clock may be wrong)

---

## API Reference

### Checkout Function

```typescript
import { checkoutAsset } from '@/app/lib/inventory';

await checkoutAsset({
  assetId: 'asset-123',
  user: { 
    id: 'user-456',
    fullName: 'John Doe'
  },
  location: 'Vehicle 1',
  note: 'Assigned to Shift A'
});
```

### Checkin Function

```typescript
import { checkinAsset } from '@/app/lib/inventory';

await checkinAsset({
  assetId: 'asset-123',
  user: { 
    id: 'user-456',
    fullName: 'John Doe'
  },
  location: 'Equipment Room',
  note: 'Returned in good condition'
});
```

---

## Settings & Configuration

### Require Both Barcode AND QR Code
To enforce both tags per asset, edit the validation in `assetmodal.tsx`:

```typescript
// Change this line in the save function:
if (!form.barcode && !form.qr) {

// To this (require both):
if (!form.barcode || !form.qr) {
```

### Restrict Checkout to Admins Only
In `/assets/checkout/page.tsx`, add role check:

```typescript
const { role } = useUserRole(); // Get user role

if (role !== 'admin') {
  return <div>Checkout restricted to admins</div>;
}
```

### Change Asset Status After Checkin
Edit `checkinAsset()` to default to different status:

```typescript
assetStatus: 'Ready', // Change to 'Available', 'In Stock', etc.
```

---

## Data Retention

- **Log Retention**: Logs stored indefinitely (audit trail)
- **Historical Timestamps**: Never modified (immutable)
- **Asset Status**: Updates on each action (not historical)
- **User Privacy**: Logs contain user ID and name (store securely, restrict access)
