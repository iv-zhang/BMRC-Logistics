#!/usr/bin/env node

/**
 * Test Harness for migrate-open-to-open-batches.js
 * 
 * Validates migration logic against fixture snapshots without touching Firestore.
 * Run this before applying the migration to production data.
 * 
 * Usage:
 *   node scripts/test-migration-scenarios.js
 */

// Import the analysis logic (we'll extract it as a testable function)
// For now, we'll duplicate the core logic here for testing

function generateBatchId() {
  return `open-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function computeCanonicalCount(item) {
  // Canonical count is the expected physical inventory:
  // Priority: unopenedBoxes * itemsPerBox (sealed inventory)
  // Fallback: totalStockQuantity (legacy)
  const unopenedBoxes = item.unopenedBoxes || 0;
  const itemsPerBox = item.itemsPerBox || 1;
  const totalStockQuantity = item.totalStockQuantity || 0;
  
  if (unopenedBoxes > 0 && itemsPerBox > 0) {
    return unopenedBoxes * itemsPerBox;
  }
  
  return totalStockQuantity;
}

function analyzeItem(item) {
  const batches = item.batches || [];
  const batchSum = batches.reduce((sum, b) => sum + (b.stock || 0), 0);
  const canonicalCount = computeCanonicalCount(item);
  const discrepancy = canonicalCount - batchSum;
  
  const hasSerialized = batches.some(b => b.serialized || (b.serialNumbers && b.serialNumbers.length > 0));
  const shouldCreateOpenBatch = discrepancy > 0 && !hasSerialized && !item.isAsset;
  
  return {
    id: item.id,
    name: item.name,
    batchSum,
    canonicalCount,
    discrepancy,
    hasSerialized,
    shouldCreateOpenBatch,
    proposedOpenBatch: shouldCreateOpenBatch ? {
      id: generateBatchId(),
      stock: discrepancy,
      lotNumber: 'OPEN',
      openDate: new Date().toISOString(),
      notes: 'Converted from open/unreconciled counts (migration)',
    } : null,
  };
}

// Test fixtures
const fixtures = [
  {
    name: 'Scenario 1: No batches, unopenedBoxes only (should create open batch)',
    item: {
      id: 'test-1',
      name: 'Gauze Pads 4x4',
      unopenedBoxes: 2,
      itemsPerBox: 100,
      batches: [],
      isAsset: false,
    },
    expected: {
      shouldCreateOpenBatch: true,
      discrepancy: 200,
      canonicalCount: 200,
      batchSum: 0,
    },
  },
  {
    name: 'Scenario 2: Batch exists, matches unopenedBoxes (no open batch needed)',
    item: {
      id: 'test-2',
      name: 'Nitrile Gloves',
      unopenedBoxes: 3,
      itemsPerBox: 100,
      batches: [
        { id: 'batch-1', stock: 300, lotNumber: 'LOT2024-01' },
      ],
      isAsset: false,
    },
    expected: {
      shouldCreateOpenBatch: false,
      discrepancy: 0,
      canonicalCount: 300,
      batchSum: 300,
    },
  },
  {
    name: 'Scenario 3: Batch sum < canonical (discrepancy, should create open batch)',
    item: {
      id: 'test-3',
      name: 'Bandages',
      unopenedBoxes: 5,
      itemsPerBox: 50,
      batches: [
        { id: 'batch-1', stock: 100, lotNumber: 'LOT2024-02' },
      ],
      isAsset: false,
    },
    expected: {
      shouldCreateOpenBatch: true,
      discrepancy: 150,
      canonicalCount: 250,
      batchSum: 100,
    },
  },
  {
    name: 'Scenario 4: Asset (should NOT create open batch)',
    item: {
      id: 'test-4',
      name: 'AED',
      unopenedBoxes: 1,
      itemsPerBox: 1,
      batches: [],
      isAsset: true,
    },
    expected: {
      shouldCreateOpenBatch: false,
      discrepancy: 1,
      canonicalCount: 1,
      batchSum: 0,
    },
  },
  {
    name: 'Scenario 5: Serialized batch (should NOT create open batch)',
    item: {
      id: 'test-5',
      name: 'Radio',
      unopenedBoxes: 1,
      itemsPerBox: 1,
      batches: [
        {
          id: 'batch-serial',
          stock: 1,
          serialized: true,
          serialNumbers: ['RADIO-001'],
        },
      ],
      isAsset: false,
    },
    expected: {
      shouldCreateOpenBatch: false,
      discrepancy: 0,
      canonicalCount: 1,
      batchSum: 1,
    },
  },
  {
    name: 'Scenario 6: Multiple batches, partial discrepancy (should create open batch)',
    item: {
      id: 'test-6',
      name: 'IV Catheters',
      unopenedBoxes: 10,
      itemsPerBox: 20,
      batches: [
        { id: 'batch-1', stock: 50, lotNumber: 'LOT2024-03', expirationDate: '2026-06-30' },
        { id: 'batch-2', stock: 100, lotNumber: 'LOT2024-04', expirationDate: '2026-12-31' },
      ],
      isAsset: false,
    },
    expected: {
      shouldCreateOpenBatch: true,
      discrepancy: 50,
      canonicalCount: 200,
      batchSum: 150,
    },
  },
  {
    name: 'Scenario 7: Legacy totalStockQuantity fallback (no batches or boxes)',
    item: {
      id: 'test-7',
      name: 'Legacy Item',
      unopenedBoxes: 0,
      itemsPerBox: 0,
      totalStockQuantity: 42,
      batches: [],
      isAsset: false,
    },
    expected: {
      shouldCreateOpenBatch: true,
      discrepancy: 42,
      canonicalCount: 42,
      batchSum: 0,
    },
  },
];

// Run tests
console.log('🧪 Running migration test scenarios...\n');

let passed = 0;
let failed = 0;

fixtures.forEach((fixture, idx) => {
  console.log(`Test ${idx + 1}: ${fixture.name}`);
  
  const result = analyzeItem(fixture.item);
  
  const checks = [
    { name: 'shouldCreateOpenBatch', actual: result.shouldCreateOpenBatch, expected: fixture.expected.shouldCreateOpenBatch },
    { name: 'discrepancy', actual: result.discrepancy, expected: fixture.expected.discrepancy },
    { name: 'canonicalCount', actual: result.canonicalCount, expected: fixture.expected.canonicalCount },
    { name: 'batchSum', actual: result.batchSum, expected: fixture.expected.batchSum },
  ];
  
  let testPassed = true;
  checks.forEach(check => {
    if (check.actual !== check.expected) {
      console.log(`  ❌ ${check.name}: expected ${check.expected}, got ${check.actual}`);
      testPassed = false;
    }
  });
  
  if (testPassed) {
    console.log(`  ✅ PASS`);
    passed++;
  } else {
    failed++;
  }
  
  console.log('');
});

console.log(`\n📊 Test Results:`);
console.log(`   Passed: ${passed}`);
console.log(`   Failed: ${failed}`);

if (failed > 0) {
  console.log('\n❌ Some tests failed. Review migration logic before applying to production.');
  process.exit(1);
} else {
  console.log('\n✅ All tests passed! Migration logic is ready.');
  process.exit(0);
}
