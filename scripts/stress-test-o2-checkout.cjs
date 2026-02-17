/**
 * Stress Test: Concurrent Statpack Checkouts with O₂ PSI Data
 * 
 * This script simulates 50 concurrent users attempting to checkout statpacks
 * with O₂ PSI readings to verify:
 * 1. Transaction atomicity (no race conditions)
 * 2. Data integrity (all O₂ readings preserved)
 * 3. Correct statpack state updates
 * 4. No double-checkouts allowed
 * 
 * Usage:
 *   node scripts/stress-test-o2-checkout.cjs
 * 
 * Requirements:
 *   - Firebase admin SDK initialized
 *   - Test statpacks in Firestore
 */

const admin = require('firebase-admin');
const { readFileSync } = require('fs');

// Initialize Firebase Admin (assumes service account in project root)
try {
  const serviceAccount = JSON.parse(
    readFileSync('./service-account-key.json', 'utf8')
  );
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
} catch (error) {
  console.error('❌ Failed to initialize Firebase Admin:', error.message);
  console.error('Ensure service-account-key.json exists in project root');
  process.exit(1);
}

const db = admin.firestore();

// Test configuration
const CONCURRENT_WORKERS = 50;
const STATPACK_ID = 'test-statpack-stress';
const OXYGEN_ITEM_ID = 'test-oxygen-tank-001';

/**
 * Generate realistic O₂ PSI reading with slight variation
 */
function generateO2Psi(baselinePsi = 2000) {
  // Add random variation ±50 PSI to simulate real readings
  const variation = Math.floor(Math.random() * 100) - 50;
  return Math.max(1800, Math.min(2200, baselinePsi + variation));
}

/**
 * Create or reset test statpack
 */
async function setupTestStatpack() {
  const statpackRef = db.collection('statpacks').doc(STATPACK_ID);
  
  await statpackRef.set({
    id: STATPACK_ID,
    name: 'Stress Test Statpack',
    status: 'Ready',
    isCheckedOut: false,
    contents: [
      {
        itemId: OXYGEN_ITEM_ID,
        itemDetails: {
          name: 'Test Oxygen Tank',
          isOxygen: true,
          verificationPolicy: {
            requireO2PsiMin: 1800,
          },
        },
        requiredQuantity: 1,
        pocket: 'main',
      },
    ],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  
  console.log(`✅ Created test statpack: ${STATPACK_ID}`);
}

/**
 * Simulate a single checkout attempt
 */
async function attemptCheckout(workerId) {
  const userId = `stress-test-user-${workerId}`;
  const userName = `Test User ${workerId}`;
  const o2Psi = generateO2Psi();
  
  const statpackRef = db.collection('statpacks').doc(STATPACK_ID);
  const logRef = db.collection('statpack_logs').doc();
  
  try {
    const result = await db.runTransaction(async (tx) => {
      const statpackDoc = await tx.get(statpackRef);
      
      if (!statpackDoc.exists) {
        throw new Error('Statpack not found');
      }
      
      const statpackData = statpackDoc.data();
      
      // Transaction should prevent double-checkout
      if (statpackData.isCheckedOut) {
        throw new Error('Statpack already checked out');
      }
      
      // Update statpack
      tx.update(statpackRef, {
        isCheckedOut: true,
        status: 'In Use',
        assignedToUserId: userId,
        assignedToUserName: userName,
        checkedOutAt: admin.firestore.FieldValue.serverTimestamp(),
        lastCheckedBy: userName,
        lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      
      // Create log with O₂ PSI data
      tx.set(logRef, {
        statpackId: STATPACK_ID,
        statpackName: 'Stress Test Statpack',
        action: 'checkout',
        userId,
        userName,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        clientTimestamp: new Date(),
        checkEntries: [
          {
            itemId: OXYGEN_ITEM_ID,
            itemName: 'Test Oxygen Tank',
            requiredQuantity: 1,
            countedQuantity: 1,
            ok: true,
            assetCheckResult: {
              oxygenPsi: o2Psi,
            },
            checkedBy: userId,
            checkedAt: new Date(),
          },
        ],
        summary: {
          totalItems: 1,
          verifiedCount: 1,
          mismatchCount: 0,
          expiredCount: 0,
        },
      });
      
      return { success: true, o2Psi, logId: logRef.id };
    });
    
    return {
      workerId,
      success: true,
      o2Psi: result.o2Psi,
      logId: result.logId,
    };
  } catch (error) {
    return {
      workerId,
      success: false,
      error: error.message,
    };
  }
}

/**
 * Reset statpack to Ready state
 */
async function resetStatpack() {
  const statpackRef = db.collection('statpacks').doc(STATPACK_ID);
  await statpackRef.update({
    isCheckedOut: false,
    status: 'Ready',
    assignedToUserId: null,
    assignedToUserName: null,
    checkedOutAt: null,
  });
}

/**
 * Verify data integrity of logged O₂ readings
 */
async function verifyDataIntegrity(results) {
  const successfulCheckouts = results.filter(r => r.success);
  
  if (successfulCheckouts.length === 0) {
    console.error('❌ No successful checkouts to verify');
    return false;
  }
  
  console.log(`\n📊 Verifying ${successfulCheckouts.length} successful checkout logs...`);
  
  const logs = await db
    .collection('statpack_logs')
    .where('statpackId', '==', STATPACK_ID)
    .orderBy('clientTimestamp', 'desc')
    .limit(successfulCheckouts.length)
    .get();
  
  let integrityPassed = true;
  
  logs.forEach((doc) => {
    const log = doc.data();
    const checkEntry = log.checkEntries?.[0];
    
    if (!checkEntry) {
      console.error(`❌ Log ${doc.id} missing checkEntries`);
      integrityPassed = false;
      return;
    }
    
    if (!checkEntry.assetCheckResult) {
      console.error(`❌ Log ${doc.id} missing assetCheckResult`);
      integrityPassed = false;
      return;
    }
    
    const o2Psi = checkEntry.assetCheckResult.oxygenPsi;
    
    if (o2Psi === undefined || o2Psi === null) {
      console.error(`❌ Log ${doc.id} missing oxygenPsi`);
      integrityPassed = false;
      return;
    }
    
    if (o2Psi < 1750 || o2Psi > 2250) {
      console.warn(`⚠️  Log ${doc.id} has unusual O₂ PSI: ${o2Psi}`);
    }
    
    console.log(`✅ Log ${doc.id}: O₂ PSI = ${o2Psi}`);
  });
  
  return integrityPassed;
}

/**
 * Analyze checkout results
 */
function analyzeResults(results) {
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  
  console.log('\n📈 STRESS TEST RESULTS');
  console.log('='.repeat(50));
  console.log(`Total workers: ${CONCURRENT_WORKERS}`);
  console.log(`Successful checkouts: ${successful.length}`);
  console.log(`Failed checkouts: ${failed.length}`);
  
  if (successful.length > 0) {
    const o2Readings = successful.map(r => r.o2Psi);
    const avgO2 = o2Readings.reduce((a, b) => a + b, 0) / o2Readings.length;
    const minO2 = Math.min(...o2Readings);
    const maxO2 = Math.max(...o2Readings);
    
    console.log(`\nO₂ PSI Statistics:`);
    console.log(`  Average: ${avgO2.toFixed(0)} PSI`);
    console.log(`  Min: ${minO2} PSI`);
    console.log(`  Max: ${maxO2} PSI`);
  }
  
  if (failed.length > 0) {
    console.log('\nFailure reasons:');
    const errorCounts = {};
    failed.forEach(r => {
      errorCounts[r.error] = (errorCounts[r.error] || 0) + 1;
    });
    Object.entries(errorCounts).forEach(([error, count]) => {
      console.log(`  ${error}: ${count}`);
    });
  }
  
  // Transaction atomicity check
  if (successful.length === 1 && failed.every(r => r.error === 'Statpack already checked out')) {
    console.log('\n✅ ATOMICITY VERIFIED: Only 1 checkout succeeded, all others properly blocked');
  } else if (successful.length > 1) {
    console.error('\n❌ ATOMICITY FAILED: Multiple concurrent checkouts succeeded!');
    console.error('This indicates a race condition in transaction handling');
  }
}

/**
 * Main stress test execution
 */
async function runStressTest() {
  console.log('🚀 Starting O₂ PSI Checkout Stress Test\n');
  
  // Setup
  await setupTestStatpack();
  
  console.log(`\n🔥 Launching ${CONCURRENT_WORKERS} concurrent checkout workers...\n`);
  
  // Launch all workers simultaneously
  const workers = Array.from({ length: CONCURRENT_WORKERS }, (_, i) => 
    attemptCheckout(i + 1)
  );
  
  // Wait for all to complete
  const results = await Promise.all(workers);
  
  // Analyze results
  analyzeResults(results);
  
  // Verify data integrity
  const integrityOk = await verifyDataIntegrity(results);
  
  if (integrityOk) {
    console.log('\n✅ DATA INTEGRITY VERIFIED: All O₂ readings correctly persisted');
  } else {
    console.error('\n❌ DATA INTEGRITY FAILED: Some O₂ readings missing or corrupted');
  }
  
  // Cleanup
  console.log('\n🧹 Cleaning up test data...');
  await resetStatpack();
  
  // Delete test logs
  const logsToDelete = await db
    .collection('statpack_logs')
    .where('statpackId', '==', STATPACK_ID)
    .get();
  
  const batch = db.batch();
  logsToDelete.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
  
  console.log(`✅ Deleted ${logsToDelete.size} test logs`);
  console.log('\n✅ Stress test complete!');
}

// Run the stress test
runStressTest()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n❌ Stress test failed:', error);
    process.exit(1);
  });
