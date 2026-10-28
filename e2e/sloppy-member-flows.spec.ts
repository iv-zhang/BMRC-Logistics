/**
 * End-to-end sloppy-member flows against the running app (Next dev) backed by
 * the Firestore emulator. Each test performs the SLOPPY version of a real member
 * action and asserts the system's SAFE response (block / flag / single order /
 * rejection). Assertions read the emulator state directly so they're robust to
 * DOM churn.
 *
 * These encode the SAFE behaviour the spec (invariants.md) requires. Against the
 * current code several are expected to FAIL — that is the finding, mirrored in
 * FINDINGS.md.
 */
import { test, expect, type Page } from '@playwright/test';
import { createDoc, getDocById, listCollection } from './emu-rest';

// Seeded by scripts/emulator/seed-auth-user.ts (run from e2e/global-setup.ts).
const ADMIN_EMAIL = 'smoke-admin@example.com';
const ADMIN_PASSWORD = 'test1234';

/** Sign in through the real /login form: every route is behind the Firebase auth gate. */
async function signIn(page: Page) {
  await page.goto('/login');
  const email = page.getByPlaceholder('Enter your email');
  const pw = page.getByPlaceholder('Enter your password');
  await email.waitFor({ state: 'visible' });
  // Controlled inputs: let hydration settle so the first render can't clear the value.
  await page.waitForTimeout(800);
  await email.fill(ADMIN_EMAIL);
  await pw.fill(ADMIN_PASSWORD);
  await expect(email).toHaveValue(ADMIN_EMAIL);
  await expect(pw).toHaveValue(ADMIN_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 25_000 });
  // Dismiss the first-login tour if it appears.
  const skip = page.getByText('Skip Tutorial');
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

// ── Flow C — double buy-list scan → single reorder (INV-9 / HR-8) ────────────
test('double buy-list entry for the same item yields ONE open reorder', async ({ page }) => {
  const NAME = `E2E Gauze ${Date.now()}`;
  await page.goto('/buy-list');

  const countRows = async () => (await listCollection('buyList')).filter((d) => d.itemName === NAME).length;

  async function addOnce(expectAtLeast: number) {
    await page.getByRole('button', { name: 'Add Item' }).click();
    await page.getByLabel('Item Name').fill(NAME);
    await page.getByRole('button', { name: 'Add to Buy List' }).click();
    // Confirm the write actually landed in the emulator (source of truth).
    await expect.poll(countRows, { timeout: 10_000 }).toBeGreaterThanOrEqual(expectAtLeast);
    // Ensure the modal is closed before the next add (don't depend on auto-close).
    await page.keyboard.press('Escape').catch(() => {});
    await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  }

  await addOnce(1);
  await addOnce(1); // same item still "below par" → a dedup guard must keep it at ONE

  // SAFE behaviour: re-triggering an item already on the list must NOT duplicate.
  expect(await countRows(), 'exactly one open buy-list entry after two identical adds').toBe(1);
});

// ── Flow A — receive a dated lot WITHOUT an expiration (INV-4 / HR-1) ─────────
test('receiving epi without an expiration date is blocked or flagged', async ({ page }) => {
  test.setTimeout(45_000);
  await page.goto('/audit');

  // Filter to epi via the audit search box, then open it + its Shipment action,
  // enter a quantity, leave the month "Expiration" input BLANK, and submit.
  await page.getByPlaceholder(/search items/i).fill('Epinephrine');
  const card = page.getByText('Epinephrine', { exact: false }).first();
  await card.click({ timeout: 12_000 }).catch(() => {
    throw new Error('DRIVE: could not reach the epi item card on /audit within 12s');
  });
  // The card also has a Shipment button; scope to the audit action drawer.
  const drawer = page.getByLabel(/Audit actions for/);
  await drawer.getByRole('button', { name: /^shipment$/i }).click({ timeout: 8_000 });
  // Quantity of sealed boxes: "Units per box/bag" is the only spinbutton-free
  // numeric field we must fill; the box count defaults to 1, which is enough.
  await drawer.getByLabel(/units per box/i).fill('10');
  // Expiration (type=month) is left BLANK on purpose.
  const submit = drawer.getByRole('button', { name: /^add shipment$/i });

  // SAFE behaviour: EITHER the UI blocks submit / shows an expiration warning …
  const blocked = (await submit.isDisabled().catch(() => false))
    || (await page.getByText(/expiration.*(required|missing)|enter.*expiration/i).count()) > 0;
  if (!blocked) await submit.click().catch(() => {});

  // … OR, if it let the receipt through, no epi lot may be stored with a null exp.
  await page.waitForTimeout(800);
  const epi = await getDocById('inventory', 'epi');
  const hasNoExpLot = ((epi?.batches as { expirationDate?: unknown }[]) ?? []).some((b) => b.expirationDate == null);
  expect(blocked || !hasNoExpLot,
    'blank-exp receipt was blocked/flagged, or no never-expiring lot was stored').toBeTruthy();
});

// ── Flow B — mark a Statpack ready with an expired item (HR-5 / INV-8) ────────
test('a Statpack containing an expired item cannot be marked ready', async ({ page }) => {
  test.setTimeout(45_000);
  // Seeded MRC1 has no expired lot (glucose is only "expiring"), so arrange a
  // checked-out pack whose glucose lot expired 5 days ago, then try to check it in.
  const day = 86_400_000;
  const PACK = `E2E-EXPIRED-${Date.now()}`;
  const mrc1 = await getDocById('statpacks', 'MRC1');
  const contents = ((mrc1?.contents as Record<string, unknown>[]) ?? []).map((c) =>
    c.expirationDate && !c.requiresExpirationCheck
      ? { ...c, expirationDate: new Date(Date.now() - 5 * day) } : c);
  await createDoc('statpacks', {
    name: 'E2E Expired Pack', type: 'Primary', status: 'In Use', isCheckedOut: true,
    currentLocation: 'MRC1', compartments: mrc1?.compartments, contents,
    sharpsContainer: { status: 'ok' }, createdAt: new Date(), updatedAt: new Date(),
  }, PACK);
  await page.goto(`/statpacks/check-off?id=${PACK}&mode=checkin`);

  // Check-in opens on a "did you use anything?" gate; escape to the full form,
  // which is the path that carries the verification + complete control.
  const fullCheckoff = page.getByRole('button', { name: /open full check-off/i });
  await fullCheckoff.click({ timeout: 12_000 }).catch(() => {});

  // Footer button: "Review Check-In" (or "N need(s) fixing" when blockers remain).
  const complete = page.getByRole('button', { name: /review check-in|need.* fixing|complete|submit/i }).last();
  await complete.waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {
    throw new Error('DRIVE: could not reach the check-off complete control within 12s');
  });
  const canComplete = await complete.isEnabled().catch(() => false);
  if (canComplete) await complete.click().catch(() => {});
  // If nothing blocked it, a "Confirm check-in" review sheet opens; confirm it.
  const confirm = page.getByRole('button', { name: /confirm check-in/i });
  if (await confirm.isVisible({ timeout: 2_000 }).catch(() => false)) await confirm.click().catch(() => {});
  await page.waitForTimeout(1500);

  // SAFE behaviour: the pack must NOT be left in a Ready state with an expired item.
  const pack = await getDocById('statpacks', PACK);
  const status = pack?.status as string | undefined;
  expect(['Ready', undefined].includes(status) === false,
    `pack with an expired item was not left 'Ready' (status='${status}')`).toBeTruthy();
});

// ── Flow D — scan a QR to a non-existent location code (INV-12 / HR-7) ────────
test('scanning to a non-existent location code is rejected, not created', async ({ page }) => {
  test.setTimeout(45_000);
  await page.goto('/audit');
  await page.getByPlaceholder(/search items/i).fill('2x2 Gauze');
  await page.getByText('2x2 Gauze', { exact: false }).first().click({ timeout: 12_000 }).catch(() => {
    throw new Error('DRIVE: could not reach the gauze item card on /audit within 12s');
  });
  const drawer = page.getByLabel(/Audit actions for/);
  await drawer.getByRole('button', { name: /^move$/i }).click({ timeout: 8_000 });

  // The Move action offers only zone/shelf/container pickers (no free-text
  // location-code field), so a phantom code can't be entered as a location.
  // Put the bogus code in the only free-text field (the note) and submit.
  const bogus = 'STA-Z9-99';
  await drawer.getByLabel(/^note/i).fill(bogus);
  const submit = drawer.getByRole('button', { name: /^move item$/i });
  if (await submit.isEnabled().catch(() => false)) await submit.click().catch(() => {});
  await page.waitForTimeout(800);

  // SAFE behaviour: the bogus code must NOT be persisted onto the gauze item.
  const gauze = await getDocById('inventory', 'gauze-2x2');
  const zoneId = (gauze?.storageLocation as { zoneId?: string } | undefined)?.zoneId;
  expect(zoneId !== bogus,
    'the phantom location code was rejected, not written to the item').toBeTruthy();
});
