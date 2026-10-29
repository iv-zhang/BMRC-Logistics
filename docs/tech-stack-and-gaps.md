# Tech stack, design system, and production gaps

A one-stop answer to "what is this built with?" for new team members, plus an honest list
of what the app is missing compared with a conventional production web app.

_Last verified against the code on 2026-10-21 (commit `c9ef8cb`). Re-check before relying on
the gap list — items get fixed._

For *why* the app works the way it does, read [decisions.md](../decisions.md). For the
working rules (plan → approve → implement → verify → PR), read [CLAUDE.md](../CLAUDE.md).

---

## 1. Tech stack at a glance

| Layer | What it does | BMRC Logistics |
|---|---|---|
| Language | What the code is written in | **TypeScript** throughout |
| Frontend framework | Builds the screens | **React 19** + **Next.js 16** (App Router, `app/` directory) |
| Rendering / build | How pages become files | **Static export** (`output: 'export'` in `next.config.ts`) — plain HTML/JS in `out/`, no Next.js server |
| Routing | URL → page | Folders under `app/`. Runtime IDs use query params (`/statpacks/check-off?id=…`), never `[id]` segments — static export can't pre-build them |
| UI components | Buttons, inputs, modals | **HeroUI** (`@heroui/react`) |
| Styling | Look and layout | **Tailwind CSS 4** utility classes; theme in `tailwind.config.ts` |
| Icons / charts | | **Lucide React**; **Recharts** (wrapped once in `app/components/stats/chart-kit.tsx`) |
| Backend / API | Server-side logic | **None of our own.** The browser talks directly to Firebase; business logic in `app/lib/` runs client-side ("backend-as-a-service") |
| Database | Stores data | **Cloud Firestore** — NoSQL documents with real-time `onSnapshot` listeners; indexes in `firestore.indexes.json` |
| Authentication | Who you are | **Firebase Auth**, email + password; self-registration at `/register` |
| Authorization | What you may do | Role on `users/{uid}`; enforced in the database by **`firestore.prod.rules`** (the real security boundary — see gap #1) |
| Hosting | Where the site lives | **Firebase Hosting** serving `out/` |
| CI/CD | Build + deploy | **GitHub Actions**: PR → preview channel; merge to `main` → live deploy (hosting only, not rules) |
| Environments | Safe places to test | Prod `bmrc-logistics` · staging `bmrc-staging` ([STAGING.md](../STAGING.md)) · local emulator `demo-bmrc-logistics` ([SANDBOX.md](../SANDBOX.md)) |
| Config / secrets | Keys kept out of code | `.env.local` locally, GitHub Secrets in CI — both git-ignored |
| Testing | Proof it works | `npm run test` (logic scripts), emulator invariant/property/simulation suites (`fast-check`), `npm run test:rules`, Playwright e2e in `e2e/` |
| Code quality | Catch mistakes early | ESLint (`npm run lint`), TypeScript (`npx tsc --noEmit`) |
| Data migrations | Changing stored data | `scripts/` with `firebase-admin`, `--dry-run` by default ([bmrc-migrations skill](../.claude/skills/bmrc-migrations)) |
| Analytics | Usage tracking | Firebase Analytics initialised in `firebase.ts` (only if a measurement ID is configured) |
| How it's written | | Almost entirely with **Claude Code**, using the workflow in CLAUDE.md and the `bmrc-*` skills in `.claude/skills/` |

**The one thing that surprises traditional engineers:** there is no API server between the
browser and the database. Every rule that matters for security has to live in
`firestore.prod.rules`, because anything enforced only in React code can be bypassed by
anyone with a valid login and the browser devtools. It also means anything that needs a
server — email, scheduled jobs, secret keys — doesn't exist yet (notifications are in-app
only for this reason, D-19).

---

## 2. Design system

| Piece | What we use |
|---|---|
| Typeface | **Hanken Grotesk** (body/UI, weights 400–800) and **Geist Mono** (code/numeric), via `next/font/google` in `app/layout.tsx` |
| Color tokens | Custom HeroUI theme in `tailwind.config.ts` — light `background #EEF0F4`, cards `content1 #FFFFFF`; dark `background #0C0E14`, cards `content1 #141820`; tiered `foreground` greys |
| Light / dark mode | `next-themes`, wired in `app/providers.tsx` |
| Components | HeroUI |
| Icons | Lucide |
| Responsive | Mobile bottom nav + safe-area handling; desktop fixed-height shells on `/inventory` and `/stats` |
| Reference pages | `/inventory` and `/dashboard` illustrate existing layout families; follow the shared standards rather than copying known defects |
| Written rules | [Shared UI/UX standards](ui-ux-standards.md) and [bmrc-ui](../.claude/skills/bmrc-ui/SKILL.md), referenced by both Codex and Claude Code |
| Mockups | None — pages are designed directly in code |

---

## 3. What's missing or needs improvement

Ranked by risk. "Verified" means checked in the repo on the date above; items marked
*console* can only be confirmed in the Firebase / Google Cloud console.

### Fix soon

**1. Per-role database rules are written but not deployed.**
`firestore.prod.rules` now has real per-role rules (PR #16, 92 passing emulator tests), but
merging does **not** deploy rules — CI deploys hosting only. There is no record that even the
earlier stopgap was deployed, so the **live rules may still be wide open** (*console*:
Firestore → Rules). Combined with open self-registration (gap #4), that could mean anyone who
finds the URL can register and read/edit everything.
→ Follow the staging checklist in
[docs/plans/log/feat-roles-access.md](plans/log/feat-roles-access.md), then
`firebase deploy --only firestore:rules --project bmrc-logistics`. That log also lists
writes deliberately left at "any signed-in user" which still need decisions.

**2. No backups visible.**
Nothing in the repo exports or backs up Firestore. If scheduled backups / point-in-time
recovery aren't on (*console*), a bad migration or a malicious user is unrecoverable.
→ Enable Firestore scheduled backups or PITR; take a manual export before every migration.

**3. CI deploys without checking anything.**
Both workflows in `.github/workflows/` only `npm ci` → `npm run build` → deploy. Lint,
typecheck, and tests never run, so a merge to `main` ships even when tests fail.
→ Add a check job (`npx tsc --noEmit`, `npm run lint`, `npm run test`, `npm run test:rules`)
and make it a required status check via GitHub branch protection on `main`.

**4. Anyone can create an account.**
`/register` is public, gives every new account `role: 'member'`, and there is no email
verification (`sendEmailVerification` is never called).
→ Decide: invite-only, an allow-listed email domain, or admin approval before a new account
can read data. (Stop-and-ask — it changes onboarding for every member.)

### Strongly recommended

**5. No error pages or error monitoring.** No `app/error.tsx`, `global-error.tsx`, or
`not-found.tsx`; the only React error boundary is in the `/stats` canvas. A crash anywhere
else is a blank white screen, and nobody hears about it unless a member complains.
→ Add the Next.js error/not-found pages and an error tracker (e.g. Sentry).

**6. CI uses an end-of-life Node.** Both workflows pin `node-version: 20` (EOL April 2026).
→ Bump to 22 or 24 LTS.

**7. No automated dependency updates.** No Dependabot or Renovate config in `.github/`.
→ Add `.github/dependabot.yml` (npm + GitHub Actions, weekly).

**8. Firebase App Check not enabled.** Nothing stops scripts from calling the Firebase API
with our public config. → Enable App Check (reCAPTCHA Enterprise) for Firestore and Auth.

**9. No security headers.** `firebase.json` sets none (no Content-Security-Policy,
`X-Frame-Options`, `Referrer-Policy`). → Add a `hosting.headers` block.

**10. README is 4 lines.** A new person opening the repo on GitHub can't find the real docs.
→ Expand it to: what the app is, how to run the sandbox, links to this doc, CLAUDE.md,
decisions.md, SANDBOX.md, STAGING.md.

### Design / UX

**11. Shared UI/UX rules are documented; screen adoption and type cleanup remain.**
Update 2026-10-22: [the shared standards](ui-ux-standards.md) now cover copy,
information hierarchy, interactions, and layout families, with one skill used by both
agents. Existing screens have not yet been converted. The code still uses many text
sizes, including one-off pixel values. Follow [the member-first plan](plans/2026-10-22-ui-ux-audit-and-plan.md)
before broad style cleanup; writing a guide does not establish visual consistency or
runtime accessibility.

**12. Not installable on phones.** No web app manifest. Members use the app on phones in
supply closets; a home-screen install with an icon would help. → Add `app/manifest.ts`.

**13. No accessibility audit.** Basics look reasonable (ARIA attributes in use, alt text
mostly present, pinch-zoom deliberately left on) but contrast and keyboard navigation have
never been checked. → Run an audit against WCAG 2.1 AA.

### Not needed for an internal tool

SEO, marketing pages, cookie banners, payments. A short privacy note is worth considering
eventually, since the app stores members' certification dates and attendance.

---

## 4. Good first tasks for new engineers

Gaps #3, #5, #6, #7, and #10 are self-contained engineering work that needs no BMRC domain
knowledge. Gaps #1 and #4 need a decision from the logistics lead before code changes. Gaps
#2, #8, and #9 are mostly console/config work and need Firebase project access.
