# Worksession, Tue 11/17: make checkout work without help

**Goal:** by the end of the session, members can check a statpack out **without anyone helping
them**, so the next step is training them. Two PRs open, a training guide drafted, nothing merged
during the session.

**This is a build session, not a decision meeting.** Every decision this work needs is already made
and logged. Don't re-open them:

| Decision | What it says |
|---|---|
| [D-37](../../decisions.md) | At checkout, shortages **flag**, never block. Expired items, low O₂, unfinished or failed checks still block. |
| [D-38](../../decisions.md) | We stay on **Firestore**. Picking one and building matters more than which one. |
| [D-39](../../decisions.md) | "Flag this pack" lists only **real failures**, never "you didn't fill this in yet". A checkout with shortages creates a restock task. |

**If a new question comes up:** write it in the parking lot (bottom of this doc) and keep building.
Ivan decides *what* in 2 minutes or less, Sid decides *how*. Anything bigger waits for 11/24.
**Stuck for 20 minutes? Say so out loud.** That isn't failing, it's the rule.

## Before the session

- [ ] **Ivan:** merge the docs PR (roadmap + decisions) so everyone pulls the same context.
- [ ] **Ivan:** restock MRC 2 (#63).
- [ ] **Everyone:** `git switch main && git pull`, `npm install`, then `npm run dev:sandbox` and log in
  as `member@bmrc.test` / `test1234`. **Setup problems kill worksessions.** If the sandbox won't
  start, post in Slack before the session, not during it. (Java errors usually mean the wrong
  `firebase-tools`; see `SANDBOX.md`.)

## Who does what

| Person | Issue(s) | Branch | Delivers |
|---|---|---|---|
| **Ian** | #61, #62 | `ian/checkout-footer-fields` | The bottom button reads "Fix N items →" and jumps to the empty field; the PSI box and pad-date box look required; pad date prefilled from the AED record |
| **Sid** | #60 | `sid/checkout-shortages-flag` | Shortages flag instead of block; the flag dialog lists only real failures; checkout shortages create a restock task |
| **Sid** | #65 | none (read-only) | **20-min timebox:** is the duplicate "AED / AED 1" data or code? Comment the answer |
| **Lang** | #59 | `lang/ci-checks` | CI runs typecheck, lint and tests on every PR. Lang also keeps time and helps anyone stuck on setup or git |
| **Ivan** | #66 | none | Training guide draft; sets up the 3 test packs in the sandbox; accepts or rejects each PR against the scenarios below |

Ian and Sid both edit `app/statpacks/check-off/page.tsx`, but in different parts:
- Ian: the footer, the PSI and pad-date inputs, and the starting check values.
- Sid: `computeIssue`, the flag list, and the flag dialog.

**Whoever merges second rebases.** Don't touch the other person's part.

## Agenda (about 2 hours; scale the build block to fit)

| Time | What |
|---|---|
| 0:00–0:10 | Ivan: the goal, the 3 decisions above, and the 3 scenarios. Each person says their one deliverable out loud |
| 0:10–1:30 | **Build.** Each person starts with the kickoff prompt below. Lang checks in with each person at 0:45 |
| 1:30–1:50 | **Demo.** Each branch runs the 3 scenarios in the sandbox; Ivan says accept, or lists the fixes |
| 1:50–2:00 | Wrap: PRs opened (draft is fine), board updated, status log in `docs/ROADMAP.md` updated, leftovers turned into issues with owners |

## The 3 scenarios (Ivan sets these up in the sandbox; every PR is judged on them)

1. **Missing PSI and pad date (FTO, 11/14):** O₂ and AED boxes ticked, but **PSI and pad date empty**. Pass: a member who
   has never seen the change can tell what's missing, gets there in one tap, and checks out.
2. **Short pack (MRC 2, 11/15):** all checks done, but **0/1 EpiPen, 0/2 pressure dressings, 2/3 cold packs**.
   Pass: checkout succeeds; the amber card says "You can still take this pack. Logistics will
   restock: …"; one restock task appears for logistics.
3. **Expired:** one expired item in the pack. Pass: checkout is blocked; "Can't fix it" lists only
   that item (not unfinished checks); the member is told to take another pack.

Bonus for Ian's branch: an AED with an in-date pad date on record opens with the month already
filled in.

## Kickoff prompts (paste into Claude Code at the start)

**Ian:**
> Read docs/ROADMAP.md, docs/plans/2026-11-17-checkout-worksession.md, and issues #61 and #62
> (`gh issue view 61`, `gh issue view 62`). On a new branch `ian/checkout-footer-fields` from fresh
> origin/main, give me a short plan (files, approach), then build #61 and #62. Only touch the
> footer, the PSI/pad-date inputs and the starting check values in
> app/statpacks/check-off/page.tsx; Sid is editing computeIssue and the flag dialog. Use the
> bmrc-ui skill. Verify with tsc + lint, then walk me through scenario 1 and the pad-date bonus in
> the sandbox. Open a draft PR; don't merge.

**Sid:**
> Read docs/ROADMAP.md, docs/plans/2026-11-17-checkout-worksession.md, decisions.md D-8, D-31,
> D-37 and D-39, and issue #60. On a new branch `sid/checkout-shortages-flag` from fresh
> origin/main, plan, then build #60: shortages flag instead of block (page + logStatpackCheckOff
> transaction + tests), the flag dialog lists only real failures, and checkout shortages create
> the D-31 restock task. Don't touch the footer or check inputs; Ian is editing those. Verify with
> tsc, lint, npm run test. Open a draft PR; don't merge. Then spend at most 20 minutes, read-only,
> on #65.

**Lang:**
> Read docs/ROADMAP.md and issue #59. On a new branch `lang/ci-checks` from fresh origin/main, add
> a GitHub Actions job that runs `npx tsc --noEmit`, `npm run lint` and `npm run test` on every PR.
> Explain each line of the workflow file to me in plain language. Open a PR; don't merge.

**Ivan:**
> Read docs/plans/2026-11-17-checkout-worksession.md and issue #66. In the sandbox, help me set up
> the 3 test packs for the scenarios (admin login), then draft the one-page checkout guide in plain
> steps. Don't edit app code.

## After the session

- Ivan reviews and accepts each PR against the scenarios. Sid reviews Ian's PR for anything touching
  `app/lib`.
- **Before each code PR is committed as final:** run the emulator smoke driver (`run-bmrc-logistics`
  skill) once. It's token-heavy, so only then.
- Ivan merges. Merging `main` deploys the live site.
- Once #60–#62 are live: Ivan finishes the guide with real screenshots (#66), then trains members.

## Parking lot (write questions here, don't debate them)

-
