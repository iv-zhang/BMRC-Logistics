#!/usr/bin/env node

/**
 * Migration Script: Convert inventory from individual unit tracking to box-based tracking
 * 
 * This script:
 * 1. Resets all inventory items to 0 unopenedBoxes
 * 2. Sets itemsPerBox to null (will be filled in manually during reorganization)
 * 3. Removes deprecated quantity fields
 * 
 * Run: node scripts/migrate-to-boxes.js
 */

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// Initialize Firebase Admin SDK
// You'll need to set GOOGLE_APPLICATION_CREDENTIALS environment variable
// or provide service account credentials
const app = initializeApp();
const db = getFirestore(app);

async function migrateToBoxes() {
  console.log('🔄 Starting migration to box-based inventory tracking...\n');

  try {
    const inventoryRef = db.collection('inventory');
    const snapshot = await inventoryRef.get();

    console.log(`📦 Found ${snapshot.size} inventory items to migrate\n`);

    let successCount = 0;
    let errorCount = 0;

    // Process in batches of 500 (Firestore batch limit)
    const batchSize = 500;
    const docs = snapshot.docs;
    
    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = db.batch();
      const batchDocs = docs.slice(i, Math.min(i + batchSize, docs.length));

      for (const doc of batchDocs) {
        try {
          const data = doc.data();
          
          // Prepare box-based fields
          const updates = {
            unopenedBoxes: 0,
            itemsPerBox: null, // Will be filled manually during reorganization
            updatedAt: new Date(),
            
            // Mark old fields as deprecated by setting to undefined
            totalStockQuantity: 0, // Keep for backwards compat but reset to 0
            tracksOpenStock: false,
            quantityPerUnit: undefined,
            unopenedQuantity: undefined,
            openedQuantity: undefined,
            openedAt: undefined,
          };

          batch.update(doc.ref, updates);
          successCount++;
          
          if ((successCount + errorCount) % 50 === 0) {
            console.log(`  Processed ${successCount + errorCount}/${docs.length} items...`);
          }
        } catch (err) {
          console.error(`❌ Error processing ${doc.id}:`, err.message);
          errorCount++;
        }
      }

      // Commit this batch
      await batch.commit();
      console.log(`  ✅ Committed batch ${Math.floor(i / batchSize) + 1}`);
    }

    console.log('\n✨ Migration complete!');
    console.log(`  Success: ${successCount} items`);
    console.log(`  Errors: ${errorCount} items`);
    console.log('\n📝 Next steps:');
    console.log('  1. Count and organize physical boxes');
    console.log('  2. Update each item with actual unopenedBoxes count');
    console.log('  3. Set itemsPerBox for each item type');
    console.log('  4. Update reorderThreshold to reflect box counts\n');
    
  } catch (error) {
    console.error('💥 Migration failed:', error);
    process.exit(1);
  }
}

// Run migration
migrateToBoxes()
  .then(() => {
    console.log('Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
