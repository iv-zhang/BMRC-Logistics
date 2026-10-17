#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Report the inventory existence baseline (confirmed/unverified/retired).
 *
 * Reads the live `inventory` collection and classifies each item by existence:
 * - retired: stored `existence === 'retired'`
 * - confirmed: not retired AND `lastAuditDate >= 2026-06-01`
 * - unverified: everything else
 *
 * Reports totals, per-category, per-location, and unverified stock > 0.
 * Never writes to Firestore.
 *
 * Usage:
 *   node ./scripts/report-existence-baseline.cjs [--list]
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS for live mode.
 */

// June 1, 2026 00:00 UTC (matching EXISTENCE_BASELINE_CUTOFF in item-status.ts)
const EXISTENCE_BASELINE_CUTOFF = new Date(2026, 5, 1, 0, 0, 0, 0).getTime();

/**
 * Parse a date from multiple formats: Date, Firestore Timestamp (with toDate method),
 * {seconds, nanoseconds} map, or ISO string.
 * Pure function; always available.
 */
function parseDate(v) {
  if (v === undefined || v === null) return undefined;
  if (v instanceof Date) {
    return isNaN(v.getTime()) ? undefined : v;
  }
  // Firestore Timestamp or Timestamp-like object
  if (v && typeof v.toDate === 'function') {
    try {
      const d = v.toDate();
      return d instanceof Date && !isNaN(d.getTime()) ? d : undefined;
    } catch {
      return undefined;
    }
  }
  // {seconds, nanoseconds} map from Firestore
  if (v && typeof v === 'object' && typeof v.seconds === 'number') {
    return new Date(v.seconds * 1000);
  }
  // ISO string or other parseable date
  if (typeof v === 'string') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

/**
 * Classify an inventory item's existence.
 * Pure function; safe to require without connecting to Firestore.
 */
function classifyExistence(item) {
  if (item.existence === 'retired') {
    return 'retired';
  }
  const audited = parseDate(item.lastAuditDate);
  if (audited && audited.getTime() >= EXISTENCE_BASELINE_CUTOFF) {
    // EXISTENCE_BASELINE_CUTOFF is already a timestamp in milliseconds
    return 'confirmed';
  }
  return 'unverified';
}

/**
 * Classify unverified items into "never audited" vs "audited before cutoff".
 * Pure function; safe to require without connecting to Firestore.
 */
function classifyUnverified(item) {
  const audited = parseDate(item.lastAuditDate);
  if (!audited) return 'never_audited';
  return 'audited_before_cutoff';
}

/**
 * Compute stock quantity for an item (back-room reserve pool).
 * Pure function; safe to require without connecting to Firestore.
 */
function getStock(item) {
  // Bag-tracked: sum batches
  if (Array.isArray(item.batches) && item.batches.length > 0) {
    return item.batches.reduce((acc, b) => {
      const bags = b.bagCount ?? 0;
      const perBag = b.itemsPerBag ?? 0;
      const loose = b.looseItems ?? 0;
      return acc + bags * perBag + loose;
    }, 0);
  }
  // Box-tracked: unopenedBoxes * itemsPerBox + looseUnits
  const boxes = item.unopenedBoxes ?? 0;
  const perBox = item.itemsPerBox ?? 0;
  const loose = item.looseUnits ?? 0;
  if (perBox > 0) return boxes * perBox + loose;
  return boxes;
}

// Export pure functions for testing (before main() so tests don't trigger admin init)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { classifyExistence, classifyUnverified, parseDate, getStock, EXISTENCE_BASELINE_CUTOFF };
}

async function main() {
  const argv = process.argv.slice(2);
  const shouldList = argv.includes('--list');

  let admin;
  try {
    admin = require('firebase-admin');
  } catch {
    console.error('Install firebase-admin to run reports: npm i firebase-admin');
    process.exit(1);
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error('Set GOOGLE_APPLICATION_CREDENTIALS to a service account JSON to run reports.');
    process.exit(1);
  }

  admin.initializeApp();
  const db = admin.firestore();

  console.log('Reading inventory collection...');
  const snap = await db.collection('inventory').get();
  const docs = snap.docs.map(d => ({
    id: d.id,
    data: d.data(),
  }));

  if (docs.length === 0) {
    console.log('No inventory items found.');
    return;
  }

  // Classify each item
  const classified = docs.map(d => ({
    id: d.id,
    name: d.data.name || '',
    category: d.data.category || 'Uncategorized',
    location: d.data.location || d.data.storageLocation?.zoneId || 'Unknown',
    room: d.data.room || '',
    existence: classifyExistence(d.data),
    unverifiedType: classifyUnverified(d.data),
    stock: getStock(d.data),
  }));

  // Aggregate totals
  const totals = {
    confirmed: 0,
    unverified: 0,
    retired: 0,
  };
  const unverifiedDetails = {
    never_audited: 0,
    audited_before_cutoff: 0,
  };
  const unverifiedWithStock = [];
  const byCategory = {};
  const byLocation = {};

  classified.forEach(item => {
    totals[item.existence]++;

    if (item.existence === 'unverified') {
      unverifiedDetails[item.unverifiedType]++;
      if (item.stock > 0) {
        unverifiedWithStock.push(item);
      }
    }

    // By category
    if (!byCategory[item.category]) {
      byCategory[item.category] = { confirmed: 0, unverified: 0, retired: 0 };
    }
    byCategory[item.category][item.existence]++;

    // By location
    if (!byLocation[item.location]) {
      byLocation[item.location] = { confirmed: 0, unverified: 0, retired: 0 };
    }
    byLocation[item.location][item.existence]++;
  });

  // Output report
  console.log('\n=== EXISTENCE BASELINE REPORT ===\n');

  console.log('TOTAL COUNTS:');
  console.log(`  Confirmed:  ${totals.confirmed}`);
  console.log(`  Unverified: ${totals.unverified}`);
  console.log(`  Retired:    ${totals.retired}`);
  console.log(`  TOTAL:      ${docs.length}`);

  console.log('\nUNVERIFIED BREAKDOWN:');
  console.log(`  Never audited:            ${unverifiedDetails.never_audited}`);
  console.log(`  Audited before 2026-06-01: ${unverifiedDetails.audited_before_cutoff}`);

  console.log('\nUNVERIFIED WITH STOCK > 0:');
  console.log(`  Count: ${unverifiedWithStock.length}`);

  console.log('\nBY CATEGORY:');
  const categories = Object.keys(byCategory).sort();
  categories.forEach(cat => {
    const counts = byCategory[cat];
    console.log(`  ${cat}:`);
    console.log(`    Confirmed:  ${counts.confirmed}`);
    console.log(`    Unverified: ${counts.unverified}`);
    console.log(`    Retired:    ${counts.retired}`);
  });

  console.log('\nBY LOCATION:');
  const locations = Object.keys(byLocation).sort();
  locations.forEach(loc => {
    const counts = byLocation[loc];
    console.log(`  ${loc}:`);
    console.log(`    Confirmed:  ${counts.confirmed}`);
    console.log(`    Unverified: ${counts.unverified}`);
    console.log(`    Retired:    ${counts.retired}`);
  });

  if (shouldList) {
    console.log('\nUNVERIFIED ITEMS:');
    const unverified = classified.filter(i => i.existence === 'unverified').sort((a, b) => a.name.localeCompare(b.name));
    unverified.forEach(item => {
      console.log(`  ${item.name} (${item.id})`);
    });
  }

  console.log('\n✓ Report complete.');
}

// Only run main() if this file is executed directly (not required as a module)
if (require.main === module) {
  main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}
