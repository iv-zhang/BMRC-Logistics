import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDoc, getDocById, listCollection } from './emu-rest';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const project = process.env.GCLOUD_PROJECT || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || '';
const loopback = /^(127\.0\.0\.1|localhost):\d+$/;
const rulesPath = fileURLToPath(new URL('../firestore.rules', import.meta.url));
const originalRulesPromise = readFile(rulesPath, 'utf8');

test.describe.configure({ mode: 'default' });

type Manifest = {
  testRunId: string;
  firestore: { collection: string; id: string }[];
  authUserIds: string[];
  purpose: string;
};
const manifests = new Map<string, Manifest>();

function assertEmulatorSafe() {
  if (!firestoreHost || !authHost || !loopback.test(firestoreHost) || !loopback.test(authHost) || !project.startsWith('demo-')) {
    throw new Error('Dashboard remediation tests require explicit loopback Firestore/Auth emulators and a demo-* project');
  }
}

async function writeEmulatorRules(rules: string) {
  // Guard directly at the only helper that can mutate emulator rules.
  assertEmulatorSafe();
  const response = await fetch(`http://${firestoreHost}/emulator/v1/projects/${project}:securityRules`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: rules }] } }),
  });
  if (!response.ok) throw new Error(`Firestore emulator rules update failed: ${response.status} ${await response.text()}`);
}

function rulesDenying(uid: string, collection: string, docId?: string) {
  const deniedPath = `collectionId == '${collection}'${docId ? ` && docId == '${docId}'` : ''}`;
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{collectionId}/{docId} {
      allow read, write: if !(request.auth != null && request.auth.uid == '${uid}' && ${deniedPath});
    }
  }
}`;
}

test.beforeAll(() => assertEmulatorSafe());

test.afterEach(async ({}, testInfo) => {
  // Always restore the checked-in emulator rules after each test, including a
  // failed assertion after a scoped deny rule was installed.
  try {
    await writeEmulatorRules(await originalRulesPromise);
  } finally {
    const manifest = manifests.get(testInfo.testId);
    if (manifest) {
      for (const collection of ['statpack_logs', 'exchange_bag_events', 'notifications']) {
        const generated = await listCollection(collection);
        const linked = generated.filter(row =>
          manifest.firestore.some(f => f.collection === 'statpacks' && (row.statpackId === f.id || row.linkedStatpackId === f.id || row.link === `/statpacks/${f.id}`)),
        );
        manifest.firestore.push(...linked.map(row => ({ collection, id: row.id })));
      }
      const path = testInfo.outputPath('emulator-cleanup-manifest.json');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(manifest, null, 2));
      manifests.delete(testInfo.testId);
    }
  }
});

async function createUser(testInfo: TestInfo, role: 'admin' | 'member') {
  assertEmulatorSafe();
  const testRunId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `dashboard-${testRunId}@bmrc.test`;
  const manifest: Manifest = {
    testRunId,
    firestore: [],
    authUserIds: [],
    purpose: 'Synthetic dashboard remediation browser fixtures; not operational stock',
  };
  manifests.set(testInfo.testId, manifest);

  const response = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true }),
  });
  if (!response.ok) throw new Error(`Auth emulator signup failed: ${response.status}`);
  const uid = (await response.json()).localId as string;
  manifest.authUserIds.push(uid);
  manifest.firestore.push({ collection: 'users', id: uid });
  await createDoc('users', {
    isTest: true, testRunId, purpose: manifest.purpose,
    email, fullName: '[TEST] Dashboard User', role, tutorialCompleted: true,
  }, uid);

  return { uid, testRunId, email, manifest };
}

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByRole('textbox', { name: /email/i }).fill(email);
  await page.getByRole('textbox', { name: /password/i }).fill('test1234');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(url => !url.pathname.includes('/login'));
}

async function addDashboardFixtures(testInfo: TestInfo, uid: string, testRunId: string) {
  const manifest = manifests.get(testInfo.testId)!;
  const labels = { isTest: true, testRunId, purpose: manifest.purpose };
  const looseId = await createDoc('inventory', {
    ...labels, name: `[TEST] Loose reserve ${testRunId}`, category: 'Airway', location: 'HQ',
    looseUnits: 2, totalStockQuantity: 999, reorderThreshold: 3, shelfQuantity: 0,
  });
  const quarantinedId = await createDoc('inventory', {
    ...labels, name: `[TEST] Quarantined reserve ${testRunId}`, category: 'Airway', location: 'HQ',
    totalStockQuantity: 6, reorderThreshold: 2, shelfQuantity: 0,
    batches: [{ id: `q-${testRunId}`, stock: 6, bagCount: 2, itemsPerBag: 3, status: 'quarantined' }],
  });
  const shelfOnlyId = await createDoc('inventory', {
    ...labels, name: `[TEST] Shelf only ${testRunId}`, category: 'Airway', location: 'HQ',
    looseUnits: 0, totalStockQuantity: 0, reorderThreshold: 1, shelfQuantity: 99,
  });
  const expiringId = await createDoc('inventory', {
    ...labels, name: `[TEST] Reserve expiry ${testRunId}`, category: 'Medical', location: 'HQ',
    totalStockQuantity: 5, reorderThreshold: 0, shelfQuantity: 0,
    batches: [{ id: `lot-${testRunId}`, stock: 5, bagCount: 1, itemsPerBag: 5, expirationDate: new Date(Date.now() + 25 * 86400000) }],
  });
  const tombstoneId = await createDoc('inventory', {
    ...labels, name: `[TEST] Tombstone expiry ${testRunId}`, category: 'Medical', location: 'HQ',
    totalStockQuantity: 0, reorderThreshold: 0, shelfQuantity: 0,
    batches: [{ id: `empty-${testRunId}`, stock: 0, expirationDate: new Date(Date.now() + 18 * 86400000) }],
  });
  const packId = await createDoc('statpacks', {
    ...labels, name: `[TEST] Expiring pack ${testRunId}`, type: 'Primary', status: 'Ready',
    contents: [{ itemId: expiringId, itemDetails: { name: `[TEST] Pack expiry ${testRunId}` }, requiredQuantity: 1, currentQuantity: 1, expirationDate: new Date(Date.now() + 20 * 86400000) }],
    assignedToUserId: uid, createdAt: new Date(), updatedAt: new Date(),
  });
  manifest.firestore.push(
    ...[looseId, quarantinedId, shelfOnlyId, expiringId, tombstoneId].map(id => ({ collection: 'inventory', id })),
    { collection: 'statpacks', id: packId },
  );
  return { looseId, quarantinedId, shelfOnlyId, expiringId, tombstoneId, packId };
}

async function createBarePack(testInfo: TestInfo, uid: string, testRunId: string, extra: Record<string, unknown> = {}) {
  const manifest = manifests.get(testInfo.testId)!;
  const id = await createDoc('statpacks', {
    isTest: true, testRunId, purpose: manifest.purpose,
    name: `[TEST] Check-in ${testRunId}`, type: 'Primary', status: 'In Use',
    isCheckedOut: true, assignedToUserId: uid, contents: [], ...extra,
  });
  manifest.firestore.push({ collection: 'statpacks', id });
  return id;
}

test('desktop admin dashboard reports canonical available reserve and only stocked expirations', async ({ page }, testInfo) => {
  const { uid, testRunId, email } = await createUser(testInfo, 'admin');
  const fixtures = await addDashboardFixtures(testInfo, uid, testRunId);
  await signIn(page, email);
  await page.goto('/dashboard');

  const looseRow = page.getByText(`[TEST] Loose reserve ${testRunId}`).locator('xpath=../..');
  await expect(looseRow).toContainText('2');
  await expect(looseRow).toContainText('3 reorder level');
  await expect(page.getByText('999', { exact: true })).toHaveCount(0);
  const quarantineRow = page.getByText(`[TEST] Quarantined reserve ${testRunId}`).locator('xpath=../..');
  await expect(quarantineRow).toContainText('0');
  const shelfRow = page.getByText(`[TEST] Shelf only ${testRunId}`).locator('xpath=../..');
  await expect(shelfRow).toContainText('0');
  await expect(shelfRow).not.toContainText('99');

  await expect(page.getByText(`[TEST] Reserve expiry ${testRunId}`)).toBeVisible();
  await expect(page.getByText(`[TEST] Tombstone expiry ${testRunId}`).locator('xpath=../..')).toContainText('No available reserve');
  await expect(page.getByText('Reserve', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Pack', { exact: true }).first()).toBeVisible();
  expect(fixtures.packId).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('dashboard-desktop.png'), fullPage: false });
});

test('390px admin dashboard keeps available reserve counts and labels in the phone view', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { uid, testRunId, email } = await createUser(testInfo, 'admin');
  await addDashboardFixtures(testInfo, uid, testRunId);
  await signIn(page, email);
  await page.goto('/dashboard');

  const lowTile = page.getByRole('button', { name: /Low reserve/i });
  await lowTile.click();
  await expect(page.getByText(`[TEST] Loose reserve ${testRunId}`).filter({ visible: true })).toBeVisible();
  await expect(page.getByText('999', { exact: true })).toHaveCount(0);
  await expect(page.getByText(`[TEST] Quarantined reserve ${testRunId}`).filter({ visible: true })).toBeVisible();
  await expect(page.getByText(`[TEST] Shelf only ${testRunId}`).filter({ visible: true })).toBeVisible();
  await expect(page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).resolves.toBe(true);
  await page.screenshot({ path: testInfo.outputPath('dashboard-phone.png'), fullPage: false });
});

test('admin sees inventory listener failure, retries after rules recover, and gets the real summary', async ({ page }, testInfo) => {
  const { uid, testRunId, email } = await createUser(testInfo, 'admin');
  await addDashboardFixtures(testInfo, uid, testRunId);
  await writeEmulatorRules(rulesDenying(uid, 'inventory'));
  await signIn(page, email);
  await expect(page.getByRole('heading', { name: 'Dashboard data unavailable' })).toBeVisible();
  await expect(page.getByText(/Could not load inventory data/)).toBeVisible();
  await writeEmulatorRules(await originalRulesPromise);
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText(`[TEST] Loose reserve ${testRunId}`).filter({ visible: true })).toBeVisible();
  await expect(page.getByText('Dashboard data unavailable')).toHaveCount(0);
});

test('denied check-off pack can be retried after access is restored', async ({ page }, testInfo) => {
  const { uid, testRunId, email } = await createUser(testInfo, 'member');
  const packId = await createBarePack(testInfo, uid, testRunId);
  await writeEmulatorRules(rulesDenying(uid, 'statpacks', packId));
  await signIn(page, email);
  await page.goto(`/statpacks/check-off?id=${packId}&mode=checkin`);
  await expect(page.getByRole('alert').filter({ hasText: 'Unable to open check-off' })).toContainText('could not be loaded');
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await writeEmulatorRules(await originalRulesPromise);
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('button', { name: /No, used nothing/i })).toBeVisible();
});

test('linked exchange bag read failure is visible and recoverable from the check-in gate', async ({ page }, testInfo) => {
  const { uid, testRunId, email } = await createUser(testInfo, 'member');
  const bagId = await createDoc('exchange_bags', {
    isTest: true, testRunId, purpose: 'Synthetic linked-bag read recovery',
    name: `[TEST] Sealed bag ${testRunId}`, bagCode: `BAG-${testRunId}`, sealRequired: true,
    lines: [], createdAt: new Date(), updatedAt: new Date(),
  });
  manifests.get(testInfo.testId)!.firestore.push({ collection: 'exchange_bags', id: bagId });
  const packId = await createBarePack(testInfo, uid, testRunId, { exchangeBagIds: [bagId] });
  await writeEmulatorRules(rulesDenying(uid, 'exchange_bags'));
  await signIn(page, email);
  await page.goto(`/statpacks/check-off?id=${packId}&mode=checkin`);
  const failure = page.getByRole('alert').filter({ hasText: 'Exchange bags could not be loaded' });
  await expect(failure).toBeVisible();
  await writeEmulatorRules(await originalRulesPromise);
  await failure.getByRole('button', { name: 'Retry loading bags' }).click();
  await expect(failure).toHaveCount(0);
  await expect(page.getByRole('button', { name: /No, used nothing/i })).toBeVisible();
});

test('member dashboard still renders Check Out when inventory reads are denied', async ({ page }, testInfo) => {
  const { uid, email } = await createUser(testInfo, 'member');
  await writeEmulatorRules(rulesDenying(uid, 'inventory'));
  await signIn(page, email);
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Check Out', exact: true })).toBeVisible();
});


test('missing pack and missing ID show an explanation with a useful back link', async ({ page }, testInfo) => {
  const { email, testRunId } = await createUser(testInfo, 'member');
  await signIn(page, email);
  await page.goto(`/statpacks/check-off?id=missing-${testRunId}&mode=checkout`);
  await expect(page.getByRole('alert').filter({ hasText: 'Unable to open check-off' })).toContainText('could not be found');
  await expect(page.getByRole('button', { name: 'Back to checkout' })).toBeVisible();
  await page.goto('/statpacks/check-off?mode=checkin');
  await expect(page.getByRole('alert').filter({ hasText: 'Unable to open check-off' })).toContainText('missing a statpack ID');
  await page.getByRole('button', { name: 'Back to check-in' }).click();
  await expect(page).toHaveURL(/statpacks\/checkin/);
});


test('offline dashboard does not show cached data as a current healthy summary', async ({ page, context }, testInfo) => {
  const { uid, testRunId, email } = await createUser(testInfo, 'admin');
  await addDashboardFixtures(testInfo, uid, testRunId);
  await signIn(page, email);
  await expect(page.getByText(`[TEST] Loose reserve ${testRunId}`)).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByRole('heading', { name: 'Dashboard is offline' })).toBeVisible();
  await expect(page.getByText(`[TEST] Loose reserve ${testRunId}`)).toHaveCount(0);
  await context.setOffline(false);
  await expect(page.getByText(`[TEST] Loose reserve ${testRunId}`)).toBeVisible();
});


test('a missing linked bag does not block a physical used-nothing return', async ({ page }, testInfo) => {
  const { uid, testRunId, email } = await createUser(testInfo, 'member');
  const packId = await createBarePack(testInfo, uid, testRunId, { exchangeBagIds: [`missing-${testRunId}`] });
  await signIn(page, email);
  await page.goto(`/statpacks/check-off?id=${packId}&mode=checkin`);
  const warning = page.getByRole('alert').filter({ hasText: 'Exchange bags could not be loaded' });
  await expect(warning).toContainText('You can still return this pack');
  await page.getByRole('button', { name: /No, used nothing/i }).click();
  await expect(page.getByText('Check-in confirmed. Thank you.', { exact: true })).toBeVisible();
  await expect.poll(async () => (await getDocById('statpacks', packId))?.isCheckedOut).toBe(false);
});


test('retrying linked bag details preserves an entered pocket count', async ({ page }, testInfo) => {
  const { uid, testRunId, email } = await createUser(testInfo, 'admin');
  const labels = { isTest: true, testRunId, purpose: 'Synthetic retry input preservation' };
  const sku = await createDoc('inventory', { ...labels, name: '[TEST] Retry airway', category: 'Airway' });
  const bagId = await createDoc('exchange_bags', { ...labels, name: '[TEST] Retry bag', lines: [] });
  manifests.get(testInfo.testId)!.firestore.push({ collection: 'inventory', id: sku }, { collection: 'exchange_bags', id: bagId });
  const packId = await createBarePack(testInfo, uid, testRunId, {
    exchangeBagIds: [bagId],
    contents: [{ itemId: sku, pocket: 'main', requiredQuantity: 2, currentQuantity: 2 }],
  });
  await writeEmulatorRules(rulesDenying(uid, 'exchange_bags'));
  await signIn(page, email);
  await page.goto(`/statpacks/check-off?id=${packId}&mode=audit`);
  const warning = page.getByRole('alert').filter({ hasText: 'Exchange bags could not be loaded' });
  await expect(warning).toBeVisible();
  await page.getByRole('navigation', { name: 'Pocket progress' }).getByRole('button', { name: /Main Compartment/ }).click();
  const row = page.locator(`[data-pocket-id="main"] [data-sku="${sku}"]`);
  await row.getByRole('button', { name: /Decrease.*count/ }).click();
  await expect(row).toContainText('1');
  await writeEmulatorRules(await originalRulesPromise);
  await warning.getByRole('button', { name: 'Retry loading bags' }).click();
  await expect(warning).toHaveCount(0);
  await expect(row).toContainText('1');
  // The canonical pack remains unchanged: retrying a read is not a stock write.
  await expect.poll(async () => (await getDocById('statpacks', packId))?.contents[0].currentQuantity).toBe(2);
});
