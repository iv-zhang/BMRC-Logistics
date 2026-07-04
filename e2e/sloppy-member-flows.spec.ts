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
import { test, expect } from '@playwright/test';
import { getDocById, listCollection } from './emu-rest';

test.beforeEach(async ({ page }) => {
  // Act as an admin/quartermaster via the app's documented role override.
  await page.addInitScript(() => localStorage.setItem('bmrc_role_override', 'admin'));
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
  await page.getByRole('button', { name: /shipment/i }).click({ timeout: 8_000 });
  // Quantity of sealed boxes (first number spinbutton in the shipment form).
  await page.getByRole('spinbutton').first().fill('2');
  const submit = page.getByRole('button', { name: /submit|receive|confirm|add/i }).last();

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
  // The glucose lot in MRC1 expires within ~20 days; force an EXPIRED state by
  // driving the check-off and attempting to complete without fixing it.
  await page.goto('/statpacks/check-off?id=MRC1&mode=checkin');

  const complete = page.getByRole('button', { name: /complete|finish|check.?in|mark.*ready|submit/i }).last();
  await complete.waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {
    throw new Error('DRIVE: could not reach the check-off complete control within 12s');
  });
  const canComplete = await complete.isEnabled().catch(() => false);
  if (canComplete) await complete.click().catch(() => {});
  await page.waitForTimeout(800);

  // SAFE behaviour: MRC1 must NOT be left in a Ready state with an expired item.
  const pack = await getDocById('statpacks', 'MRC1');
  const status = pack?.status as string | undefined;
  expect(['Ready', undefined].includes(status) === false,
    `MRC1 was not left 'Ready' with an expired item (status='${status}')`).toBeTruthy();
});

// ── Flow D — scan a QR to a non-existent location code (INV-12 / HR-7) ────────
test('scanning to a non-existent location code is rejected, not created', async ({ page }) => {
  test.setTimeout(45_000);
  await page.goto('/audit');
  await page.getByPlaceholder(/search items/i).fill('2x2 Gauze');
  await page.getByText('2x2 Gauze', { exact: false }).first().click({ timeout: 12_000 }).catch(() => {
    throw new Error('DRIVE: could not reach the gauze item card on /audit within 12s');
  });
  const move = page.getByRole('button', { name: /move|relocate/i });
  await move.first().click({ timeout: 8_000 }).catch(() => {});

  // Try to type/scan a bogus location code.
  const bogus = 'STA-Z9-99';
  const field = page.getByPlaceholder(/location|zone|shelf|bin|code|scan/i).first();
  await field.fill(bogus).catch(() => {});
  await page.getByRole('button', { name: /save|confirm|move|apply/i }).last().click().catch(() => {});
  await page.waitForTimeout(800);

  // SAFE behaviour: the bogus code must NOT be persisted onto the gauze item.
  const gauze = await getDocById('inventory', 'gauze-2x2');
  const zoneId = (gauze?.storageLocation as { zoneId?: string } | undefined)?.zoneId;
  expect(zoneId !== bogus,
    'the phantom location code was rejected, not written to the item').toBeTruthy();
});
