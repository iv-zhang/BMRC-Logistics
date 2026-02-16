#!/usr/bin/env node

/**
 * test-audit-restock.cjs
 * ─────────────────────
 * Offline test script for audit and restock business logic.
 * Run with: node scripts/test-audit-restock.cjs
 *
 * Tests pure-logic functions without Firebase. Firebase-dependent code
 * is tested via the in-app debug panel (see AuditDebugPanel component).
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.log(`  ❌ FAIL: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    failures.push(`${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    console.log(`  ❌ FAIL: ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function suite(name, fn) {
  console.log(`\n━━━ ${name} ━━━`);
  fn();
}

// ── Mock data factories ──────────────────────────────────────────────────────

function makeItem(overrides = {}) {
  return {
    id: 'test-' + Math.random().toString(36).slice(2, 8),
    name: 'Bandaids',
    category: 'first_aid',
    location: 'HQ',
    room: 'Back Room',
    unopenedBoxes: 5,
    itemsPerBox: 100,
    totalStockQuantity: 500,
    reorderThreshold: 2,
    batches: [],
    isAsset: undefined,
    assets: [],
    expirationDate: null,
    auditVerified: false,
    auditCondition: null,
    lastAuditDate: null,
    assetStatus: null,
    assetSerial: null,
    currentLocation: null,
    assetLastChecked: null,
    value: 10,
    ...overrides,
  };
}

function makeAssetItem(overrides = {}) {
  return makeItem({
    name: 'AED Defibrillator',
    category: 'equipment',
    isAsset: true,
    value: 1200,
    assetStatus: 'Ready',
    assetSerial: 'AED-001',
    currentLocation: 'Front',
    assets: [
      { id: 'inst-1', status: 'Ready', location: 'Front', serial: 'AED-001' },
    ],
    ...overrides,
  });
}

function makeUser(overrides = {}) {
  return {
    uid: 'user-001',
    email: 'test@bmrc.org',
    displayName: 'Test User',
    role: 'admin',
    canAudit: undefined,
    ...overrides,
  };
}

// ── Permission logic (mirrors canUserAudit) ──────────────────────────────────

const AUDIT_ROLES = ['admin', 'quartermaster', 'inventory_helper'];

function canUserAudit(user) {
  if (!user) return false;
  if (AUDIT_ROLES.includes(user.role)) return true;
  return user.canAudit === true;
}

suite('canUserAudit — permission checks', () => {
  assert(canUserAudit(null) === false, 'null user → no access');
  assert(canUserAudit(makeUser({ role: 'admin' })) === true, 'admin → access');
  assert(canUserAudit(makeUser({ role: 'quartermaster' })) === true, 'quartermaster → access');
  assert(canUserAudit(makeUser({ role: 'inventory_helper' })) === true, 'inventory_helper → access');
  assert(canUserAudit(makeUser({ role: 'member' })) === false, 'member without canAudit → no access');
  assert(canUserAudit(makeUser({ role: 'member', canAudit: true })) === true, 'member with canAudit → access');
  assert(canUserAudit(makeUser({ role: 'member', canAudit: false })) === false, 'member with canAudit=false → no access');
  assert(canUserAudit(makeUser({ role: 'FTO' })) === false, 'FTO without canAudit → no access');
  assert(canUserAudit(makeUser({ role: 'FTO', canAudit: true })) === true, 'FTO with canAudit → access');
});

// ── determineIsAsset logic (mirrors inventory.ts) ────────────────────────────

function determineIsAsset(item) {
  // Mirrors the real implementation in app/lib/inventory.ts
  if (item.isAsset !== undefined) return item.isAsset;
  const category = item.category;
  if (category && ['AED', 'Radio', 'Oxygen Tank', 'Generator', 'Monitor'].includes(category)) {
    return true;
  }
  const value = item.assetValue ?? 0;
  if (value >= 500) return true;
  return false;
}

suite('determineIsAsset — classification', () => {
  assert(determineIsAsset(makeItem({ isAsset: true })) === true, 'isAsset=true → asset');
  assert(determineIsAsset(makeItem({ isAsset: false })) === false, 'isAsset=false → not asset');
  assert(determineIsAsset(makeItem({ isAsset: undefined, category: 'AED' })) === true, 'AED category → asset');
  assert(determineIsAsset(makeItem({ isAsset: undefined, category: 'Radio' })) === true, 'Radio category → asset');
  assert(determineIsAsset(makeItem({ isAsset: undefined, category: 'Oxygen Tank' })) === true, 'Oxygen Tank category → asset');
  assert(determineIsAsset(makeItem({ isAsset: undefined, category: 'first_aid' })) === false, 'first_aid category → not asset');
  assert(determineIsAsset(makeItem({ isAsset: undefined, assetValue: 600 })) === true, 'assetValue ≥ 500 → asset');
  assert(determineIsAsset(makeItem({ isAsset: undefined, assetValue: 499 })) === false, 'assetValue < 500 → not asset');
  assert(determineIsAsset(makeItem({ isAsset: undefined, assetValue: 500 })) === true, 'assetValue = 500 → asset (boundary)');
  assert(determineIsAsset(makeItem({ isAsset: undefined, category: 'first_aid', assetValue: 10 })) === false, 'low-value first_aid → not asset');
});

// ── Restock decision logic (mirrors analyzeRestockNeeds) ─────────────────────

function analyzeRestockNeeds(items) {
  return items
    .map((item) => {
      const deficit = item.reorderThreshold - item.unopenedBoxes;
      let urgency = 'ok';
      let recommendation = 'Stock is adequate';

      if (item.unopenedBoxes === 0) {
        urgency = 'critical';
        recommendation = `OUT OF STOCK — Need ${item.reorderThreshold} boxes immediately`;
      } else if (deficit > 0) {
        urgency = 'low';
        recommendation = `Low stock — Order ${deficit} more boxes to reach par level`;
      }

      if (item.isExpired) {
        urgency = 'critical';
        recommendation += ' | ⚠️ EXPIRED items present';
      }

      return {
        itemId: item.id,
        itemName: item.name,
        unopenedBoxes: item.unopenedBoxes,
        itemsPerBox: item.itemsPerBox,
        reorderThreshold: item.reorderThreshold,
        deficit: Math.max(0, deficit),
        urgency,
        recommendation,
      };
    })
    .filter((d) => d.urgency !== 'ok')
    .sort((a, b) => {
      const order = { critical: 0, low: 1, ok: 2 };
      return order[a.urgency] - order[b.urgency];
    });
}

suite('analyzeRestockNeeds — restock decisions', () => {
  // Zero stock
  const zeroStock = analyzeRestockNeeds([
    { id: '1', name: 'Bandaids', unopenedBoxes: 0, itemsPerBox: 100, reorderThreshold: 3, isExpired: false },
  ]);
  assertEqual(zeroStock.length, 1, 'zero stock → 1 decision');
  assertEqual(zeroStock[0].urgency, 'critical', 'zero stock → critical');
  assertEqual(zeroStock[0].deficit, 3, 'zero stock → deficit equals threshold');

  // Low stock
  const lowStock = analyzeRestockNeeds([
    { id: '2', name: 'Gauze', unopenedBoxes: 1, itemsPerBox: 50, reorderThreshold: 3, isExpired: false },
  ]);
  assertEqual(lowStock.length, 1, 'low stock → 1 decision');
  assertEqual(lowStock[0].urgency, 'low', 'low stock → low urgency');
  assertEqual(lowStock[0].deficit, 2, 'low stock → correct deficit');

  // Adequate stock
  const okStock = analyzeRestockNeeds([
    { id: '3', name: 'Gloves', unopenedBoxes: 5, itemsPerBox: 200, reorderThreshold: 2, isExpired: false },
  ]);
  assertEqual(okStock.length, 0, 'adequate stock → no decisions');

  // Expired items escalate to critical
  const expired = analyzeRestockNeeds([
    { id: '4', name: 'Epi Pen', unopenedBoxes: 3, itemsPerBox: 1, reorderThreshold: 2, isExpired: true },
  ]);
  assertEqual(expired.length, 1, 'expired item → 1 decision');
  assertEqual(expired[0].urgency, 'critical', 'expired → always critical');
  assert(expired[0].recommendation.includes('EXPIRED'), 'expired → recommendation mentions expiration');

  // Sorting: critical before low
  const mixed = analyzeRestockNeeds([
    { id: '5', name: 'Item A', unopenedBoxes: 1, itemsPerBox: 10, reorderThreshold: 3, isExpired: false },
    { id: '6', name: 'Item B', unopenedBoxes: 0, itemsPerBox: 10, reorderThreshold: 5, isExpired: false },
  ]);
  assertEqual(mixed[0].urgency, 'critical', 'sorted: critical first');
  assertEqual(mixed[1].urgency, 'low', 'sorted: low second');

  // Boundary: stock exactly at threshold = ok
  const boundary = analyzeRestockNeeds([
    { id: '7', name: 'Tape', unopenedBoxes: 3, itemsPerBox: 1, reorderThreshold: 3, isExpired: false },
  ]);
  assertEqual(boundary.length, 0, 'stock = threshold → no restock needed (ok)');

  // Edge: reorderThreshold = 0
  const noThreshold = analyzeRestockNeeds([
    { id: '8', name: 'Misc', unopenedBoxes: 0, itemsPerBox: 1, reorderThreshold: 0, isExpired: false },
  ]);
  assertEqual(noThreshold.length, 1, 'zero boxes with zero threshold → critical (out of stock)');
});

// ── Box-based variance tracking ──────────────────────────────────────────────

function computeVariance(systemBoxes, countedBoxes) {
  return countedBoxes - systemBoxes;
}

suite('Box-based variance computation', () => {
  assertEqual(computeVariance(5, 5), 0, 'no variance');
  assertEqual(computeVariance(5, 3), -2, 'shortage (found fewer)');
  assertEqual(computeVariance(5, 7), 2, 'surplus (found more)');
  assertEqual(computeVariance(0, 0), 0, 'both zero → no variance');
  assertEqual(computeVariance(0, 3), 3, 'system zero but found some → surplus');
});

// ── Snapshot generation (mock for offline — tests data shape) ────────────────

suite('Snapshot data shape validation', () => {
  const items = [
    makeItem({ name: 'Bandaids', unopenedBoxes: 5, itemsPerBox: 100 }),
    makeItem({ name: 'Gauze', unopenedBoxes: 0, reorderThreshold: 3, itemsPerBox: 50 }),
    makeAssetItem({ name: 'AED' }),
    makeItem({
      name: 'Expired Med',
      unopenedBoxes: 2,
      expirationDate: '2020-01-01',
      reorderThreshold: 1,
    }),
  ];

  // Simulate snapshot generation
  const now = new Date();
  const disposables = [];
  const assets = [];
  let lowStockCount = 0;
  let expiredCount = 0;

  items.forEach((item) => {
    const isAsset = determineIsAsset(item);
    if (isAsset) {
      assets.push({
        id: item.id,
        name: item.name,
        isAsset: true,
        instanceCount: (item.assets || []).length || 1,
        issueCount: (item.assets || []).filter(a => a.status === 'Maintenance' || a.status === 'Not Ready').length,
      });
    } else {
      const unopenedBoxes = item.unopenedBoxes ?? 0;
      const reorderThreshold = item.reorderThreshold ?? 0;
      const isLowStock = unopenedBoxes <= reorderThreshold;
      let earliestExp;
      if (item.expirationDate) {
        earliestExp = new Date(item.expirationDate);
      }
      const isExpired = earliestExp ? earliestExp < now : false;
      if (isLowStock) lowStockCount++;
      if (isExpired) expiredCount++;
      disposables.push({
        id: item.id,
        name: item.name,
        unopenedBoxes,
        isLowStock,
        isExpired,
      });
    }
  });

  assertEqual(disposables.length, 3, '3 disposables in snapshot');
  assertEqual(assets.length, 1, '1 asset in snapshot');
  assert(lowStockCount >= 1, 'at least 1 low-stock item (Gauze has 0)');
  assert(expiredCount >= 1, 'at least 1 expired item');
  assert(assets[0].instanceCount === 1, 'AED has 1 instance');
});

// ── Zone filtering logic ─────────────────────────────────────────────────────

function filterByZone(items, zone) {
  if (!zone || zone === 'all') return items;
  return items.filter((item) => {
    const itemZone = item.room || item.location || 'HQ';
    return itemZone === zone || item.location === zone;
  });
}

suite('Zone filtering', () => {
  const items = [
    makeItem({ name: 'A', room: 'Back Room', location: 'HQ' }),
    makeItem({ name: 'B', room: 'Front', location: 'HQ' }),
    makeItem({ name: 'C', room: undefined, location: 'CPR Closet' }),
    makeItem({ name: 'D', room: undefined, location: undefined }),
  ];

  assertEqual(filterByZone(items, 'all').length, 4, 'all → returns everything');
  assertEqual(filterByZone(items, undefined).length, 4, 'undefined zone → returns everything');
  assertEqual(filterByZone(items, 'Back Room').length, 1, 'Back Room → 1 item');
  assertEqual(filterByZone(items, 'Front').length, 1, 'Front → 1 item');
  assertEqual(filterByZone(items, 'CPR Closet').length, 1, 'CPR Closet → 1 item');
  assertEqual(filterByZone(items, 'HQ').length, 3, 'HQ → 3 items (location match)');
  assertEqual(filterByZone(items, 'Nonexistent').length, 0, 'Unknown zone → 0 items');
});

// ── Stress test: large inventory ─────────────────────────────────────────────

suite('Stress test — 10,000 item audit', () => {
  const ITEM_COUNT = 10000;
  const items = [];
  for (let i = 0; i < ITEM_COUNT; i++) {
    items.push({
      id: `item-${i}`,
      name: `Item ${i}`,
      unopenedBoxes: Math.floor(Math.random() * 20),
      itemsPerBox: [1, 10, 25, 50, 100][Math.floor(Math.random() * 5)],
      reorderThreshold: Math.floor(Math.random() * 5),
      isExpired: Math.random() < 0.05, // 5% expired
    });
  }

  const start = Date.now();
  const decisions = analyzeRestockNeeds(items);
  const duration = Date.now() - start;

  assert(duration < 500, `restock analysis on ${ITEM_COUNT} items completed in ${duration}ms (< 500ms)`);
  assert(decisions.length > 0, `found ${decisions.length} restock decisions`);
  assert(
    decisions.every((d) => d.urgency === 'critical' || d.urgency === 'low'),
    'all decisions are critical or low (no "ok" leaked through)'
  );

  // Stress test zone filtering
  const zoneItems = items.map((it, i) => ({
    ...it,
    room: ['Back Room', 'Front', 'CPR Closet', 'Shed'][i % 4],
    location: 'HQ',
  }));
  const filterStart = Date.now();
  const filtered = filterByZone(zoneItems, 'Back Room');
  const filterDuration = Date.now() - filterStart;

  assertEqual(filtered.length, 2500, 'zone filter on 10k items → 2500 for Back Room');
  assert(filterDuration < 100, `zone filter on ${ITEM_COUNT} items took ${filterDuration}ms (< 100ms)`);
});

// ── Edge cases ───────────────────────────────────────────────────────────────

suite('Edge cases', () => {
  // Negative values should not occur but handle gracefully
  const negItem = { id: '1', name: 'Bad', unopenedBoxes: -1, itemsPerBox: 10, reorderThreshold: 2, isExpired: false };
  const negResult = analyzeRestockNeeds([negItem]);
  assert(negResult.length === 1, 'negative boxes → flagged');
  assertEqual(negResult[0].urgency, 'low', 'negative boxes → low (not zero so not critical)');

  // Very large itemsPerBox
  const bigBox = { id: '2', name: 'Big', unopenedBoxes: 1, itemsPerBox: 100000, reorderThreshold: 0, isExpired: false };
  const bigResult = analyzeRestockNeeds([bigBox]);
  assertEqual(bigResult.length, 0, 'large itemsPerBox with stock above threshold → ok');

  // Empty arrays
  assertEqual(analyzeRestockNeeds([]).length, 0, 'empty inventory → no decisions');

  // Item with no boxes field (undefined)
  const missingField = makeItem({ unopenedBoxes: undefined });
  const missingBoxes = missingField.unopenedBoxes ?? 0;
  assertEqual(missingBoxes, 0, 'undefined unopenedBoxes falls back to 0');

  // canUserAudit with weird inputs
  assert(canUserAudit({}) === false, 'empty object user → no access');
  assert(canUserAudit({ role: undefined }) === false, 'undefined role → no access');
  assert(canUserAudit({ role: 'member', canAudit: null }) === false, 'canAudit=null → no access');
  assert(canUserAudit({ role: 'member', canAudit: 'true' }) === false, 'canAudit="true" (string) → no access');
});

// ── Audit entry validation ───────────────────────────────────────────────────

function validateAuditEntry(entry) {
  const errors = [];
  if (!entry.itemId) errors.push('missing itemId');
  if (!entry.condition) errors.push('missing condition');
  if (!['Good', 'Damaged', 'Expired'].includes(entry.condition)) errors.push('invalid condition');
  if (entry.countedBoxes !== undefined && (typeof entry.countedBoxes !== 'number' || entry.countedBoxes < 0)) {
    errors.push('countedBoxes must be a non-negative number');
  }
  return { valid: errors.length === 0, errors };
}

suite('Audit entry validation', () => {
  const valid = validateAuditEntry({ itemId: '1', condition: 'Good', countedBoxes: 5 });
  assert(valid.valid, 'valid entry passes');

  const noItem = validateAuditEntry({ condition: 'Good' });
  assert(!noItem.valid, 'missing itemId → invalid');

  const badCond = validateAuditEntry({ itemId: '1', condition: 'Bad' });
  assert(!badCond.valid, 'invalid condition → invalid');

  const negBoxes = validateAuditEntry({ itemId: '1', condition: 'Good', countedBoxes: -1 });
  assert(!negBoxes.valid, 'negative countedBoxes → invalid');

  const noBoxes = validateAuditEntry({ itemId: '1', condition: 'Damaged' });
  assert(noBoxes.valid, 'missing countedBoxes (assets) → valid');
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log('\n════════════════════════════════════════════════════════════');
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.log('\n  Failed tests:');
  failures.forEach((f) => console.log(`    • ${f}`));
  console.log('');
  process.exit(1);
} else {
  console.log('  🎉 All tests passed!');
  console.log('════════════════════════════════════════════════════════════\n');
}
