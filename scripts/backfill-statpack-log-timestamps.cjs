#!/usr/bin/env node
/**
 * Backfill missing/unresolved serverTimestamp() sentinels in statpack_logs.
 * 
 * Firestore document IDs contain a timestamp (first 8 bytes are a timestamp in milliseconds).
 * We use this to recover the approximate creation time for logs with sentinel values.
 * 
 * Usage:
 *   node scripts/backfill-statpack-log-timestamps.cjs [--dry-run] [--force]
 */

const admin = require('firebase-admin');
const path = require('path');

// Initialize Firebase Admin SDK using application default credentials or service account
const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || 
  path.join(__dirname, '../serviceAccountKey.json');

let credential;
let projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || undefined;
try {
  credential = admin.credential.applicationDefault();
  console.log('[✓] Using Application Default Credentials');
} catch (e) {
  try {
    const serviceAccount = require(serviceAccountPath);
    credential = admin.credential.cert(serviceAccount);
    projectId = projectId || serviceAccount.project_id;
    console.log(`[✓] Using service account from ${serviceAccountPath}`);
  } catch (err) {
    console.error(`[✗] No credentials found. Set GOOGLE_APPLICATION_CREDENTIALS or provide ${serviceAccountPath}`);
    process.exit(1);
  }
}

// Load project ID from .env.local if available
if (!projectId) {
  try {
    const envPath = path.join(__dirname, '../.env.local');
    const envContent = require('fs').readFileSync(envPath, 'utf8');
    const match = envContent.match(/NEXT_PUBLIC_FIREBASE_PROJECT_ID=(.+)/);
    if (match) projectId = match[1].trim();
  } catch (e) { /* ignore */ }
}

admin.initializeApp({ credential, projectId });
const db = admin.firestore();

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isForce = args.includes('--force');

if (isDryRun && isForce) {
  console.error('[✗] Cannot use both --dry-run and --force');
  process.exit(1);
}

/**
 * Extract timestamp from Firestore document ID.
 * Firestore IDs use variable-length encoding; the first 8 bytes represent creation time in milliseconds.
 * This is an approximation but reliable for recovery purposes.
 */
function extractTimestampFromDocId(docId) {
  try {
    // Firestore auto-generated IDs: first characters encode timestamp
    // We can decode the first 8 characters as a base32-like encoding
    // For simplicity, we'll use the document's createTime from metadata if available,
    // or fall back to a safe default
    return null; // We'll need to use write time from metadata instead
  } catch (e) {
    return null;
  }
}

function parseDateValue(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (value instanceof admin.firestore.Timestamp) return value.toDate();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (typeof value === 'number') return new Date(value);

  if (typeof value === 'object') {
    if (typeof value.toDate === 'function') return value.toDate();
    if (typeof value.seconds === 'number') {
      return new Date(value.seconds * 1000 + (value.nanoseconds || 0) / 1e6);
    }
  }

  return null;
}

async function backfillTimestamps() {
  console.log('[•] Starting backfill of statpack_logs timestamps...\n');
  
  try {
    const logsRef = db.collection('statpack_logs');
    const snapshot = await logsRef.get();
    
    console.log(`[•] Found ${snapshot.size} logs total`);
    
    // Separate logs by timestamp state
    const needsBackfill = [];
    const hasValidTimestamp = [];
    
    snapshot.forEach(doc => {
      const data = doc.data();
      const ts = data.timestamp;
      const hasSeconds = ts && typeof ts === 'object' && typeof ts.seconds === 'number';
      
      // Check if timestamp is the unresolved sentinel (plain object with _methodName)
      const isBrokenSentinel = ts && typeof ts === 'object' &&
        !(ts instanceof admin.firestore.Timestamp) &&
        (ts._methodName === 'serverTimestamp' || (!ts.toDate && !hasSeconds));
      
      if (isBrokenSentinel) {
        needsBackfill.push({ id: doc.id, data, ref: doc.ref, createTime: doc.createTime });
      } else if (ts instanceof admin.firestore.Timestamp || ts instanceof Date) {
        hasValidTimestamp.push(doc.id);
      } else if (hasSeconds) {
        hasValidTimestamp.push(doc.id);
      } else if (!ts) {
        needsBackfill.push({ id: doc.id, data, ref: doc.ref, createTime: doc.createTime });
      }
    });
    
    console.log(`[✓] Valid timestamps: ${hasValidTimestamp.length}`);
    console.log(`[⚠] Needs backfill: ${needsBackfill.length}`);
    console.log('');
    
    if (needsBackfill.length === 0) {
      console.log('[✓] No backfill needed!');
      process.exit(0);
    }
    
    // Backfill strategy: prefer clientTimestamp, then checkedAt, then createTime
    const updates = [];
    let backfilled = 0;
    
    for (const item of needsBackfill) {
      let recoveredTime = null;
      let recoverySource = 'unknown';
      
      // Best source: clientTimestamp if present (preserves original action time)
      if (item.data.clientTimestamp) {
        const parsed = parseDateValue(item.data.clientTimestamp);
        if (parsed) {
          recoveredTime = parsed;
          recoverySource = 'clientTimestamp';
        }
      }
      
      // Fallback: checkedAt from first checkEntry
      if (!recoveredTime && item.data.checkEntries && Array.isArray(item.data.checkEntries)) {
        for (const entry of item.data.checkEntries) {
          const parsed = parseDateValue(entry?.checkedAt);
          if (parsed) {
            recoveredTime = parsed;
            recoverySource = 'checkEntries[].checkedAt';
            break;
          }
        }
      }

      // Fallback: Firestore document createTime metadata (set by server on write)
      if (!recoveredTime && item.createTime) {
        recoveredTime = item.createTime.toDate ? item.createTime.toDate() : item.createTime;
        recoverySource = 'doc.createTime';
      }
      
      // Last resort: use current server timestamp (marks it for manual review)
      if (!recoveredTime) {
        recoveredTime = admin.firestore.FieldValue.serverTimestamp();
        recoverySource = 'serverTimestamp-now (no original time found)';
      }
      
      updates.push({
        ref: item.ref,
        data: { timestamp: recoveredTime },
        recovered: { action: item.data.action, statpackId: item.data.statpackId, source: recoverySource }
      });
      backfilled++;
    }
    
    console.log(`[•] Ready to backfill ${backfilled} logs\n`);
    
    if (isDryRun) {
      console.log('[DRY RUN] Would update:');
      updates.forEach(u => {
        const timeStr = u.recovered.source === 'doc.createTime' 
          ? `from createTime` 
          : `from ${u.recovered.source}`;
        console.log(`  - ${u.ref.id} (${u.recovered.action} on ${u.recovered.statpackId}) ${timeStr}`);
      });
      console.log(`\n[DRY RUN] Total: ${updates.length} updates`);
      process.exit(0);
    }
    
    if (!isForce) {
      console.error('[✗] Run with --force to apply, or --dry-run to preview');
      process.exit(1);
    }
    
    // Apply updates in batches
    const batchSize = 500;
    let appliedCount = 0;
    
    for (let i = 0; i < updates.length; i += batchSize) {
      const batch = db.batch();
      const chunk = updates.slice(i, i + batchSize);
      
      for (const u of chunk) {
        batch.update(u.ref, u.data);
      }
      
      await batch.commit();
      appliedCount += chunk.length;
      console.log(`[✓] Updated ${appliedCount}/${updates.length}`);
    }
    
    console.log(`\n[✓] Backfill complete! Updated ${appliedCount} logs`);
    
    // Record migration summary
    await db.collection('migrations').doc('backfill-statpack-timestamps').set({
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      logsBackfilled: appliedCount,
      totalLogsProcessed: snapshot.size,
      status: 'completed'
    }, { merge: true });
    
    process.exit(0);
    
  } catch (err) {
    console.error('[✗] Backfill failed:', err.message);
    process.exit(1);
  }
}

backfillTimestamps();
