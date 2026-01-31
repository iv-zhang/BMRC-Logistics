# Falck Professional Workflow → Student Mode Implementation

**Date:** January 23, 2026  
**Status:** Initial Implementation Complete  
**Target:** BMRC Logistics (Next.js + Firebase)

---

## Overview

This implementation adapts Falck's professional accountability workflows to a student-capacity environment. The system enforces accountability through **sealed containers**, **asset tracking**, and **digital check-off sheets**.

### Three Core Features

1. **Sealed Box Inventory** – Students seal boxes of supplies; scanning verifies the seal (1 sec) instead of manual counting
2. **Asset vs Consumable Tracking** – Radios, manikins, AED trainers tracked by status; consumables tracked by par levels
3. **Digital Check-Off Sheets** – Statpack check-off creates audit trail; tracks who verified the bag (accountability for 911 operations)

---

## Implementation Summary

### ✅ Completed

#### 1. **Data Model Updates** (`app/types.ts`)

Added to `Container` interface:
```typescript
isBox?: boolean;                      // Mark container as a sealed box
isSealed?: boolean;                   // Seal status
sealNumber?: string;                  // Tamper-evident sticker ID
sealedAt?: Date;                      // When sealed
sealedBy?: string;                    // User ID of sealer
sealedByName?: string;                // Name of sealer
boxContents?: {                       // Contents of sealed box
  itemId: string;
  batchId: string;
  quantity: number;
  serialNumber?: string;
}[];
```

Added `BoxLog` collection type for audit trail:
```typescript
interface BoxLog {
  boxId: string;
  action: 'sealed' | 'unsealed' | 'inventory_check' | 'break_seal';
  userId: string;
  timestamp: Date;
  sealIntact?: boolean;               // true = intact, false = broken
  itemsCounted?: Record<string, number>;
}
```

Enhanced `InventoryItem`:
```typescript
parByLocation?: Record<string, number>;  // Par levels per location
```

Enhanced `StatpackLog.checkEntries`:
```typescript
checkEntries?: {
  itemId: string;
  requiredQuantity: number;
  countedQuantity: number;
  ok: boolean;                        // countedQuantity >= required?
  checkedAt?: Date;
  checkedBy?: string;
}[];
```

#### 2. **Firebase Helpers** (`app/lib/inventory.ts`)

New functions:
- **`fetchContainerById(id)`** – Load sealed box details
- **`sealContainerAsBox(...)`** – Seal a container, record sealer + contents
- **`checkBoxSeal(...)`** – Verify or break seal during audit, log discrepancies
- **`logStatpackCheckOff(...)`** – Record digital check-off with per-item counts
- **`logRestockNeeded(...)`** – Log par-level alert (item below threshold)
- **`logAssetCheckIn(...)`** – Record asset status (Ready/Not Ready/Maintenance)

#### 3. **Seal-Check Modal** (`app/components/seal-check-modal.tsx`)

**Workflow:**
1. User scans box QR code (barcode starting with `BOX-` or `SEAL-`)
2. Modal loads box details (expected contents)
3. User confirms: "Is the seal intact?"
   - **YES** → Log check in 1 second, assume contents unchanged
   - **NO** → Force manual count of contents, log discrepancy
4. Stores result in `box_logs` collection

**Features:**
- Visual seal/no-seal decision
- Manual count form for broken seals
- Notes field for tampering evidence
- Logs sealer and timestamp

#### 4. **Digital Statpack Check-Off Modal** (`app/components/statpack-checkoff-modal.tsx`)

**Workflow:**
1. User opens statpack for checkout/checkin/maintenance
2. Modal displays expected contents and compartment seals
3. User **verifies each item by counting** and clicking checkbox
4. Record actual counts, seal status, O₂ readings, notes
5. Submit creates structured `statpack_logs` entry with `checkEntries`
6. **Accountability:** Tracks who checked the bag (critical for 911 ops)

**Features:**
- Per-item verification with checkboxes
- Tracks required vs actual counts
- Visual alerts for mismatches (⚠ = items missing)
- Compartment seal verification
- O₂ PSI readings
- Mandatory verification before completing check-out

#### 5. **Mobile Audit Client Integration** (`app/mobile/audit-client.tsx`)

**Added:**
- `SealCheckModal` import and integration
- Barcode scan detection for sealed box codes (`BOX-`, `SEAL-` prefixes)
- Automatic routing to seal-check flow when box barcode detected
- State management for seal-check mode

**Usage:**
```
Scan → Is it a box? → Open seal check → Yes/No → Log result
```

#### 6. **Mobile Checkout Integration** (`app/mobile/checkout/mobile-checkout-client.tsx`)

**Added:**
- `StatpackCheckOffModal` component
- Button to open check-off before final submission
- "Digital Check-Off & Complete" button replaces "Complete Checkout"
- Modal integration that chains check-off → `handleFinish()`

**Behavior:**
- All items must be verified before closing modal
- Check-off data automatically saved to `statpack_logs` with `checkEntries`
- User name/ID recorded for accountability

#### 7. **Restock Alert Modal** (`app/components/restock-alert-modal.tsx`)

**Workflow:**
1. User notices item is below par level (or manually triggers restock)
2. Modal prompts to confirm current count
3. Optionally select location
4. Submit creates alert in `inventory_alerts` collection
5. Admin/quartermaster reviews and acts on alerts

**Features:**
- Confirms item name + current count
- Optional location selection
- Tracks reporter (user ID + name)
- Timestamp for follow-up

---

## Integration Guide

### For Quick-Count / Mobile Workflows

To add **"Restock Needed" button** in mobile quick-count or audit clients:

```typescript
import RestockAlertModal from '@/app/components/restock-alert-modal';

// In component state:
const { isOpen: isRestockOpen, onOpen: openRestock, onOpenChange: onRestockChange } = useDisclosure();
const [restockItem, setRestockItem] = useState<any>(null);

// Trigger modal:
<Button onPress={() => {
  setRestockItem(item);
  openRestock();
}}>
  🔴 Report Restock Needed
</Button>

// Render modal:
{restockItem && (
  <RestockAlertModal
    isOpen={isRestockOpen}
    onOpenChange={onRestockChange}
    itemId={restockItem.id}
    itemName={restockItem.name}
    currentQuantity={restockItem.totalStockQuantity}
    parLevel={restockItem.reorderThreshold || restockItem.parByLocation?.['HQ'] || 5}
    userId={user?.uid || 'unknown'}
    userName={user?.displayName || 'Unknown'}
    onComplete={() => alert('Restock alert logged')}
  />
)}
```

### For Inventory Page

To add **"Restock Needed" button** in inventory list (`app/inventory/page.tsx`):

1. Import the modal:
   ```typescript
   import RestockAlertModal from '@/app/components/restock-alert-modal';
   ```

2. Add state near `selectedItem`:
   ```typescript
   const { isOpen: isRestockOpen, onOpen: openRestock, onOpenChange: onRestockChange } = useDisclosure();
   const [restockItem, setRestockItem] = useState<InventoryItem | null>(null);
   ```

3. Find the inventory item card render (around line ~1305) and add button:
   ```typescript
   <Button
     size="sm"
     color="warning"
     variant="flat"
     onPress={() => {
       setRestockItem(item);
       openRestock();
     }}
   >
     🔴 Restock Needed
   </Button>
   ```

4. Before the closing modals, add:
   ```typescript
   {restockItem && (
     <RestockAlertModal
       isOpen={isRestockOpen}
       onOpenChange={onRestockChange}
       itemId={restockItem.id}
       itemName={restockItem.name}
       currentQuantity={restockItem.totalStockQuantity}
       parLevel={restockItem.reorderThreshold || 5}
       userId={user?.uid || 'unknown'}
       userName={user?.displayName || 'Unknown'}
       onComplete={() => setRestockItem(null)}
     />
   )}
   ```

---

## Firestore Collections & Queries

### New Collections

**`boxes`** (or reuse `containers` with `isBox: true`)
- Stores sealed box metadata + contents snapshot
- Query: `where('isSealed', '==', true)` for active seals

**`box_logs`**
- Audit trail: seal, unseal, break, count actions
- Query: `orderBy('timestamp', 'desc')` for recent actions

**`inventory_alerts`** (extended)
- Alerts for low stock, expiration, restock needed
- Query: `where('alertType', '==', 'restock_needed')` and `where('resolved', '==', false)`

**`statpack_logs`** (extended)
- Already exists; now includes `checkEntries` for digital check-off
- Supports accountability queries: "Who checked this bag last?"

### Example Queries

**Find all unresolved restock alerts:**
```typescript
const alerts = await getDocs(query(
  collection(db, 'inventory_alerts'),
  where('alertType', '==', 'restock_needed'),
  where('resolved', '==', false),
  orderBy('timestamp', 'desc')
));
```

**Audit who checked a statpack:**
```typescript
const logs = await getDocs(query(
  collection(db, 'statpack_logs'),
  where('statpackId', '==', packId),
  orderBy('timestamp', 'desc'),
  limit(5)
));
```

**Find sealed boxes with broken seals:**
```typescript
const broken = await getDocs(query(
  collection(db, 'box_logs'),
  where('action', '==', 'break_seal'),
  where('sealIntact', '==', false),
  orderBy('timestamp', 'desc')
));
```

---

## Security & Permissions (Client-Side)

The current implementation is **client-side only**. For production, add Firestore security rules:

```firestore
// Restrict seal/unseal to authorized roles (admin, quartermaster, FTO)
match /containers/{containerDoc} {
  allow read: if request.auth != null;
  allow write: if request.auth != null && 
    get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role in ['admin', 'quartermaster', 'FTO'];
}

match /box_logs/{logDoc} {
  allow read: if request.auth != null;
  allow create: if request.auth != null;
  allow update, delete: if false;  // Immutable audit log
}

match /inventory_alerts/{alertDoc} {
  allow read, create: if request.auth != null;
  allow update: if request.auth != null && 
    (resource.data.resolved == false || request.resource.data.resolved == true);
}
```

---

## Student Accountability Features

### 1. Sealed Boxes
- ✅ Reduces labor: scan → 1-second verify instead of manual count
- ✅ Prevents loss: if seal is broken, investigation required
- ✅ Audit trail: `box_logs` tracks every seal event

### 2. Asset Tracking
- ✅ Status field: Ready | Not Ready | Maintenance
- ✅ Check-in/check-out logs per asset
- ✅ Serial-based tracking for high-value items (radios, AEDs)

### 3. Digital Check-Off
- ✅ Per-item verification: student counts contents
- ✅ Accountability: name + timestamp logged
- ✅ Audit ready: can query who last checked a bag
- ✅ Gamification: "You are responsible for the accuracy"

### 4. Par Levels & Restock
- ✅ Low stock alerts: "Item below par" → restock button
- ✅ Reporter tracked: admin knows who reported low stock
- ✅ Optional locations: restock for specific rooms/shelves

---

## Next Steps for Full Deployment

1. **Security Rules** – Implement Firestore rules above for role-based access
2. **Admin Dashboard** – Create view to review restock alerts and broken seals
3. **Mobile Check-In** – Integrate check-off modal into mobile-checkin-client.tsx (similar to checkout)
4. **Cloud Functions** (optional) – Enforce state transitions server-side (e.g., prevent unsealing without log)
5. **Migration** – Populate existing `containers` with `isBox: false` to avoid breaking existing queries
6. **Analytics** – Track which students report restock frequently, which assets need maintenance

---

## Testing Checklist

- [ ] Scan box barcode → modal appears → seal check works
- [ ] Break seal → manual count form appears → count logged
- [ ] Statpack checkout → digital check-off modal → all items verified → can complete
- [ ] Inventory page → click "Restock Needed" → alert logged
- [ ] Query `box_logs` → see sealed/unsealed/broken actions
- [ ] Query `statpack_logs.checkEntries` → verify per-item counts recorded
- [ ] Query `inventory_alerts` → see restock needed entries
- [ ] Mobile audit → scan BOX-123 → seal-check appears

---

## Files Changed

| File | Change | Status |
|------|--------|--------|
| `app/types.ts` | Added `Container.isBox`, `BoxLog`, enhanced `StatpackLog` | ✅ Done |
| `app/lib/inventory.ts` | Added seal, asset, restock, check-off helpers | ✅ Done |
| `app/components/seal-check-modal.tsx` | New component | ✅ Done |
| `app/components/statpack-checkoff-modal.tsx` | New component | ✅ Done |
| `app/components/restock-alert-modal.tsx` | New component | ✅ Done |
| `app/mobile/audit-client.tsx` | Added seal-check integration | ✅ Done |
| `app/mobile/checkout/mobile-checkout-client.tsx` | Added check-off modal, button | ✅ Done |
| `app/inventory/page.tsx` | TODO: Add restock button to item cards | ⏳ Manual |
| `app/mobile/checkin/mobile-checkin-client.tsx` | TODO: Add check-off modal (optional) | ⏳ Manual |

---

## Environment & Dependencies

**No new packages required** – uses existing HeroUI, Firebase, React.

**Firebase collections required:**
- `containers` (extend with `isBox` field)
- `box_logs` (new)
- `inventory_alerts` (extend with `alertType`)
- `statpack_logs` (extend with `checkEntries`)

---

## Questions & Support

For questions about this implementation:
1. Check Firestore document structure against types in `app/types.ts`
2. Verify role-based access (user.role must be 'admin', 'quartermaster', 'FTO', or 'member')
3. Test seal-check modal with sample box (barcode: `BOX-TEST-001`)
4. Review audit logs in Firebase console under `box_logs` collection

---

**Prepared:** January 23, 2026  
**For:** BMRC Student Capacity Inventory System
