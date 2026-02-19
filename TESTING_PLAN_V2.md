# BMRC Logistics — Comprehensive Testing Plan

> Created: 2026-02-18 | Framework: Next.js + Playwright | Coverage: All 5 issues

---

## Testing Strategy

### Tools
- **Playwright** — E2E tests with screenshot capture for UI/UX verification
- **Next.js App Router** — test via dev server at `localhost:3000`
- **Firebase Emulator** — for Firestore/Auth (or mock via test fixtures)

### Test Categories
1. **Smoke Tests** — critical paths work at all
2. **Functional Tests** — features work correctly
3. **Edge Case Tests** — boundary conditions and error handling
4. **Stress Tests** — performance under load
5. **UI/UX Screenshots** — visual regression detection

---

## Test Suite 1: Configuration System (Issue 5)

### 1.1 Config Loading
| Test | Type | Expected |
|---|---|---|
| Config loads without errors | Smoke | All config fields defined |
| Adding new location to config shows in all pickers | Functional | New location appears in dropdowns |
| Adding new asset category shows in filters | Functional | New category in asset filter bar |
| Adding new vehicle type shows in relevant UIs | Functional | Vehicle type appears where applicable |
| Adding new statpack type with custom pockets | Functional | Statpack creation shows new pocket options |
| Config with empty arrays doesn't crash | Edge | Graceful empty states |
| Config with very long names renders properly | Edge | Text truncation, no layout break |
| 📸 Screenshot: Location picker with custom locations | UI/UX | All locations visible, styled |
| 📸 Screenshot: Asset category filter with custom categories | UI/UX | All categories in filter bar |

### 1.2 Verification Field Definitions
| Test | Type | Expected |
|---|---|---|
| Custom verification field appears in checkout flow | Functional | Field renders with correct input type |
| Numeric field enforces min/max bounds | Edge | Values clamped, error shown |
| Required field blocks checkout if empty | Functional | Submit disabled, error message |
| Optional field can be skipped | Functional | No validation error |

---

## Test Suite 2: Barcode Scanning (Issue 1)

### 2.1 ScannerInput Component
| Test | Type | Expected |
|---|---|---|
| Camera mode opens viewfinder | Smoke | Video element visible |
| Manual mode shows text input | Smoke | Input field visible, focusable |
| Typing barcode in manual mode triggers onScan | Functional | Callback fired with code |
| Camera permission denied shows fallback | Edge | Switches to manual mode, shows message |
| Very long barcode string accepted | Edge | Full string captured, no truncation |
| Empty string submission blocked | Edge | No callback, validation message |
| Rapid consecutive scans debounced | Stress | Only one scan registered per interval |
| GS1 barcode parsed correctly | Functional | Expiration + lot extracted |
| Non-GS1 barcode treated as raw code | Functional | Raw string passed through |
| 📸 Screenshot: Scanner in camera mode | UI/UX | Viewfinder centered, controls visible |
| 📸 Screenshot: Scanner in manual mode | UI/UX | Input field with placeholder |
| 📸 Screenshot: Scanner with successful scan feedback | UI/UX | Green flash/checkmark |

### 2.2 Scan-to-Assign Workflow
| Test | Type | Expected |
|---|---|---|
| Scan barcode → asset has no tag → assigns tag | Smoke | Tag stored on asset document |
| Scan barcode → tag already on another asset → shows warning | Functional | Duplicate warning with asset info |
| Override duplicate warning → reassigns tag | Functional | Old asset cleared, new asset tagged |
| Cancel duplicate warning → no change | Functional | Both assets unchanged |
| Assign tag → scan same tag → resolves to correct asset | Functional | Asset lookup returns correct item |
| Assign tag → edit asset → tag persists | Functional | Tag survives edit/save |
| Remove tag from asset → scan → no match | Functional | "No asset found" message |
| Assign tag with special characters | Edge | Tag stored correctly |
| Assign empty tag blocked | Edge | Validation error |
| 📸 Screenshot: Asset modal scan-to-assign section | UI/UX | Scanner, assigned tag display |
| 📸 Screenshot: Duplicate barcode warning modal | UI/UX | Clear warning with asset details |

### 2.3 Cross-Component Scanner Usage
| Test | Type | Expected |
|---|---|---|
| Scanner works in asset checkout page | Functional | Scans resolve assets |
| Scanner works in statpack checkout page | Functional | Scans resolve statpacks |
| Scanner works in statpack checkin page | Functional | Scans resolve statpacks |
| Scanner works in audit page | Functional | Scans resolve items |
| All scanners use same ScannerInput | Code | No duplicate scanning logic |

---

## Test Suite 3: Asset ↔ Statpack Integration (Issue 2)

### 3.1 Bidirectional Visibility
| Test | Type | Expected |
|---|---|---|
| Asset assigned to statpack shows badge in asset view | Smoke | Badge with statpack name + pocket |
| Click asset badge → navigates to statpack detail | Functional | Statpack page opens, pocket highlighted |
| Statpack detail shows all assigned assets per pocket | Smoke | Asset list under each pocket |
| Click asset in statpack view → opens asset detail | Functional | Asset modal opens |
| Unassigned asset shows "Unassigned" badge | Functional | Gray unassigned indicator |
| Assign asset to statpack → both views update | Functional | Real-time update |
| Remove asset from statpack → both views update | Functional | Badge removed, asset list updated |
| 📸 Screenshot: Asset view with statpack badge | UI/UX | Badge styled, pocket icon visible |
| 📸 Screenshot: Statpack detail with asset summary panel | UI/UX | Assets grouped by pocket |

### 3.2 Pocket Assignment
| Test | Type | Expected |
|---|---|---|
| Assign asset to specific pocket | Functional | Pocket stored on assignment |
| Move asset between pockets | Functional | Assignment updated |
| Pocket visualizer highlights assigned assets | Functional | Asset icons in correct pockets |
| Asset in wrong pocket shows warning | Edge | Mismatch indicator |
| Two assets assigned to same pocket position | Edge | No conflict, both visible |

### 3.3 Data Consistency
| Test | Type | Expected |
|---|---|---|
| Asset document and statpack document agree on assignment | Functional | Both reference each other |
| Delete statpack → assets show unassigned | Edge | Graceful cleanup |
| Delete asset → statpack shows missing item warning | Edge | Warning indicator |
| Reassign asset from statpack A to B | Functional | A cleared, B assigned |
| Double-assign same asset to two statpacks blocked | Edge | Error: "Asset already assigned to [name]" |

---

## Test Suite 4: Asset Verification & Batch Checkout (Issue 3)

### 4.1 Batch Asset Checkout (Admin)
| Test | Type | Expected |
|---|---|---|
| Open batch checkout mode | Smoke | UI shows continuous scanner + list |
| Scan first asset → appears in list | Functional | Asset name + serial in list |
| Scan 10 radios in sequence | Stress | All 10 appear, correct order |
| Scan same asset twice → deduplicated | Edge | Warning: "Already scanned", not added twice |
| Scan unknown barcode → warning | Edge | "No asset found for barcode X" |
| Remove asset from batch before confirm | Functional | Asset removed from list |
| Confirm batch → all assets checked out | Functional | Firestore shows all as checked out |
| Cancel batch → nothing changed | Functional | No Firestore writes |
| Scan 50 assets (batch limit test) | Stress | All processed, chunked if needed |
| Network error during batch commit | Edge | Retry option, no partial state |
| 📸 Screenshot: Batch scanner with running list | UI/UX | List grows as items scanned |
| 📸 Screenshot: Batch review before confirm | UI/UX | Summary card with all assets |
| 📸 Screenshot: Batch completion success | UI/UX | Success message with count |

### 4.2 Batch Asset Checkin (Admin)
| Test | Type | Expected |
|---|---|---|
| Scan assets to check in | Functional | Assets appear in return list |
| Per-asset condition toggle (Good/Damaged) | Functional | Condition recorded per asset |
| Scan asset not currently checked out → warning | Edge | "Asset is not checked out" |
| Checkin with damaged flag → creates maintenance task | Functional | Maintenance task created |
| 📸 Screenshot: Batch checkin with condition toggles | UI/UX | Each asset has condition selector |

### 4.3 Single Asset Quick Checkout
| Test | Type | Expected |
|---|---|---|
| Scan → identify → one-tap checkout | Smoke | 2 interactions total |
| Scan → multiple matches → disambiguation | Edge | List of matching assets shown |
| Scan → asset already checked out → warning | Edge | Shows who has it |

---

## Test Suite 5: Member Statpack Checkout Verification (Issue 4)

### 5.1 Asset Verification During Checkout
| Test | Type | Expected |
|---|---|---|
| Checkout flow shows verify button for asset items | Smoke | Scan button on asset items |
| Scan correct asset barcode → green checkmark | Functional | Item verified, next field shown |
| Scan wrong asset barcode → red warning | Functional | Mismatch warning with expected info |
| Manual entry of barcode works as fallback | Functional | Same verification as scan |
| Skip verification → warning logged | Functional | Item marked "unverified" |
| 📸 Screenshot: Asset verification step in checkout | UI/UX | Scanner + verify indicators |
| 📸 Screenshot: Successful scan match | UI/UX | Green checkmark, asset info |
| 📸 Screenshot: Scan mismatch warning | UI/UX | Red warning with expected vs actual |

### 5.2 Item-Specific Verification Fields
| Test | Type | Expected |
|---|---|---|
| Epipen shows expiration date field | Functional | Date input appears after scan |
| O2 Tank shows PSI input | Functional | Number input with range 0-2200 |
| AED shows battery level slider | Functional | Slider 0-100% |
| Radio shows power check toggle | Functional | On/Off toggle |
| Expired item → critical warning | Functional | Red warning, blocks checkout |
| Low O2 PSI → warning | Functional | Yellow warning, allows override |
| Low battery → warning | Functional | Yellow warning, allows override |
| 📸 Screenshot: Epipen verification with expiration | UI/UX | Date field + expiration warning |
| 📸 Screenshot: O2 tank verification with PSI | UI/UX | PSI input + gauge visual |
| 📸 Screenshot: AED verification with battery | UI/UX | Battery slider + level indicator |

### 5.3 Admin Audit Scan-and-Go
| Test | Type | Expected |
|---|---|---|
| Open audit mode from statpack view | Smoke | Continuous scanner + checklist |
| Scan asset → auto-fills audit entry | Functional | Item checked off |
| Scan all items in statpack → 100% completion | Functional | Complete indicator |
| Missing item flagged after full scan | Functional | "Not verified" warning |
| Scan item not in this statpack → warning | Edge | "Item not expected in this statpack" |
| Complete audit → submit results | Functional | Results stored in Firestore |
| 📸 Screenshot: Audit scan-and-go mode | UI/UX | Scanner + progress checklist |
| 📸 Screenshot: Audit completion summary | UI/UX | Pass/fail per item |

---

## Test Suite 6: Stress & Performance

### 6.1 Data Volume
| Test | Type | Expected |
|---|---|---|
| 100 assets in asset table | Stress | Table renders < 2s, smooth scroll |
| 50 statpacks in list | Stress | Cards render < 2s |
| Asset with 20+ log entries | Stress | History tab loads < 1s |
| Statpack with 30 content items | Stress | Editor responsive |
| Audit with 200 items | Stress | Card navigation smooth |

### 6.2 Rapid Interactions
| Test | Type | Expected |
|---|---|---|
| 20 rapid barcode scans in batch mode | Stress | All captured, no drops |
| Toggle all items in checkout checklist rapidly | Stress | All toggles register |
| Open/close modals rapidly | Stress | No memory leaks, no stale state |
| Navigate between pages rapidly | Stress | No crashed state, data loads |

### 6.3 Concurrent Operations
| Test | Type | Expected |
|---|---|---|
| Two users check out same asset simultaneously | Stress | Second user sees conflict error |
| Two users edit same statpack | Stress | Last write wins or conflict shown |
| Audit lock prevents concurrent audits | Stress | Second user sees "locked" |

---

## Test Suite 7: UI/UX Screenshot Verification

All screenshots captured via Playwright `page.screenshot()` with comparison baselines.

### 7.1 Responsive Design
| Test | Expected |
|---|---|
| 📸 Asset table on desktop (1920×1080) | Full table visible, filters in row |
| 📸 Asset table on tablet (768×1024) | Cards or compact table |
| 📸 Asset table on mobile (375×667) | Single column, touch-friendly |
| 📸 Statpack visualizer on mobile | Bag SVG scales, pockets tappable |
| 📸 Scanner modal on mobile | Camera viewfinder fills screen |
| 📸 Batch checkout on mobile | List scrollable, scanner accessible |

### 7.2 Dark/Light Mode
| Test | Expected |
|---|---|
| 📸 Dashboard in light mode | Proper contrast, no invisible text |
| 📸 Dashboard in dark mode | Proper contrast, no invisible text |
| 📸 Modals in dark mode | Backgrounds, borders correct |
| 📸 Scanner overlay in dark mode | Viewfinder visible |

### 7.3 Empty States
| Test | Expected |
|---|---|
| 📸 No assets | Friendly empty state with CTA |
| 📸 No statpacks | Friendly empty state with CTA |
| 📸 No audit history | "No audits yet" message |
| 📸 Empty batch checkout list | "Scan an asset to begin" |

---

## Test Implementation Structure

```
tests/
├── e2e/
│   ├── config.spec.ts          # Test Suite 1
│   ├── scanner.spec.ts         # Test Suite 2
│   ├── asset-statpack.spec.ts  # Test Suite 3
│   ├── batch-checkout.spec.ts  # Test Suite 4
│   ├── member-checkout.spec.ts # Test Suite 5
│   ├── stress.spec.ts          # Test Suite 6
│   └── screenshots.spec.ts    # Test Suite 7
├── fixtures/
│   ├── assets.json             # Test asset data
│   ├── statpacks.json          # Test statpack data
│   └── org-config.json         # Test org config
├── screenshots/
│   └── baseline/               # Reference screenshots
└── playwright.config.ts
```

---

## Screenshot Capture Strategy

```typescript
// Example Playwright test with screenshot
test('asset table with statpack badges', async ({ page }) => {
  await page.goto('/assets');
  await page.waitForSelector('[data-testid="asset-table"]');
  await expect(page).toHaveScreenshot('asset-table-with-badges.png', {
    fullPage: false,
    mask: [page.locator('[data-testid="timestamp"]')], // mask dynamic content
  });
});
```

Each screenshot test:
1. Navigates to the page
2. Waits for data to load (skeleton → content)
3. Masks dynamic content (timestamps, user names)
4. Captures screenshot with descriptive filename
5. Compares against baseline (first run = baseline, subsequent = diff)

---

## CI Integration

```yaml
# .github/workflows/test.yml
- name: Install Playwright
  run: npx playwright install --with-deps
- name: Run E2E tests
  run: npx playwright test
- name: Upload screenshots
  uses: actions/upload-artifact@v4
  with:
    name: test-screenshots
    path: tests/screenshots/
```
