#!/usr/bin/env node
/**
 * Asset Migration Script
 * 
 * This script migrates the BMRC Logistics system to the new asset-based model:
 * 1. Marks inventory items over $500 threshold as tracked assets (isAsset=true)
 * 2. Computes and sets assetValue for statpacks based on their contents
 * 3. Validates serialized asset tracking
 * 4. Generates a comprehensive migration report
 * 
 * Usage:
 *   DRY_RUN=true node scripts/migrate-to-asset-model.js  # Preview changes
 *   node scripts/migrate-to-asset-model.js               # Apply changes
 */

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');
const path = require('path');

// Asset value threshold (configurable)
const ASSET_VALUE_THRESHOLD = process.env.ASSET_VALUE_THRESHOLD 
  ? Number(process.env.ASSET_VALUE_THRESHOLD) 
  : 500; // Default $500 USD

const DRY_RUN = process.env.DRY_RUN === 'true';

console.log('\n=== BMRC Asset Migration Script ===');
console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes will be made)' : 'LIVE (changes will be applied)'}`);
console.log(`Asset Value Threshold: $${ASSET_VALUE_THRESHOLD}`);
console.log('====================================\n');

// Initialize Firebase Admin
let serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!serviceAccountPath) {
  // Try common locations
  const candidates = [
    path.join(__dirname, '..', 'firebase-service-account.json'),
    path.join(__dirname, '..', 'serviceAccountKey.json'),
    path.join(__dirname, 'firebase-service-account.json'),
  ];
  serviceAccountPath = candidates.find(p => fs.existsSync(p));
}

if (!serviceAccountPath || !fs.existsSync(serviceAccountPath)) {
  console.error('❌ Firebase service account key not found!');
  console.error('Set FIREBASE_SERVICE_ACCOUNT env var or place firebase-service-account.json in project root');
  process.exit(1);
}

const serviceAccount = require(serviceAccountPath);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// Report tracking
const report = {
  inventory: {
    total: 0,
    newAssets: 0,
    existingAssets: 0,
    updated: [],
    errors: [],
  },
  statpacks: {
    total: 0,
    updated: 0,
    valueComputed: [],
    errors: [],
  },
  validation: {
    serializedAssets: [],
    missingValues: [],
    warnings: [],
  },
};

/**
 * Compute total asset value from statpack contents
 */
function computeStatpackAssetValue(statpack) {
  if (!statpack.contents || statpack.contents.length === 0) return 0;
  return statpack.contents.reduce((total, item) => {
    const itemValue = item.itemValue ?? item.itemDetails?.assetValue ?? 0;
    const qty = item.currentQuantity ?? item.requiredQuantity ?? 1;
    return total + (itemValue * qty);
  }, 0);
}

/**
 * Check if item should be marked as asset based on value or category
 */
function shouldBeAsset(item) {
  // Already marked as asset
  if (item.isAsset) return { shouldBe: true, reason: 'Already marked as asset' };
  
  // Check value threshold
  if (item.assetValue && item.assetValue >= ASSET_VALUE_THRESHOLD) {
    return { shouldBe: true, reason: `Value $${item.assetValue} >= threshold $${ASSET_VALUE_THRESHOLD}` };
  }
  
  // Check high-value categories
  const assetCategories = ['AED', 'Radio', 'Oxygen Tank', 'Generator', 'Monitor'];
  if (item.assetCategory && assetCategories.includes(item.assetCategory)) {
    return { shouldBe: true, reason: `High-value category: ${item.assetCategory}` };
  }
  
  // Check if it's oxygen equipment
  if (item.isOxygen) {
    return { shouldBe: true, reason: 'Oxygen equipment (assumed high-value)' };
  }
  
  // Check name patterns for common high-value items
  const name = (item.name || '').toLowerCase();
  if (name.includes('aed') || name.includes('defibrillator')) {
    return { shouldBe: true, reason: 'AED detected in name' };
  }
  if (name.includes('radio') || name.includes('walkie')) {
    return { shouldBe: true, reason: 'Radio detected in name' };
  }
  if (name.includes('o2') || name.includes('oxygen')) {
    return { shouldBe: true, reason: 'Oxygen detected in name' };
  }
  
  return { shouldBe: false, reason: 'Below threshold and not high-value category' };
}

/**
 * Validate serialized assets
 */
function validateSerializedAssets(item) {
  const issues = [];
  
  if (item.batches && Array.isArray(item.batches)) {
    item.batches.forEach((batch, idx) => {
      if (batch.serialized && batch.serialNumbers) {
        const expectedCount = batch.serialNumbers.length;
        const actualStock = batch.stock || 0;
        if (expectedCount !== actualStock) {
          issues.push({
            itemId: item.id,
            itemName: item.name,
            batchId: batch.id,
            issue: `Serialized count mismatch: ${expectedCount} serials vs ${actualStock} stock`,
          });
        }
      }
      
      // Check assetInstances
      if (batch.assetInstances && Array.isArray(batch.assetInstances)) {
        batch.assetInstances.forEach((asset, aIdx) => {
          if (!asset.serial) {
            issues.push({
              itemId: item.id,
              itemName: item.name,
              batchId: batch.id,
              issue: `AssetInstance ${aIdx} missing serial number`,
            });
          }
        });
      }
    });
  }
  
  // Check top-level assets array
  if (item.assets && Array.isArray(item.assets)) {
    item.assets.forEach((asset, idx) => {
      if (!asset.serial) {
        issues.push({
          itemId: item.id,
          itemName: item.name,
          issue: `Top-level asset ${idx} missing serial number`,
        });
      }
    });
  }
  
  return issues;
}

/**
 * Process inventory items
 */
async function migrateInventory() {
  console.log('📦 Processing inventory items...\n');
  
  const inventoryRef = db.collection('inventory');
  const snapshot = await inventoryRef.get();
  
  report.inventory.total = snapshot.size;
  
  for (const doc of snapshot.docs) {
    const item = { id: doc.id, ...doc.data() };
    
    // Validate serialized assets
    const validationIssues = validateSerializedAssets(item);
    if (validationIssues.length > 0) {
      report.validation.serializedAssets.push(...validationIssues);
    }
    
    // Check if should be asset
    const assetCheck = shouldBeAsset(item);
    
    if (assetCheck.shouldBe && !item.isAsset) {
      console.log(`✓ ${item.name} → Marking as asset (${assetCheck.reason})`);
      report.inventory.newAssets++;
      report.inventory.updated.push({
        id: item.id,
        name: item.name,
        reason: assetCheck.reason,
        value: item.assetValue,
      });
      
      if (!DRY_RUN) {
        try {
          await inventoryRef.doc(doc.id).update({
            isAsset: true,
            updatedAt: new Date(),
          });
        } catch (err) {
          console.error(`  ❌ Error updating ${item.name}:`, err.message);
          report.inventory.errors.push({ id: item.id, name: item.name, error: err.message });
        }
      }
    } else if (item.isAsset) {
      report.inventory.existingAssets++;
    }
    
    // Check for missing assetValue on assets
    if (item.isAsset && !item.assetValue) {
      report.validation.missingValues.push({
        id: item.id,
        name: item.name,
        type: 'inventory',
      });
    }
  }
  
  console.log(`\n  Total items: ${report.inventory.total}`);
  console.log(`  New assets: ${report.inventory.newAssets}`);
  console.log(`  Existing assets: ${report.inventory.existingAssets}`);
  console.log(`  Errors: ${report.inventory.errors.length}\n`);
}

/**
 * Process statpacks
 */
async function migrateStatpacks() {
  console.log('🎒 Processing statpacks...\n');
  
  const statpacksRef = db.collection('statpacks');
  const snapshot = await statpacksRef.get();
  
  report.statpacks.total = snapshot.size;
  
  for (const doc of snapshot.docs) {
    const statpack = { id: doc.id, ...doc.data() };
    const computedValue = computeStatpackAssetValue(statpack);
    
    // Always update if value changed or missing
    const currentValue = statpack.assetValue || 0;
    if (computedValue !== currentValue) {
      console.log(`✓ ${statpack.name} → Value: $${computedValue.toFixed(2)} (was $${currentValue.toFixed(2)})`);
      report.statpacks.updated++;
      report.statpacks.valueComputed.push({
        id: statpack.id,
        name: statpack.name,
        oldValue: currentValue,
        newValue: computedValue,
        itemCount: statpack.contents?.length || 0,
      });
      
      if (!DRY_RUN) {
        try {
          await statpacksRef.doc(doc.id).update({
            assetValue: computedValue,
            updatedAt: new Date(),
          });
        } catch (err) {
          console.error(`  ❌ Error updating ${statpack.name}:`, err.message);
          report.statpacks.errors.push({ id: statpack.id, name: statpack.name, error: err.message });
        }
      }
    }
    
    // Check if statpack has missing location
    if (!statpack.currentLocation) {
      report.validation.warnings.push({
        id: statpack.id,
        name: statpack.name,
        warning: 'Missing currentLocation field',
      });
    }
  }
  
  console.log(`\n  Total statpacks: ${report.statpacks.total}`);
  console.log(`  Updated: ${report.statpacks.updated}`);
  console.log(`  Errors: ${report.statpacks.errors.length}\n`);
}

/**
 * Print final report
 */
function printReport() {
  console.log('\n========================================');
  console.log('           MIGRATION REPORT            ');
  console.log('========================================\n');
  
  console.log('📦 INVENTORY:');
  console.log(`   Total items:      ${report.inventory.total}`);
  console.log(`   New assets:       ${report.inventory.newAssets}`);
  console.log(`   Existing assets:  ${report.inventory.existingAssets}`);
  console.log(`   Errors:           ${report.inventory.errors.length}`);
  
  console.log('\n🎒 STATPACKS:');
  console.log(`   Total statpacks:  ${report.statpacks.total}`);
  console.log(`   Values updated:   ${report.statpacks.updated}`);
  console.log(`   Errors:           ${report.statpacks.errors.length}`);
  
  console.log('\n⚠️  VALIDATION:');
  console.log(`   Serialized issues: ${report.validation.serializedAssets.length}`);
  console.log(`   Missing values:    ${report.validation.missingValues.length}`);
  console.log(`   Warnings:          ${report.validation.warnings.length}`);
  
  if (report.validation.serializedAssets.length > 0) {
    console.log('\n  Serialized Asset Issues:');
    report.validation.serializedAssets.slice(0, 10).forEach(issue => {
      console.log(`    - ${issue.itemName}: ${issue.issue}`);
    });
    if (report.validation.serializedAssets.length > 10) {
      console.log(`    ... and ${report.validation.serializedAssets.length - 10} more`);
    }
  }
  
  if (report.validation.missingValues.length > 0) {
    console.log('\n  Missing Asset Values:');
    report.validation.missingValues.slice(0, 10).forEach(item => {
      console.log(`    - ${item.name} (${item.type})`);
    });
    if (report.validation.missingValues.length > 10) {
      console.log(`    ... and ${report.validation.missingValues.length - 10} more`);
    }
  }
  
  console.log('\n========================================\n');
  
  // Save detailed report to file
  const reportPath = path.join(__dirname, '..', `asset-migration-report-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`📄 Detailed report saved to: ${reportPath}\n`);
  
  if (DRY_RUN) {
    console.log('🔍 DRY RUN COMPLETE - No changes were made');
    console.log('   Run without DRY_RUN=true to apply changes\n');
  } else {
    console.log('✅ MIGRATION COMPLETE\n');
  }
}

/**
 * Main execution
 */
async function main() {
  try {
    await migrateInventory();
    await migrateStatpacks();
    printReport();
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Migration failed:', err);
    process.exit(1);
  }
}

main();
