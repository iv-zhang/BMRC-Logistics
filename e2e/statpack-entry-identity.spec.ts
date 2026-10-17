import { test, expect, type Page, type TestInfo, type Locator } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createDoc, getDocById, listCollection } from './emu-rest';

// Require explicit local emulators even though emu-rest also rejects real projects.
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const project = process.env.GCLOUD_PROJECT || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'demo-bmrc-logistics';
const loopback = /^(127\.0\.0\.1|localhost):\d+$/;
test.beforeAll(() => {
  if (!firestoreHost || !authHost || !loopback.test(firestoreHost) || !loopback.test(authHost) || !project.startsWith('demo-')) {
    throw new Error('Statpack identity tests require explicit loopback Firestore/Auth emulators and a demo project');
  }
});

type FixtureManifest = { testRunId: string; firestore: { collection: string; id: string }[]; authUserIds: string[]; packId?: string };
const manifests = new Map<string, FixtureManifest>();
test.afterEach(async ({}, testInfo) => {
  const manifest = manifests.get(testInfo.testId);
  if (!manifest) return;
  // Retained exact-ID manifest for this throwaway emulator run. Auto-generated
  // side effects are linked to our unique pack; never select unrelated data.
  if (manifest.packId) {
    for (const collection of ['statpack_logs', 'team_tasks', 'notifications']) {
      const generated = (await listCollection(collection)).filter(row =>
        row.statpackId === manifest.packId || row.linkedStatpackId === manifest.packId || row.link === `/statpacks/${manifest.packId}`);
      manifest.firestore.push(...generated.map(row => ({ collection, id: row.id })));
    }
  }
  const path = testInfo.outputPath('emulator-cleanup-manifest.json');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ ...manifest, purpose: 'Synthetic repeated-SKU regression; remove only these exact IDs or shut down the throwaway emulator' }, null, 2));
  manifests.delete(testInfo.testId);
});

async function fixture(page: Page, testInfo: TestInfo) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const email = `entry-${stamp}@bmrc.test`;
  const labels = { isTest: true, testRunId: stamp, purpose: 'Synthetic pack entry identity regression; not clinical stock' };
  const manifest: FixtureManifest = { testRunId: stamp, firestore: [], authUserIds: [] };
  manifests.set(testInfo.testId, manifest);
  const response = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }),
  });
  if (!response.ok) throw new Error(`Auth emulator signup: ${response.status}`);
  const uid = (await response.json()).localId;
  manifest.authUserIds.push(uid);
  manifest.firestore.push({ collection: 'users', id: uid });
  await createDoc('users', { ...labels, fullName: '[TEST] Entry Inspector', email, role: 'admin', tutorialCompleted: true, createdAt: new Date() }, uid);
  const sku = `entry-airway-${stamp}`;
  manifest.firestore.push({ collection: 'inventory', id: sku });
  await createDoc('inventory', { ...labels, name: '[TEST] OPA', variantLabel: '80 mm', category: 'Airway', isAsset: false }, sku);
  const id = await createDoc('statpacks', {
    ...labels, name: `[TEST] Repeated SKU ${stamp}`, type: 'Primary', status: 'In Use',
    isCheckedOut: true, assignedToUserId: uid, assignedToUserName: '[TEST] Entry Inspector',
    contents: [
      { itemId: sku, batchId: 'lot-1', compartmentId: 'shared', pocket: 'main', requiredQuantity: 2, currentQuantity: 2 },
      { itemId: sku, batchId: 'lot-1', compartmentId: 'shared', pocket: 'front_aux', requiredQuantity: 5, currentQuantity: 5 },
    ], createdAt: new Date(), updatedAt: new Date(),
  });
  manifest.packId = id;
  manifest.firestore.push({ collection: 'statpacks', id });
  await page.goto('/login');
  await page.getByRole('textbox', { name: /email/i }).fill(email);
  await page.getByRole('textbox', { name: /password/i }).fill('test1234');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(url => !url.pathname.includes('/login'));
  return { id, sku };
}

async function quantities(id: string) {
  const pack = await getDocById('statpacks', id);
  return (pack?.contents || []).map((entry: { currentQuantity: number }) => entry.currentQuantity);
}

async function expectWithinPhoneViewport(page: Page, locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeInViewport();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'phone layout must not overflow horizontally').toBe(true);
}

test('full audit keeps repeated SKU counts and verification independent by pocket', async ({ page }, testInfo) => {
  const { id, sku } = await fixture(page, testInfo);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/statpacks/check-off?id=${id}&mode=audit`);
  await expectWithinPhoneViewport(page, page.getByRole('navigation', { name: 'Pocket progress' }));
  await page.getByRole('navigation', { name: 'Pocket progress' }).getByRole('button', { name: /Main Compartment/ }).click();
  const main = page.locator(`[data-pocket-id="main"] [data-sku="${sku}"]`);
  await expect(main).toContainText('80 mm');
  await main.getByRole('button', { name: /Decrease.*count/ }).click();
  await main.click();
  await page.getByRole('navigation', { name: 'Pocket progress' }).getByRole('button', { name: /Front Aux Pouch/ }).click();
  const front = page.locator(`[data-pocket-id="front_aux"] [data-sku="${sku}"]`);
  await expect(front).toContainText('5');
  await expect(page.getByRole('navigation', { name: 'Pocket progress' }).getByRole('button', { name: /Front Aux Pouch/ })).toContainText('1 remaining');
  await front.click();
  await expectWithinPhoneViewport(page, page.getByRole('button', { name: 'Submit Audit', exact: true }));
  await page.screenshot({ path: testInfo.outputPath('audit-phone.png'), animations: 'disabled', fullPage: false });
  await page.getByRole('button', { name: 'Submit Audit', exact: true }).click();
  await expect(page.getByText(/Audit submitted for/)).toBeVisible();
  await expect.poll(() => quantities(id)).toEqual([1, 5]);
  const logs = (await listCollection('statpack_logs')).filter(log => log.statpackId === id);
  expect(logs).toHaveLength(1);
  expect(logs[0].checkEntries.map((entry: { pocket: string; countedQuantity: number }) => [entry.pocket, entry.countedQuantity])).toEqual([['main', 1], ['front_aux', 5]]);
});

test('used-something saves only the touched occurrence even with a shared compartment ID', async ({ page }, testInfo) => {
  const { id, sku } = await fixture(page, testInfo);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/statpacks/check-off?id=${id}&mode=checkin`);
  await page.getByRole('button', { name: /Yes.*used something/i }).click();
  await page.locator(`[data-used-pocket="front_aux"][data-sku="${sku}"]`).click();
  await expectWithinPhoneViewport(page, page.getByRole('button', { name: 'Continue', exact: true }));
  await page.screenshot({ path: testInfo.outputPath('used-picker.png'), animations: 'disabled', fullPage: false });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm Check-In', exact: true }).click();
  await expect(page.getByText('Check-in confirmed. Thank you.', { exact: true })).toBeVisible();
  await expect.poll(() => quantities(id)).toEqual([2, 4]);
  const logs = (await listCollection('statpack_logs')).filter(log => log.statpackId === id);
  expect(logs).toHaveLength(1);
  expect(logs[0].checkEntries).toHaveLength(1);
  expect(logs[0].checkEntries[0]).toMatchObject({ itemId: sku, pocket: 'front_aux', compartmentId: 'shared', countedQuantity: 4 });
});

test('used-nothing returns immediately and preserves both pocket counts', async ({ page }, testInfo) => {
  const { id } = await fixture(page, testInfo);
  await page.goto(`/statpacks/check-off?id=${id}&mode=checkin`);
  await page.getByRole('button', { name: /No.*used nothing/i }).click();
  await expect(page.getByText('Check-in confirmed. Thank you.', { exact: true })).toBeVisible();
  await expect.poll(async () => (await getDocById('statpacks', id))?.isCheckedOut).toBe(false);
  expect(await quantities(id)).toEqual([2, 5]);
  const logs = (await listCollection('statpack_logs')).filter(log => log.statpackId === id);
  expect(logs).toHaveLength(1);
  expect(logs[0].quickCheckin).toBe(true);
  expect(logs[0].checkEntries).toEqual([]);
});
