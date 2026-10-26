import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Same suite, served from the static export instead of `next dev` — what members
 * actually load, without React StrictMode's double-mounted listeners.
 *
 * `out/` must be built against the emulator first, and is NOT deployable afterwards
 * (rebuild with plain `npm run build` before any deploy):
 *
 *   NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
 *     NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-bmrc-logistics npx next build
 *   E2E_STATIC=1 E2E_PORT=3123 npx firebase emulators:exec --config firebase.emulator.json \
 *     --only firestore,auth --project demo-bmrc-logistics "npx playwright test -c playwright.static.config.ts"
 */
const PORT = Number(process.env.E2E_PORT || 3000);

export default defineConfig({
  ...base,
  webServer: {
    ...base.webServer,
    command: `npx -y serve@14.2.4 out -l ${PORT}`,
  },
});
