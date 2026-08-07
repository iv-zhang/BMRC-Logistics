# Cloud Staging Project — genuine role testing

A real, cloud-based Firebase project (`bmrc-staging`, separate from prod `bmrc-logistics`) for manually testing roles with genuine per-role logins and a synthetic dataset. This is **not** a production export — all data is seeded from schema defaults, so nothing here corrupts real records.

**Contrast with the local emulator sandbox** (`npm run dev:sandbox`, see [SANDBOX.md](SANDBOX.md)): the emulator is in-memory, zero-cost, and runs offline on your machine; staging is a real cloud project, shareable (live URL), and uses real Firebase authentication. Both use synthetic data and neither touches production.

## One-time setup

1. **Create the Firebase project** (if not already done):
   - In [Firebase Console](https://console.firebase.google.com/), create or confirm the `bmrc-staging` project.
   - Add a **Web app** under Project Settings.
   - Enable **Email/Password** authentication under Authentication → Sign-in methods.

2. **Download a service-account key**:
   - Project Settings → Service accounts → Generate new private key.
   - Save to a path **outside the repo**, e.g. `~/bmrc-staging-key.json` or `~/.secrets/bmrc-staging-key.json`.
   - **Never commit this key.**

3. **Set the credential env var**:
   ```bash
   export GOOGLE_APPLICATION_CREDENTIALS=~/bmrc-staging-key.json
   ```

4. **Deploy security rules to staging**:
   ```bash
   firebase deploy --only firestore:rules --project staging
   ```
   (The `.firebaserc` alias `staging → bmrc-staging` is already configured.)

5. **Configure the web app**:
   - Copy `.env.staging.local.example` → `.env.staging.local` (which is gitignored).
   - Fill in the staging web-app config from Firebase Console → Project Settings → Web apps.
   - Keep `NEXT_PUBLIC_FIREBASE_PROJECT_ID=bmrc-staging`.

## Seeding

```bash
npm run seed:staging -- --confirm
```

The script **dry-runs by default**; add `--confirm` to actually write data. Add `--wipe` to clear all collections first, then reseed.

The seed script **hard-aborts** unless the service-account key's `project_id` is exactly `bmrc-staging`. It refuses loudly if it detects prod `bmrc-logistics` — this is an extra safety gate.

## Running the app

```bash
npm run dev:staging
```

Opens the app at the printed URL (usually http://localhost:3000). Sign in with any account below — all use password `staging1234`.

| Email | Role |
|---|---|
| `admin@bmrc.staging.test` | admin |
| `qm@bmrc.staging.test` | quartermaster |
| `member@bmrc.staging.test` | member |
| `member2@bmrc.staging.test` | member |
| `member3@bmrc.staging.test` | member |
| `fto@bmrc.staging.test` | FTO |
| `fto2@bmrc.staging.test` | FTO |
| `medops@bmrc.staging.test` | medops |

## Safety

- The seed script verifies the Firebase project is `bmrc-staging` before running — it cannot accidentally write to prod.
- All data is synthetic, seeded from schema defaults — no real member records, inventory counts, or history are involved.
- The staging project is a real cloud resource and will incur minimal Firebase costs (Firestore read/write/delete ops are billed per use, auth is free).
