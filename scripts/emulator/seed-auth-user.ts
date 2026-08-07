/**
 * Seed signed-in-able users into the Auth emulator (+ matching users/{uid} docs)
 * so browser sessions can pass the Firebase auth gate as any role.
 *
 * Two consumers:
 *   • Playwright globalSetup — needs the single smoke admin (SMOKE_ADMIN_*).
 *   • The local sandbox (`npm run dev:sandbox`) — wants one login per role so a
 *     developer can exercise admin / quartermaster / member / FTO / medops views
 *     without ever touching the real project. See SANDBOX.md.
 *
 * No-ops unless an Auth emulator host is present, so the Firestore-only test
 * runs (invariants / properties / simulation) are unaffected. Idempotent: if an
 * account already exists we sign in to recover its uid. The Auth emulator
 * ignores the API key value; project scoping comes from --project (singleProject).
 */
import { db } from './harness';
import { doc, setDoc } from 'firebase/firestore';

export const SMOKE_ADMIN_EMAIL = 'smoke-admin@example.com';
export const SMOKE_ADMIN_PASSWORD = 'test1234';

/** Shared password for every sandbox login. */
const SANDBOX_PASSWORD = 'test1234';

const AUTH_HOST =
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||
  process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST ||
  '';

/** Role values must match app/types.ts (note the exact `FTO` casing). */
interface SeedUser {
  email: string;
  password: string;
  role: 'admin' | 'quartermaster' | 'member' | 'FTO' | 'medops';
  fullName: string;
}

const SEED_USERS: SeedUser[] = [
  // Kept for Playwright globalSetup (do not remove).
  { email: SMOKE_ADMIN_EMAIL, password: SMOKE_ADMIN_PASSWORD, role: 'admin', fullName: 'Smoke Admin' },
  // One friendly login per role for the local sandbox.
  { email: 'admin@bmrc.test',  password: SANDBOX_PASSWORD, role: 'admin',         fullName: 'Ada Admin' },
  { email: 'qm@bmrc.test',     password: SANDBOX_PASSWORD, role: 'quartermaster', fullName: 'Quinn Quartermaster' },
  { email: 'member@bmrc.test', password: SANDBOX_PASSWORD, role: 'member',        fullName: 'Morgan Member' },
  { email: 'fto@bmrc.test',    password: SANDBOX_PASSWORD, role: 'FTO',           fullName: 'Frankie FTO' },
  { email: 'medops@bmrc.test', password: SANDBOX_PASSWORD, role: 'medops',        fullName: 'Max MedOps' },
];

/** Create (or recover) an auth account and write its users/{uid} doc. */
async function seedRoleUser(u: SeedUser): Promise<void> {
  const key = 'demo-emulator-key';
  const base = `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts`;
  const body = JSON.stringify({ email: u.email, password: u.password, returnSecureToken: true });

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
    throw new Error(`could not resolve uid for ${u.email}: ${JSON.stringify(signUpJson)}`);
  }

  await setDoc(
    doc(db, 'users', localId),
    {
      id: localId,
      // `fullName` is what the app reads; `name` kept for any legacy reader.
      fullName: u.fullName,
      name: u.fullName,
      email: u.email,
      role: u.role,
      tutorialCompleted: true, // suppress the first-login onboarding overlay
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    { merge: true },
  );
  console.log(`[seed-auth-user] ${u.role.padEnd(13)} ${u.email.padEnd(24)} → users/${localId}`);
}

async function main() {
  if (!AUTH_HOST) {
    console.log('[seed-auth-user] no Auth emulator host set; skipping');
    process.exit(0);
  }
  for (const u of SEED_USERS) {
    await seedRoleUser(u);
  }
  console.log(`[seed-auth-user] ${SEED_USERS.length} accounts ready (password: ${SANDBOX_PASSWORD})`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[seed-auth-user] failed:', e);
  process.exit(1);
});
