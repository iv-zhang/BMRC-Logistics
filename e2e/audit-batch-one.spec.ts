/** Targeted audit UI coverage. Requires fresh demo Firestore + Auth emulators.
 * E2E_PORT=3123 firebase emulators:exec --config firebase.emulator.json --only firestore,auth \
 *   --project demo-bmrc-logistics "npx playwright test e2e/audit-batch-one.spec.ts"
 * Fixtures use only synthetic [TEST] records; never point this at hosted Firebase.
 */
import { test, expect, type Page } from '@playwright/test';
import { createDoc, getDocById, listCollection } from './emu-rest';

const project = process.env.GCLOUD_PROJECT || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'demo-bmrc-logistics';
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
function loopback(host: string) {
  const url = new URL(`http://${host}`);
  return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && Boolean(url.port) && !url.username && !url.password;
}
if (!project.startsWith('demo-') || !loopback(firestoreHost) || !loopback(authHost)) {
  throw new Error('Audit fixtures require a demo project and loopback emulator hosts');
}

type CleanupRecord = { run: string; authUsers: string[]; fixtures: Array<{ collection: string; id: string }>; itemIds: string[] };
const cleanupRecords = new Map<string, CleanupRecord>();

test.afterEach(async () => {
  const record = cleanupRecords.get(test.info().testId);
  if (!record) return;
  const generated: Array<{ collection: string; id: string }> = [];
  for (const collection of ['inventory_logs', 'auditEvents', 'issue_reports']) {
    const rows = await listCollection(collection);
    for (const row of rows) {
      if (record.itemIds.includes(row.itemId) || record.itemIds.includes(row.sourceId) ||
          record.itemIds.includes(row.target?.docId) ||
          (row.targets ?? []).some((target: { docId?: string }) => target.docId && record.itemIds.includes(target.docId))) {
        generated.push({ collection, id: row.id });
      }
    }
  }
  await test.info().attach('cleanup-manifest', {
    body: JSON.stringify({ ...record, generated, environment: { project, firestoreHost, authHost }, disposition: 'Retain until dedicated emulators are disposed; no shared-emulator deletion' }, null, 2),
    contentType: 'application/json',
  });
  cleanupRecords.delete(test.info().testId);
});

async function fixture(page: Page) {
  const run = `TEST-AUDIT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const email = `${run.toLowerCase()}@bmrc.test`;
  const record: CleanupRecord = { run, authUsers: [], fixtures: [], itemIds: [] };
  cleanupRecords.set(test.info().testId, record);
  const response = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }),
  });
  if (!response.ok) throw new Error(`Demo auth fixture failed: ${response.status}`);
  const { localId: uid } = await response.json();
  record.authUsers.push(uid);
  record.fixtures.push({ collection: 'users', id: uid });
  const labels = { isTest: true, testRunId: run, purpose: 'Disposable audit Batch 1 fixture' };
  await createDoc('users', { ...labels, email, fullName: '[TEST] Audit quartermaster', role: 'quartermaster', tutorialCompleted: true }, uid);
  const bin = `${run}-BIN`, tote = `${run}-TOTE`;
  record.fixtures.push({ collection: 'containers', id: bin }, { collection: 'containers', id: tote });
  await createDoc('containers', { ...labels, name: '[TEST] Shared mixed-size bin', barcode: bin }, bin);
  await createDoc('containers', { ...labels, name: '[TEST] Bulk tote', barcode: tote }, tote);
  const sizes = [['OPA, 80 mm', 12], ['OPA, 90 mm', 10], ['NPA, 28 Fr', 5], ['NPA, 30 Fr', 2], ['SAM Splint, standard', 6]] as const;
  const ids: string[] = [];
  for (const [index, [name, count]] of sizes.entries()) {
    const id = `${run}-${index}`;
    ids.push(id);
    record.itemIds.push(id);
    record.fixtures.push({ collection: 'inventory', id });
    await createDoc('inventory', { ...labels, name: `[TEST] ${name}`, category: 'Airway', location: 'HQ', room: 'Storage Room', unopenedBoxes: 0, looseUnits: count, totalStockQuantity: count, storageLocation: { containerId: bin, containerName: '[TEST] Shared mixed-size bin' } }, id);
  }
  const bulk = `${run}-COLD`;
  record.itemIds.push(bulk);
  record.fixtures.push({ collection: 'inventory', id: bulk });
  await createDoc('inventory', { ...labels, name: '[TEST] Cold Pack, individual', category: 'First Aid', location: 'HQ', unopenedBoxes: 0, looseUnits: 60, totalStockQuantity: 60, storageLocation: { containerId: tote, containerName: '[TEST] Bulk tote' } }, bulk);
  await page.goto('/login');
  expect(loopback(new URL(page.url()).host)).toBeTruthy();
  await page.getByRole('textbox', { name: /email/i }).fill(email);
  await page.getByRole('textbox', { name: /password/i }).fill('test1234');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(url => !url.pathname.includes('/login'));
  return { run, bin, tote, ids, bulk };
}

async function openCount(page: Page, id: string) {
  await page.getByTestId(`audit-item-${id}`).getByRole('button', { name: 'Count', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save count', exact: true })).toBeDisabled();
}

test('mixed-size bin: keyboard selection, mismatch persists, explicit correction, revisiting verified sizes', async ({ page }) => {
  const { bin, ids } = await fixture(page);
  await page.goto('/audit');
  const selector = page.getByLabel('Open a bin or tote');
  await selector.focus();
  await selector.selectOption(bin);
  await expect(page.getByTestId('active-audit-container')).toContainText('5 size-specific items');
  for (const id of ids) await expect(page.getByTestId(`audit-item-${id}`)).toBeVisible();
  const count = page.getByTestId(`audit-item-${ids[0]}`).getByRole('button', { name: 'Count', exact: true });
  await count.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Save count', exact: true })).toBeDisabled();
  await page.getByLabel('Individual units observed').fill('9');
  await expect(page.getByTestId('audit-count-comparison')).toContainText('Delta -3 units');
  await page.getByRole('button', { name: 'Save count', exact: true }).click();
  await expect(page.getByTestId(`audit-item-${ids[0]}`)).toContainText('Unresolved count');
  await expect.poll(async () => (await getDocById('inventory', ids[0]))?.auditCountObservation?.observed.loose).toBe(9);
  let stored = await getDocById('inventory', ids[0]);
  expect(stored?.looseUnits).toBe(12);
  expect(stored?.auditCountObservation?.observed.loose).toBe(9);
  await openCount(page, ids[0]);
  await expect(page.getByTestId('saved-audit-variance')).toContainText('Delta: -3 units');
  await page.screenshot({ path: test.info().outputPath('audit-desktop-unresolved.png'), animations: 'disabled', fullPage: false });
  await page.getByRole('button', { name: 'Use recorded observation' }).click();
  await page.screenshot({ path: test.info().outputPath('audit-desktop-correction.png'), animations: 'disabled', fullPage: false });
  await page.getByRole('button', { name: 'Apply observed count to stock' }).click();
  // Role queries can temporarily omit a loading button; wait for the server record,
  // then require the whole drawer to close before continuing.
  await expect.poll(async () => {
    const saved = await getDocById('inventory', ids[0]);
    return { loose: saved?.looseUnits, verified: saved?.auditVerified, unresolved: Boolean(saved?.auditCountObservation) };
  }).toEqual({ loose: 9, verified: true, unresolved: false });
  await expect(page.getByRole('dialog', { name: 'Audit actions for [TEST] OPA, 80 mm', exact: true })).not.toBeVisible();
  stored = await getDocById('inventory', ids[0]);
  expect(stored?.looseUnits).toBe(9);
  expect(stored?.auditCountObservation).toBeFalsy();
  await expect(page.getByTestId(`audit-item-${ids[0]}`)).toContainText('Verified');
  await expect(page.getByTestId(`audit-item-${ids[1]}`)).toBeVisible();
  await openCount(page, ids[1]);
  await page.getByRole('button', { name: 'Matches expected (10 units)', exact: true }).click();
  await page.getByRole('button', { name: 'Save count', exact: true }).click();
  await expect(page.getByTestId(`audit-item-${ids[1]}`)).toContainText('Verified');
  await expect(page.getByTestId(`audit-item-${ids[0]}`)).toBeVisible();
});

test('mobile tote deep link counts loose stock and reports in place without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { tote, bulk } = await fixture(page);
  await page.goto(`/audit?container=${encodeURIComponent(tote)}`);
  await expect(page.getByTestId('active-audit-container')).toContainText('1 size-specific items');
  await openCount(page, bulk);
  await page.getByRole('button', { name: 'Matches expected (60 units)', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Audit actions for [TEST] Cold Pack, individual', exact: true });
  await expect(dialog).toBeVisible();
  const panelBounds = await dialog.boundingBox();
  expect(panelBounds).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(panelBounds!.y).toBeGreaterThanOrEqual(0);
  expect(panelBounds!.y + panelBounds!.height).toBeLessThanOrEqual(viewport.height);
  await expect(page.getByRole('button', { name: 'Save count', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: test.info().outputPath('audit-phone-count.png'), animations: 'disabled', fullPage: false });
  await page.getByRole('button', { name: 'Save count', exact: true }).click();
  await expect(page.getByTestId(`audit-item-${bulk}`)).toContainText('Verified');
  await openCount(page, bulk);
  await page.getByRole('button', { name: 'Report', exact: true }).click();
  await page.getByRole('button', { name: 'Broken', exact: true }).click();
  await page.getByRole('button', { name: 'Submit report', exact: true }).click();
  await expect.poll(async () => (await getDocById('inventory', bulk))?.auditCondition).toBe('Damaged');
  await expect(page.getByRole('dialog', { name: 'Audit actions for [TEST] Cold Pack, individual', exact: true })).not.toBeVisible();
  expect((await getDocById('inventory', bulk))?.auditCondition).toBe('Damaged');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test('receipt while count is open preserves input and blocks stale absolute correction', async ({ page }) => {
  const { bin, ids } = await fixture(page);
  await page.goto(`/audit?container=${encodeURIComponent(bin)}`);
  await openCount(page, ids[0]);
  await page.getByLabel('Individual units observed').fill('9');
  const url = `http://${firestoreHost}/v1/projects/${project}/databases/(default)/documents/inventory/${ids[0]}?updateMask.fieldPaths=looseUnits&updateMask.fieldPaths=totalStockQuantity`;
  const response = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { looseUnits: { integerValue: '15' }, totalStockQuantity: { integerValue: '15' } } }) });
  expect(response.ok).toBeTruthy();
  await expect(page.getByRole('alert').filter({ hasText: 'Stock changed while this count was open' })).toContainText('Stock changed while this count was open');
  await expect(page.getByLabel('Individual units observed')).toHaveValue('9');
  await expect(page.getByRole('button', { name: 'Save count', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Apply observed count to stock' })).toBeDisabled();
  expect((await getDocById('inventory', ids[0]))?.looseUnits).toBe(15);
});
