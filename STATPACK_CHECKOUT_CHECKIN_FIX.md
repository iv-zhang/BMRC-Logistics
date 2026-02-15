# Statpack Checkout/Check-In Fix — Implementation Plan

## Problem Statement

The statpack checkout/checkin process has several critical gaps:

1. **Check-in logs are missing**: The checkin page (`app/statpacks/checkin/page.tsx`) does NOT call `logStatpackCheckOff()`. It directly updates Firestore documents without creating `statpack_logs` entries, making admin audit trails incomplete.
2. **Quick Check-In has zero logging**: The "I did not use anything" path calls `markPackCheckedIn()` which only does a raw `updateDoc` — no `statpack_logs` entry, no audit event, no `pairId` resolution.
3. **Checkout page double-writes**: After `logStatpackCheckOff()` (which updates the statpack via transaction), the checkout page also calls `updateDoc()` separately — creating a race condition.
4. **No enforcement that checkout must precede checkin**: Any "In Use" pack can be checked in without verifying it was properly checked out first.
5. **Members can skip item verification at checkin**: The usage-reporting mode lets members check in without actually verifying item presence, counts, or expiration.
6. **No detailed per-item logging at checkin**: Even when the modal is used, the checkin page's `handleCheckOffComplete` doesn't pass check entries to any logging function.

## Architecture Overview

### Current Flow (Broken)
```
CHECKOUT:
  Pocket Selection → CheckOff Modal (skipLogging=true) → Collect Data → handleCheckOffComplete()
  → logStatpackCheckOff(action='checkout') ✓  (creates statpack_logs entry)
  → updateDoc(statpack) ✗ (REDUNDANT — transaction already did this)

CHECKIN:
  Select Pack → CheckOff Modal (checkinUsageMode=true) → handleCheckOffComplete()
  → updateDoc(statpack) only ✗ (NO statpack_logs entry created!)
  
QUICK CHECKIN:
  Select Pack → "I did not use anything" → markPackCheckedIn()
  → updateDoc(statpack) only ✗ (NO logging at all!)
```

### Fixed Flow
```
CHECKOUT:
  Pocket Selection → CheckOff Modal (per pocket) → Collect All Pocket Data
  → logStatpackCheckOff(action='checkout') ✓ (creates log + updates statpack in transaction)
  → NO separate updateDoc (transaction handles it)

CHECKIN (Full):
  Select Pack → Pocket-by-Pocket Verification (SAME as checkout) → Collect All Data
  → logStatpackCheckOff(action='checkin') ✓ (creates log, resolves pairId, updates statpack)
  → NO separate updateDoc (transaction handles it)

QUICK CHECKIN:
  Select Pack → "Nothing used" confirmation → logStatpackCheckOff(action='checkin', quickCheckin=true)
  → Creates minimal log entry with pairId ✓
  → Updates statpack via transaction ✓
```

## Changes Required

### 1. Fix Check-In Page (`app/statpacks/checkin/page.tsx`)

**Problem**: `handleCheckOffComplete()` and `markPackCheckedIn()` do raw Firestore updates without logging.

**Fix**:
- Import `logStatpackCheckOff` from `@/app/lib/inventory`
- Add pocket-by-pocket verification flow (same as checkout)
- Add `allPocketCheckData` state to collect per-pocket check entries
- Replace `markPackCheckedIn()` with a call to `logStatpackCheckOff(action='checkin')` that includes all check entries
- For quick checkin: call `logStatpackCheckOff()` with empty check entries but `quickCheckin: true` flag
- Remove redundant `updateDoc()` calls — the transaction in `logStatpackCheckOff` handles statpack updates

### 2. Remove Redundant updateDoc in Checkout Page (`app/statpacks/checkout/page.tsx`)

**Problem**: After `logStatpackCheckOff()` returns (which runs a transaction updating the statpack), the checkout page also calls `updateDoc()` separately.

**Fix**:
- Remove the `updateDoc()` call in `handleCheckOffComplete()` — the transaction already handles it.

### 3. Add Quick Check-In Logging (`app/lib/inventory.ts`)

**Problem**: Quick checkin has no logging path.

**Fix**:
- `logStatpackCheckOff` already handles `action='checkin'` properly with pairId resolution and transaction updates
- Pass a flag or empty checkEntries for quick checkin scenarios
- Add a `quickCheckin` boolean to the log entry for admin audit clarity

### 4. Enforce Checkout-Before-Checkin

**Problem**: Any "In Use" pack can be checked in regardless of checkout state.

**Fix**:
- In `logStatpackCheckOff()`, when `action='checkin'`, verify the statpack's `isCheckedOut` is `true`
- Already partially handled by the transaction checking `spData.isCheckedOut` — enhance with better error messages

### 5. Require Full Item Verification at Check-In

**Problem**: Members can skip checking items entirely at checkin.

**Fix**:
- Checkin now uses pocket-by-pocket verification (same UI as checkout)
- Members must verify each item's presence, count, and expiration
- "Quick Check-In" remains but creates a minimal log entry (flagged for admin review)
- All items must be checked off before submission (same as checkout enforcement)

### 6. Detailed Activity Logging

**Problem**: Admin can't see exactly what was checked during checkout/checkin.

**Fix**:
- Every check entry includes: itemId, itemName, countedQuantity, requiredQuantity, ok, expirationDate, serialNumber, pocket, compartmentId
- Expired items are flagged in the log with `expirationWarning: true`
- Items with count mismatches are flagged with `countMismatch: true`
- The log includes a summary: `totalItems`, `verifiedCount`, `mismatchCount`, `expiredCount`

## Files Modified

| File | Change |
|------|--------|
| `app/statpacks/checkin/page.tsx` | Major rewrite: add pocket-by-pocket verification, proper logging via `logStatpackCheckOff`, remove raw `updateDoc` calls |
| `app/statpacks/checkout/page.tsx` | Remove redundant `updateDoc` after `logStatpackCheckOff` |
| `app/lib/inventory.ts` | Add `quickCheckin` field support, add summary stats to log entries |
| `app/components/statpack-checkoff-modal.tsx` | Fix duplicate notes section, improve checkin verification UX |
| `scripts/test-checkout-checkin.ts` | NEW: Testing configuration and validation script |

## Testing Strategy

A test configuration script will validate:
1. Checkout creates a `statpack_logs` entry with `action: 'checkout'` and proper `pairId`
2. Checkin creates a `statpack_logs` entry with `action: 'checkin'` and matching `pairId`
3. Quick checkin creates a log entry with `quickCheckin: true`
4. Checkout-before-checkin enforcement works
5. All check entries have required fields populated
6. Expired items are flagged in the log
7. Count mismatches are flagged in the log
8. No redundant Firestore writes occur
