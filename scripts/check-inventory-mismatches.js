#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function analyzeDocs(docs) {
  const mismatches = [];
  docs.forEach((d) => {
    const id = d.id || (d._id && d._id.toString()) || '<unknown>';
    const data = d.data || d;
    const batches = Array.isArray(data.batches) ? data.batches : [];
    const batchSum = batches.reduce((acc, b) => acc + Number(b.stock ?? 0), 0);
    const total = Number(data.totalStockQuantity ?? 0);
    if (batches.length > 0 && total !== batchSum) {
      mismatches.push({ id, type: 'total_vs_batch_sum', total, batchSum, batchesLen: batches.length, name: data.name });
    }
    // serialized checks
    (batches || []).forEach((b) => {
      if (b && b.serialized) {
        const serialCount = Array.isArray(b.serialNumbers) ? b.serialNumbers.length : 0;
        if (Number(b.stock ?? 0) !== serialCount) {
          mismatches.push({ id, type: 'serialized_count_mismatch', batchId: b.id, batchStock: Number(b.stock ?? 0), serialCount, name: data.name });
        }
      }
    });
  });
  return mismatches;
}

async function main() {
  const argv = process.argv.slice(2);
  const fileIdx = argv.findIndex(a => a === '--file');
  if (fileIdx >= 0 && argv[fileIdx+1]) {
    const filePath = path.resolve(process.cwd(), argv[fileIdx+1]);
    if (!fs.existsSync(filePath)) {
      console.error('Snapshot file not found:', filePath);
      process.exit(1);
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const docs = JSON.parse(raw);
    if (!Array.isArray(docs)) {
      console.error('Snapshot must be an array of docs [{ id, data }, ...]');
      process.exit(1);
    }
    const mismatches = analyzeDocs(docs.map(d => ({ id: d.id, data: d.data })));
    console.log('Found', mismatches.length, 'mismatches.');
    const out = path.join(__dirname, 'inventory_mismatches.json');
    fs.writeFileSync(out, JSON.stringify(mismatches, null, 2), 'utf8');
    console.log('Report written to', out);
    return;
  }

  // Live mode via firebase-admin
  let admin;
  try { admin = require('firebase-admin'); } catch (e) { console.error('Install firebase-admin to run live checks.'); process.exit(1); }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error('Set GOOGLE_APPLICATION_CREDENTIALS to a service account JSON to run live.');
    process.exit(1);
  }
  admin.initializeApp();
  const db = admin.firestore();
  const snap = await db.collection('inventory').get();
  const docs = snap.docs.map(d => ({ id: d.id, data: d.data() }));
  const mismatches = analyzeDocs(docs);
  console.log('Found', mismatches.length, 'mismatches.');
  const out = path.join(__dirname, 'inventory_mismatches.json');
  fs.writeFileSync(out, JSON.stringify(mismatches, null, 2), 'utf8');
  console.log('Report written to', out);
}

main().catch(err => { console.error(err); process.exit(1); });
