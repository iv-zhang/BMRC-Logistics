import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for BMRC sloppy-member end-to-end flows.
 *
 * Run it via the emulator wrapper so both the Firestore emulator AND the Next
 * dev server (pointed at that emulator) are up:
 *
 *   npm run test:e2e
 *   → firebase emulators:exec --only firestore --project demo-bmrc-logistics "playwright test"
 *
 * globalSetup seeds the representative dataset; the webServer boots `next dev`
 * with NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST set so the browser app talks to the
 * same emulator. No production config is ever reachable (demo-* project only).
 */
/**
 * Port is overridable so a run can coexist with a dev server the developer
 * already has on :3000 — `E2E_PORT=3100 npm run test:e2e`. It must never
 * `reuseExistingServer`, so without this the suite simply refuses to start.
 */
const PORT = Number(process.env.E2E_PORT || 3000);
const ORIGIN = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run dev:emulator -- --port ${PORT}`,
    url: ORIGIN,
    // Always boot a FRESH server: a stale `next dev` (built without the
    // emulator env) would make the browser talk to production Firestore.
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-bmrc-logistics',
    },
  },
});
