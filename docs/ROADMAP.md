# BMRC Logistics roadmap: who does what, by when

Status: **DRAFT, proposed by Ivan 2026-11-16, to be confirmed at the 11/24 website meeting.**
Until it's confirmed, the dates and roles below are proposals, not decisions. Anything listed under
"Open decisions" is **stop-and-ask**.

This is the team's single shared answer to "what should I work on next?" It is read by people
**and by Claude Code**: when anyone asks Claude what to do next, Claude reads this file (via the
`bmrc-next-step` skill). Keep it current. When a deliverable lands, update its row in the same PR.

Dates come from the official [UC Berkeley 2026–27 academic calendar](https://registrar.berkeley.edu/wp-content/uploads/UCB_AcademicCalendar_2026-27_a11y.pdf).
We are all undergrads, so **no deadlines fall during RRR week, finals, or winter break.**

---

## 1. The rules we work by

1. **Fixed dates, flexible scope.** A deadline doesn't move. If we're behind, we cut scope using
   the cut list for that phase. We don't slip the date.
2. **Every task is a GitHub issue with one owner and a milestone.** If it isn't an issue, it isn't
   a task. Meeting action items become issues before the meeting ends.
3. **Small PRs.** One issue per PR, opened as a draft on day one, small enough to review in about
   15 minutes. Big PRs stall because nobody has time to review them.
4. **`main` is guarded by checks, not by memory.** Once #59 lands, a PR merges only if CI is green
   **and** it has the approvals in §2. Merging `main` deploys the live site.
5. **Status goes on the board, decisions happen in meetings.** Update the
   [project board](https://github.com/users/iv-zhang/projects/2) by Sunday night. Tuesday meetings
   are for decisions only: a timekeeper, at most 3 decisions, 30 minutes when possible.
6. **A decision only counts once it's in [decisions.md](../decisions.md).** An AI summary of a
   meeting is not a decision.
7. **"They used it wrong" is a design bug.** If members repeatedly fail a flow, the screen is
   teaching them wrong. Watch someone use it before deciding what to fix.

## 2. Roles (proposed)

| Person | GitHub | Role | Owns | Has the final say on |
|---|---|---|---|---|
| Ivan | `iv-zhang` | **Product owner** | Priorities and order, scope cuts at deadlines, acceptance testing with FTOs, working with the board and ALCO, live-app safety | **What** we build, and whether it solves the member's problem |
| Sid | `sidves52` | **Tech lead** | The data model, the data layer, Firestore rules, and the code patterns everyone copies. Reviews every PR that touches data, rules, or `app/lib` | **How** it's built |
| Lang | `1angeth` | **Delivery lead** (website project lead) | The board, deadlines, meeting agendas and timekeeping, CI, the release checklist, deploys | **When** something ships (checklist passed) |
| Ian | `IanInProgress` | **Builder** | Screens, moving features onto Sid's patterns, the item catalog | — |
| Rest of the logistics team | — | **Testers and data** | Re-entering the catalog, HQ location data, trying each new screen before it ships | — |

**Merge rule (proposed):**
- Code touching data, rules, or `app/lib` needs Sid's approval.
- Anything a member sees needs Ivan's approval.
- Lang deploys.

**Safe lanes for AI-assisted ("vibe") coding:** screens, wording, settings, docs, and tests. AI is
good at copying an existing pattern and bad at inventing consistent ones, so anything that creates a
*new* pattern or touches the data layer goes to Sid first.

## 3. Timeline

| Dates | Calendar context | Phase | Goal |
|---|---|---|---|
| **Mon 11/16 → Tue 11/24** | Week 13 | **A. Checkpoint** | Checkout worksession Tue 11/17; homework for 11/24 (milestone 1) |
| Wed 11/25 → Fri 11/27 | Thanksgiving | — | No work expected |
| **Mon 11/30 → Fri 12/4** | Last week of classes | **B. Live-app stopgap** | Stop the "checkout is broken" reports; log the platform decision |
| Mon 12/7 → Mon 1/18 | RRR, finals (12/14–18), winter break | Quiet period | **No deadlines.** Optional work only (§5) |
| **Tue 1/19 → Fri 2/26** | Spring weeks 1–6 | **C. Rebuild cycle 1** | Offline statpack check-off on the new data layer |
| Mon 3/1 → Fri 3/12 | Midterms | Cooldown + cutover | Fix field-test issues; switch members to the new check-off |
| **Mon 3/15 → Fri 4/30** | Weeks 9–15 (spring recess 3/22–26) | **D. Rebuild cycle 2** | Supply inventory on the new model, plus location labels |
| Mon 5/3 → Fri 5/14 | RRR, finals | Handoff | Handoff doc and next year's owners. **No build deadlines** |
| Summer 2027 | — | Optional | Open-source prep (§6) |

### Phase A: checkpoint (Mon 11/16 → Tue 11/24 meeting, 5–6pm; milestone "11/24 checkpoint")

Phase A has two jobs: **stop members getting blocked at checkout this week**, and **come to 11/24
with written homework** so the meeting makes decisions instead of debating.

**By person, in order:**

| Due | Owner | Issue | Deliverable | Done when |
|---|---|---|---|---|
| **Wed 11/18** | Ivan | #63 | Restock MRC 2; post the checkout rule in Slack | MRC 2 at par; Slack post up |
| **Tue 11/17** | All | #59–#62, #65, #68 | **Checkout worksession**: [plan](plans/2026-11-17-checkout-worksession.md). Sid: #65 + #68 (sizes #60). Ivan + Claude: #60. Ian: #61 + #62 (Lang backs up #61). Lang: #59 | PRs open; the scenarios pass in the sandbox |
| Sun 11/22 | Ian | #52 | Clean item catalog in a Google Sheet | Sheet linked on #52 |
| Sun 11/22 | Sid | #50 | Draft data structure: catalog, locations, par, check-off log | Posted on #50 so others can read it before the meeting |
| Sun 11/22 | Lang | #58 | HQ storage and pack location map | Sheet linked on #58 |
| Sun 11/22 | Ivan | #64 | Watch 3–5 FTOs do a checkout without helping | Notes posted on #64 |
| Sun 11/22 | Lang | — | Send the 11/24 agenda (at most 4 decisions; each person brings a written pick, the same silent-prep format as 11/15) | Agenda in Slack |
| Mon 11/23 | Sid, Ivan | #60–#62, #68 | Review the worksession PRs (Sid: `app/lib`; Ivan: member-facing) | Approved, or changes requested |
| **Tue 11/24** | Lang | #59 | CI check: typecheck, lint, tests on every PR | Runs on a PR |
| **Tue 11/24** | Lang | #60–#62 | Merge and deploy the checkout fixes | Live; the 3 scenarios pass on the real site |
| Tue 11/24 | Ivan | #53 | Live-app safety. **Backups first** (no approval needed); rules deploy and registration are stop-and-ask | Backups on |
| After 11/24 | Ivan | #54, #55 | Log the meeting's decisions; README PR | Merged |

**The 11/24 meeting (60 min, Lang keeps time):**
Platform is decided ([D-38](../decisions.md): Firestore), so the meeting does not revisit it.
1. New repo vs rebuild in place: Sid proposes, the team accepts or amends (10 min).
2. Roles and the merge rule in §2 (10 min).
3. Review the worksession PRs and Ivan's #64 notes; agree what's left for Phase B (20 min).
4. Confirm the Phase C plan and Sid's data structure (#50) (15 min).
5. Owners and dates for anything new, written as issues before leaving (5 min).

**Cut list if behind:** README (#55) → #59 slides to Phase B. **Never cut:** #60, because members are
being blocked at events now. Also never cut #50 and #52, because Phase C depends on them.

### Phase B: live-app stopgap (due Fri 12/4)

The live app has to keep working until the cutover in March, roughly 10 check-offs a week. Do only
what stops the two failures members actually hit (§4), nothing more. **The feature freeze still
applies.**

| Deliverable | Owner | Done when |
|---|---|---|
| #66: checkout how-to guide with real screenshots; 5-minute member training | Ivan | Posted in HQ and Slack; demo given |
| #61: the "N need fixing" button looks tappable and takes you to the empty field (started 11/17) | Ian builds, Ivan accepts | An FTO who has never seen the fix completes a checkout without help |
| #62: the AED pad expiration is prefilled from the AED's record; an empty O₂ PSI is obviously required (started 11/17) | Ian builds, Ivan accepts (Sid if it touches `app/lib`) | An in-date AED opens prefilled; ticking the regulator box puts the cursor in the PSI box |
| One-page "how to check out a pack" card posted in HQ, with a QR to the site | Ivan | Posted |
| Phase C issues written, with owners, for Spring cycle 1 | Lang | Issues exist in the new milestone |

**Cut list if behind:** drop the card before the code fix. Drop the code fix before the platform
decision.

### Phase C: rebuild cycle 1, offline check-off (Tue 1/19 → Fri 2/26)

**Goal:** a member can check a statpack out and in **in the basement HQ with no signal**, on the new
data layer, in about 2 minutes. Built alongside the old flow, so the live app keeps working.

| Week | Milestone | Owner |
|---|---|---|
| Wk 1 (by Fri 1/22) | Kickoff; **test that offline saves survive closing the app** (open question in the game plan) | Sid |
| Wk 2–3 (by Fri 2/5) | New data layer for statpacks and the check-off log; the only place that imports Firestore (#56) | Sid, with Ian pairing |
| Wk 2–4 (by Fri 2/12) | Check-off screen on the new layer: pockets in bag order, prefilled from last check, tap only what changed, "saved on this phone" message (#57) | Ian |
| Wk 3 | Clean catalog imported | Ian + logistics team |
| Wk 6 (2/22–2/26) | **Field test in HQ in airplane mode** with 3–5 FTOs; record taps and time | Ivan |

**Cut list if behind (cut from the top):** sealed sub-kit seal numbers → QR codes on packs →
duration metrics → audit mode on the new flow. **Never cut:** offline save, correct counts, and the
full-pack checkout gate.

**Cutover (by Fri 3/12):** if the field test passes, members switch to the new check-off. The old
one stays reachable but hidden for one cycle.

### Phase D: rebuild cycle 2, supply inventory (Mon 3/15 → Fri 4/30)

**Goal:** supply inventory runs on the new model, with every item in a labeled home.

- Stock lots with quantity and expiration on the new model (Sid designs, Ian builds).
- `Room-Shelf-Level-Bin` labels printed and placed, using Lang's map (Lang + logistics team).
- A 30/60/90-day expiring report feeds the buy list (Ian).
- Restock loop: a pack flagged "Restock Needed" gets refilled within 48 hours (Ivan sets the policy;
  the logistics team owns it).

**Cut list if behind:** the expiring report → printed labels (handwritten is OK at first). **Never
cut:** lots with expirations.

### Handoff (Mon 5/3 → Fri 5/14)

No build deadlines. Ivan and Lang write the handoff: what works, what's open, and who owns what next
year. Update this file for 2027–28.

## 4. Evidence: what "checkout broke" actually was (Nov 2026)

Two members reported checkout as broken. In both cases the full-pack checkout gate
([decisions.md D-8](../decisions.md)) worked as designed. The real problem is that the screen didn't
make clear what was blocking checkout.

- **11/14, an FTO at an event:** "It won't let me click that we have aed and oxy tank." The O₂ PSI
  field and the AED pad-expiration field were empty, even though the checkboxes were ticked. The
  footer button read "6 need fixing" in flat red, which looks disabled. Tapping it *does* jump to the
  first problem (`handleComplete` in `app/statpacks/check-off/page.tsx`), but nothing on screen says
  so.
- **11/15, a member checking out MRC 2:** the pack was really short: **0 of 1 EpiPen, 0 of 2
  pressure dressings**, and 2 of 3 cold packs. The app blocked checkout correctly. **The member took
  the pack anyway, outside the app**, so there is no record that it left, and it went out without
  epi.

What follows from this:
1. The gate caught a real readiness failure, but blocking on shortages made a member walk around
   the app. Now **shortages flag, never block** ([D-37](../decisions.md)), and the flag dialog lists
   only real failures ([D-39](../decisions.md)), #60. Expired items and failed checks still block.
2. The fix is clarity: the button and the required fields (Phase B).
3. **Process, not code:** never take a pack the app hasn't checked out. If you're blocked, tap "Can't
   fix it — flag this pack" and take another pack, or text logistics.
4. A short pack reached a checkout, which means the **restock loop** after check-in is missing
   (Phase D).

## 5. Optional work during the quiet period (12/7 → 1/18)

Only if someone wants to. Nothing here is due.
- Finish the catalog sheet (Ian / logistics team).
- A spike on the data layer or the offline test (Sid).
- Photograph one Breather pack, pocket by pocket (anyone near HQ).

## 6. Later (not scheduled)

- **Fall 2027:** shifts and roster on the new data layer.
- **Open source for other collegiate EMS orgs:** setup docs a non-engineer can follow, every
  BMRC-specific value in Settings, a demo dataset. The data model and docs matter more here than
  which database we use.

## 7. Open decisions (stop-and-ask)

1. ~~Platform~~: **decided, stay on Firestore** ([D-38](../decisions.md), 2026-11-16).
2. New repo vs rebuild in place.
3. Roles and the merge rule in §2.
4. Fate of the `inventory-dupe-fixes` branch and the old PR #18.
5. Who owns Phase 0 safety items that are stop-and-ask (rules deploy, registration).

## Status log

Add one line per change: date, what changed, who.

- 2026-11-16: draft created from the 11/15 meeting, Slack reports, and the academic calendar (Ivan).
- 2026-11-16: Worksession resized: #60 split into #60 (gate, Ivan + Claude, Sid reviews), #68 (flag dialog, Sid) and #69 (checkout restock task, deferred). Sid sizes his own work; Lang backs up Ian's #61. D-37 now spells out critical items (AED/O₂ still block via their checks; a missing EpiPen flags on purpose and the card says so) (Ivan).
- 2026-11-16: D-37 broadened (all shortages flag at checkout); D-38 (stay on Firestore, #51 closed); D-39 (flag dialog lists only real failures; checkout shortages create a restock task). #60 rescoped and moved to Sid; #65 (duplicate AED) and #66 (training guide) created. Worksession planned for Tue 11/17 (Ivan).
- 2026-11-16: Phase A detailed by day and owner. D-37 added (a missing EpiPen doesn't block checkout). Issues #60–#64 created; milestone "12/4 live-app stopgap" added (Ivan).
