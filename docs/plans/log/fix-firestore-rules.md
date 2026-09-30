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
- `delete`: admin/quartermaster/medops only.
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

**Open questions:** none blocking. R4 (later, `feat/roles-access`) is the known follow-up that
replaces the coarse "any signed-in write" floor on non-`users` collections with real per-role
checks.

---

<!-- S2 section appended after S2 lands -->

<!-- S3 section appended after S3 lands -->

<!-- S4 deploy command appended at the end -->
