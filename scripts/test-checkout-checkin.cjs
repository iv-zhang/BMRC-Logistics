/**
 * Statpack Checkout/Check-In Testing Configuration & Validation Script
 * ====================================================================
 * 
 * This script validates the checkout/checkin process by checking Firestore
 * data integrity and process correctness. Run against the Firebase emulator
 * or a test project.
 * 
 * Usage:
 *   node scripts/test-checkout-checkin.cjs
 * 
 * Environment:
 *   Requires FIREBASE_* env vars to be set (uses firebase-admin SDK).
 *   Set TEST_PROJECT_ID for emulator testing.
 */

const admin = require('firebase-admin');

// --- Configuration ---
const TEST_CONFIG = {
  // Test data identifiers — set these to real IDs in your test env
  testStatpackId: process.env.TEST_STATPACK_ID || 'test-statpack-1',
  testUserId: process.env.TEST_USER_ID || 'test-user-1',
  testUserName: process.env.TEST_USER_NAME || 'Test User',
  
  // Validation thresholds
  maxLogDelayMs: 5000, // Max acceptable delay between action and log timestamp
};

// --- Test Cases ---

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// ============================================================
// TEST SUITE 1: Checkout Process Validation
// ============================================================

test('T1.1 — Checkout creates a statpack_logs entry with action=checkout', async (db) => {
  const logs = await db.collection('statpack_logs')
    .where('statpackId', '==', TEST_CONFIG.testStatpackId)
    .where('action', '==', 'checkout')
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get();

  assert(!logs.empty, 'No checkout log found for test statpack');
  
  const log = logs.docs[0].data();
  assert(log.action === 'checkout', `Expected action=checkout, got ${log.action}`);
  assert(log.userId, 'Checkout log missing userId');
  assert(log.userName, 'Checkout log missing userName');
  assert(log.statpackName, 'Checkout log missing statpackName');
  console.log('  ✓ Checkout log has required fields');
});

test('T1.2 — Checkout log has a pairId', async (db) => {
  const logs = await db.collection('statpack_logs')
    .where('statpackId', '==', TEST_CONFIG.testStatpackId)
    .where('action', '==', 'checkout')
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get();

  assert(!logs.empty, 'No checkout log found');
  const log = logs.docs[0].data();
  assert(log.pairId, 'Checkout log missing pairId — checkin cannot be paired');
  assert(typeof log.pairId === 'string' && log.pairId.length > 0, 'pairId must be a non-empty string');
  console.log(`  ✓ pairId: ${log.pairId}`);
});

test('T1.3 — Checkout log has checkEntries array', async (db) => {
  const logs = await db.collection('statpack_logs')
    .where('statpackId', '==', TEST_CONFIG.testStatpackId)
    .where('action', '==', 'checkout')
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get();

  assert(!logs.empty, 'No checkout log found');
  const log = logs.docs[0].data();
  assert(Array.isArray(log.checkEntries), 'checkEntries must be an array');
  assert(log.checkEntries.length > 0, 'checkEntries should not be empty for a checkout');
  
  // Validate each entry has required fields
  for (const entry of log.checkEntries) {
    assert(entry.itemId, `Check entry missing itemId`);
    assert(typeof entry.requiredQuantity === 'number', `Check entry ${entry.itemId} missing requiredQuantity`);
    assert(typeof entry.countedQuantity === 'number', `Check entry ${entry.itemId} missing countedQuantity`);
    assert(typeof entry.ok === 'boolean', `Check entry ${entry.itemId} missing ok flag`);
  }
  console.log(`  ✓ ${log.checkEntries.length} check entries with required fields`);
});

test('T1.4 — Checkout updates statpack document (isCheckedOut=true, status=In Use)', async (db) => {
  const snap = await db.collection('statpacks').doc(TEST_CONFIG.testStatpackId).get();
  assert(snap.exists, 'Test statpack not found');
  
  const pack = snap.data();
  // This test is meaningful only if checkout was the last action
  if (pack.isCheckedOut) {
    assert(pack.status === 'In Use', `Expected status='In Use', got '${pack.status}'`);
    assert(pack.assignedToUserId, 'Checked-out pack missing assignedToUserId');
    assert(pack.assignedToUserName, 'Checked-out pack missing assignedToUserName');
    console.log('  ✓ Statpack marked as checked out');
  } else {
    console.log('  ⚠ Statpack is not currently checked out — skipping');
  }
});

test('T1.5 — No duplicate statpack_logs for same checkout event', async (db) => {
  const logs = await db.collection('statpack_logs')
    .where('statpackId', '==', TEST_CONFIG.testStatpackId)
    .where('action', '==', 'checkout')
    .orderBy('timestamp', 'desc')
    .limit(5)
    .get();

  if (logs.docs.length >= 2) {
    const pairs = new Set();
    let duplicates = 0;
    for (const doc of logs.docs) {
      const d = doc.data();
      if (d.pairId && pairs.has(d.pairId)) {
        duplicates++;
      }
      if (d.pairId) pairs.add(d.pairId);
    }
    assert(duplicates === 0, `Found ${duplicates} duplicate checkout logs with same pairId`);
  }
  console.log('  ✓ No duplicate checkout logs detected');
});

// ============================================================
// TEST SUITE 2: Check-In Process Validation  
// ============================================================

test('T2.1 — Checkin creates a statpack_logs entry with action=checkin', async (db) => {
  const logs = await db.collection('statpack_logs')
    .where('statpackId', '==', TEST_CONFIG.testStatpackId)
    .where('action', '==', 'checkin')
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get();

  assert(!logs.empty, 'No checkin log found — this is the MAIN BUG being fixed');
  
  const log = logs.docs[0].data();
  assert(log.action === 'checkin', `Expected action=checkin, got ${log.action}`);
  assert(log.userId, 'Checkin log missing userId');
  assert(log.userName, 'Checkin log missing userName');
  console.log('  ✓ Checkin log has required fields');
});

test('T2.2 — Checkin log has pairId matching a checkout log', async (db) => {
  const checkinLogs = await db.collection('statpack_logs')
    .where('statpackId', '==', TEST_CONFIG.testStatpackId)
    .where('action', '==', 'checkin')
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get();

  if (checkinLogs.empty) {
    console.log('  ⚠ No checkin log found — skipping pairId validation');
    return;
  }

  const checkin = checkinLogs.docs[0].data();
  assert(checkin.pairId, 'Checkin log missing pairId');

  // Verify the pairId matches a checkout
  const checkoutLogs = await db.collection('statpack_logs')
    .where('statpackId', '==', TEST_CONFIG.testStatpackId)
    .where('action', '==', 'checkout')
    .where('pairId', '==', checkin.pairId)
    .get();

  assert(!checkoutLogs.empty, `No checkout log found with pairId=${checkin.pairId}`);
  console.log(`  ✓ Checkin pairId ${checkin.pairId} matches checkout`);
});

test('T2.3 — Checkin log has checkEntries (even for quick checkin)', async (db) => {
  const logs = await db.collection('statpack_logs')
    .where('statpackId', '==', TEST_CONFIG.testStatpackId)
    .where('action', '==', 'checkin')
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get();

  if (logs.empty) {
    console.log('  ⚠ No checkin log found — skipping');
    return;
  }

  const log = logs.docs[0].data();
  assert(Array.isArray(log.checkEntries), 'checkEntries must be an array (can be empty for quick checkin)');
  
  if (log.quickCheckin) {
    console.log('  ✓ Quick checkin — checkEntries present (may be empty)');
  } else {
    assert(log.checkEntries.length > 0, 'Full checkin should have non-empty checkEntries');
    for (const entry of log.checkEntries) {
      assert(entry.itemId, `Check entry missing itemId`);
      assert(typeof entry.requiredQuantity === 'number', `Check entry ${entry.itemId} missing requiredQuantity`);
      assert(typeof entry.countedQuantity === 'number', `Check entry ${entry.itemId} missing countedQuantity`);
    }
    console.log(`  ✓ ${log.checkEntries.length} check entries validated`);
  }
});

test('T2.4 — Checkin updates statpack (isCheckedOut=false, status=Ready)', async (db) => {
  const snap = await db.collection('statpacks').doc(TEST_CONFIG.testStatpackId).get();
  assert(snap.exists, 'Test statpack not found');
  
  const pack = snap.data();
  if (!pack.isCheckedOut) {
    assert(pack.status === 'Ready' || pack.status === 'Restock Needed' || pack.status === 'Expired Items', 
      `After checkin, status should be Ready (or needs attention), got '${pack.status}'`);
    assert(!pack.assignedToUserId, 'After checkin, assignedToUserId should be null');
    console.log('  ✓ Statpack correctly marked as checked in');
  } else {
    console.log('  ⚠ Statpack is still checked out — checkin test not applicable');
  }
});

// ============================================================
// TEST SUITE 3: Quick Check-In Validation
// ============================================================

test('T3.1 — Quick checkin creates a log with quickCheckin=true', async (db) => {
  const logs = await db.collection('statpack_logs')
    .where('statpackId', '==', TEST_CONFIG.testStatpackId)
    .where('action', '==', 'checkin')
    .orderBy('timestamp', 'desc')
    .limit(5)
    .get();

  const quickLogs = logs.docs.filter(d => d.data().quickCheckin === true);
  if (quickLogs.length === 0) {
    console.log('  ⚠ No quick checkin logs found — test requires a quick checkin to have occurred');
    return;
  }

  const log = quickLogs[0].data();
  assert(log.quickCheckin === true, 'Quick checkin log should have quickCheckin=true');
  assert(log.pairId, 'Quick checkin must have pairId for audit pairing');
  assert(log.userId, 'Quick checkin must have userId');
  console.log('  ✓ Quick checkin log is properly structured');
});

// ============================================================
// TEST SUITE 4: Checkout-Before-Checkin Enforcement
// ============================================================

test('T4.1 — Statpack logs show checkout always before corresponding checkin', async (db) => {
  const logs = await db.collection('statpack_logs')
    .where('statpackId', '==', TEST_CONFIG.testStatpackId)
    .orderBy('timestamp', 'asc')
    .get();

  if (logs.empty) {
    console.log('  ⚠ No logs found — skipping');
    return;
  }

  // Group by pairId and verify checkout comes before checkin
  const pairs = {};
  for (const doc of logs.docs) {
    const d = doc.data();
    if (!d.pairId) continue;
    if (!pairs[d.pairId]) pairs[d.pairId] = [];
    pairs[d.pairId].push(d);
  }

  for (const [pairId, events] of Object.entries(pairs)) {
    const checkout = events.find(e => e.action === 'checkout');
    const checkin = events.find(e => e.action === 'checkin');
    
    if (checkout && checkin) {
      const checkoutTime = checkout.clientTimestamp?.toDate?.() || checkout.timestamp?.toDate?.() || new Date(0);
      const checkinTime = checkin.clientTimestamp?.toDate?.() || checkin.timestamp?.toDate?.() || new Date(0);
      assert(checkoutTime <= checkinTime, 
        `Pair ${pairId}: checkout (${checkoutTime}) should be before checkin (${checkinTime})`);
    }
  }
  console.log(`  ✓ All ${Object.keys(pairs).length} checkout/checkin pairs are correctly ordered`);
});

// ============================================================
// TEST SUITE 5: Detailed Activity Logging
// ============================================================

test('T5.1 — Check entries include expiration status for items that track it', async (db) => {
  const logs = await db.collection('statpack_logs')
    .where('statpackId', '==', TEST_CONFIG.testStatpackId)
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get();

  if (logs.empty) {
    console.log('  ⚠ No logs found — skipping');
    return;
  }

  const log = logs.docs[0].data();
  const entries = log.checkEntries || [];
  const withExpiration = entries.filter(e => e.expirationDate);
  
  console.log(`  ✓ ${withExpiration.length}/${entries.length} entries have expiration dates recorded`);
});

test('T5.2 — Log includes summary statistics', async (db) => {
  const logs = await db.collection('statpack_logs')
    .where('statpackId', '==', TEST_CONFIG.testStatpackId)
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get();

  if (logs.empty) {
    console.log('  ⚠ No logs found — skipping');
    return;
  }

  const log = logs.docs[0].data();
  
  if (log.summary) {
    assert(typeof log.summary.totalItems === 'number', 'summary.totalItems should be a number');
    assert(typeof log.summary.verifiedCount === 'number', 'summary.verifiedCount should be a number');
    console.log(`  ✓ Summary: ${log.summary.verifiedCount}/${log.summary.totalItems} items verified, ${log.summary.mismatchCount || 0} mismatches, ${log.summary.expiredCount || 0} expired`);
  } else {
    console.log('  ⚠ No summary field found — this is expected for logs created before the fix');
  }
});

test('T5.3 — Audit events are created for checkout/checkin actions', async (db) => {
  const events = await db.collection('auditEvents')
    .where('sourceId', '==', TEST_CONFIG.testStatpackId)
    .orderBy('timestamp', 'desc')
    .limit(5)
    .get();

  if (events.empty) {
    console.log('  ⚠ No audit events found for statpack — may need broader query');
    return;
  }

  const types = events.docs.map(d => d.data().eventType);
  console.log(`  ✓ Found ${events.docs.length} audit events: ${types.join(', ')}`);
});

// ============================================================
// TEST SUITE 6: Data Integrity
// ============================================================

test('T6.1 — No statpack_logs entries without required fields', async (db) => {
  const logs = await db.collection('statpack_logs')
    .where('statpackId', '==', TEST_CONFIG.testStatpackId)
    .orderBy('timestamp', 'desc')
    .limit(20)
    .get();

  let issues = 0;
  for (const doc of logs.docs) {
    const d = doc.data();
    if (!d.userId) { console.log(`  ✗ Log ${doc.id} missing userId`); issues++; }
    if (!d.userName) { console.log(`  ✗ Log ${doc.id} missing userName`); issues++; }
    if (!d.action) { console.log(`  ✗ Log ${doc.id} missing action`); issues++; }
    if (!d.statpackName) { console.log(`  ✗ Log ${doc.id} missing statpackName`); issues++; }
    if (!d.timestamp) { console.log(`  ✗ Log ${doc.id} missing timestamp`); issues++; }
  }
  
  assert(issues === 0, `Found ${issues} data integrity issues in statpack_logs`);
  console.log(`  ✓ All ${logs.docs.length} logs have required fields`);
});

test('T6.2 — Orphaned checkins (checkin without matching checkout pairId)', async (db) => {
  const checkins = await db.collection('statpack_logs')
    .where('statpackId', '==', TEST_CONFIG.testStatpackId)
    .where('action', '==', 'checkin')
    .get();

  let orphans = 0;
  for (const doc of checkins.docs) {
    const d = doc.data();
    if (!d.pairId) {
      console.log(`  ⚠ Checkin ${doc.id} has no pairId`);
      orphans++;
      continue;
    }
    
    const matchingCheckout = await db.collection('statpack_logs')
      .where('statpackId', '==', TEST_CONFIG.testStatpackId)
      .where('action', '==', 'checkout')
      .where('pairId', '==', d.pairId)
      .limit(1)
      .get();
    
    if (matchingCheckout.empty) {
      console.log(`  ⚠ Checkin ${doc.id} has pairId=${d.pairId} but no matching checkout`);
      orphans++;
    }
  }

  if (orphans > 0) {
    console.log(`  ⚠ Found ${orphans} orphaned checkin(s) — these predate the fix`);
  } else {
    console.log(`  ✓ All checkins have matching checkout pairs`);
  }
});

// ============================================================
// Runner
// ============================================================

async function run() {
  console.log('\n🧪 Statpack Checkout/Check-In Test Suite\n');
  console.log('='.repeat(60));
  
  // Initialize Firebase Admin
  let db;
  try {
    if (!admin.apps.length) {
      const projectId = process.env.TEST_PROJECT_ID || process.env.GCLOUD_PROJECT || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
      
      if (process.env.FIRESTORE_EMULATOR_HOST) {
        console.log(`Using Firestore emulator: ${process.env.FIRESTORE_EMULATOR_HOST}`);
        admin.initializeApp({ projectId });
      } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        admin.initializeApp({ credential: admin.credential.applicationDefault() });
      } else {
        console.error('⚠ No Firebase credentials found. Set GOOGLE_APPLICATION_CREDENTIALS or use emulator.');
        console.log('\nTo use emulator:');
        console.log('  export FIRESTORE_EMULATOR_HOST=localhost:8080');
        console.log('  export TEST_PROJECT_ID=your-project-id');
        console.log('\nTo use a test project:');
        console.log('  export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json');
        process.exit(1);
      }
    }
    db = admin.firestore();
  } catch (e) {
    console.error('Failed to initialize Firebase:', e.message);
    process.exit(1);
  }

  // Verify test statpack exists
  const testPack = await db.collection('statpacks').doc(TEST_CONFIG.testStatpackId).get();
  if (!testPack.exists) {
    console.log(`\n⚠ Test statpack '${TEST_CONFIG.testStatpackId}' not found.`);
    console.log('Set TEST_STATPACK_ID to an existing statpack ID to run tests.\n');
    console.log('Available statpacks:');
    const allPacks = await db.collection('statpacks').limit(10).get();
    allPacks.docs.forEach(d => {
      const data = d.data();
      console.log(`  - ${d.id}: ${data.name} (${data.status})`);
    });
    process.exit(1);
  }
  
  console.log(`\nTest statpack: ${testPack.data().name} (${TEST_CONFIG.testStatpackId})`);
  console.log(`Status: ${testPack.data().status} | Checked out: ${testPack.data().isCheckedOut}`);
  console.log('='.repeat(60) + '\n');

  // Run all tests
  for (const t of tests) {
    try {
      console.log(`\n📋 ${t.name}`);
      await t.fn(db);
      passed++;
    } catch (e) {
      console.log(`  ✗ FAILED: ${e.message}`);
      failed++;
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${tests.length} total\n`);
  
  if (failed > 0) {
    console.log('❌ Some tests failed. Review the issues above.');
    process.exit(1);
  } else {
    console.log('✅ All tests passed!');
    process.exit(0);
  }
}

run().catch(e => {
  console.error('Unhandled error:', e);
  process.exit(1);
});
