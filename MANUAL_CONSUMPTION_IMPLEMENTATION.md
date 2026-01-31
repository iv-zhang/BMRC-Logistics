# Manual Consumption Migration — Implementation Summary

## Status: ✅ COMPLETE

Implementation of Option A (manual consumption migration) is complete. All code changes have been applied, tested, and documented.

## What Changed

### 1. Core Helpers ([app/lib/inventory.ts](app/lib/inventory.ts))
- ✅ **`determineIsAsset(item)`** — Centralized asset classification using `ASSET_VALUE_THRESHOLD` and `ASSET_CATEGORIES`
- ✅ **`createOpenBatch(itemId, quantity, opts)`** — Creates an open batch record with audit logging
- ✅ **`consumeBox(itemId, boxCount, opts)`** — Atomically decrements `unopenedBoxes` and creates/updates open batch

### 2. UI Components
- ✅ **[app/components/consume-box-modal.tsx](app/components/consume-box-modal.tsx)** (NEW) — Manual "Consume Box" workflow
  - Select target batch or create new open batch
  - Shows preview of unopenedBoxes change
  - Validates sufficient inventory before consuming
  - Creates audit logs in `inventory_logs`

- ✅ **[app/inventory/page.tsx](app/inventory/page.tsx)** — Added "Consume Box" button
  - Appears for back-room items with `unopenedBoxes > 0`
  - Opens consume modal on click
  - Positioned next to "Restock Forward" button

- ✅ **[app/components/statpack-checkoff-modal.tsx](app/components/statpack-checkoff-modal.tsx)** — Updated to audit-only
  - Added contextual help banner explaining manual consumption workflow
  - Admins see guidance to use "Consume Box" in inventory page
  - No automatic inventory mutations

### 3. Migration Script
- ✅ **[scripts/migrate-open-to-open-batches.js](scripts/migrate-open-to-open-batches.js)** (NEW)
  - Dry-run and force modes
  - Converts existing open/unreconciled counts into explicit open batches
  - Writes audit logs to `inventory_migrations` and `inventory_logs`
  - Skips assets and serialized items
  - Batch processing with progress indicators

- ✅ **[scripts/test-migration-scenarios.js](scripts/test-migration-scenarios.js)** (NEW)
  - Test harness with 7 scenarios
  - Validates migration logic against fixture data
  - All tests passing ✅

### 4. Documentation
- ✅ **[BOX_MIGRATION_README.md](BOX_MIGRATION_README.md)** — Updated with:
  - Open-batch migration section (Option A)
  - Before/after document examples
  - Dry-run output examples
  - Rollback plan
  - Disposables vs Assets policy
  - Firestore collections reference

## Key Concepts

### Disposables (everything not an asset)
- **Tracked as**: Unopened boxes in back room (`unopenedBoxes`)
- **When opened**: Quartermaster uses "Consume Box" button → decrements `unopenedBoxes`, creates/updates `open batch`
- **Expiration**: Only matters while in sealed boxes; once opened, members discard expired items and request refill
- **Location**: Back room (sealed) → Forward staging (open batches)

### Assets (high-value items)
- **Tracked as**: Individual serialized items with full lifecycle
- **Examples**: AEDs, radios, oxygen tanks, generators, monitors, items > $500
- **Classification**: Automatic via `determineIsAsset()` using `ASSET_VALUE_THRESHOLD` (500 USD) and `ASSET_CATEGORIES`
- **Fields**: `status`, `maintenanceReason`, `location`, `history`, `padExpiration`, `batteryExpiration`, etc.

### Statpacks
- **Contain both**: Disposables and assets
- **Check-off**: Audit-only (creates `statpack_logs`, does not mutate inventory)
- **Restocking**: Members use "Consume Box" in Master Inventory when removing items from sealed boxes

## Migration Workflow

### Step 1: Test Migration Logic
```bash
node scripts/test-migration-scenarios.js
```
Expected output: ✅ All tests passed!

### Step 2: Dry Run
```bash
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/serviceAccountKey.json"
node scripts/migrate-open-to-open-batches.js --dry-run
```
Review output table showing items to migrate.

### Step 3: Apply Migration
```bash
node scripts/migrate-open-to-open-batches.js --force --userId=admin-uid
```
Confirm when prompted.

### Step 4: Verify
- Check `inventory_migrations` collection for audit records
- Spot-check a few inventory items to confirm open batches created
- Test "Consume Box" button in inventory page

## Usage (Post-Migration)

### For Quartermasters
1. Navigate to **Inventory** → filter by **Back Room**
2. Find item with `unopenedBoxes > 0`
3. Click **"Consume Box"** button
4. Choose:
   - Create new open batch (default)
   - Add to existing open batch
5. Set number of boxes to open (defaults to 1)
6. Confirm → system decrements `unopenedBoxes` and creates/updates open batch

### For Members (Statpack Check-Off)
1. Navigate to **Statpacks** → select statpack → **Check-In/Check-Out**
2. Complete digital check-off (count items, mark OK/issues)
3. Submit → creates audit log only (does NOT consume inventory)
4. If items needed from sealed boxes → request quartermaster to "Consume Box"

### For Admins (Monitoring)
- **inventory_logs** — View all consume/open-batch operations
- **inventory_migrations** — View migration audit trail
- **statpack_logs** — View statpack check-off history

## Files Changed

### New Files
- [app/components/consume-box-modal.tsx](app/components/consume-box-modal.tsx)
- [scripts/migrate-open-to-open-batches.js](scripts/migrate-open-to-open-batches.js)
- [scripts/test-migration-scenarios.js](scripts/test-migration-scenarios.js)

### Modified Files
- [app/lib/inventory.ts](app/lib/inventory.ts) — Added `determineIsAsset`, `createOpenBatch`, `consumeBox`
- [app/inventory/page.tsx](app/inventory/page.tsx) — Added "Consume Box" button and modal integration
- [app/components/statpack-checkoff-modal.tsx](app/components/statpack-checkoff-modal.tsx) — Added contextual help banner
- [BOX_MIGRATION_README.md](BOX_MIGRATION_README.md) — Updated with open-batch migration section

## Next Steps (Optional)

1. **Run migration** — Execute dry-run and force modes on production data
2. **Train users** — Show quartermasters how to use "Consume Box" workflow
3. **Monitor logs** — Check `inventory_logs` and `inventory_migrations` collections for anomalies
4. **Iterate** — Gather feedback and refine UI/UX as needed

## Rollback Plan

If issues arise:
1. Query `inventory_migrations` collection
2. For each migration record, remove the created batch by `createdBatchId`
3. Optionally restore `before` state from migration record

See [BOX_MIGRATION_README.md](BOX_MIGRATION_README.md) for detailed rollback script example.

---

**Implementation Date**: January 30, 2026  
**Status**: Ready for production migration
