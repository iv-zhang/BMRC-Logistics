---
name: bmrc-next-step
description: >
  What to work on next in BMRC Logistics. USE THIS SKILL when anyone asks what to
  do next, what's their task, what's due, what the plan/roadmap/timeline is, where
  the project stands, or when starting a session with no specific task. Keywords:
  next step, what's next, what should I work on, my tasks, roadmap, timeline,
  deadline, due, milestone, phase, priorities, status.
---

# BMRC Logistics: what's next

`docs/ROADMAP.md` is the team's source of truth for who does what, by when.

## Steps

1. **Read `docs/ROADMAP.md` fully.** If its status line still says DRAFT, say so:
   dates and roles are proposals until the 11/24/2026 meeting confirms them.
2. **Identify the person.** Run `git config user.name` and `gh api user -q .login`
   (skip `gh` if it is not installed). Map the login to ROADMAP §2:
   `iv-zhang` = Ivan, `sidves52` = Sid, `1angeth` = Lang, `IanInProgress` = Ian.
   If the login is unknown, ask who they are.
3. **Find the current phase** from today's date using the ROADMAP §3 timeline.
   If today falls in a quiet period (RRR week, finals, winter break), say so and
   offer only the optional list.
4. **Fetch live status (read-only):**
   - `gh issue list --assignee <login> --state open --json number,title,milestone,updatedAt`
   - `gh pr list --author <login> --json number,title,isDraft,reviewDecision`
   - `gh pr list --search "review-requested:<login>"`
5. **Recommend 1 to 3 next steps, in order.** Each one needs an issue number or
   ROADMAP row, plus its "done when" criterion. Priority order:
   - Unblock others first: reviews owed, and dependencies such as #50, #51, #52
     that Phase C needs.
   - Then the person's current-phase deliverables, soonest deadline first.
   - Then the cut list.
   Respect role lanes: data layer, rules, and `app/lib` work goes to Sid's review;
   member-facing work goes to Ivan's acceptance. Flag anything overdue.
6. **Never start work on an item under ROADMAP "Open decisions".** Present it
   as a question for the person or the team.
7. **Explain in plain language.** Ivan, Lang, and Ian are not CS majors. For Sid,
   be precise and cite files and issue numbers. Flag anything you could not verify.
8. **Remind the person of the workflow** from CLAUDE.md: plan, get approval, then
   delegate implementation to Sonnet/Haiku subagents. Never commit or push unless
   asked. When a deliverable lands, update its ROADMAP row and status log in the
   same PR.
9. **Keep the answer short.** Start with a one-line "where we are" (phase, and
   days to the next deadline). Then give the numbered steps.
