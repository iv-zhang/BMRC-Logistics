#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const uniqueIdFallback = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString()}-${Math.random().toString(36).slice(2,9)}`);

function safeParseDate(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (v && typeof v.toDate === 'function') {
    try { const d = v.toDate(); return d instanceof Date && !isNaN(d.getTime()) ? d : undefined; } catch { return undefined; }
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
}

function preparePayload(data, opts) {
  const uniqueId = (opts && opts.uniqueId) || uniqueIdFallback;
  const payload = Object.assign({}, data || {});

  if (payload.openedAt) {
    if (typeof payload.openedAt === 'string') {
      const d = new Date(payload.openedAt);
      payload.openedAt = isNaN(d.getTime()) ? null : d;
    } else if (!(payload.openedAt instanceof Date)) {
      payload.openedAt = null;
    }
  }

  payload.totalStockQuantity = Number(payload.totalStockQuantity ?? 0);
  payload.reorderThreshold = Number(payload.reorderThreshold ?? 0);
  payload.unopenedQuantity = Number(payload.unopenedQuantity ?? 0);
  payload.openedQuantity = Number(payload.openedQuantity ?? 0);
  payload.quantityPerUnit = Number(payload.quantityPerUnit ?? 1);

  if (Array.isArray(payload.variants)) {
    payload.variants = payload.variants.map((v) => {
      const out = Object.assign({}, v);
      if (out.expirationDate) {
        if (typeof out.expirationDate === 'string') {
          const d = new Date(out.expirationDate);
          out.expirationDate = isNaN(d.getTime()) ? null : d;
        } else if (!(out.expirationDate instanceof Date)) {
          out.expirationDate = null;
        }
      }
      out.quantityPerUnit = Number(out.quantityPerUnit ?? 1);
      out.stock = Number(out.stock ?? 0);
      out.reorderThreshold = Number(out.reorderThreshold ?? payload.reorderThreshold ?? 0);
      Object.keys(out).forEach(k => out[k] === undefined && delete out[k]);
      return out;
    });

    const convertedBatches = [];
    const keptVariants = [];
    (payload.variants || []).forEach((v) => {
      if (v.expirationDate || v.lotNumber) {
        convertedBatches.push({ id: v.id ?? uniqueId(), lotNumber: v.lotNumber ?? '', expirationDate: v.expirationDate ?? null, stock: Number(v.stock ?? 0), receivedAt: undefined, notes: `Converted from variant ${v.name ?? ''}`, locations: [] });
      } else keptVariants.push(v);
    });
    payload.variants = keptVariants;
    if (convertedBatches.length > 0) payload.batches = [...(payload.batches || []), ...convertedBatches];

    const variantNestedBatches = [];
    payload.variants = (payload.variants || []).map((vv) => {
      if (Array.isArray(vv.batches) && vv.batches.length > 0) {
        vv.batches.forEach((vb) => variantNestedBatches.push(Object.assign({}, vb, { notes: vb.notes ?? `Variant: ${vv.name ?? ''}` })));
      }
      const out = Object.assign({}, vv);
      delete out.batches;
      return out;
    });
    if (variantNestedBatches.length > 0) payload.batches = [...(payload.batches || []), ...variantNestedBatches];
  }

  if (Array.isArray(payload.batches) && payload.batches.length > 0) {
    const normBatches = payload.batches.map((b) => {
      const out = Object.assign({}, b);
      if (out.expirationDate) {
        if (typeof out.expirationDate === 'string') {
          const d = new Date(out.expirationDate);
          out.expirationDate = isNaN(d.getTime()) ? null : d;
        } else if (!(out.expirationDate instanceof Date)) out.expirationDate = null;
      }
      out.stock = Number(out.stock ?? 0);
      out.receivedAt = out.receivedAt ? (out.receivedAt instanceof Date ? out.receivedAt : new Date(out.receivedAt)) : undefined;
      out.locations = Array.isArray(out.locations) ? out.locations.map((l) => ({ id: l.id ?? uniqueId(), name: l.name ?? '', quantity: Number(l.quantity ?? 0) })) : [];
      return out;
    });
    payload.batches = normBatches;
    const hasBatchExpirations = normBatches.some((b) => !!b.expirationDate || !!b.lotNumber || !!b.serialized || (Array.isArray(b.serialNumbers) && b.serialNumbers.length > 0));
    payload.totalStockQuantity = normBatches.reduce((acc, b) => acc + Number(b.stock ?? 0), 0);
    if (!hasBatchExpirations) delete payload.batches;
  }

  const removeUndefinedDeep = (obj) => {
    if (obj === null || obj === undefined) return;
    if (Array.isArray(obj)) {
      for (let i = obj.length - 1; i >= 0; i--) {
        const v = obj[i];
        if (v === undefined) obj.splice(i, 1);
        else if (typeof v === 'object' && v !== null) removeUndefinedDeep(v);
      }
      return;
    }
    if (typeof obj === 'object') {
      Object.keys(obj).forEach((k) => {
        const v = obj[k];
        if (v === undefined) delete obj[k];
        else if (typeof v === 'object' && v !== null) removeUndefinedDeep(v);
      });
    }
  };

  removeUndefinedDeep(payload);
  return payload;
}

async function main() {
  const argv = process.argv.slice(2);
  const isDry = argv.includes('--dry-run') || argv.length === 0;
  const fileArgIndex = argv.findIndex(a => a === '--file');
  const filePath = fileArgIndex >= 0 && argv[fileArgIndex+1] ? argv[fileArgIndex+1] : path.join(__dirname, 'inventory_snapshot.json');

  if (isDry) {
    if (!fs.existsSync(filePath)) {
      console.error('Dry-run mode: snapshot file not found at', filePath);
      console.error('Create a JSON export of your `inventory` collection at this path, or run the script with `--live` after installing firebase-admin and setting GOOGLE_APPLICATION_CREDENTIALS.');
      process.exit(1);
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const docs = JSON.parse(raw);
    if (!Array.isArray(docs)) {
      console.error('Snapshot must be an array of docs [{ id, data }, ...]');
      process.exit(1);
    }
    const preview = docs.map(d => ({ id: d.id, before: d.data, after: preparePayload(d.data) }));
    const outPath = path.join(__dirname, 'inventory_normalized_preview.json');
    fs.writeFileSync(outPath, JSON.stringify(preview, null, 2), 'utf8');
    console.log('Dry-run complete. Preview written to', outPath);
    const summary = preview.map(p => ({ id: p.id, name: p.after.name || p.before.name || '', beforeTotal: p.before.totalStockQuantity ?? 0, afterTotal: p.after.totalStockQuantity ?? 0, batches: (p.after.batches || []).length }));
    console.table(summary);
    return;
  }

  // live mode: requires firebase-admin
  let admin;
  try {
    admin = require('firebase-admin');
  } catch (e) {
    console.error('Live mode requires firebase-admin. Install with `npm i firebase-admin` and set GOOGLE_APPLICATION_CREDENTIALS.');
    process.exit(1);
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error('Set GOOGLE_APPLICATION_CREDENTIALS to a service account JSON to run live.');
    process.exit(1);
  }
  admin.initializeApp();
  const db = admin.firestore();
  const snap = await db.collection('inventory').get();
  console.log('Found', snap.size, 'inventory docs.');
  const operations = [];
  snap.forEach(doc => {
    const data = doc.data();
    const normalized = preparePayload(data);
    // Compare shallowly
    if (JSON.stringify(normalized) !== JSON.stringify(data)) {
      operations.push({ id: doc.id, normalized });
    }
  });
  if (operations.length === 0) {
    console.log('No changes required.');
    return;
  }
  console.log('Will update', operations.length, 'documents.');
  if (!argv.includes('--force')) {
    console.log('Run again with --force to apply changes.');
    process.exit(0);
  }
  for (const op of operations) {
    await db.collection('inventory').doc(op.id).set(op.normalized, { merge: false });
    console.log('Updated', op.id);
  }
  console.log('Normalization applied to', operations.length, 'documents.');
}

main().catch(err => { console.error(err); process.exit(1); });
