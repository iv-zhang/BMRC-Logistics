/**
 * Standalone Playwright config for the run-bmrc-logistics smoke driver.
 *
 * Mirrors the project's e2e config (playwright.config.ts) but points testDir at
 * THIS directory so the driver + its config live together inside the skill. It
 * still reuses the repo's real emulator plumbing: the SAME seed step
 * (e2e/global-setup.ts) and the SAME `next dev` against the Firestore emulator.
 * Invoke from the repo root wrapped in `firebase emulators:exec` so the Firestore
 * emulator is up — see SKILL.md.
 */
import { defineConfig, devices } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: HERE,
  testMatch: /smoke\.spec\.ts$/,
  // Reuse the project's working seed (child-tsx seed CLI). Path is relative to
  // this config's directory: .claude/skills/run-bmrc-logistics → repo root/e2e.
  globalSetup: join(HERE, '../../../e2e/global-setup.ts'),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'off',
    screenshot: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Boot a FRESH next dev pointed at the emulator; never reuse a stale server
    // that might have been built without the emulator env (→ production reads).
    command: 'npm run dev:emulator',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-bmrc-logistics',
    },
  },
});
