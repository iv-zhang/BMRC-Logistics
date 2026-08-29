#!/usr/bin/env node

/**
 * Backfill `User.joinedOn` from `User.joinedTerm` (Phase 2, medops-signup-plan.md §2.3).
 *
 * For each user, normalizes their `joinedTerm` (case-fold, trim, etc.) and matches
 * it against the configured `terms` list (from org_settings/current, or TERMS_DEFAULTS).
 * If a match is found, writes `joinedOn` as a Firestore Timestamp of the term's
 * `startDate` (parsed as LOCAL midnight, never UTC).
 *
 * Unmatched terms are reported (with example uids), never guessed. A user with no
 * `joinedTerm` at all is counted as "no term recorded" for coverage tracking.
 *
 * Existing `joinedOn` is never overwritten unless `--force` is passed.
 *
 * Usage:
 *   node scripts/backfill-joined-on.cjs               # dry run (default)
 *   node scripts/backfill-joined-on.cjs --dry-run     # dry run (explicit)
 *   node scripts/backfill-joined-on.cjs --apply       # apply writes
 *   node scripts/backfill-joined-on.cjs --force       # dry run, previewing overwrites
 *   node scripts/backfill-joined-on.cjs --apply --force # apply with overwrite
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS pointing at a service account JSON
 * (or ADC available). Batches writes in chunks of 400 to stay under the
 * Firestore 500-op write-batch cap.
 *
 * Output:
 *   - Per-term tally (matched users by term label)
 *   - Unmatched `joinedTerm` values with count and example uid
 *   - Summary totals: scanned / would-write / skipped-existing / no-term / unmatched-term
 *   - Next-step guidance
 */

const BATCH_CHUNK_SIZE = 400;

// ---------------------------------------------------------------------------
// Defaults: TERMS_DEFAULTS from app/config/org-config.ts (seeds if missing)
// ---------------------------------------------------------------------------

const TERMS_DEFAULTS = [
  { id: 'fa25', label: 'Fall 2025', startDate: '2025-08-20' },
  { id: 'sp26', label: 'Spring 2026', startDate: '2026-01-13' },
  { id: 'fa26', label: 'Fall 2026', startDate: '2026-08-19' },
];

// ---------------------------------------------------------------------------
// Parsing & matching helpers
// ---------------------------------------------------------------------------

/**
 * Parse a 'YYYY-MM-DD' date string into a LOCAL Date (midnight local time).
 * Never use new Date(str) which is UTC and silently shifts the day.
 */
function parseLocalDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  // Local midnight: new Date(year, month-1, day)
  const date = new Date(y, m - 1, d, 0, 0, 0, 0);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

/**
 * Normalize a joinedTerm string for matching: trim, lowercase, collapse whitespace.
 * Future expansions (e.g. '25' → '2025', 'Fa' → 'Fall') can go here.
 */
function normalizeJoinedTerm(str) {
  if (!str || typeof str !== 'string') return null;
  return str.trim().toLowerCase();
}

/**
 * Find a matching term from the list by id or label (case-insensitive).
 * Returns the term object if found, null otherwise.
 */
function findMatchingTerm(joinedTerm, terms) {
  if (!joinedTerm) return null;
  const normalized = normalizeJoinedTerm(joinedTerm);
  if (!normalized) return null;
  for (const term of terms) {
    if (normalizeJoinedTerm(term.id) === normalized || normalizeJoinedTerm(term.label) === normalized) {
      return term;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Script
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  // `--force` widens WHAT is written (existing `joinedOn` too); only `--apply`
  // decides WHETHER anything is written. Keeping them independent means a
  // `--force` typo previews an overwrite instead of performing one.
  const isApply = argv.includes('--apply');
  const isDry = !isApply; // dry-run is the default
  const forceOverwrite = argv.includes('--force'); // overwrite existing joinedOn

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

  console.log(`\njoined-On backfill — mode: ${isDry ? 'DRY RUN (no writes)' : 'APPLY (will write)'}, overwrite: ${forceOverwrite ? 'YES' : 'NO'}\n`);

  // Fetch org config to get configured terms, fall back to TERMS_DEFAULTS.
  let terms = TERMS_DEFAULTS;
  try {
    const configSnap = await db.collection('org_settings').doc('current').get();
    if (configSnap.exists) {
      const configData = configSnap.data();
      if (Array.isArray(configData.terms) && configData.terms.length > 0) {
        terms = configData.terms;
        console.log(`Using ${terms.length} configured term(s) from org_settings/current.`);
      } else {
        console.log(`No terms in org_settings/current; using TERMS_DEFAULTS (${TERMS_DEFAULTS.length} term(s)).`);
      }
    } else {
      console.log(`org_settings/current not found; using TERMS_DEFAULTS (${TERMS_DEFAULTS.length} term(s)).`);
    }
  } catch (e) {
    console.warn(`Error reading org_settings/current; using TERMS_DEFAULTS:`, e.message);
  }

  console.log(`Available terms: ${terms.map(t => `${t.label} (${t.id})`).join(', ')}\n`);

  // Fetch all users.
  const usersSnap = await db.collection('users').get();
  console.log(`Found ${usersSnap.size} user docs.\n`);

  const updates = [];
  const termsMatched = new Map(); // term label → count
  const unmatched = new Map(); // joinedTerm string → { count, exampleUid }
  let skippedExisting = 0;
  let noTermRecorded = 0;
  let unmatchedCount = 0;

  usersSnap.forEach((docSnap) => {
    const data = docSnap.data();
    const uid = docSnap.id;
    const joinedTerm = data.joinedTerm;
    const existingJoinedOn = data.joinedOn;

    // Case 1: No joinedTerm recorded at all.
    if (!joinedTerm) {
      noTermRecorded++;
      return;
    }

    // Case 2: Already has joinedOn and we're not forcing overwrite.
    if (existingJoinedOn && !forceOverwrite) {
      skippedExisting++;
      return;
    }

    // Case 3: Try to match the joinedTerm.
    const matchedTerm = findMatchingTerm(joinedTerm, terms);
    if (!matchedTerm) {
      // Unmatched: record for the report.
      unmatchedCount++;
      if (!unmatched.has(joinedTerm)) {
        unmatched.set(joinedTerm, { count: 0, exampleUid: uid });
      }
      const entry = unmatched.get(joinedTerm);
      entry.count++;
      return;
    }

    // Case 4: Matched term — derive joinedOn and queue update.
    const joinedOnDate = parseLocalDate(matchedTerm.startDate);
    if (!joinedOnDate) {
      console.warn(`Warning: Could not parse startDate '${matchedTerm.startDate}' for term '${matchedTerm.label}'.`);
      return;
    }

    // Count this match.
    const count = termsMatched.get(matchedTerm.label) || 0;
    termsMatched.set(matchedTerm.label, count + 1);

    updates.push({
      ref: docSnap.ref,
      data: {
        joinedOn: admin.firestore.Timestamp.fromDate(joinedOnDate),
      },
      displayTerm: matchedTerm.label,
      uid,
    });
  });

  // Print the two-column report.
  console.log('=== TERM MATCHES ===\n');
  if (termsMatched.size > 0) {
    const matchTable = [];
    for (const [label, count] of termsMatched.entries()) {
      matchTable.push({ term: label, count });
    }
    console.table(matchTable);
  } else {
    console.log('(no matches)\n');
  }

  console.log('\n=== UNMATCHED joinedTerm VALUES ===\n');
  if (unmatched.size > 0) {
    const unmatchedTable = [];
    for (const [termStr, { count, exampleUid }] of unmatched.entries()) {
      unmatchedTable.push({ joinedTerm: termStr, count, exampleUid });
    }
    console.table(unmatchedTable);
  } else {
    console.log('(none)\n');
  }

  // Summary.
  const totalScanned = usersSnap.size;
  const totalWrite = updates.length;
  console.log(`\n=== SUMMARY ===\n`);
  console.log(`Total users scanned:     ${totalScanned}`);
  console.log(`Would write (new/force): ${totalWrite}`);
  console.log(`Skipped (already has):   ${skippedExisting}`);
  console.log(`No term recorded:        ${noTermRecorded}`);
  console.log(`Unmatched term value:    ${unmatchedCount}`);
  console.log();

  if (totalWrite === 0) {
    console.log('Nothing to do.');
    if (noTermRecorded > 0 || unmatchedCount > 0) {
      console.log(`\nIssues to address before enabling tenure criteria:`);
      if (noTermRecorded > 0) console.log(`  - ${noTermRecorded} user(s) have no joinedTerm recorded.`);
      if (unmatchedCount > 0) console.log(`  - ${unmatchedCount} user(s) have unmatched joinedTerm value(s).`);
      console.log(`\nReview the unmatched list above and either update the roster spreadsheet or adjust the configured terms.`);
    }
    return;
  }

  if (isDry) {
    console.log(`\n--- DRY RUN REPORT ---\n`);
    console.log(`Would backfill ${updates.length} users with joinedOn.`);
    if (forceOverwrite) {
      console.log(`(--force is set, but this is a dry run — re-run with --apply to write.)`);
    } else {
      console.log(`(--force is not set; existing joinedOn values will be skipped.)`);
    }
    console.log(`\nDry run complete. No writes performed. Re-run with --apply to write.`);
    return;
  }

  // Apply writes.
  console.log(`\n--- APPLYING UPDATES ---\n`);
  console.log(`Backfilling ${updates.length} users in batches of ${BATCH_CHUNK_SIZE}...`);
  let applied = 0;
  for (let i = 0; i < updates.length; i += BATCH_CHUNK_SIZE) {
    const chunk = updates.slice(i, i + BATCH_CHUNK_SIZE);
    const batch = db.batch();
    for (const u of chunk) batch.update(u.ref, u.data);
    await batch.commit();
    applied += chunk.length;
    console.log(`  Committed ${applied}/${updates.length}`);
  }

  console.log(`\n✓ Backfill complete. ${applied} users now have joinedOn set.`);
  console.log(`\nNext step: Once you've verified the roster is complete, enable tenure criteria in /settings.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
