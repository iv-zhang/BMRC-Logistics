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

// AUTH-GATED: without a real Firebase user these redirect to /login. We capture
// the login screen (as documentation) and assert the gate behaves as expected.
test('dashboard is auth-gated (shows login)', async ({ page }) => {
  await shoot(page, '/dashboard', 'dashboard-login');
  await expect(page.getByText('Sign in to BMRC')).toBeVisible();
});
