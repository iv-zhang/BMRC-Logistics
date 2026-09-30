# `fix/firestore-rules` branch log

Tracks packets S1-S4 from `docs/plans/platform-overhaul.md` §0.5 (production Firestore rules
stopgap). Append-only; newest packet at the bottom of "Packets done".

## Packets done

### S1 — `firestore.prod.rules` (new)

**What:** New production-only rules file. Signed-in required everywhere. `users/{uid}`:
- `create`: self-create allowed only with `role == 'member'` (matches every current self-create
  site — see below), OR by a caller whose own `users/{uid}` doc has `role` in
  `admin | quartermaster | medops` (covers seeding another uid, e.g. test identities).
- `update`: self-update allowed as long as `role` is unchanged (partial `updateDoc`/merge
  `setDoc` writes that never touch `role` trivially satisfy this — `request.resource.data.role`
  reflects the post-write value), OR by admin/quartermaster/medops on ANY other user's doc.
- `delete`: admin/quartermaster only (amended; see "S1 amendment" below for the final create/update rules, which restrict medops to FTO/fto_intern/member role assignments).
- All other collections: `allow read, write: if isSignedIn()` — a coarse floor, not the full
  per-role model. That full model is R4 in `feat/roles-access` (plan §2), deliberately out of
  scope here; S1 is a narrow "nobody signed out can touch anything, nobody can self-promote to
  admin" stopgap.

**Every current write to `users/{id}` was grepped and checked against these rules** (all pass):

| Site | Op | Actor | Fields touched | Passes because |
|---|---|---|---|---|
| `app/register/page.tsx:88` | `setDoc` (create) | self | `id, fullName, email, role:'member', tutorialCompleted, createdAt, updatedAt` | self-create, `role=='member'` |
| `app/components/app-sidebar.tsx:110` | `setDoc` (create, only if `!snap.exists()`) | self | `id, email, fullName, role:'member', createdAt, updatedAt` (no `tutorialCompleted`) | self-create, `role=='member'`; create rule does not require any field beyond `role` |
| `app/roster/page.tsx` (5 sites: `handleRoleChange`, `handleCanAuditToggle`, `handleMemberStatusChange`, `handleJoinedTermChange`, `handleCommitteeToggle`) | `updateDoc` | admin/QM/medops, on another member's doc | `role`, `canAudit`, `memberStatus`, `joinedTerm`, `isCommitteeMember` respectively | caller is privileged, target is not caller's own doc → privileged branch |
| `app/components/onboarding-tour.tsx:115` | `updateDoc` | self (`effectiveUid ?? user.uid`) | `tutorialCompleted, tutorialCompletedAt` | self-update, `role` untouched so post-write `role` == pre-write `role` |
| `app/lib/certifications.ts:updateMemberCertification` (called from roster) | `updateDoc` | admin/medops, on another member's doc | `certifications.<kind>.*`, `updatedAt` | caller privileged, target not self |
| `app/lib/audit-helpers.ts:setAuditPermission` (called from `audit-permission-modal.tsx`) | `batch.update` | admin, on another member's doc | `canAudit, updatedAt` | caller privileged, target not self |
| `app/lib/test-identity.ts:seedTestUsers` (gated client-side to `isRealAdmin` = admin/QM only, in `app/profile/page.tsx`) | `setDoc(..., {merge:true})` on 6 fixed `__test_*` ids | admin/QM | `id, email, fullName, role:<varies>, isTestUser, certifications, createdAt, updatedAt` | target id is never the caller's own uid → falls straight to the privileged branch regardless of the target `role` value (FTO/medops/QM/admin test identities all need non-`member` roles, which only the privileged branch permits) |
| `scripts/emulator/seed-auth-user.ts` | `setDoc(..., {merge:true})` | N/A — emulator-only script, never runs against `firestore.prod.rules` | — | out of scope (uses `firestore.rules`, see S2) |

**Read-only sites confirmed NOT to need write rules** (just `getDoc`/`onSnapshot`/`getDocs`):
`app/components/checkout-modal.tsx`, `app/profile/page.tsx`, `app/assets/page.tsx`,
`app/print-labels/page.tsx`, `app/inventory/page.tsx`, `app/hooks/useUserRole.tsx`,
`app/statpacks/[id]/page.client.tsx`, `app/committee-board/page.tsx`,
`app/components/audit-permission-modal.tsx`, `app/components/events/notify-modal.tsx`,
`app/lib/statpack-restock-flag.ts`, `app/lib/events.ts` (role queries only) — all covered by
`allow read: if isSignedIn()`.

**Dead-code note (not a blocker):** `app/components/tutorial-overlay.tsx` (`TutorialOverlay`) is
not imported anywhere (`onboarding-tour.tsx` replaced it, per CLAUDE.md). Its `finishTutorial`
does a merge `setDoc` with only `{tutorialCompleted, tutorialCompletedAt}` and an explicit
comment about a "first-login race where `users/{uid}` may not exist yet" — if that doc doesn't
exist yet, Firestore would treat the merge as a **create** with no `role` field at all, which
S1's create rule would deny (accessing `request.resource.data.role` on a doc with no `role` key
errors out the rule expression → denied). Since the component is unreachable dead code today
this doesn't break anything live, but flag it if it's ever revived: the create branch would need
`(!('role' in request.resource.data) || request.resource.data.role == 'member')` instead of a
bare `== 'member'` check.

**Verification:** `npx tsc --noEmit` N/A (no TS files touched — `.rules` files aren't compiled).
No lint target either (`.rules` isn't an ESLint-covered extension). Not yet runtime-verified
against the emulator — S3 is the emulator test suite that exercises these rules directly; see
that section below for the actual pass/fail.

**S1 amendment (found by the S3 test, fixed before S3 was committed):** the first S1 version had
two real holes that only the emulator test exposed (the rules file was never run before S3):
1. **Additive catch-all.** `match /{document=**} { allow read, write: if isSignedIn(); }` also
   matches `users/*`, and Firestore rules are additive, so it silently granted every signed-in user
   full write on `users` and nullified every `users` restriction (self-promotion to admin worked).
   Fixed: catch-all is now `match /{collection}/{document=**}` with `collection != 'users'`.
2. **medops escalation.** "admin/QM/medops may update other users" let medops set any user's role
   to `admin` (the roster UI only offers FTO/fto_intern/member, `MEDOPS_AVAILABLE_ROLES`, but rules
   did not). Fixed: medops may only change a role from and to `FTO | fto_intern | member`, and may
   only create user docs with those roles; admin/QM are unrestricted. Also: nobody (including
   admin/medops) may change their OWN role, and only admin/QM may delete user docs (no app flow
   deletes users). Non-role field edits by medops on any user (certs, memberStatus, joinedTerm,
   canAudit, isCommitteeMember) still work, including on admin docs.
The S1 commit (6779f71) contains the buggy version; it is fixed in the S3 commit below. Do NOT
deploy 6779f71's rules.

**Open questions:** none blocking. R4 (later, `feat/roles-access`) is the known follow-up that
replaces the coarse "any signed-in write" floor on non-`users` collections with real per-role
checks.

---

### S2 — config split so a bare `firebase deploy` can never ship open rules

**What changed (no file renamed or deleted):**
- `firebase.json`: `firestore.rules` -> `firestore.prod.rules` (only diff vs. before).
- `firebase.emulator.json` (new): byte-for-byte copy of the old `firebase.json`, i.e. it points at the
  open `firestore.rules`. (`diff firebase.json firebase.emulator.json` shows exactly one line.)
  Note: no `_comment` key inside it; the Firebase CLI schema is strict about unknown keys.
- `package.json`: `--config firebase.emulator.json` added to all 8 scripts that start emulators:
  `emulator`, `test:invariants`, `test:properties`, `test:simulation`, `test:emulator`, `test:e2e`,
  `dev:sandbox`, `test:events`. (`dev:emulator`, `seed*`, `sandbox:seed` only run against an
  already-running emulator, so they need nothing.)
- Copy-paste command examples in docs/comments updated to match, so nobody types the old form:
  `.claude/skills/run-bmrc-logistics/SKILL.md`, `.claude/skills/run-bmrc-logistics/smoke.spec.ts`
  (comment), `.claude/skills/bmrc-testing/SKILL.md`, `e2e/fto-attendance.spec.ts` (comment),
  `playwright.config.ts` (comment). `STAGING.md` now notes the staging deploy uses `firebase.json`
  (i.e. `firestore.prod.rules`).
- `firestore.rules`: header comment now says it is loaded only via `firebase.emulator.json`.
- `.github/copilot-instructions.md`: both "Deploy" bullets (the file contains the guidance twice)
  now say `firebase deploy --only hosting`, forbid a bare `firebase deploy`, forbid AI sessions
  deploying rules, and explain the config split.

**Verification:**
- `python3 json.load` on `firebase.json`, `firebase.emulator.json`, `package.json`: all parse.
- `firebase emulators:exec --config firebase.emulator.json --only firestore --project
  demo-bmrc-logistics "echo ..."` with the globally installed `firebase-tools` 15.30.2 and JDK 21.0.12:
  emulator started, script ran, exit 0. (The memory note that JDK 21 needs firebase-tools 13.35.1 did
  not apply here; firebase-tools 15 works.) Side effect on this machine: the CLI downloaded
  `cloud-firestore-emulator-v1.22.0.jar` and deleted the cached v1.19.8 jar.
- `npm ci` was needed in this worktree (no `node_modules`); no lockfile change in S2.
- `npx tsc --noEmit` / `npm run lint`: see S3 (S2 touched no TS logic, only comments in two TS files).

**Findings:**
- Decision needed from you (not blocking): a bare `firebase deploy` still deploys hosting AND
  firestore rules/indexes (now the safe prod stopgap). That is the intended outcome, but the
  recommended habit is still the explicit `--only` forms.
- `.github/workflows/*` deploy hosting only (per plan) and do not reference rules; left untouched.
- `decisions.md:416` and `docs/statpack-checkin-fast-path.md:361` describe `firestore.rules` as
  emulator-only/wide open, which stays true; left untouched (O owns decisions.md).
- `app/hooks/useStatsData.ts`, `app/stats/page.tsx`, `app/lib/dashboards.ts` comments say medops
  reads/dashboards are "role-gated by firestore.rules". The stopgap does NOT enforce that (any
  signed-in user can read every collection, including `dashboards`, and write the published
  dashboard docs, because the stopgap drops the `/dashboards` block the open file carried). Until
  R4, these gates are client-side only. Flagged for R4.

---

### S3 — `app/lib/__tests__/rules-stopgap.test.ts` (new) + `npm run test:rules`

**What:** 25 emulator tests (`node:test` run through `tsx`, using `@firebase/rules-unit-testing`
`^5.0.2`, added as a devDependency; `package.json` + `package-lock.json` changed). The suite injects
`firestore.prod.rules` itself, so it tests the prod file regardless of which config the emulator
booted with. New script: `test:rules` (`firebase emulators:exec --config firebase.emulator.json
--only firestore ... tsx --test app/lib/__tests__/rules-stopgap.test.ts`). Why not vitest: the two
existing `app/lib/__tests__/o2-*.test.ts` files import `vitest`, which is NOT in `package.json`,
so they are not runnable (see findings). Fixtures are fake names/uids only (`example.test` emails).

**Cases:** anonymous read/write/delete denied (users, inventory, org_settings, statpacks);
register payload allowed; app-sidebar self-heal payload allowed; self-create as
admin/QM/medops/FTO denied; creating another uid's doc as member denied; self role change denied
(member, medops, admin); self non-role update (onboarding tour stamp, merge setDoc) allowed;
member cannot update/delete other users; medops roster edits (role->FTO, memberStatus, joinedTerm,
canAudit, isCommitteeMember, cert fields) allowed; medops cannot promote/demote/self-promote/create
admin docs; admin + QM edits incl. `setAuditPermission`-style batch; admin/QM `seedTestUsers`
(create then merge re-update, non-member roles) allowed, member seeding denied; member
check-off transaction (pack update + `statpack_logs` add), shift request + notification, issue
report, inventory/`inventory_logs` writes, org_settings read/admin save, personal dashboards doc all
allowed; signed-in user with no `users` doc can read without error.

**Verification results (exact):**
- First run (against the S1 rules): 22 pass / 6 fail (the holes above).
- After the fix: `npm run test:rules` -> `tests 25, pass 25, fail 0`, script exit code 0
  (firebase-tools 15.30.2, JDK 21.0.12, Firestore emulator 1.22.0). The emulator DID run here.
- `npx tsc --noEmit`: no errors in any file I touched. Pre-existing errors remain in
  `app/lib/__tests__/o2-checkout-integration.test.ts` and `o2-validation.test.ts` (missing `vitest`
  module) — not caused by this branch.
- `npx eslint` on `rules-stopgap.test.ts`, `e2e/fto-attendance.spec.ts`, `playwright.config.ts`,
  `.claude/skills/run-bmrc-logistics/smoke.spec.ts`: clean (no output).
- NOT run: the app itself against these rules (no Playwright/smoke driver; the emulator sandbox
  loads the open rules via `firebase.emulator.json`, so it cannot exercise prod rules anyway).
  Flows were verified by replaying each write's exact payload shape in the rules test, not by
  driving the UI.

**Stopgap limitations (by design, for R4):** any signed-in user (including a fresh self-registered
member) can read/write every non-`users` collection, read all user docs (names/emails), and write
the published `dashboards` doc; medops/member gates on logistics are client-side only. The test
"known stopgap limitation" pins this so R4 must change it deliberately.

**Findings:**
- `.firebaserc` `default` alias is `bmrc-staging` and the prod project is not in the repo. So a bare
  `firebase deploy` from this repo targets STAGING; the open rules reached prod another way (an
  explicit `--project <prod>` or a console paste). The `firebase.json` repoint still removes the
  risk for any project, but the plan §0.5 root-cause explanation may be incomplete.
- Existing `o2-*.test.ts` need `vitest` (not installed) and are invisible to `npm run test`; they
  also break `tsc --noEmit`. Suggest installing vitest or removing them (deletions need your OK).
- `firebase-tools` 15.x works with JDK 21 here; the memory note about pinning 13.35.1 is stale
  for this machine.
- Possible follow-up (S-D1): rules can't restrict sign-up domain; that needs Auth blocking
  functions or an email check in rules (`request.auth.token.email.matches('.*@berkeley.edu')`),
  which would also break the `@bmrc.test` sandbox/staging logins unless gated per project.

---

## S4 — deploy (you run this; nothing was deployed by the agent)

Before deploying: make sure you are on the merged/reviewed branch and `firestore.prod.rules` is the
version in the final commit (not 6779f71). Then, with the **production** project id (the value of
`NEXT_PUBLIC_FIREBASE_PROJECT_ID` in `.env.local`; it is NOT in `.firebaserc`, whose `default` is
staging):

```bash
firebase deploy --only firestore:rules --project <PROD_PROJECT_ID>
```

Run it from the repo root so `firebase.json` (-> `firestore.prod.rules`) is used; do NOT pass
`--config firebase.emulator.json`. Before deploying you may want to first push to staging
(`firebase deploy --only firestore:rules --project staging`) and log in as admin/medops/member on
`npm run dev:staging` to sanity check. After deploying: confirm in the Firebase console that the
Rules tab shows the `users` block and no `allow read, write: if true`, open the live site logged
out (should show login, no data), then log in as admin and as a fresh member.

Rollback if something breaks for real users: the console Rules tab keeps history; but rolling back
to the open rules re-opens the data, so prefer a forward fix in `firestore.prod.rules`.
