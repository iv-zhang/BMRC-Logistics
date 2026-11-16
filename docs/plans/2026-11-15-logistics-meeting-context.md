# 2026-11-15 logistics website meeting — context for coding decisions

Status: **context note, not a decision record.** Update 2026-11-16: the platform question is closed (stay on Firestore, D-38); see [docs/ROADMAP.md](../ROADMAP.md) for the current plan. The platform vote below is being re-checked because it rested on a wrong fact. Until the team re-confirms it, treat every item under "Unresolved" as **stop-and-ask**.

Attendees: Ivan (Logistics Director), Lang (website project lead), Sid (data model / back end), Ian (builder). ~66 min, Zoom. Agenda source: Google Doc "BMRC Logistics Rebuild Briefing" (Agenda / Decisions / Context tabs), mirrored in `docs/plans/2026-11-14-rebuild-game-plan.md`.

## Agenda vs what happened

| Planned item | Outcome |
|---|---|
| 1. Platform + approach (rec: Firestore, rebuild in place, PWA + QR) | Voted 2–1 for a relational DB (Sid, Lang for; Ian against; Ivan abstained). Ivan enabled Firebase SQL Connect in the new Firebase project (us-west2 / LA). Approach shifted to Sid's plan: copy the app's base into a clean project and port one feature at a time. QR codes per pack deferred (a QR on the wall linking to the site is enough for now). PWA not discussed. |
| 2. Ian's PRs #42–46 | Not discussed. Still waiting. |
| 3. Workflow (issues, review, merge, deploy) | Partly: issues will include screenshots / repro steps; if a bug can't be reproduced, comment that on the issue instead of closing it. Review/merge/deploy owners not decided. |
| 4. Who makes technical calls | Not decided. Sid named lead of the migration but said the final call is Ivan's/Lang's. |
| 5. Phase owners | Partly: Sid = data structure for statpacks + check-off; Ian = copy the base (UI, Firebase scaffolding, TS types, package.json), strip features, then port statpack + check-off. Phase 0 owner not set. |
| 6. Location code format | Not discussed. |
| 7. Six design principles | Not discussed formally. Ivan restated the simplicity principle from Falck: count by container, front shelf = consumed, track only back reserve, swap pre-filled glove/band-aid bags, logistics refills them. |
| Goal: check-off works in HQ with no signal | **Not discussed** (still a hard requirement in the plan). |
| Goal: clean item catalog | Discussed as the root problem: spreadsheet import created duplicate/inconsistent items ("4x4 gauze" vs "4 in gauze", "M gloves" vs "medium gloves"). Direction: wipe and re-enter clean data rather than migrate. |
| Goal: baseline check-off time | Not discussed. |
| Open items (dup branch, PR previews on live DB, multi-role, Google sign-in, PR #39 rules, who deploys) | Not discussed. |

Why it drifted: started ~12 min late; one attendee had a 30-minute window; the platform debate took ~24 min; the agenda doc wasn't opened until ~30 min in; no timekeeper; too many items (7 decisions + 3 goals + 13 open items) for an hour.

## Facts corrected after the meeting (affect the platform decision)

- The "relational DB pauses after a week of inactivity and needs a manual restart" con came from **Supabase's free tier**, not Firebase. Firebase SQL Connect (Data Connect) on Blaze: 3-month no-cost Cloud SQL trial, then standard Cloud SQL pricing from ~$9.37/month (over the plan's $5/month cap). Changing the instance config ends the trial early.
- Supabase free: pauses after 7 idle days, no backups, Pro $25/month. Offline sync for any Postgres option needs an add-on (PowerSync free deactivates after a week idle; Pro from $49/month).
- Issue #19's 45-second timeout (`SUBMIT_TIMEOUT_MS` in `app/statpacks/check-off/page.tsx`) stops the spinner; it does not fix the cause. The cause is how a check-off saves (~60 sequential round-trips, a transaction that needs a live connection, offline persistence off). This is true whichever database we use.
- A line in the briefing doc saying Firestore was "agreed upon by Sid and Ian" was not supported by any meeting; the prior website meeting (11/4) was Lang + Sid only. Do not treat AI-written summaries as decisions unless the decision log confirms them.

## What both sides agreed on (safe to build on)

- Priority is **statpack check-out/check-in and supply inventory only.** Everything else (shifts, stats, finance, uniforms, admin) waits. Hide, don't delete.
- The data needs **enforced structure**: one canonical item catalog (size/variant as fields, no free text), no duplicated names across statpacks/assets/inventory, validation on every write.
- Re-enter clean data instead of migrating the current inventory.
- Assets that must be tracked by person/location: AEDs, glucometers, O2 regulators (things we can't afford to lose).
- Front shelf is treated as consumed; only back reserve is tracked; refills happen on a regular cycle.
- Future maintainers will likely be non-technical and rely on AI coding tools, so: fewer moving parts, always-on, $0, decisions and schema documented in the repo.

## Unresolved — stop and ask before coding

1. **Platform:** Firestore with one data layer + schema validation vs Firebase SQL Connect vs Supabase. Re-vote pending with the corrected facts. Do not write SQL-specific code or a Postgres schema until this is confirmed in `decisions.md`.
2. **Offline check-off** in the no-signal basement HQ: how the chosen platform satisfies it.
3. **New repo vs rebuild in place** (Sid's copy-and-port plan vs the game plan's in-place rebuild).
4. Who decides technical calls; who reviews, merges and deploys (Ian currently depends on Ivan/Lang to deploy).
5. Fate of PRs #42–46 and the `inventory-dupe-fixes` branch.
6. PR #39 policy questions (#19 part 2, #30): does a lapsed AED/glucometer check block Ready or only flag it? Do acknowledgements create reports? Do checkout shortages flag restock? Are admins notified?
7. Phase 0 safety items (rules deploy, backups, CI checks, registration lockdown) need an owner. The rules deploy and the registration change are stop-and-ask per CLAUDE.md.
8. PR preview channels currently write to the production database.

## Next checkpoint

Website team meeting Tue 2026-11-24, 5–6pm. Expected by then: Sid's data structure for statpacks + check-off; Ian's stripped-down base project; or a stated reason why not.
