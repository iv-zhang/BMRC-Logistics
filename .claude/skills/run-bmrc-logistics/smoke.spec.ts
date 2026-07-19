/**
 * Smoke driver for BMRC Logistics — launches the real app against the Firestore
 * emulator (seeded with representative data) and screenshots the main surfaces.
 *
 * This is the agent-facing "drive the app" harness. It is a Playwright spec so it
 * reuses the project's existing emulator plumbing (see smoke.config.ts):
 *   - webServer boots `npm run dev:emulator` (next dev with
 *     NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST set → the browser talks to the emulator).
 *   - globalSetup (e2e/global-setup.ts) seeds demo-bmrc-logistics with data.
 *   - The Firestore emulator is provided by the `firebase emulators:exec` wrapper.
 * Nothing here can reach production: the project id is demo-* and the role is
 * faked with the app's documented `bmrc_role_override` localStorage flag.
 *
 * Run it (from repo root):
 *   firebase emulators:exec --only firestore --project demo-bmrc-logistics \
 *     "npx playwright test --config=.claude/skills/run-bmrc-logistics/smoke.config.ts"
 *
 * Screenshots land in .claude/skills/run-bmrc-logistics/screenshots/.
 *
 * AUTH GATE (important — see SKILL.md Gotchas): pages that call
 * onAuthStateChanged and redirect to /login without a real Firebase user
 * (dashboard, inventory, audit) show the LOGIN screen in emulator mode, because
 * firebase.ts wires only the Firestore emulator, not an Auth emulator. Pages that
 * gate on role only (statpacks, buy-list) render fully. The driver asserts on the
 * latter and captures the former as documentation.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), 'screenshots');
mkdirSync(SHOTS, { recursive: true });

// Act as admin/quartermaster so role-gated surfaces render (documented override).
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bmrc_role_override', 'admin'));
});

async function shoot(page: import('@playwright/test').Page, path: string, name: string) {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('load');
  // Firestore's long-lived listeners never reach networkidle; give the first
  // snapshot a beat to paint, then screenshot.
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

// The admin account seeded into the Auth emulator by global-setup
// (scripts/emulator/seed-auth-user.ts). Signing in with it satisfies the
// Firebase auth gate AND resolves to an admin users/{uid} doc.
const ADMIN_EMAIL = 'smoke-admin@example.com';
const ADMIN_PASSWORD = 'test1234';

// Sign in through the real /login form so onAuthStateChanged fires with a real
// Firebase user — the only thing that opens the auth-gated pages.
async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('load');
  const email = page.getByPlaceholder('Enter your email');
  const pw = page.getByPlaceholder('Enter your password');
  await email.waitFor({ state: 'visible' });
  // These are React-controlled inputs; filling before hydration finishes lets the
  // first client render clear the value (→ auth/invalid-email on submit). Let it
  // settle, fill, then assert the value actually stuck before submitting.
  await page.waitForTimeout(800);
  await email.fill(ADMIN_EMAIL);
  await pw.fill(ADMIN_PASSWORD);
  await expect(email).toHaveValue(ADMIN_EMAIL);
  await expect(pw).toHaveValue(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  // handleSubmit routes to /dashboard on success.
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 25_000 });
}

// Renders with live seeded data WITHOUT a signed-in Firebase user (role-gated only).
test('statpacks renders seeded packs', async ({ page }) => {
  await shoot(page, '/statpacks', 'statpacks');
  // Distinctive seeded content proves the emulator round-trip, not just chrome.
  // (Each pack name appears in both a card and the "expiring" banner → .first().)
  await expect(page.getByText('MRC1 Primary').first()).toBeVisible();
  await expect(page.getByText('MRC2 Primary').first()).toBeVisible();
});

// Regression: overriding to a NON-admin role (member) used to hide the sidebar's
// role-override control (it was gated on the effective isAdmin), stranding the
// user with no way to clear the test role. It must stay reachable.
test('sidebar keeps Clear test role reachable under a member override', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bmrc_role_override', 'member'));
  await shoot(page, '/statpacks', 'sidebar-clear-test-role');
  await expect(page.getByRole('button', { name: /Clear test role/i }).first()).toBeVisible();
});

test('buy-list renders', async ({ page }) => {
  await shoot(page, '/buy-list', 'buy-list');
  await expect(page.getByText('Buy List', { exact: false }).first()).toBeVisible();
});

// AUTH-GATED, now reachable: sign in via the Auth emulator, then the merged
// Assets page renders with statpacks folded in (statpacks appear as asset rows).
test('assets page renders merged statpacks (signed in)', async ({ page }) => {
  await signIn(page);
  await page.goto('/assets', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('load');
  await page.waitForTimeout(2000);
  // Dismiss the first-login tutorial overlay if it appears, for a clean shot.
  const skip = page.getByText('Skip Tutorial');
  if (await skip.isVisible().catch(() => false)) { await skip.click(); await page.waitForTimeout(400); }
  await page.screenshot({ path: join(SHOTS, 'assets.png'), fullPage: true });
  // Seeded statpacks now live under Assets — proves the merge + the auth gate opened.
  await expect(page.getByText('MRC1 Primary').first()).toBeVisible();
});

// AUTH-GATED: admin edits a pack's expected contents straight from the audit
// Statpacks tab — opens the shared StatpackEditorModal, adds an item, saves,
// and expects the success toast (toast only fires after the Firestore writes).
test('audit statpacks tab edits pack contents', async ({ page }) => {
  await signIn(page);
  await page.goto('/audit?tab=statpacks', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('load');
  await page.waitForTimeout(2500);
  const skip = page.getByText('Skip Tutorial');
  if (await skip.isVisible().catch(() => false)) { await skip.click(); await page.waitForTimeout(400); }
  await page.screenshot({ path: join(SHOTS, 'audit-statpacks.png'), fullPage: true });
  const edit = page.getByRole('button', { name: 'Edit contents' }).first();
  await expect(edit).toBeVisible();
  await edit.click();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();
  await page.getByText('Add item', { exact: false }).first().click();
  await page.screenshot({ path: join(SHOTS, 'audit-edit-contents.png'), fullPage: true });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('contents saved', { exact: false })).toBeVisible({ timeout: 10_000 });
});

// AUTH-GATED: without a real Firebase user these redirect to /login. We capture
// the login screen (as documentation) and assert the gate behaves as expected.
test('dashboard is auth-gated (shows login)', async ({ page }) => {
  await shoot(page, '/dashboard', 'dashboard-login');
  await expect(page.getByText('BMRC Logistics')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

// Inventory is a fixed-height app shell on desktop: only the item list scrolls.
// Shot at the VIEWPORT (not fullPage) — fullPage would defeat the h-screen layout.
test('inventory desktop shell (signed in)', async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/inventory', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('load');
  await page.waitForTimeout(2500);
  const skip = page.getByText('Skip Tutorial');
  if (await skip.isVisible().catch(() => false)) { await skip.click(); await page.waitForTimeout(400); }
  await page.screenshot({ path: join(SHOTS, 'inventory.png') });
  await expect(page.getByRole('heading', { name: 'Inventory' })).toBeVisible();
});

// Clicking a statpack row on /assets opens the statpack editor modal directly.
test('statpack editor modal opens from assets row', async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/assets', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('load');
  await page.waitForTimeout(2500);
  const skip = page.getByText('Skip Tutorial');
  if (await skip.isVisible().catch(() => false)) { await skip.click(); await page.waitForTimeout(400); }
  await page.getByText('MRC1 Primary').first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(SHOTS, 'statpack-editor.png') });
  await expect(page.getByText('Statpack Editor')).toBeVisible();
});

// The /tasks page is merged into /committee-board behind a Board / Tasks switcher.
test('committee board hosts the merged tasks view', async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/committee-board?view=tasks', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('load');
  await page.waitForTimeout(2500);
  const skip = page.getByText('Skip Tutorial');
  if (await skip.isVisible().catch(() => false)) { await skip.click(); await page.waitForTimeout(400); }
  await page.screenshot({ path: join(SHOTS, 'committee-tasks.png') });
  // /tasks must still resolve (redirect), not 404.
  await page.goto('/tasks', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await expect(page).toHaveURL(/committee-board/);
});

// Reads inventory docs straight from the Firestore emulator REST API so a test
// can assert on persisted fields (e.g. itemValue) the UI doesn't surface.
async function fetchInventoryDoc(name: string): Promise<Record<string, unknown> | null> {
  const host = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
  const url = `http://${host}/v1/projects/demo-bmrc-logistics/databases/(default)/documents/inventory?pageSize=300`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const body = (await res.json()) as { documents?: { fields?: Record<string, { stringValue?: string }> }[] };
  return (body.documents || []).find(d => d.fields?.name?.stringValue === name) ?? null;
}

// Log Purchase → Receive, end-to-end through the real helpers (logPurchase →
// receivePurchaseLine → addShipment) against the emulator. Drives the 3-step
// wizard (vendor dropdown w/ seeded + custom vendor, qty steppers, review value
// cards), creates an "On the way" placeholder row, receives it (stock enters,
// on-order clears), and asserts the received item persisted itemValue (worth).
test('log purchase then receive it (inventory, signed in)', async ({ page }) => {
  const ITEM = `E2E OnTheWay Bandages ${Date.now()}`;
  const NEW_VENDOR = `E2E Vendor ${Date.now()}`;
  await signIn(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/inventory', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('load');
  await page.waitForTimeout(2500);
  const skip = page.getByText('Skip Tutorial');
  if (await skip.isVisible().catch(() => false)) { await skip.click(); await page.waitForTimeout(400); }

  // ── Phase 1: Log Purchase — Step 0: Order (vendor dropdown) ────────────────
  await page.getByRole('button', { name: 'Log Purchase' }).first().click();
  await expect(page.getByText('Record an order', { exact: false })).toBeVisible();
  const vendorBox = page.getByRole('combobox', { name: 'Vendor' });
  // On a fresh emulator the vendors collection is empty; the modal seeds the two
  // defaults on open, then subscribes. Give that write + snapshot a beat before
  // opening the dropdown so the options are present.
  await page.waitForTimeout(3000);
  await vendorBox.click();
  // Seeded defaults must be offered in the dropdown.
  await expect(page.getByRole('option', { name: 'Bound Tree Medical' })).toBeVisible({ timeout: 8000 });
  await expect(page.getByRole('option', { name: 'Amazon' })).toBeVisible();
  await page.screenshot({ path: join(SHOTS, 'purchase-vendor-dropdown.png') });
  // allowsCustomValue: type a brand-new vendor (must persist on submit).
  await vendorBox.fill(NEW_VENDOR);
  // Blur into another field to close the popover (and commit the custom value)
  // so it stops covering the footer Continue button.
  await page.locator('input[type="date"]').click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Continue' }).click();

  // ── Step 1: Line Items (new SKU, qty steppers, line cost) ──────────────────
  await page.getByRole('button', { name: 'New item' }).first().click();
  await page.getByPlaceholder('e.g. Nitrile Gloves').fill(ITEM);
  await page.getByPlaceholder('e.g. GLV-7782-M').fill('E2E-SKU-001');
  await page.getByPlaceholder('—').fill('10');     // units/package input
  await page.getByPlaceholder('0.00').fill('50');  // line cost (now required) → $5.00/unit
  await page.screenshot({ path: join(SHOTS, 'purchase-line-items.png') });
  await page.getByRole('button', { name: 'Continue' }).click();

  // ── Step 2: Costs & Review (value cards) ───────────────────────────────────
  await expect(page.getByText('Total purchase value')).toBeVisible();
  await expect(page.getByText('$5.00/unit')).toBeVisible();
  await page.screenshot({ path: join(SHOTS, 'purchase-review.png') });
  // Footer submit shares the "Log Purchase" label with the toolbar button → .last()
  await page.getByRole('button', { name: 'Log Purchase' }).last().click();
  await expect(page.getByText('Record an order', { exact: false })).toBeHidden({ timeout: 10_000 });

  // The placeholder row arrives via onSnapshot and reads as "On the way".
  await expect(page.getByText(ITEM).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('On the way', { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: join(SHOTS, 'inventory-on-the-way.png') });

  // ── Phase 2: Receive it ───────────────────────────────────────────────────
  await page.getByRole('button', { name: 'Receive', exact: true }).first().click();
  await expect(page.getByText('Receive Shipment')).toBeVisible();
  await page.getByRole('button', { name: 'Receive this line' }).first().click();
  // The drawer closes itself only after receivePurchaseLine resolves for every
  // line — so a clean close is proof the Firestore round-trip succeeded.
  await expect(page.getByText('Receive Shipment')).toBeHidden({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(SHOTS, 'inventory-after-receive.png') });

  // ── Assert persisted worth + vendor persistence ───────────────────────────
  const doc = await fetchInventoryDoc(ITEM);
  expect(doc, 'received inventory doc should exist').toBeTruthy();
  const fields = (doc as { fields?: Record<string, { doubleValue?: number; integerValue?: string }> }).fields || {};
  const itemValue = fields.itemValue?.doubleValue ?? Number(fields.itemValue?.integerValue);
  expect(itemValue, 'itemValue (worth per unit) should be persisted').toBe(5);

  // The typed custom vendor must have been added to the vendors collection.
  const host = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
  const vres = await fetch(`http://${host}/v1/projects/demo-bmrc-logistics/databases/(default)/documents/vendors?pageSize=100`);
  const vbody = (await vres.json()) as { documents?: { fields?: { name?: { stringValue?: string } } }[] };
  const vendorNames = (vbody.documents || []).map(d => d.fields?.name?.stringValue);
  expect(vendorNames).toContain(NEW_VENDOR);
  expect(vendorNames).toEqual(expect.arrayContaining(['Bound Tree Medical', 'Amazon']));
});

// Member dashboard: real signed-in user + a member role override.
test('member dashboard (signed in, member override)', async ({ page }) => {
  await signIn(page);
  await page.addInitScript(() => localStorage.setItem('bmrc_role_override', 'member'));
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('load');
  await page.waitForTimeout(2500);
  const skip = page.getByText('Skip Tutorial');
  if (await skip.isVisible().catch(() => false)) { await skip.click(); await page.waitForTimeout(400); }
  await page.screenshot({ path: join(SHOTS, 'member-dashboard.png'), fullPage: true });
});
