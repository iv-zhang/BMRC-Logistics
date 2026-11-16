# BMRC Logistics

The logistics app for the **Berkeley Medical Reserve Corps** (UC Berkeley student EMS). Members
check statpacks out and in pocket by pocket, logistics tracks supply inventory and assets
(AEDs, oxygen, glucometers), and managers staff shifts and keep the roster.

> **No patient information goes in this app.** ESO is the patient record.

**Status (Nov 2026):** the live app is in use while the data model is being rebuilt. See the
[11/24 checkpoint](https://github.com/iv-zhang/BMRC-Logistics/milestone/1) and
[Rebuild v1](https://github.com/iv-zhang/BMRC-Logistics/milestone/2) milestones for what's in
progress.

## Stack

Next.js 16 (static export) · React 19 · TypeScript · HeroUI + Tailwind CSS 4 · Cloud Firestore ·
Firebase Auth · Firebase Hosting. There is no backend server: the browser talks to Firestore
directly, so `firestore.prod.rules` is the only real security boundary.

Full stack, design system, and known production gaps: [docs/tech-stack-and-gaps.md](docs/tech-stack-and-gaps.md).

## Run it locally

Requires **Node 22+** and Java (for the Firebase emulators).

```bash
npm install
npm run dev:sandbox   # emulator + seeded data + dev server — never touches real data
```

Log in with `admin@bmrc.test`, `qm@bmrc.test`, `member@bmrc.test`, `fto@bmrc.test`, or
`medops@bmrc.test` (password `test1234`) to see each role. Details: [SANDBOX.md](SANDBOX.md).
For testing on real Firebase with per-role logins, use staging: [STAGING.md](STAGING.md).

`npm run dev` runs against the project in `.env.local` (ask a maintainer). Don't commit that file.

## Checks

```bash
npx tsc --noEmit   # typecheck
npm run lint
npm run test
npm run build
```

CI does **not** run these yet — it only builds and deploys — so run them before opening a PR.

## How work happens

- **Tasks** live in [GitHub Issues](https://github.com/iv-zhang/BMRC-Logistics/issues), grouped by
  milestone, and tracked on the [project board](https://github.com/users/iv-zhang/projects/2).
  If it isn't an issue, it isn't a task. Meeting action items become issues before the
  meeting ends.
- **Changes** go through a PR into `main`. **Merging to `main` deploys the live site**
  (hosting only; Firestore rules are deployed separately).
- **Decisions** and their reasons go in [decisions.md](decisions.md). Read it before changing
  something that looks odd; it's probably deliberate.
- **Plans** for larger work go in [docs/plans/](docs/plans/).

## Docs

| Doc | What it's for |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Architecture overview and working rules (also read by Claude Code) |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Who does what by when — phases, owners, deadlines (read this first) |
| [decisions.md](decisions.md) | Why the app works the way it does |
| [MODEL.md](MODEL.md) | Firestore document shapes |
| [invariants.md](invariants.md) | Rules the data must always satisfy |
| [FINDINGS.md](FINDINGS.md) | Known issues found in audits |
| [docs/tech-stack-and-gaps.md](docs/tech-stack-and-gaps.md) | Stack, design system, production gaps |
| [SANDBOX.md](SANDBOX.md) / [STAGING.md](STAGING.md) | Local emulator / cloud staging setup |

## License

MIT. See [LICENSE](LICENSE).
