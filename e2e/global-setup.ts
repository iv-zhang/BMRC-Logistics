/**
 * Playwright globalSetup — seed the emulator before the browser runs.
 *
 * Seeds in a child `tsx` process rather than importing the firebase SDK here:
 * Playwright's bundler cannot load @grpc/grpc-js. The child inherits
 * FIRESTORE_EMULATOR_HOST from `firebase emulators:exec` and runs the same
 * guarded seed CLI used everywhere else.
 */
import { execSync } from 'node:child_process';

export default async function globalSetup() {
  execSync('./node_modules/.bin/tsx ./scripts/emulator/seed-cli.ts', {
    stdio: 'inherit',
    env: process.env,
  });
  // eslint-disable-next-line no-console
  console.log('[e2e] emulator seeded with representative BMRC data');

  // If an Auth emulator is running, seed a signed-in-able admin so drivers can
  // pass the Firebase auth gate. Self-skips when no Auth emulator host is set.
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    execSync('./node_modules/.bin/tsx ./scripts/emulator/seed-auth-user.ts', {
      stdio: 'inherit',
      env: process.env,
    });
  }
}
