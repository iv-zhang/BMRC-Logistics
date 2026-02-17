# O₂ PSI Tracking - Quick Start Guide

## For Members: Checking Out a Statpack with O₂

1. **Start Checkout**
   - Navigate to statpack page
   - Click "Checkout" button
   - Enter counts for each item

2. **Enter O₂ PSI** (REQUIRED)
   - Locate "Oxygen Cylinder PSI (Required)" section
   - Read PSI from pressure gauge on oxygen tank
   - Enter exact reading (e.g., 1950)
   - **Note:** Checkout will be blocked if you don't enter PSI

3. **Validation**
   - ✅ PSI ≥ 1800: Checkout proceeds normally
   - ❌ PSI < 1800: Contact admin before proceeding
   - ❌ PSI missing: Cannot checkout until entered

4. **Complete Checkout**
   - Review all entries
   - Click "Complete Checkout"
   - PSI reading is saved to log automatically

---

## For Admins: Reviewing O₂ Logs

### Quick Scan for Issues

1. Go to Statpack Logs page
2. Look for `⚠️ Low O₂` badge on checkout cards
3. Click card to view details

### Detailed Log Review

1. Open log detail modal
2. Look for O₂ PSI in check entries
3. Warning chip shown if PSI < 1800
4. Note user, timestamp, and exact PSI value

### Running Forgery Detection

```bash
# Check last 30 days for all statpacks
node scripts/detect-o2-forgery.cjs --days=30

# Check specific statpack
node scripts/detect-o2-forgery.cjs --statpack-id=statpack-primary-1
```

**Look for:**
- 🚨 **CRITICAL**: PSI increases (non-physical)
- ⚠️ **HIGH**: Identical readings (copy-paste)
- 📋 **MEDIUM**: Round number bias (estimation)

### Running Trend Analysis

```bash
# Analyze all tanks for last 90 days
node scripts/analyze-o2-trends.cjs --days=90

# Export detailed report
node scripts/analyze-o2-trends.cjs --export=o2-report.json
```

**Report shows:**
- Current leak rates (PSI/day)
- Predicted refill dates
- Maintenance recommendations
- Tanks needing immediate attention

---

## For Admins: Setting Up O₂ Requirements

### 1. Mark Item as Oxygen

In Firestore, edit inventory item:

```typescript
// inventory/oxygen-tank-d-cylinder
{
  name: "Oxygen Tank D-Cylinder",
  category: "Medical Equipment",
  
  // Enable O₂ tracking
  isOxygen: true,
  maxOxygenPsi: 2200,
  
  // Set validation rules
  verificationPolicy: {
    requireO2PsiMin: 1800,
    advisoryOnly: false
  }
}
```

### 2. Add to Statpack

In statpack contents:

```typescript
contents: [
  {
    itemId: "oxygen-tank-d-cylinder",
    requiredQuantity: 1,
    pocket: "main"
  }
]
```

### 3. Test Checkout Flow

1. Login as member
2. Attempt checkout
3. Verify O₂ PSI field appears and is required
4. Complete checkout with valid PSI
5. Verify log shows PSI in checkEntries

---

## Troubleshooting

### Problem: O₂ field not showing

**Solution:**
1. Check `isOxygen: true` in inventory item
2. Verify action is `'checkout'` (not checkin)
3. Clear browser cache
4. Check browser console for errors

### Problem: Can't checkout even with valid PSI

**Solution:**
1. Verify PSI ≥ `requireO2PsiMin` (default 1800)
2. Check if user is member (admins can override)
3. Look for other validation errors in modal

### Problem: Forgery script shows no data

**Solution:**
1. Verify recent checkouts exist
2. Check logs have `checkEntries[].assetCheckResult.oxygenPsi`
3. Try increasing `--days` parameter
4. Verify service-account-key.json exists

### Problem: Trend analysis shows weird leak rates

**Possible causes:**
- Not enough data points (need ≥2 readings)
- Tank was refilled without logging
- PSI readings were estimated (not measured)
- Tank was swapped between statpacks

---

## Best Practices

### For Members

✅ **DO:**
- Read PSI directly from pressure gauge
- Enter exact reading (don't round)
- Report low PSI to admin immediately
- Take photo of gauge if uncertain

❌ **DON'T:**
- Estimate or guess PSI
- Copy PSI from previous checkout
- Checkout with PSI < 1800 without approval
- Enter PSI for wrong tank

### For Admins

✅ **DO:**
- Run forgery detection weekly
- Review trend analysis monthly
- Schedule refills proactively
- Document tank refills/swaps
- Train members on proper measurement

❌ **DON'T:**
- Ignore low PSI warnings
- Let tanks drop below 1500 PSI
- Disable validation without good reason
- Skip regular maintenance checks

---

## Quick Reference

### PSI Thresholds

| PSI Range | Status | Action |
|-----------|--------|--------|
| 2000-2200 | ✅ Excellent | Normal use |
| 1800-1999 | ⚠️ OK | Monitor |
| 1500-1799 | 🔶 Low | Schedule refill |
| < 1500 | 🚨 Critical | Refill immediately |

### Normal Leak Rates

| Rate (PSI/day) | Status | Action |
|----------------|--------|--------|
| 0-2 | ✅ Normal | Continue monitoring |
| 2-10 | ⚠️ Elevated | Inspect seals |
| 10-50 | 🔶 High | Schedule maintenance |
| > 50 | 🚨 Critical | Immediate inspection |

### Script Commands

```bash
# Stress test concurrent checkouts
node scripts/stress-test-o2-checkout.cjs

# Detect forgery patterns
node scripts/detect-o2-forgery.cjs --days=30

# Analyze leak trends
node scripts/analyze-o2-trends.cjs --days=90

# Export trend report
node scripts/analyze-o2-trends.cjs --export=report.json
```

---

## Support

**Questions?** Check [O2_PSI_IMPLEMENTATION.md](./O2_PSI_IMPLEMENTATION.md) for detailed documentation.

**Bug Reports?** Include:
- User role (member/admin)
- Statpack ID
- Screenshot of error
- Browser console logs
- Steps to reproduce
