# Mobile Audit Testing Guide

## Quick Start

### Access Mobile Audit
1. **From navbar**: Mobile menu → Audit
2. **From audit page**: Click "Mobile Audit" button in header
3. **Direct URL**: `/mobile/audit`

## Test Scenarios

### Scenario 1: Basic Item Audit
1. Navigate to `/mobile/audit`
2. You should see:
   - Progress bar at top
   - Current item with system count
   - CountControl (+/− buttons)
   - ConditionToggle (Good/Damaged/Expired)
   - Notes textarea
   - Scan button
   - Navigation arrows (Previous/Next)

**Expected**: All controls render and respond to touch

### Scenario 2: Count Adjustment
1. Use CountControl to adjust count:
   - Tap − button (should decrement)
   - Tap + button (should increment)
   - Tap preset buttons (+1, +5, +10)
   - Type directly in the number field
2. Navigate to next item
3. Return to previous item

**Expected**: Count persists when navigating

### Scenario 3: Barcode Scan
1. Tap "Scan Barcode" button
2. A modal should open with camera/file upload
3. Scan a GS1 barcode (if available) or upload an image
4. Modal should close and fields should populate

**Expected**: Barcode data auto-fills lot/expiration fields

### Scenario 4: Condition Tracking
1. Cycle through conditions (Good → Damaged → Expired)
2. Notice color changes (green → yellow → red)
3. Navigate to next item

**Expected**: Condition persists, color feedback is clear

### Scenario 5: Add Found Item
1. Tap "Add Found Item" button
2. Fill in minimal info:
   - Item name
   - Quantity
   - Category (optional)
   - Location (optional)
3. Tap "Submit" or use form submission

**Expected**: Modal closes, item added to inventory

### Scenario 6: Submit All Items
1. Work through several items
2. Tap "Submit Audit" button
3. Confirmation modal appears showing item count
4. Tap "Submit"

**Expected**: 
- All items update in Firestore
- `auditVerified: true` flag set
- `auditCondition` recorded
- Audit events created
- Router redirects to `/audit`

### Scenario 7: Data Persistence (Atomicity)
1. Open browser DevTools → Network tab
2. Slow down network (3G simulation)
3. Submit audit and observe:
   - Single batch commit request
   - Inventory updates + audit events in one operation
   - No partial updates

**Expected**: All-or-nothing batch semantics

### Scenario 8: Mobile Responsiveness
1. Test on actual mobile device (or DevTools mobile mode):
   - Portrait orientation
   - Landscape orientation
   - Different screen sizes
2. Verify:
   - Buttons are easily tappable (56px minimum)
   - No horizontal scrolling
   - Text is readable

**Expected**: Fully mobile-optimized layout

## Regression Testing

### Desktop Audit (Stack Mode)
1. Navigate to `/audit`
2. Click "Zero-Out" to start audit
3. Select a zone and enter stack audit mode
4. Verify:
   - CountControl renders correctly
   - ConditionToggle colors work
   - Navigation works
   - Submit batches correctly

### Barcode Scanning
1. Test BarcodeScanner across components:
   - Mobile audit
   - Stack audit
   - Quick-count (if applicable)
2. Verify:
   - Native BarcodeDetector works (Chrome/Android)
   - ZXing fallback works (iOS Safari)
   - Image upload fallback works

## Firestore Verification

### After Audit Submission
Check Firestore collections:

**`inventory` collection:**
- Items should have `auditVerified: true`
- `auditCondition` set to selected value
- `auditNotes` populated with notes
- `isAuditRequired: false`
- `updatedAt` timestamp recent

**`auditEvents` collection:**
- New events with `eventType: 'audit_item_verified'`
- `source: 'mobile_audit'`
- `actor` info present
- `targets` and `after` populated

**`inventory_logs` collection:**
- Log entries for each audited item
- Action: `'audit_count_update'`
- Notes describe the audit

## Performance Checks

1. **Load Time**: Mobile audit page should load in < 2s
2. **Interaction Latency**: Buttons should respond immediately
3. **Batch Commit**: 50+ items should commit in < 5s
4. **Navigation**: Next/Previous should be instant

## Known Limitations

- Offline support: Not yet implemented (future enhancement)
- Batch size: Currently no limit (consider 100-item chunks for very large audits)
- Resume functionality: No draft saving (audit must complete in one session)

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| CountControl not responding | Click outside field first | Click to focus, then use buttons |
| Barcode scan modal blank | Camera permission denied | Grant camera permission in settings |
| Batch commit fails | Firestore permissions | Check security rules for audit-related writes |
| Items not appearing | Filter by `isAuditRequired: true` | Check inventory filters |
| Condition colors not showing | Dark mode issue | Check theme settings |

---

**Last Updated**: Jan 22, 2026
