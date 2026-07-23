#!/usr/bin/env node

/**
 * Migration script: backfill structured item naming (family + variant).
 *
 * For each `inventory` doc, splits the legacy free-typed `name` the same way
 * `parseLegacyName` in `app/lib/item-naming.ts` does (reimplemented in plain
 * CJS here — the script can't import TS): trailing parenthetical, then last
 * comma, then ` - ` / ` — ` separator, checked against the org's controlled
 * family list (`org_settings/current.itemFamilies`, falling back to the three
 * seed defaults).
 *
 *   - Confident split  -> writes `family`, `variantLabel`, and a regenerated
 *     `name` (`${family}, ${variantLabel}` or just `${family}`).
 *   - Not confident     -> writes ONLY `namingReviewNeeded: true`; `name` is
 *     left untouched so nothing already-correct changes on screen. These
 *     items surface in the admin naming-review queue (`/inventory`).
 *
 * Idempotent: a doc that already has `family` set (and no distinct docs
 * change) is skipped from the confident group's write; re-running twice is a
 * no-op provided the source `name` hasn't changed.
 *
 * Usage:
 *   node scripts/migrate-item-naming.cjs               # dry run (default)
 *   node scripts/migrate-item-naming.cjs --dry-run      # dry run (explicit)
 *   node scripts/migrate-item-naming.cjs --force        # apply writes
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS pointing at a service account JSON
 * (or ADC available). Chunks writes into batches of 400 to stay under the
 * Firestore 500-op write-batch cap.
 */

const DEFAULT_FAMILIES = ['Bandaids', 'Nitrile Gloves', 'OPAs'];
const BATCH_CHUNK_SIZE = 400;

// ---------------------------------------------------------------------------
// Pure naming-split logic — mirrors app/lib/item-naming.ts exactly.
// ---------------------------------------------------------------------------

function titleCaseWord(word) {
  if (!word) return word;
  const hasInternalUpper = /[A-Z]/.test(word.slice(1));
  if (hasInternalUpper) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function titleCaseFamily(family) {
  return family
    .split(/\s+/)
    .filter(Boolean)
    .map(titleCaseWord)
    .join(' ');
}

function deriveItemName(family, variantLabel) {
  const famTrim = (family || '').trim();
  const varTrim = (variantLabel || '').trim();
  const famTitled = titleCaseFamily(famTrim);
  return varTrim ? `${famTitled}, ${varTrim}` : famTitled;
}

function parseLegacyName(name, families) {
  const trimmed = (name || '').trim();
  if (!trimmed) return { family: '', confident: false };

  let family = trimmed;
  let variantLabel;

  // (a) trailing parenthetical: "Nitrile Gloves (Large)"
  const parenMatch = trimmed.match(/^(.*\S)\s*\(([^()]+)\)\s*$/);
  if (parenMatch) {
    family = parenMatch[1].trim();
    variantLabel = parenMatch[2].trim();
  } else {
    // (b) last comma: "Bandaids, Small"
    const lastComma = trimmed.lastIndexOf(',');
    if (lastComma > 0 && lastComma < trimmed.length - 1) {
      family = trimmed.slice(0, lastComma).trim();
      variantLabel = trimmed.slice(lastComma + 1).trim();
    } else {
      // (c) ' - ' / ' — ' separator
      const dashMatch = trimmed.match(/^(.*\S)\s+(?:-|—)\s+(\S.*)$/);
      if (dashMatch) {
        family = dashMatch[1].trim();
        variantLabel = dashMatch[2].trim();
      }
    }
  }

  const wholeMatch = families.find((f) => f.toLowerCase() === trimmed.toLowerCase());
  if (wholeMatch && !variantLabel) {
    return { family: wholeMatch, confident: true };
  }

  const familyMatch = families.find((f) => f.toLowerCase() === family.toLowerCase());
  if (familyMatch && variantLabel) {
    return { family: familyMatch, variantLabel, confident: true };
  }

  return { family: family || trimmed, variantLabel, confident: false };
}

// ---------------------------------------------------------------------------
// Script
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const isForce = argv.includes('--force');
  const isDry = !isForce; // dry-run is the default; --force is required to write

  let admin;
  try {
    admin = require('firebase-admin');
  } catch (e) {
    console.error('This script requires firebase-admin. Install with `npm i firebase-admin` and set GOOGLE_APPLICATION_CREDENTIALS.');
    process.exit(1);
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error('Set GOOGLE_APPLICATION_CREDENTIALS to a service account JSON to run this script.');
    process.exit(1);
  }
  if (!admin.apps.length) admin.initializeApp();
  const db = admin.firestore();

  console.log(`\nItem naming backfill — mode: ${isDry ? 'DRY RUN (no writes)' : 'FORCE (will write)'}\n`);

  // Families: org_settings/current.itemFamilies, falling back to defaults.
  let families = DEFAULT_FAMILIES;
  try {
    const orgSnap = await db.doc('org_settings/current').get();
    const docFamilies = orgSnap.exists ? orgSnap.data().itemFamilies : undefined;
    if (Array.isArray(docFamilies) && docFamilies.length > 0) families = docFamilies;
  } catch (e) {
    console.warn('Could not read org_settings/current, using default families.', e.message);
  }
  console.log('Families:', families.join(', '));

  const snap = await db.collection('inventory').get();
  console.log(`Found ${snap.size} inventory docs.\n`);

  const confidentRows = [];
  const reviewRows = [];
  const confidentUpdates = [];
  const reviewUpdates = [];

  snap.forEach((docSnap) => {
    const data = docSnap.data();
    const name = data.name || '';

    // Idempotent: a doc that already has a family and whose name already
    // matches the derived form needs no write at all.
    if (data.family) {
      const already = deriveItemName(data.family, data.variantLabel);
      if (already === name) return;
    }

    const parsed = parseLegacyName(name, families);

    if (parsed.confident) {
      const newName = deriveItemName(parsed.family, parsed.variantLabel);
      confidentRows.push({ id: docSnap.id, before: name, family: parsed.family, variant: parsed.variantLabel || '', after: newName });
      confidentUpdates.push({
        ref: docSnap.ref,
        data: {
          family: parsed.family,
          variantLabel: parsed.variantLabel || admin.firestore.FieldValue.delete(),
          name: newName,
          namingReviewNeeded: admin.firestore.FieldValue.delete(),
        },
      });
    } else {
      // Skip docs already flagged — nothing changed.
      if (data.namingReviewNeeded === true) return;
      reviewRows.push({ id: docSnap.id, name, guess: parsed.family });
      reviewUpdates.push({ ref: docSnap.ref, data: { namingReviewNeeded: true } });
    }
  });

  console.log(`Confident splits (family + variant regenerated): ${confidentRows.length}`);
  if (confidentRows.length > 0) console.table(confidentRows);

  console.log(`\nFlagged for naming review (namingReviewNeeded=true, name untouched): ${reviewRows.length}`);
  if (reviewRows.length > 0) console.table(reviewRows);

  const totalUpdates = confidentUpdates.length + reviewUpdates.length;
  console.log(`\nSummary: ${confidentUpdates.length} confident, ${reviewUpdates.length} flagged for review, ${totalUpdates} total doc writes.`);

  if (totalUpdates === 0) {
    console.log('Nothing to do.');
    return;
  }

  if (isDry) {
    console.log('\nDry run complete. No writes performed. Re-run with --force to apply.');
    return;
  }

  const allUpdates = [...confidentUpdates, ...reviewUpdates];
  console.log(`\nApplying ${allUpdates.length} updates in batches of ${BATCH_CHUNK_SIZE}...`);
  let applied = 0;
  for (let i = 0; i < allUpdates.length; i += BATCH_CHUNK_SIZE) {
    const chunk = allUpdates.slice(i, i + BATCH_CHUNK_SIZE);
    const batch = db.batch();
    for (const u of chunk) batch.update(u.ref, u.data);
    await batch.commit();
    applied += chunk.length;
    console.log(`  Committed ${applied}/${allUpdates.length}`);
  }

  console.log(`\nDone. Applied ${applied} updates.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
