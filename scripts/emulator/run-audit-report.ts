import './guard';

import assert from 'node:assert/strict';
import { collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, terminate, Timestamp, where } from 'firebase/firestore';
import { db } from '@/firebase';
import type { InventoryItem } from '@/app/types';
import { reportItemIssue } from '@/app/lib/audit-actions';
import { createReport } from '@/app/lib/reports';

const testRunId = `audit-report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const purpose = 'Batch 1b bin report completion without optional reporter fields';
const itemId = `${testRunId}-cold-pack`;
const actor = { uid: testRunId, name: `[TEST] ${testRunId}` };
const cleanupManifest = { inventory: [itemId], issue_reports: [] as string[], inventory_logs: [] as string[], auditEvents: [] as string[] };
const item = {
  id: itemId, name: `[TEST] Cold Pack ${testRunId}`, category: 'Trauma',
  location: 'Other', unopenedBoxes: 0, looseUnits: 60,
  reorderThreshold: 0, tracksExpiration: false, auditCondition: 'Good',
  createdAt: new Date(), updatedAt: new Date(),
} as InventoryItem;

async function related(collectionName: string, field: string, value: string) {
  return (await getDocs(query(collection(db, collectionName), where(field, '==', value)))).docs;
}

async function discover() {
  const [reports, logs, itemEvents, directReports] = await Promise.all([
    related('issue_reports', 'target.docId', itemId),
    related('inventory_logs', 'itemId', itemId),
    related('auditEvents', 'sourceId', itemId),
    related('issue_reports', 'title', `[TEST] Optional fields ${testRunId}`),
  ]);
  cleanupManifest.issue_reports.push(...reports.map(d => d.id), ...directReports.map(d => d.id));
  cleanupManifest.inventory_logs.push(...logs.map(d => d.id));
  cleanupManifest.auditEvents.push(...itemEvents.map(d => d.id));
  const reportEvents = await Promise.all([...new Set(cleanupManifest.issue_reports)].map(id => related('auditEvents', 'sourceId', id)));
  cleanupManifest.auditEvents.push(...reportEvents.flat().map(d => d.id));
  return { reports, logs, itemEvents, reportEvents: reportEvents.flat() };
}

let failed = false;
try {
  await setDoc(doc(db, 'inventory', itemId), { ...item, isTest: true, testRunId, purpose });
  // Actual drawer action: reporter.isAnonymous, quantity, notes and email are absent.
  await reportItemIssue(item, { issueType: 'damaged' }, actor);
  const after = (await getDoc(doc(db, 'inventory', itemId))).data();
  assert.equal(after?.auditCondition, 'Damaged');
  assert.ok(after?.updatedAt instanceof Timestamp, 'server timestamp stays a Firestore timestamp');
  const evidence = await discover();
  assert.equal(evidence.reports.length, 1);
  assert.equal(evidence.logs.length, 1);
  assert.equal(evidence.itemEvents.length, 1);
  assert.equal(evidence.reportEvents.length, 1);
  assert.equal(evidence.reports[0].data().reporter.isAnonymous, undefined);
  assert.ok(evidence.reports[0].data().createdAt instanceof Timestamp);
  assert.equal(evidence.logs[0].data().action, 'issue_reported');
  assert.equal(evidence.itemEvents[0].data().eventType, 'item_issue_reported');
  assert.equal(evidence.reportEvents[0].data().eventType, 'issue_report_created');
  assert.equal(evidence.reportEvents[0].data().details.isAnonymous, undefined);

  // The same create boundary must retain explicit false while omitting optional
  // top-level fields, nested reporter fields and undefined target qualifiers.
  const directId = await createReport({
    reporter: { userId: testRunId, userName: undefined, isAnonymous: false },
    title: `[TEST] Optional fields ${testRunId}`, description: `[TEST] ${purpose}`,
    type: 'bug', priority: 'low', target: { collection: 'inventory', docId: undefined },
  });
  cleanupManifest.issue_reports.push(directId);
  const direct = (await getDoc(doc(db, 'issue_reports', directId))).data();
  assert.equal(direct?.reporter.isAnonymous, false);
  assert.equal(direct?.pagePath, undefined);
  assert.equal(direct?.target.docId, undefined);
  assert.ok(direct?.createdAt instanceof Timestamp);
  const directEvents = await related('auditEvents', 'sourceId', directId);
  cleanupManifest.auditEvents.push(...directEvents.map(d => d.id));
  assert.equal(directEvents.length, 1);
  assert.equal(directEvents[0].data().details.isAnonymous, false);
  console.log(`Audit bin report writer checks passed (${testRunId}).`);
} catch (error) {
  failed = true;
  console.error('Audit bin report writer checks failed:', error);
} finally {
  try { await discover(); } catch (error) {
    failed = true;
    console.error('Could not discover report evidence for cleanup:', error);
  }
  for (const [collectionName, ids] of Object.entries(cleanupManifest)) {
    for (const id of new Set(ids)) {
      try { await deleteDoc(doc(db, collectionName, id)); } catch (error) {
        failed = true;
        console.error(`Cleanup failed for ${collectionName}/${id}:`, error);
      }
    }
  }
  if (failed) console.error('Audit report cleanup manifest:', JSON.stringify(cleanupManifest, null, 2));
  await terminate(db);
}
process.exit(failed ? 1 : 0);
