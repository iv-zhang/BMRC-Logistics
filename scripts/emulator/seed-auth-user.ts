/**
 * Seed a signed-in-able admin user into the Auth emulator (+ a matching
 * users/{uid} doc) so browser drivers can pass the Firebase auth gate and land
 * on admin-gated pages (assets, dashboard, inventory, audit).
 *
 * No-ops unless an Auth emulator host is present, so the Firestore-only test
 * runs (invariants / properties / simulation) are unaffected. Idempotent: if the
 * user already exists we sign in to recover its uid.
 *
 * Runs from Playwright globalSetup after the dataset seed. The Auth emulator
 * ignores the API key value; project scoping comes from --project on the
 * emulator (singleProjectMode).
 */
import { db } from './harness';
import { doc, setDoc } from 'firebase/firestore';

export const SMOKE_ADMIN_EMAIL = 'smoke-admin@example.com';
export const SMOKE_ADMIN_PASSWORD = 'test1234';

const AUTH_HOST =
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||
  process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST ||
  '';

async function main() {
  if (!AUTH_HOST) {
    // eslint-disable-next-line no-console
    console.log('[seed-auth-user] no Auth emulator host set; skipping');
    process.exit(0);
  }
  const key = 'demo-emulator-key';
  const base = `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts`;
  const body = JSON.stringify({
    email: SMOKE_ADMIN_EMAIL,
    password: SMOKE_ADMIN_PASSWORD,
    returnSecureToken: true,
  });

  let localId = '';
  const signUp = await fetch(`${base}:signUp?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const signUpJson = await signUp.json();
  if (signUpJson.localId) {
    localId = signUpJson.localId;
  } else {
    // Already exists (EMAIL_EXISTS) → sign in to recover the uid.
    const signIn = await fetch(`${base}:signInWithPassword?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const signInJson = await signIn.json();
    localId = signInJson.localId || '';
  }
  if (!localId) {
    // eslint-disable-next-line no-console
    console.error('[seed-auth-user] could not resolve uid', signUpJson);
    process.exit(1);
  }

  await setDoc(
    doc(db, 'users', localId),
    {
      name: 'Smoke Admin',
      email: SMOKE_ADMIN_EMAIL,
      role: 'admin',
      tutorialCompleted: true, // suppress the first-login onboarding overlay
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    { merge: true }
  );
  // eslint-disable-next-line no-console
  console.log(`[seed-auth-user] admin ready (${SMOKE_ADMIN_EMAIL} → users/${localId})`);
  process.exit(0);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[seed-auth-user] failed:', e);
  process.exit(1);
});
