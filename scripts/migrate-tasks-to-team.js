#!/usr/bin/env node
/**
 * Migration: fold the legacy `tasks` collection into `team_tasks`, making the
 * Committee Board the single task system. `TeamTask` (app/types.ts) has been
 * extended with optional `priority`/`category`/`quantity`/`unit`/`notes`
 * fields so this migration is non-lossy.
 *
 * For each doc in `tasks`:
 *   - Creates a new `team_tasks` doc: title, status (legacy 'todo' -> 'backlog'),
 *     a single-owner `owners` array derived from createdBy/createdByName,
 *     definitionOfDone (falling back to description, then notes, then a
 *     placeholder), plus priority/category (defaulted) and quantity/unit/notes/
 *     completedAt/completedBy/completedByName when present.
 *   - Deletes the source `tasks` doc.
 *
 * The `buyList` collection is untouched — TasksPanel only synthesized
 * in-memory buy-list rows for display, it never wrote them into `tasks`.
 *
 * Usage:
 *   - Dry run (default):    node scripts/migrate-tasks-to-team.js
 *   - Apply changes:        node scripts/migrate-tasks-to-team.js --apply
 *
 * Requires a Firebase service account or application default credentials.
 * Set `GOOGLE_APPLICATION_CREDENTIALS` env var to the service account JSON file,
 * or set `FIREBASE_SERVICE_ACCOUNT_JSON` to the JSON contents directly.
 */

import admin from 'firebase-admin';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error('Missing credentials. Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON.');
  process.exit(1);
}

let cred;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    cred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON');
    process.exit(1);
  }
}

if (!admin.apps.length) {
  if (cred) admin.initializeApp({ credential: admin.credential.cert(cred) });
  else admin.initializeApp();
}

const db = admin.firestore();

/** Legacy docs may contain 'todo'; normalize to the current TeamTaskStatus vocab. */
function normalizeStatus(status) {
  return status === 'todo' ? 'backlog' : (status || 'backlog');
}

(async () => {
  console.log(`Scanning \`tasks\` collection for migration to \`team_tasks\`... (${APPLY ? 'APPLY' : 'DRY RUN'})`);
  const snap = await db.collection('tasks').get();

  if (snap.empty) {
    console.log('No documents found in `tasks`. Nothing to migrate.');
    process.exit(0);
  }

  let migrated = 0;
  for (const docSnap of snap.docs) {
    const task = docSnap.data();

    const owners = [
      {
        id: task.createdBy || 'unknown',
        name: task.createdByName || 'Unknown',
      },
    ];

    const newDoc = {
      title: task.title,
      status: normalizeStatus(task.status),
      owners,
      definitionOfDone:
        task.definitionOfDone || task.description || task.notes || '(migrated task)',
      priority: task.priority || 'medium',
      category: task.category || 'other',
      subtasks: [],
      updates: [],
      createdBy: task.createdBy || 'unknown',
      createdByName: task.createdByName || 'Unknown',
      createdAt: task.createdAt || admin.firestore.FieldValue.serverTimestamp(),
    };

    // Preserve these only when present — Firestore rejects `undefined`.
    if (task.quantity != null) newDoc.quantity = task.quantity;
    if (task.unit != null) newDoc.unit = task.unit;
    if (task.notes != null) newDoc.notes = task.notes;
    if (task.completedAt != null) newDoc.completedAt = task.completedAt;
    if (task.completedBy != null) newDoc.completedBy = task.completedBy;
    if (task.completedByName != null) newDoc.completedByName = task.completedByName;

    console.log(
      `tasks/${docSnap.id} ("${task.title}") -> team_tasks${APPLY ? '' : ' (dry run — would create)'}`
    );

    if (APPLY) {
      const ref = await db.collection('team_tasks').add(newDoc);
      await db.collection('tasks').doc(docSnap.id).delete();
      console.log(`  Created team_tasks/${ref.id}, deleted tasks/${docSnap.id}`);
    }

    migrated++;
  }

  console.log(
    `\nScan complete. Documents ${APPLY ? 'migrated' : 'that WOULD be migrated'}: ${migrated}`
  );
  if (!APPLY) console.log('Dry-run complete. Re-run with --apply to write changes.');
  process.exit(0);
})();
