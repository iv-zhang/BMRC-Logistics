/**
 * Production-config guard for the emulator test suite.
 *
 * Every test/seed run imports this module for its side effect. It refuses to
 * proceed unless it can prove it is talking to the Firestore emulator against a
 * throwaway `demo-*` project. If it ever detects a production-shaped config
 * (real project id, real credentials, no emulator host) it prints a loud banner
 * and hard-exits BEFORE any Firestore client is created — so a misconfigured run
 * can never read or write live data.
 */

export const EMULATOR_PROJECT_ID = 'demo-bmrc-logistics';
export const DEFAULT_EMULATOR_HOST = '127.0.0.1:8080';

function die(reason: string): never {
  const line = '━'.repeat(72);
  // eslint-disable-next-line no-console
  console.error(
    `\n\x1b[41m\x1b[97m ABORTED — PRODUCTION FIRESTORE CONFIG DETECTED \x1b[0m\n` +
      `${line}\n` +
      `${reason}\n\n` +
      `Emulator tests must run against the '${EMULATOR_PROJECT_ID}' project with\n` +
      `FIRESTORE_EMULATOR_HOST set (usually via 'firebase emulators:exec').\n` +
      `Refusing to touch a real Firestore project.\n` +
      `${line}\n`,
  );
  process.exit(1);
}

export function assertEmulator(): { host: string; projectId: string } {
  const host =
    process.env.FIRESTORE_EMULATOR_HOST ||
    process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST ||
    '';

  // 1) An emulator host MUST be present. No host => we would hit prod.
  if (!host) {
    die(
      'No emulator host found (FIRESTORE_EMULATOR_HOST / ' +
        'NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST are both empty).',
    );
  }

  // 2) The host must be loopback. A remote host is not the local emulator.
  const hostname = host.split(':')[0];
  const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '0.0.0.0'];
  if (!LOOPBACK.includes(hostname)) {
    die(`Emulator host '${host}' is not loopback — refusing to treat it as the local emulator.`);
  }

  // 3) The project id must be a demo-* project. Firebase guarantees demo-*
  //    projects never reach real Google Cloud, so even a stray real call cannot
  //    escape the emulator.
  const projectId =
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
    process.env.GCLOUD_PROJECT ||
    EMULATOR_PROJECT_ID;
  if (!projectId.startsWith('demo-')) {
    die(
      `Project id '${projectId}' is not a demo-* project. ` +
        `Set NEXT_PUBLIC_FIREBASE_PROJECT_ID=${EMULATOR_PROJECT_ID} or unset it to use the default.`,
    );
  }

  // 4) Real service-account credentials must not be present — those only make
  //    sense for hitting production.
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    die(
      `GOOGLE_APPLICATION_CREDENTIALS is set (${process.env.GOOGLE_APPLICATION_CREDENTIALS}). ` +
        `Real credentials must not be present during emulator tests.`,
    );
  }

  // Normalise env so the client SDK (firebase.ts) also connects to the emulator
  // and uses the demo project, regardless of which var was originally set.
  process.env.FIRESTORE_EMULATOR_HOST = host;
  process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST = host;
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = projectId;

  return { host, projectId };
}

// Run the guard the moment this module is imported.
export const EMULATOR = assertEmulator();
