# Worksession, Tue 11/17: make checkout work without help

**Goal:** by the end of the session, members can check a statpack out **without anyone helping
them**, so the next step is training them. Small PRs open, nothing merged during the session.

**This is a build session, not a decision meeting.** Every decision this work needs is already made
and logged. Don't re-open them:

| Decision | What it says |
|---|---|
| [D-37](../../decisions.md) | At checkout, shortages **flag**, never block. AED and O₂ still block in practice (their checks can't be completed without the device). A missing EpiPen flags **on purpose** (first-aid scope), and the card says so. Expired items and failed checks still block. |
| [D-38](../../decisions.md) | We stay on **Firestore**. |
| [D-39](../../decisions.md) | "Flag this pack" lists only **real failures**, never "you didn't fill this in yet". Checkout shortages will create a restock task (#69, later, not tonight). |

**If a new question comes up:** write it in the parking lot (bottom of this doc) and keep building.
Ivan decides *what* in 2 minutes or less, Sid decides *how*. Anything bigger waits for 11/24.
**Stuck for 20 minutes? Say so out loud.**

## Sized to fit

Every task tonight is something one person can finish in one block. Anything that didn't fit was cut
to its own issue rather than squeezed in:
- The restock task at checkout (#69) is deferred. It isn't needed for members to check out unaided.
- The old #60 was three changes. It's now three issues: #60 the gate, #68 the dialog, #69 the restock
  task.
- **Sid sizes his own work.** His default is the two tasks below. If he says #60 also fits before
  8:30, he takes it; otherwise Ivan builds it with Claude and Sid reviews the `app/lib` part afterwards.

## Before the session

- [ ] **Ivan, tonight:** merge the docs PR (#67) so everyone pulls the same context.
- [ ] **Ivan, tonight:** send Sid one message: what's decided, his default tasks, and one question,
  "does #60 fit too?" Confirm with Ian whether he can attend.
- [ ] **Ivan:** restock MRC 2 (#63).
- [ ] **Everyone:** `git switch main && git pull`, `npm install`, then `npm run dev:sandbox` and log in
  as `member@bmrc.test` / `test1234`. If the sandbox won't start, post in Slack before the session.
  (Java errors usually mean the wrong `firebase-tools`; see `SANDBOX.md`.)

## Who does what

| Person | Issue(s) | Branch | Delivers | Why this person |
|---|---|---|---|---|
| **Sid** (hard stop 8:30) | #65, then #68 | `sid/flag-dialog-real-failures` | Duplicate-AED answer (data or code, read-only); the flag dialog lists only real failures | Narrow, well-defined problems are his strength. #68 is page-only, one block of code |
| **Ivan** + Claude | #60 | `ivan/checkout-shortages-flag` | Shortages flag instead of block (page + transaction + test, which must ship together) | It's Ivan's product decision, and it's small and well-specified. Sid reviews the `app/lib` part |
| **Ian** (if present) | #61, #62 | `ian/checkout-footer-fields` | The bottom button reads "Fix N items →" and jumps to the empty field; the PSI and pad-date boxes look required; pad date filled in from the AED record | Already his; page-only UI |
| **Lang** | #59, then #61 if Ian is out | `lang/ci-checks` | Automatic checks on every PR; keeps time; helps with setup. **If Ian can't come, Lang takes #61** (the button) after #59; #62 stays Ian's, async, due 12/4 | #59 is about 20 min; #61 is the most direct fix for the 11/14 report |

Three people edit `app/statpacks/check-off/page.tsx`, in separate parts:
- Ivan: `computeIssue`
- Sid: the `unfillable` list and the flag dialog
- Ian or Lang: the footer and the check inputs

**Don't touch someone else's part. Whoever merges second rebases.**

## Agenda (about 2 hours; Sid's demo goes first because of his 8:30 stop)

| Time | What |
|---|---|
| 0:00–0:10 | Ivan: the goal, the decisions table above, the scenarios. Each person says their one deliverable out loud |
| 0:10–1:20 | **Build.** Lang checks in with each person at 0:40 |
| 1:20–1:30 | **Sid demos** #68 and reports #65 before his hard stop |
| 1:30–1:50 | Other demos: each branch runs its scenarios in the sandbox; Ivan says accept, or lists the fixes |
| 1:50–2:00 | Wrap: PRs opened (draft is fine), board updated, status log in `docs/ROADMAP.md` updated, leftovers turned into issues with owners |

## Scenarios (every PR is judged on these in the sandbox)

1. **Missing fields (FTO, 11/14):** O₂ and AED boxes ticked, PSI and pad date empty. Pass: a member who
   has never seen the change can tell what's missing, gets there in one tap, and checks out. "Can't
   fix it" never lists these as problems. (#61, #62, #68)
2. **Short pack (MRC 2, 11/15):** checks done, but 0/1 EpiPen, 0/2 pressure dressings, 2/3 cold packs.
   Pass: checkout succeeds; the card says "You can still take this pack. Logistics will restock: …"
   and "No EpiPen in this pack — OK at first-aid scope"; the pack reads Restock Needed. (#60)
3. **No O₂ tank:** PSI can't be entered. Pass: still blocked. (#60)
4. **Expired item:** Pass: blocked; "Can't fix it" lists only that item; the member is told to take
   another pack. (#60, #68)

Bonus for #62: an AED with an in-date pad date on record opens with the month already filled in.

## Briefs

**Sid** (works by hand; no Claude prompt):
- #65: read-only. Is the duplicate "AED / AED 1" on MRC 2 data or code? Comment the answer. The lead
  is `app/components/asset-attach-modal.tsx:29`.
- #68: in `page.tsx`, change `unfillable` (~L1808) and the dialog (~L2158) so they list only real
  failures. If "Can't fix it" is tapped with checks unfinished, send the member to the first one.
- The *what* is decided (D-39); the *how* is yours.

**Ivan** (paste into Claude Code):
> Read docs/plans/2026-11-17-checkout-worksession.md, decisions.md D-8 and D-37, and issue #60. On
> a new branch `ivan/checkout-shortages-flag` from fresh origin/main, give me a short plan, then
> build #60: change only `computeIssue` in app/statpacks/check-off/page.tsx, the checkoutShort
> throw in logStatpackCheckOff (app/lib/inventory.ts), the amber card wording, and the test. Don't
> touch unfillable/the flag dialog (Sid) or the footer/check inputs (Ian). Verify with tsc, lint,
> npm run test; walk me through scenarios 2–4 in the sandbox. Open a draft PR; don't merge.

**Ian** (paste into Claude Code):
> Read docs/plans/2026-11-17-checkout-worksession.md and issues #61 and #62. On a new branch
> `ian/checkout-footer-fields` from fresh origin/main, give me a short plan, then build #61 and
> #62. Only touch the footer, the PSI/pad-date inputs and the starting check values in
> app/statpacks/check-off/page.tsx. Use the bmrc-ui skill. Verify with tsc + lint, then walk me
> through scenario 1 and the pad-date bonus in the sandbox. Open a draft PR; don't merge.

**Lang** (paste into Claude Code):
> Read issue #59. On a new branch `lang/ci-checks` from fresh origin/main, add a GitHub Actions job
> that runs `npx tsc --noEmit`, `npm run lint` and `npm run test` on every PR. Explain each line in
> plain language. Open a PR; don't merge.
> *(If Ian is out, afterwards:)* Read issue #61 and build it on `lang/checkout-footer-button`. Only
> touch the sticky footer in app/statpacks/check-off/page.tsx.

## After the session

- Sid reviews the `app/lib` part of #60. Ivan accepts the member-facing PRs against the scenarios.
- **Before each code PR's final commit:** run the emulator smoke driver (`run-bmrc-logistics` skill)
  once.
- Ivan merges. Merging `main` deploys the live site.
- Once #60, #61 and #68 are live: Ivan writes the guide with real screenshots (#66), then trains members.

## Parking lot (write questions here, don't debate them)

-
