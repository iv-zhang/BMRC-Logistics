// Simple validator for inventory documents.
// Usage (as CLI):
// node scripts/validate-inventory-doc.js --file snapshot.json
// Or require and call validateDoc(data)

const fs = require('fs');
const path = require('path');

function validateDoc(data) {
  const issues = [];
  if (!data) return [{ type: 'missing_doc', message: 'Document is empty or undefined' }];

  const batches = Array.isArray(data.batches) ? data.batches : [];
  const batchSum = batches.reduce((acc, b) => acc + Number(b.stock ?? 0), 0);
  const total = Number(data.totalStockQuantity ?? 0);
  if (batches.length > 0 && total !== batchSum) {
    issues.push({ type: 'total_vs_batch_sum', expected: batchSum, actual: total });
  }

  batches.forEach((b, idx) => {
    if (!b) return;
    if (b.serialized) {
      const serialCount = Array.isArray(b.serialNumbers) ? b.serialNumbers.length : 0;
      if (Number(b.stock ?? 0) !== serialCount) {
        issues.push({ type: 'serialized_count_mismatch', batchId: b.id ?? `index:${idx}`, batchStock: Number(b.stock ?? 0), serialCount });
      }
    }
    if (Number(b.stock ?? 0) < 0) {
      issues.push({ type: 'negative_batch_stock', batchId: b.id ?? `index:${idx}`, stock: Number(b.stock ?? 0) });
    }
    if (Array.isArray(b.locations)) {
      const locSum = b.locations.reduce((a, l) => a + Number(l.quantity ?? 0), 0);
      if (locSum !== Number(b.stock ?? 0)) {
        issues.push({ type: 'batch_location_mismatch', batchId: b.id ?? `index:${idx}`, stock: Number(b.stock ?? 0), locSum });
      }
    }
  });

  if (Number(total) < 0) issues.push({ type: 'negative_total', total });
  return issues;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const fi = argv.findIndex(a => a === '--file');
  if (fi >= 0 && argv[fi+1]) {
    const file = path.resolve(process.cwd(), argv[fi+1]);
    if (!fs.existsSync(file)) {
      console.error('File not found:', file);
      process.exit(1);
    }
    const raw = fs.readFileSync(file, 'utf8');
    let docs;
    try { docs = JSON.parse(raw); } catch (e) { console.error('Invalid JSON'); process.exit(1); }
    if (!Array.isArray(docs)) {
      console.error('Snapshot must be an array of { id, data }');
      process.exit(1);
    }
    const report = [];
    docs.forEach((d) => {
      const id = d.id || '<unknown>';
      const issues = validateDoc(d.data || d);
      if (issues.length > 0) report.push({ id, issues });
    });
    const out = path.join(__dirname, 'validation_report.json');
    fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
    console.log('Validation complete. Report written to', out, 'found issues for', report.length, 'docs');
  } else {
    console.error('Usage: node scripts/validate-inventory-doc.js --file snapshot.json');
    process.exit(1);
  }
}

module.exports = { validateDoc };
