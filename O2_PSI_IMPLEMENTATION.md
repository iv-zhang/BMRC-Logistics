# O₂ PSI Tracking Implementation

## Overview

This implementation adds required oxygen tank PSI tracking during statpack checkout, with comprehensive validation, logging, and fraud detection capabilities.

## Features Implemented

### 1. Required O₂ PSI Input During Checkout

**File:** `app/components/statpack-checkoff-modal.tsx`

- **Removed admin-only restriction** - All users must now enter O₂ PSI during checkout
- **Required validation** - Checkout blocked if PSI not provided for oxygen items
- **Threshold enforcement** - Warnings shown if PSI below minimum (default 1800 PSI)
- **Type safety** - Input restricted to numbers with min/max validation

**Key Changes:**
```typescript
// Before: isAdmin && (statpack.contents || []).some(item => item.itemDetails?.isOxygen)
// After: (statpack.contents || []).some(item => item.itemDetails?.isOxygen) && action === 'checkout'

// Required validation before checkout
if (action === 'checkout') {
  const oxygenItems = (statpack.contents || []).filter(item => item.itemDetails?.isOxygen);
  const missingO2 = oxygenItems.filter(item => !oxygenReadings[item.itemId]);
  
  if (missingO2.length > 0) {
    // Block checkout
  }
}
```

### 2. Per-Entry PSI Storage in Logs

**Files:** 
- `app/components/statpack-checkoff-modal.tsx` (data collection)
- `app/lib/inventory.ts` (persistence)

O₂ PSI readings are now stored in `checkEntries[].assetCheckResult.oxygenPsi` instead of only in the top-level `issues.oxygenReadings` object.

**Schema:**
```typescript
checkEntries: [{
  itemId: string;
  itemName: string;
  // ...
  assetCheckResult: {
    oxygenPsi: number;        // ← New: PSI reading stored here
    batteryPct?: number;
    padsSealed?: boolean;
  };
}]
```

This enables:
- Per-asset historical tracking
- Trend analysis over time
- Forgery detection algorithms

### 3. Enhanced Log Display with Warnings

**Files:**
- `app/components/log-detail-modal.tsx` - Detail view
- `app/components/statpack-log-history.tsx` - List view

**Detail View:**
- O₂ PSI shown as warning-colored Chip if below 1800
- Clear visual indicator: `⚠️ O₂: 1750 PSI`

**List View:**
- Low O₂ warning badge on checkout cards: `⚠️ Low O₂`
- Quickly identifies problematic checkouts

### 4. Validation Logic (Already Existed)

**File:** `app/lib/inventory.ts`

The verification function `verifyAssetAgainstRules` already included O₂ validation:
- Checks `requireO2PsiMin` from `AssetVerificationRules`
- Returns warnings for missing or low PSI
- Configurable per-item via `itemDetails.verificationRules.requireO2PsiMin`

## Testing

### Unit Tests

**File:** `app/lib/__tests__/o2-validation.test.ts`

Tests for `verifyAssetAgainstRules`:
- ✅ Missing O₂ PSI detection
- ✅ Low O₂ PSI warnings (below threshold)
- ✅ Good O₂ PSI (no warnings)
- ✅ Edge cases: 0 PSI, negative PSI, no rules, etc.

Run tests:
```bash
npm test app/lib/__tests__/o2-validation.test.ts
```

### Integration Tests

**File:** `app/lib/__tests__/o2-checkout-integration.test.ts`

Tests for full checkout flow:
- ✅ O₂ PSI persisted in `checkEntries[].assetCheckResult`
- ✅ Multiple O₂ tanks in one checkout
- ✅ Sanitization preserves O₂ data
- ✅ Timestamps correctly set

Run tests:
```bash
npm test app/lib/__tests__/o2-checkout-integration.test.ts
```

### Stress Tests

#### 1. Concurrent Checkout Test

**File:** `scripts/stress-test-o2-checkout.cjs`

Simulates 50 concurrent checkout attempts to verify:
- Transaction atomicity (only 1 succeeds)
- Data integrity (all O₂ readings preserved)
- No race conditions

Run:
```bash
node scripts/stress-test-o2-checkout.cjs
```

Expected output:
```
✅ ATOMICITY VERIFIED: Only 1 checkout succeeded, all others properly blocked
✅ DATA INTEGRITY VERIFIED: All O₂ readings correctly persisted
```

#### 2. Forgery Detection Test

**File:** `scripts/detect-o2-forgery.cjs`

Analyzes historical O₂ PSI data to detect:
- **Identical readings** - Copy-paste fraud (3+ identical PSI across checkouts)
- **PSI increases** - Non-physical increases (tanks don't refill themselves)
- **Implausible leaks** - Leak rates >50 PSI/hour (normal: 0.2-0.8)
- **Round number bias** - >80% round numbers (indicates estimation)

Run:
```bash
node scripts/detect-o2-forgery.cjs --days=30
node scripts/detect-o2-forgery.cjs --statpack-id=statpack-primary-1 --days=60
```

Example output:
```
🚨 CRITICAL ISSUES:
  [PSI_INCREASE] Oxygen Tank PSI increased from 1800 to 2100 (+300) without documented refill

⚠️  HIGH PRIORITY:
  [IDENTICAL_READINGS] Oxygen Tank showed identical PSI (2000) across 3+ checkouts over 12.3 hours

📊 SUMMARY BY TYPE:
  Identical readings: 2
  PSI increases: 1
  Implausible leaks: 0
  Round number bias: 3
```

#### 3. Trend Analysis Script

**File:** `scripts/analyze-o2-trends.cjs`

Performs leak rate analysis using linear regression:
- Calculates leak rate (PSI/day)
- Predicts refill dates
- Classifies leak severity (EXCELLENT/NORMAL/ELEVATED/HIGH/CRITICAL)
- Generates maintenance recommendations

Run:
```bash
node scripts/analyze-o2-trends.cjs --days=90
node scripts/analyze-o2-trends.cjs --item-id=oxygen-tank-001 --days=60
node scripts/analyze-o2-trends.cjs --export=o2-report.json
```

Example output:
```
📊 O₂ PSI TREND ANALYSIS REPORT
=======================================================================
Total tanks analyzed: 5

🚨 CRITICAL ISSUES:
  Oxygen Tank D-Cylinder (oxygen-tank-001)
    Current PSI: 1650
    Leak rate: 125.3 PSI/day
    Days until refill: 2
    🚨 IMMEDIATE ACTION: PSI below minimum threshold - refill or replace now
    🔧 CRITICAL: Abnormal leak rate detected - inspect valve and connections immediately

📅 REFILL SCHEDULE (Next 30 days):
  🚨 Oxygen Tank D-Cylinder: 2 days (2024-01-17)
  ⚠️ Spare O₂ Tank: 12 days (2024-01-27)

📈 FLEET STATISTICS:
  Average leak rate: 15.2 PSI/day
  Tanks below minimum: 1
  Tanks needing refill (30 days): 2
```

## Data Schema

### InventoryItem (Firestore: `inventory/{itemId}`)

```typescript
{
  name: string;
  isOxygen: boolean;                    // ← Flags oxygen items
  maxOxygenPsi?: number;                // ← Max capacity (e.g., 2200)
  verificationPolicy?: {
    requireO2PsiMin?: number;           // ← Minimum PSI (default: 1800)
    advisoryOnly?: boolean;
  }
}
```

### StatpackLog (Firestore: `statpack_logs/{logId}`)

```typescript
{
  statpackId: string;
  action: 'checkout' | 'checkin';
  userId: string;
  userName: string;
  timestamp: FieldValue;
  clientTimestamp: Date;
  
  checkEntries: [{
    itemId: string;
    itemName: string;
    requiredQuantity: number;
    countedQuantity: number;
    ok: boolean;
    
    assetCheckResult?: {
      oxygenPsi?: number;               // ← PSI reading stored here
      batteryPct?: number;
      padsSealed?: boolean;
    };
    
    checkedBy: string;
    checkedAt: Date;
  }];
  
  // Legacy format (still populated for backward compatibility)
  issues?: {
    oxygenReadings?: Record<string, string>;
  };
}
```

## User Workflows

### Member Checkout Workflow

1. Member initiates checkout for statpack with oxygen tank
2. Modal displays **required** O₂ PSI input field
3. Member enters PSI reading (e.g., 1950)
4. If PSI < 1800: Error shown, checkout blocked (unless admin)
5. If PSI missing: Error shown, checkout blocked
6. If PSI valid: Checkout proceeds, PSI saved to log

### Admin Log Review Workflow

1. Admin navigates to statpack logs
2. Log list shows `⚠️ Low O₂` badge on checkouts with PSI < 1800
3. Admin clicks log to view details
4. Detail view shows O₂ PSI with color-coded chip
5. Admin can run forgery detection script to identify suspicious patterns

### Admin Trend Analysis Workflow

1. Admin runs: `node scripts/analyze-o2-trends.cjs --days=90`
2. Script generates report with:
   - Tanks with critical/high leak rates
   - Predicted refill dates
   - Maintenance recommendations
3. Admin schedules refills and inspections based on report

## Configuration

### Setting O₂ Requirements per Item

Edit inventory item in Firestore:
```typescript
// inventory/oxygen-tank-001
{
  name: "Oxygen Tank D-Cylinder",
  isOxygen: true,
  maxOxygenPsi: 2200,
  verificationPolicy: {
    requireO2PsiMin: 1800,    // Minimum PSI required
    advisoryOnly: false        // If true, warnings are shown but not blocking
  }
}
```

### Adjusting Thresholds

Default thresholds in code:
- **Minimum PSI**: 1800 (configured per item)
- **Low PSI warning**: Any reading below `requireO2PsiMin`
- **Normal leak rate**: 0.2-0.8 PSI/hour (5-20 PSI/day)
- **High leak rate**: >50 PSI/hour
- **Round number bias**: >80% round numbers is suspicious

## Known Limitations

1. **No max PSI validation** - Currently doesn't warn on overpressure (e.g., 5000 PSI)
2. **Advisory mode not fully implemented** - `advisoryOnly: true` still generates warnings
3. **Refill events not tracked** - System assumes tanks leak continuously; no way to log refills
4. **Single O₂ type per item** - Can't distinguish between different O₂ cylinder sizes in same statpack

## Future Enhancements

1. **Refill logging** - Add "Refill O₂ Tank" action to record when tanks are refilled
2. **Max PSI validation** - Warn on overpressure readings
3. **Tank swap tracking** - Track when O₂ tanks are swapped between statpacks
4. **Automated alerts** - Email/SMS alerts for critical leak rates or low PSI
5. **Mobile barcode scanning** - Scan O₂ tank barcode to auto-populate PSI gauge reading
6. **Historical charts** - Visual graphs of O₂ PSI trends over time
7. **ML-based forgery detection** - Train model to detect subtle BS patterns

## Migration Notes

### Backward Compatibility

This implementation is **backward compatible**:
- Old logs without `checkEntries[].assetCheckResult.oxygenPsi` still display correctly
- Legacy `issues.oxygenReadings` format still populated (for redundancy)
- No database migration required

### Rollout Strategy

1. **Phase 1: Soft launch** (set `advisoryOnly: true`)
   - Users see O₂ input but can skip
   - Collect initial data
   
2. **Phase 2: Required enforcement** (set `advisoryOnly: false`)
   - O₂ PSI becomes mandatory
   - Monitor for user complaints
   
3. **Phase 3: Analytics rollout**
   - Run forgery detection weekly
   - Share trend reports with team

## Troubleshooting

### Issue: O₂ input not showing for member

**Check:**
- Is `itemDetails.isOxygen = true` in Firestore?
- Is action `'checkout'` (not checkin/maintenance)?
- Check browser console for errors

### Issue: Checkout blocked despite valid PSI

**Check:**
- Is PSI ≥ `requireO2PsiMin` threshold?
- Is user role `'member'` (admins can override)?
- Check validation logic in `statpack-checkoff-modal.tsx`

### Issue: Forgery detection script returns no data

**Check:**
- Are there recent checkout logs in `statpack_logs` collection?
- Do logs have `checkEntries[].assetCheckResult.oxygenPsi`?
- Adjust `--days` parameter to look further back

## Support

For questions or issues:
1. Check this documentation
2. Review test files for usage examples
3. Inspect Firestore data structure
4. Contact development team

---

**Implementation Date:** January 2025  
**Version:** 1.0  
**Status:** ✅ Complete and tested
