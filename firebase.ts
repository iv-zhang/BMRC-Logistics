// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// ── Firestore Local Emulator wiring ──────────────────────────────────────────
// When an emulator host is present we point Firestore at it. Two sources:
//   • NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST — inlined into the browser bundle by
//     Next when running `next dev` against the emulator (Playwright / P5).
//   • FIRESTORE_EMULATOR_HOST — set automatically by `firebase emulators:exec`
//     for Node test runs (integration / property / simulation).
// Production builds set NEITHER, so this branch is dead in prod and the app
// talks to the real project exactly as before.
const EMULATOR_HOST =
  process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST ||
  process.env.FIRESTORE_EMULATOR_HOST ||
  "";
const USING_EMULATOR = EMULATOR_HOST.length > 0;

// Optional Auth emulator host (browser bundle or Node). Empty in prod.
const AUTH_EMULATOR_HOST =
  process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST ||
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||
  "";

// Your web app's Firebase configuration
// Values are read from environment variables to avoid committing secrets.
// Create a local `.env.local` with these keys (see .env.local.example).
// Against the emulator we fall back to a demo-* project id so no real
// credentials are ever required (and can never be reached).
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || (USING_EMULATOR ? "demo-emulator-key" : undefined),
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId:
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
    (USING_EMULATOR ? "demo-bmrc-logistics" : undefined),
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Firestore and, if requested, wire it to the emulator FIRST —
// before any other SDK (auth) or app code can touch Firestore. Calling
// connectFirestoreEmulator after the first Firestore use throws and leaves the
// client pointed at production, so ordering matters.
export const db = getFirestore(app);

if (USING_EMULATOR) {
  const [host, portStr] = EMULATOR_HOST.split(":");
  const port = Number(portStr) || 8080;
  try {
    connectFirestoreEmulator(db, host || "127.0.0.1", port);
    console.info(`[firebase] Firestore connected to EMULATOR at ${host}:${port} (project ${firebaseConfig.projectId})`);
  } catch {
    // connectFirestoreEmulator throws if called after Firestore is already in
    // use; safe to ignore on hot reload.
  }
}

// Initialize Auth after Firestore is wired.
export const auth = getAuth(app);

// Wire the Auth emulator when running against the local emulator suite. Gated on
// USING_EMULATOR (never touches prod) and on either an explicit auth host env or
// a browser context — so the Node-only Firestore test runs (invariants /
// properties / simulation), which never call auth and don't start an auth
// emulator, are left completely untouched. In the browser we default to the
// standard auth-emulator port so `next dev:emulator` + `--only firestore,auth`
// just works. connectAuthEmulator must run before any auth call, so it's here.
if (USING_EMULATOR && (AUTH_EMULATOR_HOST || typeof window !== "undefined")) {
  const authHost = AUTH_EMULATOR_HOST || "127.0.0.1:9099";
  try {
    connectAuthEmulator(auth, `http://${authHost}`, { disableWarnings: true });
    console.info(`[firebase] Auth connected to EMULATOR at ${authHost}`);
  } catch {
    // connectAuthEmulator throws if auth was already used; safe on hot reload.
  }
}

let analytics;
if (typeof window !== "undefined" && !USING_EMULATOR) {
  try {
    analytics = getAnalytics(app);
  } catch {
    // Analytics may fail during SSR or if measurementId is missing; ignore silently.
  }
}

export { app, analytics };
