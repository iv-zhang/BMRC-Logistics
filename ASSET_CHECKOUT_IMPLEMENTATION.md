# Asset Checkout Feature Implementation

## Overview
A complete scan-based asset checkout/checkin system for members to quickly check out and return assets (radios, AEDs, oxygen tanks, etc.) with detailed audit logging so admins can track who last used an asset if it was broken or lost.

## Key Features
1. **Barcode/QR Code Scanning**: Assets can be scanned using either barcode or QR code (enforces at least one tag per asset)
2. **Quick Checkout/Checkin**: One-click checkout and checkin with timestamp and location tracking
3. **Admin Audit Trail**: Complete history of all checkout/checkin events queryable by asset ID
4. **User Tracking**: Know exactly who checked out an asset and when, so you can contact them if the asset is damaged/missing
5. **Location Tracking**: Members report where they checked out/returned the asset
6. **Timestamp Precision**: Server-side timestamps for accurate event logging (no client clock skew)

## Files Changed & Created

### Types (`app/types.ts`)
**Added to InventoryItem:**
- `barcode?: string` - Barcode value for scanning
- `qr?: string` - QR code content for scanning
- `checkedOutAt?: Date | FieldValue` - When asset was checked out
- `checkedOutBy?: string` - User ID of member who checked it out
- `lastCheckedInAt?: Date | FieldValue` - When asset was last checked in
- `lastCheckedInBy?: string` - User ID of member who checked it in
- `lastKnownReturnLocation?: string` - Location where member reported returning it
- `assetStatus` extended with 'Checked Out' and 'In Use' states

**Added to AssetInstance:**
- `barcode?: string`
- `qr?: string`
- `checkedOutAt?: Date | FieldValue`
- `checkedOutBy?: string`
- `lastCheckedInAt?: Date | FieldValue`
- `lastCheckedInBy?: string`
- `status` extended with 'In Use' and 'Checked Out' states

**New Type: `InventoryLog`**
```typescript
interface InventoryLog {
  id?: string;
  itemId?: string;
  itemName?: string;
  action: string; // 'asset_checkout', 'asset_checkin', etc.
  userId?: string;
  userName?: string;
  timestamp: Date | FieldValue; // Server timestamp
  location?: string; // Where asset is/was located
  notes?: string; // Additional context
  // ... other fields
}
```

### API Functions (`app/lib/inventory.ts`)
**New Functions:**

1. **`checkoutAsset(params)`**
   - Updates asset status to 'Checked Out'
   - Records checkout timestamp and user
   - Logs the event to `inventory_logs` collection
   - Records audit event to `auditEvents` collection
   - Saves reported location

2. **`checkinAsset(params)`**
   - Updates asset status to 'Ready'
   - Records checkin timestamp and user
   - Logs the event to `inventory_logs` collection
   - Records audit event to `auditEvents` collection
   - Saves reported return location

Both functions write server timestamps for audit accuracy.

### Components

#### `app/components/checkout-modal.tsx` (NEW)
Modal dialog for confirming asset checkout/checkin:
- Displays asset details (name, category, serial)
- Shows current asset status
- Prefills logged-in user
- Text input for location (where using/returning to)
- Text area for optional notes
- Calls `checkoutAsset()` or `checkinAsset()` on confirm
- Shows success message and auto-closes

**Using HeroUI components:**
- Modal with ModalContent/Header/Body/Footer
- Input, Textarea, Card, CardBody, Chip

#### `app/components/asset-history.tsx` (NEW)
Displays checkout/checkin activity history for an asset:
- Queries `inventory_logs` by `itemId`
- Sorted by timestamp descending
- Shows: Action, User, Timestamp, Location, Notes
- Highlights most recent entry (blue background)
- Paginated with `maxRows` prop (default 10)
- Shows spinner while loading
- Clean HeroUI Table display

**Using HeroUI components:**
- Card with CardHeader/CardBody
- Table with TableHeader/TableBody/TableCell/TableColumn
- Chip for action badges with color coding
- Spinner for loading state

#### `app/components/assetmodal.tsx` (UPDATED)
Enhanced asset create/edit modal:
- Added `barcode` input field
- Added `qr` input field
- Validation: enforces at least one barcode OR qr code
- Embeds `AssetHistory` component for existing assets
- Shows validation error if neither tag provided
- Extended `assetStatus` select with 'Checked Out' option

### Pages

#### `app/assets/checkout/page.tsx` (NEW)
Main checkout/checkin interface:

**Features:**
1. Quick scan mode: Opens camera and detects barcodes/QR codes
2. Manual search: Search assets by name, serial, barcode, or QR code
3. Asset list table showing:
   - Asset name & category
   - Serial number
   - Current status (colored chip)
   - Who checked it out (if checked out)
   - Action button (Checkout or Checkin)
4. Multi-match handling: If scan matches multiple assets, user selects one
5. Error handling: Shows alerts if scan doesn't match any asset

**Using HeroUI components:**
- Card, CardHeader, CardBody
- Button with icon
- Input for search
- Chip for status
- Modal for multi-match selection
- Table for asset list
- Spinner for loading

### Database Schema

**Collection: `inventory_logs` (existing, enhanced)**
Each checkout/checkin creates an entry with:
```json
{
  "itemId": "asset-id",
  "itemName": "Radio Unit 5",
  "action": "asset_checkout" | "asset_checkin",
  "userId": "user-id",
  "userName": "John Doe",
  "timestamp": serverTimestamp(),
  "location": "Vehicle 1",
  "notes": "Optional context"
}
```

**Collection: `auditEvents` (existing, enhanced)**
Each checkout/checkin also creates an audit event:
```json
{
  "eventType": "asset_checkout" | "asset_checkin",
  "source": "inventory",
  "sourceId": "asset-id",
  "actor": {
    "userId": "user-id",
    "userName": "John Doe"
  },
  "targets": [{ "collection": "inventory", "docId": "asset-id" }],
  "timestamp": serverTimestamp(),
  "after": { "assetStatus": "Checked Out", ... }
}
```

## Workflow

### Member Checkout Flow
1. Member navigates to `/assets/checkout`
2. Scans asset barcode/QR code with phone camera
3. Confirms location where they'll use it
4. Optionally adds a note
5. Confirms checkout
6. Asset status changes to 'Checked Out', timestamp recorded

### Member Checkin Flow
1. Member navigates to `/assets/checkout`
2. Scans asset barcode/QR code
3. Confirms location where they're returning it
4. Optionally notes the condition (e.g., "Good", "Minor damage")
5. Confirms checkin
6. Asset status changes to 'Ready', timestamp recorded

### Admin Lookup Flow
1. Admin opens asset details in edit modal
2. Sees recent activity history at bottom
3. Clicks on most recent checkout entry to see user who last checked it out
4. Can contact that user if asset is damaged/missing

## Admin Features

### Find Who Last Used an Asset
- Open asset in `/assets` page
- Click edit (pencil icon)
- Scroll to "Activity History" section
- First entry shows: action, username, exact timestamp, location, notes
- For broken/missing assets, contact the user listed in the most recent `asset_checkout` entry

### Query Logs Programmatically
```typescript
// Get all checkouts/checkins of an asset
const q = query(
  collection(db, 'inventory_logs'),
  where('itemId', '==', assetId),
  orderBy('timestamp', 'desc')
);
const snap = await getDocs(q);

// Get all assets checked out by a user
const q = query(
  collection(db, 'inventory_logs'),
  where('userId', '==', userId),
  where('action', '==', 'asset_checkout'),
  orderBy('timestamp', 'desc')
);
```

## Barcode/QR Code Policy

### "Accept Either" Strategy
- Assets can have **either** a barcode OR QR code (or both)
- Scanning accepts any of: barcode value, QR code content, or serial number
- Validation enforces **at least one** tag when creating/editing assets
- No requirement for both (simplifies adoption)

### Assigning Tags to Assets
1. In asset modal, click "Generate" to auto-create a UUID
2. Tag generates a QR code and barcode preview
3. Click "Print" to print label with QR + barcode
4. Manually set `barcode` and `qr` fields if desired
5. Save asset
6. Affix label to physical asset

### Bulk Tagging
Optional: Create a backfill script to generate tags for existing assets:
```bash
node scripts/backfill-asset-tags.js
```
(Script not included in this implementation; can be added on request)

## Security & Permissions

### Checkout Permissions
- Currently: Any logged-in user can checkout/checkin
- Future: Could restrict to specific roles (FTO, Quartermaster) via `useUserRole()`
- Location is member-reported (not validated)

### Audit Permissions
- Full history visible in admin asset modal
- History queryable by admins only (firestore rules should enforce)
- Timestamps server-side (cannot be tampered)

## Implementation Notes

1. **Timestamps**: All checkout/checkin events use `serverTimestamp()` for accuracy
2. **Logs**: Events written to both `inventory_logs` and `auditEvents` for redundancy
3. **No Photos**: Per requirement, feature stores only logs—no file storage needed
4. **HeroUI Styling**: All components use consistent HeroUI design (Chip, Card, Modal, Table, etc.)
5. **Error Handling**: Graceful errors with user-facing messages
6. **Loading States**: Spinners shown during async operations

## Next Steps (Optional Enhancements)

1. **Bulk Asset Tags**: Script to generate & print tags for existing assets
2. **Expected Return**: Add optional expected return date field
3. **Asset Condition**: Photo or condition code on checkin
4. **Email Alerts**: Notify if asset not returned within expected timeframe
5. **Analytics**: Dashboard showing asset usage patterns
6. **Offline Support**: Service worker for offline scanning in poor connectivity

## Testing Checklist

- [ ] Create asset with barcode + QR code
- [ ] Validation: Try save without barcode or QR (should show error)
- [ ] Scan barcode and checkout asset
- [ ] Confirm asset status changes to "Checked Out"
- [ ] View asset history and see checkout entry
- [ ] Scan same asset and checkin
- [ ] Confirm asset status changes to "Ready"
- [ ] View history again, see both checkout + checkin entries
- [ ] Search asset list and click button to checkout/checkin manually
- [ ] Multi-match: Create 2 assets with same barcode, verify selection dialog
- [ ] Member contact: Admin can identify who checked out asset from history
