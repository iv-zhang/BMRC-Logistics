#!/usr/bin/env node

/**
 * Migration Script: Convert Open/Unreconciled Inventory Counts to Open Batches
 * 
 * Purpose: Implement Option A (manual consumption migration) by creating explicit
 * "open batch" records for existing inventory items that have open/unreconciled counts.
 * 
 * This script:
 * 1. Scans all inventory documents
 * 2. For each item, computes canonical physical count:
 *    - If batch-tracked: sum(batches.stock)
 *    - Otherwise: unopenedBoxes * itemsPerBox OR totalStockQuantity fallback
 * 3. If canonical total > sum(batch.stock), creates a new "open" batch
 * 4. Preserves serialized/asset semantics (no open batches for serialized items)
 * 5. Writes audit logs to inventory_migrations and inventory_logs
 * 
 * Usage:
 *   node scripts/migrate-open-to-open-batches.js --dry-run       # Preview changes
 *   node scripts/migrate-open-to-open-batches.js --force         # Apply changes
 *   node scripts/migrate-open-to-open-batches.js --help          # Show help
 * 
 * Options:
 *   --dry-run         Preview changes without writing to Firestore
 *   --force           Apply changes (requires confirmation)
 *   --batch-size N    Process N items at a time (default: 50)
 *   --userId ID       Set operator userId for audit logs (default: 'migration-script')
 *   --help            Show this help message
 */

const admin = require('firebase-admin');
const readline = require('readline');

// Initialize Firebase Admin SDK
// Expects GOOGLE_APPLICATION_CREDENTIALS env var or default credentials
try {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
} catch (e) {
  console.error('Failed to initialize Firebase Admin SDK:', e.message);
  console.error('Set GOOGLE_APPLICATION_CREDENTIALS or use gcloud auth application-default login');
  process.exit(1);
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// Parse CLI args
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isForce = args.includes('--force');
const showHelp = args.includes('--help');
const batchSizeArg = args.find(a => a.startsWith('--batch-size='));
const userIdArg = args.find(a => a.startsWith('--userId='));

const batchSize = batchSizeArg ? parseInt(batchSizeArg.split('=')[1]) : 50;
const operatorUserId = userIdArg ? userIdArg.split('=')[1] : 'migration-script';

if (showHelp || (!isDryRun && !isForce)) {
  console.log(`
Migration Script: Convert Open/Unreconciled Counts to Open Batches

Usage:
  node scripts/migrate-open-to-open-batches.js --dry-run       # Preview
  node scripts/migrate-open-to-open-batches.js --force         # Apply

Options:
  --dry-run         Preview changes without writing
  --force           Apply changes (requires confirmation)
  --batch-size N    Process N items at a time (default: 50)
  --userId ID       Operator userId for audit logs (default: 'migration-script')
  --help            Show this help

Examples:
  node scripts/migrate-open-to-open-batches.js --dry-run
  node scripts/migrate-open-to-open-batches.js --force --userId=admin-uid
  `);
  process.exit(0);
}

// Helper: generate unique batch ID
function generateBatchId() {
  return `open-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// Helper: compute canonical physical count for an item
function computeCanonicalCount(item) {
  // Canonical count is the expected physical inventory:
  // Priority: unopenedBoxes * itemsPerBox (sealed inventory is source of truth)
  // Fallback: totalStockQuantity (legacy field)
  // Batches are what we reconcile AGAINST, not the canonical source
  const unopenedBoxes = item.unopenedBoxes || 0;
  const itemsPerBox = item.itemsPerBox || 1;
  const totalStockQuantity = item.totalStockQuantity || 0;
  
  if (unopenedBoxes > 0 && itemsPerBox > 0) {
    return unopenedBoxes * itemsPerBox;
  }
  
  return totalStockQuantity;
}

// Helper: compute discrepancy and create open batch if needed
function analyzeItem(item) {
  const batches = item.batches || [];
  const batchSum = batches.reduce((sum, b) => sum + (b.stock || 0), 0);
  const canonicalCount = computeCanonicalCount(item);
  const discrepancy = canonicalCount - batchSum;
  
  // Check if item has serialized batches (don't create numeric open batches)
  const hasSerialized = batches.some(b => b.serialized || (b.serialNumbers && b.serialNumbers.length > 0));
  
  const shouldCreateOpenBatch = discrepancy > 0 && !hasSerialized && !item.isAsset;
  
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    isAsset: item.isAsset || false,
    unopenedBoxes: item.unopenedBoxes || 0,
    itemsPerBox: item.itemsPerBox || 1,
    totalStockQuantity: item.totalStockQuantity || 0,
    batchCount: batches.length,
    batchSum,
    canonicalCount,
    discrepancy,
    hasSerialized,
    shouldCreateOpenBatch,
    proposedOpenBatch: shouldCreateOpenBatch ? {
      id: generateBatchId(),
      stock: discrepancy,
      lotNumber: 'OPEN',
      openDate: admin.firestore.Timestamp.now(),
      notes: 'Converted from open/unreconciled counts (migration)',
    } : null,
  };
}

// Main migration function
async function runMigration() {
  console.log(`\n🔍 Scanning inventory collection...`);
  console.log(`   Mode: ${isDryRun ? 'DRY RUN (preview only)' : 'FORCE (will apply changes)'}`);
  console.log(`   Batch size: ${batchSize}`);
  console.log(`   Operator: ${operatorUserId}\n`);
  
  const inventoryRef = db.collection('inventory');
  const snapshot = await inventoryRef.get();
  
  if (snapshot.empty) {
    console.log('❌ No inventory documents found.');
    return;
  }
  
  console.log(`✓ Found ${snapshot.size} inventory documents\n`);
  
  const analyses = [];
  const itemsToMigrate = [];
  
  // Analyze all items
  snapshot.forEach(doc => {
    const item = { id: doc.id, ...doc.data() };
    const analysis = analyzeItem(item);
    analyses.push(analysis);
    
    if (analysis.shouldCreateOpenBatch) {
      itemsToMigrate.push({ doc, analysis });
    }
  });
  
  // Print summary
  console.log('📊 Migration Analysis:');
  console.log(`   Total items: ${analyses.length}`);
  console.log(`   Items with discrepancies: ${analyses.filter(a => a.discrepancy > 0).length}`);
  console.log(`   Items needing open batch creation: ${itemsToMigrate.length}`);
  console.log(`   Items skipped (assets/serialized): ${analyses.filter(a => a.discrepancy > 0 && !a.shouldCreateOpenBatch).length}\n`);
  
  if (itemsToMigrate.length === 0) {
    console.log('✅ No open batches needed. All inventory is reconciled.');
    return;
  }
  
  // Print preview table
  console.log('📋 Items to migrate:\n');
  console.table(itemsToMigrate.map(({ analysis }) => ({
    ID: analysis.id.slice(0, 8) + '...',
    Name: analysis.name?.slice(0, 30) || 'Unknown',
    'Batch Sum': analysis.batchSum,
    'Canonical': analysis.canonicalCount,
    'Discrepancy': analysis.discrepancy,
    'Open Batch Stock': analysis.proposedOpenBatch?.stock,
  })));
  
  if (isDryRun) {
    console.log('\n✅ Dry run complete. No changes written.');
    console.log('   To apply changes, run with --force flag.\n');
    return;
  }
  
  // Confirm before applying
  console.log(`\n⚠️  About to create ${itemsToMigrate.length} open batches.`);
  const confirmed = await confirm('Proceed with migration?');
  
  if (!confirmed) {
    console.log('❌ Migration cancelled by user.');
    return;
  }
  
  console.log('\n🚀 Applying migration...\n');
  
  let successCount = 0;
  let failureCount = 0;
  const failures = [];
  
  // Process in batches
  for (let i = 0; i < itemsToMigrate.length; i += batchSize) {
    const chunk = itemsToMigrate.slice(i, i + batchSize);
    const batch = db.batch();
    
    for (const { doc, analysis } of chunk) {
      try {
        const itemRef = db.collection('inventory').doc(doc.id);
        const currentItem = doc.data();
        const currentBatches = currentItem.batches || [];
        const newBatch = analysis.proposedOpenBatch;
        
        // Update inventory doc with new batch
        batch.update(itemRef, {
          batches: [...currentBatches, newBatch],
          updatedAt: FieldValue.serverTimestamp(),
        });
        
        // Create audit log in inventory_logs
        const logRef = db.collection('inventory_logs').doc();
        batch.set(logRef, {
          itemId: doc.id,
          itemName: currentItem.name || 'Unknown',
          action: 'migration_create_open_batch',
          batchId: newBatch.id,
          quantity: newBatch.stock,
          userId: operatorUserId,
          userName: 'Migration Script',
          timestamp: FieldValue.serverTimestamp(),
          notes: 'Created open batch from migration script (reconciling open counts)',
          beforeBatchSum: analysis.batchSum,
          afterBatchSum: analysis.batchSum + newBatch.stock,
          canonicalCount: analysis.canonicalCount,
        });
        
        // Create migration record
        const migrationRef = db.collection('inventory_migrations').doc();
        batch.set(migrationRef, {
          itemId: doc.id,
          itemName: currentItem.name || 'Unknown',
          migrationType: 'open_batch_creation',
          operatorUserId,
          timestamp: FieldValue.serverTimestamp(),
          before: {
            batchCount: currentBatches.length,
            batchSum: analysis.batchSum,
            unopenedBoxes: currentItem.unopenedBoxes || 0,
          },
          after: {
            batchCount: currentBatches.length + 1,
            batchSum: analysis.batchSum + newBatch.stock,
            unopenedBoxes: currentItem.unopenedBoxes || 0,
          },
          createdBatchId: newBatch.id,
          createdBatchStock: newBatch.stock,
        });
        
        successCount++;
      } catch (e) {
        console.error(`Failed to migrate ${doc.id}:`, e.message);
        failures.push({ id: doc.id, name: analysis.name, error: e.message });
        failureCount++;
      }
    }
    
    // Commit batch
    await batch.commit();
    console.log(`   Processed ${Math.min(i + batchSize, itemsToMigrate.length)} / ${itemsToMigrate.length}`);
  }
  
  console.log(`\n✅ Migration complete!`);
  console.log(`   Success: ${successCount}`);
  console.log(`   Failures: ${failureCount}\n`);
  
  if (failures.length > 0) {
    console.log('❌ Failed items:');
    console.table(failures);
  }
}

// Helper: prompt user for confirmation
function confirm(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  return new Promise(resolve => {
    rl.question(`${question} (yes/no): `, answer => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
    });
  });
}

// Run migration
runMigration()
  .then(() => {
    console.log('\n🏁 Script finished.');
    process.exit(0);
  })
  .catch(err => {
    console.error('\n❌ Migration failed:', err);
    process.exit(1);
  });
