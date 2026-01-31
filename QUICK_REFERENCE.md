# Quick Reference: Falck Student Workflow Components

## 🎯 Three Core Features

### 1️⃣ Sealed Box Inventory
**File:** `seal-check-modal.tsx`  
**Trigger:** Scan barcode starting with `BOX-` or `SEAL-`  
**Result:** 1-second seal verification or manual count on break

```typescript
// In any audit/inventory client:
import SealCheckModal from '@/app/components/seal-check-modal';

<SealCheckModal
  isOpen={isOpen}
  onOpenChange={onOpenChange}
  boxBarcode={scannedCode}
  onSealCheckComplete={(sealIntact) => {
    // true = intact, false = broken
  }}
/>
```

### 2️⃣ Digital Statpack Check-Off
**File:** `statpack-checkoff-modal.tsx`  
**Trigger:** User clicks "Digital Check-Off" during checkout  
**Result:** Per-item count + seal verification logged with accountability

```typescript
// In mobile checkout client:
import StatpackCheckOffModal from '@/app/components/statpack-checkoff-modal';

<StatpackCheckOffModal
  isOpen={isCheckOffOpen}
  onOpenChange={onCheckOffChange}
  statpack={pack}
  action="checkout"
  userId={user.uid}
  userName={user.displayName}
  onCheckOffComplete={() => {
    // Proceed with final submission
    handleFinish();
  }}
/>
```

### 3️⃣ Restock Needed Alert
**File:** `restock-alert-modal.tsx`  
**Trigger:** User clicks "Report Restock" button  
**Result:** Alert logged to inventory_alerts for admin review

```typescript
// In inventory page or mobile quick-count:
import RestockAlertModal from '@/app/components/restock-alert-modal';

<RestockAlertModal
  isOpen={isOpen}
  onOpenChange={onOpenChange}
  itemId={item.id}
  itemName={item.name}
  currentQuantity={item.totalStockQuantity}
  parLevel={item.reorderThreshold}
  userId={user.uid}
  userName={user.displayName}
/>
```

---

## 📡 Helper Functions

**File:** `app/lib/inventory.ts`

### Seal Operations
```typescript
// Seal a container
await sealContainerAsBox({
  containerId: 'container-123',
  sealNumber: 'SEAL-001',
  sealedBy: user.uid,
  sealedByName: 'John Doe',
  boxContents: [
    { itemId: 'item-1', batchId: 'batch-1', quantity: 50 }
  ]
});

// Check seal during inventory
await checkBoxSeal({
  containerId: 'container-123',
  userId: user.uid,
  userName: 'Jane Doe',
  sealIntact: true, // or false
  itemsCounted: { 'item-1': 50 },
  notes: 'Seal verified intact'
});
```

### Digital Check-Off
```typescript
// Log statpack check-off
await logStatpackCheckOff({
  statpackId: 'pack-1',
  statpackName: 'Primary Kit A',
  action: 'checkout', // or 'checkin' or 'maintenance'
  userId: user.uid,
  userName: user.displayName,
  checkEntries: [
    {
      itemId: 'item-1',
      requiredQuantity: 5,
      countedQuantity: 5,
      ok: true
    }
  ],
  sealChecks: { 'compartment-1': { sealed: true } }
});
```

### Par Levels & Restock
```typescript
// Log restock alert
await logRestockNeeded({
  itemId: 'item-1',
  itemName: 'Trauma Dressing',
  currentQuantity: 3,
  parLevel: 10,
  location: 'Back Room',
  userId: user.uid,
  userName: user.displayName
});

// Log asset check-in
await logAssetCheckIn({
  itemId: 'radio-1',
  itemName: 'Radio - Unit A',
  serialNumber: 'RADIO-001',
  newStatus: 'Ready',
  userId: user.uid,
  userName: user.displayName,
  notes: 'Battery replaced'
});
```

---

## 🗂️ Type Definitions

### Container (Extended)
```typescript
interface Container {
  // ... existing fields
  isBox?: boolean;
  isSealed?: boolean;
  sealNumber?: string;
  sealedAt?: Date;
  sealedBy?: string;
  sealedByName?: string;
  boxContents?: {
    itemId: string;
    batchId: string;
    quantity: number;
    serialNumber?: string;
  }[];
}
```

### BoxLog (New)
```typescript
interface BoxLog {
  boxId: string;
  action: 'sealed' | 'unsealed' | 'inventory_check' | 'break_seal';
  userId: string;
  timestamp: Date;
  sealIntact?: boolean;
  itemsCounted?: Record<string, number>;
  notes?: string;
}
```

### StatpackLog.checkEntries (New)
```typescript
checkEntries?: {
  itemId: string;
  itemName?: string;
  requiredQuantity: number;
  countedQuantity: number;
  ok: boolean; // countedQuantity >= required?
  serialNumber?: string;
  notes?: string;
  checkedAt?: Date;
  checkedBy?: string;
}[];
```

---

## 🔍 Firebase Queries

### Find sealed boxes
```typescript
const sealed = await getDocs(query(
  collection(db, 'containers'),
  where('isSealed', '==', true)
));
```

### View seal audit trail
```typescript
const logs = await getDocs(query(
  collection(db, 'box_logs'),
  where('boxId', '==', boxId),
  orderBy('timestamp', 'desc')
));
```

### Find restock alerts
```typescript
const alerts = await getDocs(query(
  collection(db, 'inventory_alerts'),
  where('alertType', '==', 'restock_needed'),
  where('resolved', '==', false)
));
```

### Who checked a statpack?
```typescript
const checkOffs = await getDocs(query(
  collection(db, 'statpack_logs'),
  where('statpackId', '==', packId),
  where('action', '==', 'checkout'),
  orderBy('timestamp', 'desc')
));
// checkOffs[0].checkEntries shows per-item verification
```

---

## 🧪 Integration Checklist

- [ ] Import components in relevant pages/clients
- [ ] Add button/trigger points (restock button in inventory.page.tsx)
- [ ] Pass user data (user.uid, user.displayName)
- [ ] Test barcode scanning for sealed boxes
- [ ] Verify Firestore writes (check collections in console)
- [ ] Review logs: box_logs, statpack_logs.checkEntries, inventory_alerts
- [ ] Add Firestore rules for role-based access (security)

---

## ⚡ Key Design Decisions

✅ **Client-side implementation** – No Cloud Functions needed; roles checked via user.role field  
✅ **Reuse containers collection** – No new tables; just add `isBox` flag  
✅ **Immutable audit logs** – box_logs can be created but not edited  
✅ **Structured check-offs** – checkEntries[] for per-item accountability  
✅ **Par levels optional** – Can use reorderThreshold or parByLocation  

---

## 📞 Support

- **Seal check not triggering?** Make sure barcode starts with `BOX-` or `SEAL-`
- **Check-off not logging?** Verify user.uid and user.displayName are set
- **Restock button missing?** Add import + state + button manually to inventory.page.tsx
- **Queries returning empty?** Check Firestore console for collection structure

---

**Version:** 1.0  
**Last Updated:** January 23, 2026
