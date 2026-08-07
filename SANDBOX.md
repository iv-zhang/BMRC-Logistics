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

## Cloud staging project

A cloud staging project **is now available** for genuine per-role login testing on real Firebase:
- Run `npm run seed:staging -- --confirm` to seed synthetic data.
- Run `npm run dev:staging` to start the app against the staging project.
- Sign in with per-role accounts; see [STAGING.md](STAGING.md) for full setup and logins.

The emulator sandbox above remains the zero-cost default for day-to-day testing (no billing, no internet). Use staging only when you need real authentication or a shareable URL.
