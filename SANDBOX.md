# Local Sandbox — safe role/data testing

The sandbox runs the entire app against the **Firebase emulator** on the throwaway
`demo-bmrc-logistics` project. It **never connects to the real `bmrc-logistics`
project** — production builds set none of the emulator env vars, and the emulator
guard (`scripts/emulator/guard.ts`) hard-aborts if it ever sees a production-shaped
config. So you can create/edit/delete anything here with zero risk to real
inventory, members, or history.

## Quickstart

```bash
npm run dev:sandbox
```

That one command boots the Firestore + Auth emulators, seeds a synthetic dataset
**and** one login per role, then starts the dev server. Requires the Firebase CLI
and `tsx` (already a dev dependency).

- App: the URL Next prints (usually http://localhost:3000)
- Emulator UI (inspect/reset data): http://127.0.0.1:4000

## Logins

All use password **`test1234`**:

| Email | Role |
|---|---|
| `admin@bmrc.test` | admin |
| `qm@bmrc.test` | quartermaster |
| `member@bmrc.test` | member |
| `fto@bmrc.test` | FTO |
| `medops@bmrc.test` | medops |

## Resetting

Emulator data is in-memory: stop the process (Ctrl-C) and rerun `npm run dev:sandbox`
for a clean seed. To reseed without restarting the emulator, run `npm run sandbox:seed`
in another terminal while the emulator is up (or `npm run seed:roles` for just the
role accounts).

## Rules files and configuration

There are two rules files. `firestore.rules` is the real production ruleset — it is what
`firebase deploy --only firestore` ships. `firestore.emulator.rules` is the wide-open
harness ruleset, which exists so the seed scripts and integration tests can run
**unauthenticated**.

Every emulator script passes `--config firebase.emulator.json`, and that flag is the only
thing pointing the Firebase CLI at the permissive file. **If you run a bare
`firebase emulators:exec` without it, you get the production rules**, and the
unauthenticated seed/test scripts fail on permission-denied — which surfaces as a pile of
confusing assertion failures, not as an obvious rules error. That is the single most
useful thing to know about this split.

Consequence: because the harness runs on the permissive file, a passing emulator run no
longer proves the production rules are correct. Exercise those in staging
(`npm run dev:staging`), or with a deliberate `firebase emulators:exec --config firebase.json`
run using the seeded per-role logins — which is what those seeded roles are for.

## Cloud staging project

A cloud staging project **is now available** for genuine per-role login testing on real Firebase:
- Run `npm run seed:staging -- --confirm` to seed synthetic data.
- Run `npm run dev:staging` to start the app against the staging project.
- Sign in with per-role accounts; see [STAGING.md](STAGING.md) for full setup and logins.

The emulator sandbox above remains the zero-cost default for day-to-day testing (no billing, no internet). Use staging only when you need real authentication or a shareable URL.
