/**
 * Isolated rehearsal for repair-statpack-timestamps.cjs. Seeds only the local
 * demo emulator, runs its real dry-run, then checks planner output in memory.
 * No apply function or --apply flag is invoked.
 */
const host = process.env.FIRESTORE_EMULATOR_HOST || '';
if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host) || process.env.GCLOUD_PROJECT !== 'demo-bmrc-logistics') {
  console.error('Refusing: rehearsal requires localhost Firestore emulator and demo-bmrc-logistics.');
  process.exit(1);
}

const admin = require('firebase-admin');
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
admin.initializeApp({ projectId: 'demo-bmrc-logistics' });
const db = admin.firestore();
const { Timestamp } = admin.firestore;
const { planDocument } = require('../repair-statpack-timestamps.cjs');
const SENTINEL = { _methodName: 'serverTimestamp' };
const sec = (seconds, nanoseconds) => ({ seconds, nanoseconds });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const packRef = db.doc('statpacks/timestamp-rehearsal');
  const oldLogRef = db.doc('statpack_logs/timestamp-rehearsal-old');
  const latestLogRef = db.doc('statpack_logs/timestamp-rehearsal-latest');
  await Promise.all([packRef.delete(), oldLogRef.delete(), latestLogRef.delete()]);

  await packRef.set({
    createdAt: SENTINEL,
    updatedAt: SENTINEL,
    contentsUpdatedAt: SENTINEL,
    lastAuditAt: sec(1800000000, 123456789),
    contents: [{ expirationDate: sec(1800000001, 987654321), effectiveExpiration: Timestamp.fromMillis(1900000000000) }],
    readyOverride: { at: sec(1800000002, 7) },
    maintenance_logs: [{ completedAt: { type: 'firestore/timestamp/1.0', ...sec(1800000003, 888) } }],
  });
  await oldLogRef.set({
    statpackId: 'timestamp-rehearsal',
    action: 'content_edit',
    timestamp: Timestamp.fromMillis(1700000000000),
  });
  await wait(5);
  await latestLogRef.set({ statpackId: 'timestamp-rehearsal', action: 'content_edit', timestamp: SENTINEL });

  const beforePack = await packRef.get();
  const beforeLatestLog = await latestLogRef.get();
  const beforeOldLog = await oldLogRef.get();
  const latestContentEditTime = beforeLatestLog.createTime;
  const run = spawnSync('node', [path.join(__dirname, '../repair-statpack-timestamps.cjs')], {
    encoding: 'utf8',
    env: process.env,
  });
  assert.strictEqual(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /DRY RUN \(no writes\)/);
  assert.match(run.stdout, /\[APPROXIMATE; doc\.createTime\]/);
  assert.match(run.stdout, /\[APPROXIMATE; doc\.updateTime\]/);
  assert.match(run.stdout, /\[APPROXIMATE; latest content_edit log createTime\]/);
  assert.match(run.stdout, /\[APPROXIMATE; log\.createTime\]/);
  assert.match(run.stdout, new RegExp(
    `statpacks/timestamp-rehearsal contentsUpdatedAt: .* -> Timestamp\\(${latestContentEditTime.seconds}, ${latestContentEditTime.nanoseconds}\\)`
  ));
  assert.match(run.stdout, /SUMMARY: changes=8 docs=2 unresolved=0 dry-run; nothing written/);

  const afterDryPack = await packRef.get();
  const afterDryLatestLog = await latestLogRef.get();
  assert.deepStrictEqual(afterDryPack.data(), beforePack.data(), 'dry-run changed statpack');
  assert.ok(afterDryPack.updateTime.isEqual(beforePack.updateTime), 'dry-run wrote statpack');
  assert.deepStrictEqual(afterDryLatestLog.data(), beforeLatestLog.data(), 'dry-run changed latest log');
  assert.ok(afterDryLatestLog.updateTime.isEqual(beforeLatestLog.updateTime), 'dry-run wrote latest log');

  const packPlan = planDocument(Timestamp, 'statpacks', beforePack.data(), {
    createTime: beforePack.createTime,
    updateTime: beforePack.updateTime,
  }, latestContentEditTime);
  const logPlan = planDocument(Timestamp, 'statpack_logs', beforeLatestLog.data(), {
    createTime: beforeLatestLog.createTime,
    updateTime: beforeLatestLog.updateTime,
  });
  assert.strictEqual(packPlan.changes.length, 7);
  assert.strictEqual(logPlan.changes.length, 1);
  const expiration = packPlan.changes.find(change => change.path === 'contents[0].expirationDate').after;
  assert.ok(expiration instanceof Timestamp);
  assert.strictEqual(expiration.nanoseconds, 987654321);
  assert.ok(packPlan.changes.find(change => change.path === 'contentsUpdatedAt').after.isEqual(latestContentEditTime));
  assert.ok(packPlan.changes.every(change => !change.approximate || change.source));
  assert.ok(logPlan.changes[0].after.isEqual(beforeLatestLog.createTime));

  const missingLogPlan = planDocument(Timestamp, 'statpacks', { contentsUpdatedAt: SENTINEL }, {
    createTime: beforePack.createTime,
    updateTime: beforePack.updateTime,
  }, undefined);
  assert.strictEqual(missingLogPlan.changes.length, 0);
  assert.deepStrictEqual(missingLogPlan.unresolved.map(item => item.path), ['contentsUpdatedAt']);
  assert.match(missingLogPlan.unresolved[0].reason, /latest content_edit log createTime unavailable/);

  // Apply only the pure planner result to these emulator fixtures; never invoke script apply.
  const packPatch = {};
  for (const change of packPlan.changes) {
    const topLevel = change.path.split(/[.[]/)[0];
    packPatch[topLevel] = packPlan.result[topLevel];
  }
  await packRef.update(packPatch);
  await latestLogRef.update({ timestamp: logPlan.result.timestamp });
  const repairedPackSnapshot = await packRef.get();
  const repairedPack = repairedPackSnapshot.data();
  const repairedLatestLog = (await latestLogRef.get()).data();
  assert.ok(repairedPack.createdAt.isEqual(beforePack.createTime));
  assert.ok(repairedPack.updatedAt.isEqual(beforePack.updateTime));
  assert.ok(repairedPack.contentsUpdatedAt.isEqual(latestContentEditTime));
  // Firestore stores timestamps at microsecond precision; the pure planner
  // assertion above separately proves all source nanoseconds are preserved.
  assert.strictEqual(repairedPack.contents[0].expirationDate.nanoseconds, 987654000);
  assert.ok(repairedLatestLog.timestamp.isEqual(beforeLatestLog.createTime));

  const rerun = planDocument(Timestamp, 'statpacks', repairedPack, {
    createTime: beforePack.createTime,
    updateTime: repairedPackSnapshot.updateTime,
  }, latestContentEditTime);
  assert.strictEqual(rerun.changes.length, 0, 'planner is not idempotent');
  const cleanRun = spawnSync('node', [path.join(__dirname, '../repair-statpack-timestamps.cjs'), '--dry-run'], { encoding: 'utf8', env: process.env });
  assert.strictEqual(cleanRun.status, 0, cleanRun.stdout + cleanRun.stderr);
  assert.match(cleanRun.stdout, /SUMMARY: changes=0 docs=0 unresolved=0 dry-run; nothing written/);
  const oldLogAfter = await oldLogRef.get();
  assert.ok(oldLogAfter.data().timestamp.isEqual(Timestamp.fromMillis(1700000000000)));
  assert.ok(oldLogAfter.updateTime.isEqual(beforeOldLog.updateTime), 'older log was written');

  await db.terminate();
  console.log('REHEARSAL PASSED: dry-run was read-only; latest-log recovery, planner shape, and idempotency verified.');
})().catch(error => {
  console.error('REHEARSAL FAILED', error);
  process.exit(1);
});
