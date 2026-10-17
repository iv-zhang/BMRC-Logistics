# Logistics workflow & UX: small fixes first

2026-10-16 · Implementation started under the user’s instruction to begin Phase 1, use lower-cost implementation agents, commit on a branch, and open a PR. Merge/deployment and natural next-shift observation remain pending.

## Implementation progress — 2026-10-16

- **Scope:** Phase 1 is provisionally mapped to **Batch 0**, the first release in this plan; the scope clarification is pending. 0b/0c and the independent 0d input slice are underway. The explicit 0e maintenance-policy decision remains pending; no maintenance behavior change is authorized by elapsed time.
- **Branch:** `codex/workflow-remediation-phase-1`, based on freshly fetched `origin/main` `fdbf6574a51257cd05d52dff65f2af947817b1e5`. Preserve Release A / Release B as separate implementation commits and verification records; do not claim a live release from a PR.
- **Cost:** bounded implementation delegated to lower-cost models; orchestration reserved for cross-file review and verification. No unrelated branch integration or production data writes.
- **0a audit complete (shipping pending):** [branch/worktree inventory](2026-10-16-branch-worktree-audit.md) records all 17 worktrees and 51 refs. Three old worktrees have uncommitted edits even though their HEADs are merged; all are preserved. `381cec5` is already in the release base and will not be replayed.
- **Deployment evidence:** [successful live workflow run](https://github.com/iv-zhang/BMRC-Logistics/actions/runs/38683048735) deployed commit `fdbf657` on 2026-10-15 UTC, Hosting artifact `f7c8b66e27d6406a`. Its companion duplicate workflow failed. Job output masks project/site/build configuration, so this alone does not verify the compiled app’s backend or rule out a later manual deployment.
- **CI decision:** reuse the reviewed two-file repair from `1087471` / [existing PR #7](https://github.com/iv-zhang/BMRC-Logistics/pull/7): remove the stale placeholder-env live workflow and serialize the remaining live workflow. Existing branch/PR stays intact; the Phase 1 PR will explain the overlap.
- **New finding:** the check-off loader also defaults missing status to `Ready`, so fixing only the badge fallback would leave false-ready behavior. Remove that loader default as part of 0c.
- **Verification:** source audit only so far. Build, targeted regression, invariant/property suites for 0d, and emulator UI journey pending. Live validation remains pending merge/deploy and a real next-shift observation.

## Context & design principles

**Members joined to be EMTs, not inventory clerks.** Rank work by manual labor removed per unit of developer effort, starting with reported failures. Data trust, ease of use, and practical usefulness all matter.

- Derive, don't ask: compute status, hours, shortages, lateness, and bin contents from existing facts. Extend D-8's derived pack status, D-16's button-press attendance, and D-4's periodic shelf re-anchor instead of asking members to maintain another ledger.
- Make routine checkout, matching counts, and “used nothing” returns as close to one tap as safety checks allow. Extra input appears only for exceptions. Prefer removing a step to adding a confirmation, field, or screen.
- Count supplies as stored: loose units, mixed-size bins, and bulk totes. No imaginary packaging or mental conversions. Problems should become claimable work automatically; process overhead belongs to logistics, not general members.

One student developer—the logistics director, assisted by AI coding agents—maintains this. There is no dedicated QA, reviewer, or ops staff. Logistics is a handful of volunteers with semesterly turnover. About 140 mostly EMT-certified students use the app occasionally for shifts, pack checkout/return, and reporting problems; many receive only the onboarding tour. This plan must fit work between semesters.

Cost stays **$0**: Firebase free tier, static export ([next.config.ts:4](../../next.config.ts#L4)), no application server, Cloud Functions, email, paid services, or new backend. Use browser-side computation and existing Firebase client reads/transactions within free-tier limits. No background scheduler is assumed.

The project is [MIT-licensed](../../LICENSE#L1). Aim for the best free logistics/operations platform for BMRC and reuse by other volunteer/collegiate EMS agencies. Keep org configuration as data, not BMRC-specific code; use runtime hooks/getters ([CLAUDE.md:77](../../CLAUDE.md#L77)).

The field reports are enough to start: awkward pack inspection; loose OPAs/NPAs/SAM splints the audit form cannot count; mixed-size colored bins when blue bins ran out; bulk cold-pack totes; and short packs missing from checkout. No study blocks Batch 0. [Review notes](2026-10-16-workflow-review-notes.md) preserve earlier isolated tests, not proof of the live release.

## Checked facts and shipping gap

Source references below describe this checkout (`381cec5`); recheck them on the current release base before implementation. Branch facts were refreshed with `git fetch origin` on 2026-10-16:

- **02: merged; live release still unverified.** Freshly fetched `origin/main` is `fdbf657` (Oct 14, PR #9), which contains `381cec5`. Local `main` (`f9943a1`, Sept 26) is its ancestor, **25 commits behind**; `feat/statpack-restock-flag` is **0 ahead / 24 behind** `origin/main`. This supersedes the earlier 21-behind / 1-ahead snapshot and the previous incorrect claim that origin/main was older. The main-push workflow targets live Hosting ([firebase-hosting.yml:4–6](../../.github/workflows/firebase-hosting.yml#L4), [40–41](../../.github/workflows/firebase-hosting.yml#L40)); a merge alone does not prove a successful live deployment.
- Qualification to “Hosting deploys only on main”: there is a second main-push live workflow ([firebase-hosting-merge.yml:3–5](../../.github/workflows/firebase-hosting-merge.yml#L3), [38–39](../../.github/workflows/firebase-hosting-merge.yml#L38)) and a PR preview workflow ([firebase-hosting-pull-request.yml:5](../../.github/workflows/firebase-hosting-pull-request.yml#L5), [38–43](../../.github/workflows/firebase-hosting-pull-request.yml#L38)). Local refs cannot prove “never deployed” manually or identify the current live artifact. Preview Hosting is not isolated test data by itself.
- **Assignment mismatch:** dashboard queries `assignedTo` ([member-dashboard.tsx:190](../../app/dashboard/member-dashboard.tsx#L190)); checkout writes `assignedToUserId` ([inventory.ts:783](../../app/lib/inventory.ts#L783)). New checkouts are missing from My Assigned Packs. “Always empty” is too absolute for legacy records that might contain the old field; the mismatch and local failure are confirmed.
- **False Ready:** every status other than Expired/Restock Needed falls back to green Ready, including In Use and In Maintenance ([check-off/page.tsx:1392–1395](../../app/statpacks/check-off/page.tsx#L1392)).
- **No loose-count input:** `AuditEntry` has `countedBoxes` but no loose count ([audit-helpers.ts:336–353](../../app/lib/audit-helpers.ts#L336)); the drawer asks only for sealed boxes/bags ([audit-action-drawer.tsx:394](../../app/components/audit-action-drawer.tsx#L394)). The model supports `looseUnits` ([types.ts:445](../../app/types.ts#L445)).
- **Maintenance decision:** the picker includes In Maintenance ([checkout/page.tsx:112](../../app/statpacks/checkout/page.tsx#L112)); the transaction has no maintenance-status gate ([inventory.ts:588–607](../../app/lib/inventory.ts#L588)). Recommend excluding it from member checkout. Additional mismatch: `Statpack.status` does not include In Maintenance ([types.ts:730](../../app/types.ts#L730)); reconcile that representation with the policy, not by silently treating it as Ready.

## Working rules

The logistics director is the default owner. Approve each implementation slice before code, then delegate bounded edits to lower-cost agents. No separate reviewer, observation program, pilot, or inventory day is a release prerequisite. Old item numbers below preserve traceability, not the old sequence.

Preserve [decisions.md](../../decisions.md): D-7 orderless audits; D-4 reserve/shelf and D-8 pack separation/derived status; D-8 shortages flag rather than block, with genuine safety gates intact; D-9 shared check-off; D-31 fast return; D-13 MedOps ≠ isAdmin; D-16/D-29 attendance stamps, team boundaries, manager-only retro-edits. **D-11 class/field pools and D-12 box-lot quantities are stop-and-ask**, not implicit counting-fix scope.

Future code follows [CLAUDE.md:34–43](../../CLAUDE.md#L34): typecheck + lint touched files after changes; build + `npm run test` before feature handoff; expensive driven emulator smoke only before a requested commit or on explicit request. Add targeted cases with each fix. Report runtime checks separately from source/automated checks; never imply end-to-end verification that was not run. This docs revision needs no app test run.

Use isolated emulator accounts/data by default, or verified staging. Names/display names start `[TEST]`; records carry `isTest`, unique `testRunId`, and purpose where supported. Track generated history/tasks in a scoped cleanup manifest. **Production test writes require the user's explicit approval.** Include separate airway sizes sharing a bin, loose splints, a tote, sealed-plus-loose stock, short packs, and a repeated SKU in two pockets. Synthetic counts are not real stock or clinical standards.

## Batch 0 — Ship what's already fixed + the reported failures

**Release A:** integrate and ship **0a + 0b + 0c + 0e together**, after the logistics director decides 0e. Start with 0a's current-main audit, implement the approved remaining changes, then verify the combined checkout → dashboard → return journey. **Release B:** ship **0d separately**, with its stock-math checks; do not hold Release A for it. No research needed.

### [ ] 0a. Audit branches, then ship the restock-flag fix (old 02) · S

**Files/approach:** review `381cec5` and current-main changes to `app/statpacks/checkout/page.tsx`, `app/statpacks/check-off/page.tsx`, `app/lib/inventory.ts`, and both live deploy workflows. Fetch before recording ref facts; use `git merge-base --is-ancestor` and `git rev-list --left-right --count` to distinguish ancestry from dates. After this fetch, main is 25 behind and the feature branch is 0 ahead / 24 behind `origin/main` (`fdbf657`), which already contains the fix.

Audit local/remote branches **and `.claude/worktrees/`**, using `git worktree list --porcelain` plus a directory inventory. Record each worktree's branch/HEAD, dirty state, merge status against current `origin/main`, and uncommitted work separately; preserve it all. The refreshed remote-ref snapshot has six unmerged branches: `feat/assets-expiry`, `feat/inventory-hygiene-w2`, `feat/roles-access-w2`, `feat/waitlist-p3-reminders`, `plan/platform-overhaul`, `worktree-fix-duplicate-deploy-workflow`.

Base Release A on **current `origin/main`**: rebase or merge any remaining fix/release work onto it, resolve checkout/check-off drift, then re-test. Since `381cec5` is already merged, do not replay it. Match the last successful live SHA/artifact, Hosting site, and build's Firebase project to the live site; review the existing duplicate-workflow fix before including any necessary deploy repair. Deploy the combined approved release through main, not the stale feature branch. These are future actions, not part of this docs task.

**Verify:** code tiers on the integrated release plus targeted emulator/staging short-pack, assignment, real-status, and approved-maintenance cases. The old local pass is not enough after checkout/check-off drift. After deployment, **observe a real member checking out a real short pack on the next shift**—no synthetic production account, pack, status change, or forced shortage. Production test writes only with the user's explicit approval.

**Done when:** the combined release's live SHA/backend are recorded and next-shift observation confirms short-pack checkout without a Ready override. Check dashboard assignment/real status and return's preserved shortages during the normal journey; mark live validation pending until observed.

### [ ] 0b. Fix My Assigned Packs · S

**Files/approach:** change `app/dashboard/member-dashboard.tsx` to query `assignedToUserId`, matching [inventory.ts:783](../../app/lib/inventory.ts#L783). Preserve effective-identity scoping (D-18; [CLAUDE.md:73](../../CLAUDE.md#L73)); no new assignment field or migration by default.

**Verify:** code tiers + query regression. Next authorized targeted run: checkout → dashboard → return as one journey, with a second member as the negative case.

**Done when:** the pack appears only for its holder after checkout and disappears after return.

### [ ] 0c. Display the real pack status · S

**Files/approach:** replace `statusInfo` in `app/statpacks/check-off/page.tsx` with an explicit mapping for the declared statuses, including Pending Initial Check and CRITICAL - EXPIRED ITEMS ([types.ts:730](../../app/types.ts#L730)), plus safe display of persisted In Maintenance. Missing/unrecognized values show neutral Unknown, never green Ready. Do not change derived readiness rules.

**Verify:** code tiers + mapping cases for every status and missing/unknown values; inspect the return gate in the next targeted run.

**Done when:** a checked-out/maintenance pack is never labeled Ready by fallback.

### [ ] 0d. Count sealed packages + loose units (old 04, input slice) · M

**Files/approach:** extend `AuditEntry`/`submitAuditEntries` in `app/lib/audit-helpers.ts` and count state/fields/payload/result text in `app/components/audit-action-drawer.tsx`. Reuse `computeBagStock` ([item-status.ts:56–84](../../app/lib/item-status.ts#L56)): scalar `looseUnits` for box/loose items; batch `bagCount`/`looseItems` for bag-tracked stock ([types.ts:380–386](../../app/types.ts#L380)). Its no-pack-size fallback currently ignores loose units ([item-status.ts:77–78](../../app/lib/item-status.ts#L77)); include that helper in this fix so loose-only records work without invented packaging.

Use one direct unit field for loose-only supplies, package + loose otherwise, with a computed total: “2 bags × 10 + 7 loose = 27 units.” Validate nonnegative integers in the writer; keep legacy totals/logs consistent. Keep sizes separate items (`family`/`variantLabel`, [types.ts:421–435](../../app/types.ts#L421)); bins/totes are locations, not packaging. Ambiguous multi-lot counts remain unresolved observations, not invented lot assignments. Differing counts must not gain a fresh verification stamp; finish their resolution UI in Batch 1.

**Verify (Release B):** code tiers **plus `npm run test:invariants` and `npm run test:properties`**, required because this changes `computeBagStock` ([package.json:18–19](../../package.json#L18)). Add writer/math cases: 12 loose OPAs (including missing package size), 6 splints, 60 cold packs, 2 ten-unit bags + 7 loose, zero, invalid input, ambiguous multi-lot count. Missing conversion on real sealed stock stays unknown; don't guess a package size.

**Done when:** those counts can be entered without imaginary boxes or mental conversion; canonical quantities/logs agree, or a clearly unresolved observation remains.

### [ ] 0e. Decide In Maintenance checkout policy · decision, then S

**Decision for the logistics director:** exclude In Maintenance from member checkout? **Recommend yes.** A shortage is not repair work; keep the approved Restock Needed behavior.

**If approved:** update `app/statpacks/checkout/page.tsx`, the checkout/direct-link entry in `app/statpacks/check-off/page.tsx`, and `logStatpackCheckOff` in `app/lib/inventory.ts`. Reuse one eligibility rule; recheck maintenance state inside the transaction. Explain unavailability without a normal-path confirmation. An admin maintenance override needs a separate explicit decision.

**Verify:** code tiers + picker, direct URL, and stale-tab status-change cases in the next authorized targeted run.

**Done when:** the decision is recorded and all three paths enforce it without blocking eligible short packs.

## Batch 1 — Data-trust fixes that remove rework

Observation = **one physical walkthrough with 1–2 people**, alongside these changes, not a study. Use the awkward pack and actual loose/mixed-bin/tote arrangements. S = focused change; M = connected surfaces; L = larger/model-dependent work. Apply the same verification tiers.

### [ ] 1a. A mismatch stays unresolved (rest of old 04) · M

Bag counts stamp `lastAuditDate` without reconciling batches ([audit-helpers.ts:387–417](../../app/lib/audit-helpers.ts#L387)); monthly verification trusts that date ([item-status.ts:190](../../app/lib/item-status.ts#L190)). In helper/drawer, separate observed from resolved; show expected/observed/delta and retain unresolved variance. Offer the smallest batch/loose correction, preserve provenance, and detect intervening stock changes before applying absolute counts. Use an explicit **“Matches expected (N)”** action after physical counting, or a blind count entered before revealing expected values. **Automation-bias risk:** showing expected values can encourage rubber-stamping; never silently prefill an observed count or treat opening/submitting a form as confirmation.

**Done when:** a mismatch stays visible/unverified until canonical stock is reconciled; matching counts stay quick and stale corrections cannot overwrite a receipt.

### [ ] 1b. Open a bin; count everything in it (old 08, entry point) · M

Extend `app/audit/page.tsx`/drawer: select/scan bin or tote → expected size-specific items → count/report in place. Group by `storageLocation.containerId` ([types.ts:361–368](../../app/types.ts#L361)); never merge sizes. Keep skipping/revisiting orderless. Color is optional; stable name/ID works when blue bins run out.

**Done when:** one mixed-size bin and one bulk tote can be audited without re-searching each item. If one SKU needs quantities split across containers, stop and ask before expanding the model.

### [ ] 1c. Fit inspection to the physical pack (old 12) · M

In `app/statpacks/check-off/page.tsx`, keep exact size/count with its pocket, expose unfinished pockets, and reduce backtracking. Fix repeated-SKU state keys: initialization/reads use only `itemId` ([1067–1071](../../app/statpacks/check-off/page.tsx#L1067), [1478–1482](../../app/statpacks/check-off/page.tsx#L1478)). Use stable content-entry identity across counts/checks/verification/resolutions, retaining pocket/compartment identity on submission ([1504–1511](../../app/statpacks/check-off/page.tsx#L1504)). The writer already disambiguates these ([inventory.ts:625–637](../../app/lib/inventory.ts#L625)); don't collapse upstream. Keep fast returns unchanged. If interruptions still waste work, add a small user/pack/mode/version-scoped draft, not another workflow.

**Done when:** the walkthrough completes all pockets without coaching; the same SKU in two pockets saves independent counts; “used nothing” stays short.

## Backlog — ranked, no fixed batches

Take the next useful small slice when time permits. Concurrency risks are real but collisions rare at this scale: **05, 17, and 18 reliability work is “fix when touching that code,”** not a prerequisite for reported fixes.

1. [ ] **03 · Dashboard truth · M.** Replace legacy low-stock totals/raw expiry scans ([dashboard/page.tsx:188–216](../../app/dashboard/page.tsx#L188)) with canonical quantity/status/date/config helpers. Distinguish reserve, shelf observations, and pack contents. **Done when:** dashboard/inventory agree for loose, expired, quarantined, and empty-reserve/full-shelf fixtures.
2. [ ] **07 · Failure isn't empty/healthy · S per surface.** Handle listener errors ([dashboard/page.tsx:151–159](../../app/dashboard/page.tsx#L151), [events.ts:762–770](../../app/lib/events.ts#L762)) and failed/missing pack loads ([check-off/page.tsx:1079](../../app/statpacks/check-off/page.tsx#L1079), [1682](../../app/statpacks/check-off/page.tsx#L1682)) with explanation/retry/back. **Done when:** denied/offline/missing and empty look different, without lost input.
3. [ ] **10 · Delivery → intake · M.** Received only updates tracker metadata ([buy-list-panel.tsx:242–254](../../app/components/buy-list-panel.tsx#L242)). Prefill existing receiving or label “delivered; intake needed”; support partial delivery. **Done when:** stock posts once without retyping order context.
4. [ ] **06 · Useful exceptions · M, split by kind.** `buildExceptions` accepts any one lot date and truthy location ([reconciliation.ts:57–103](../../app/lib/reconciliation.ts#L57)). Add missing stocked-lot dates, broken refs, quarantine, stale shelves, unresolved variance, and correction links (remaining 08). **Done when:** fixtures produce actionable work; empty claims only checks performed; D-12 limitations remain explicit.
5. [ ] **11 · Recover return follow-up · M.** Hooks are best-effort after return ([inventory.ts:828–851](../../app/lib/inventory.ts#L828)). Add client-visible pending/retry or derived reconciliation, never undoing a physical return. Ask whether one team's return should end every team's hours ([events.ts:620–647](../../app/lib/events.ts#L620)). **Done when:** failures recover once under the agreed team policy.
6. [ ] **13 · Find common actions · S per destination.** Align desktop/mobile member destinations and labels ([app-sidebar.tsx:71–78](../../app/components/app-sidebar.tsx#L71), [mobile-bottom-nav.tsx:20–24](../../app/components/mobile-bottom-nav.tsx#L20)). Keep shifts/equipment/reporting obvious, logistics role-gated. **Done when:** members find common actions on phone/desktop without coaching.
7. [ ] **14 · Follow problems to closure · M.** Clarify source/status/claim/next action across separately loaded reports ([issue-reports/page.tsx:92–125](../../app/issue-reports/page.tsx#L92)) and existing board tasks. Link source corrections; no parallel inbox or duplicate member report. **Done when:** a report leads to corrected source data with clear counts/closure.
8. [ ] **15 · Friction on touched screens · S per defect.** Prefer defaults, concise labels, disclosed uncommon controls, readable sizes/units. Check phone, keyboard/focus, enlarged text, and non-color cues. Preserve inventory scrolling ([CLAUDE.md:126–132](../../CLAUDE.md#L126)). **Done when:** the specific hidden/clipped action or extra step is gone; no broad cosmetic rewrite.
9. [ ] **17 · Shift signup · M; fix concurrency when touching that code.** Clarify requested/confirmed, blockers, cancellation. Dedupe is query-then-add ([events.ts:265–294](../../app/lib/events.ts#L265)); approval doesn't reread request state ([325–370](../../app/lib/events.ts#L325)). Harden there, preserving cert/intern/attendance rules. **Done when:** the lifecycle is clear; retries/two tabs cannot duplicate requests/placements.
10. [ ] **18 · Standalone equipment · M; fix concurrency/idempotency when touching that code.** Improve failed loads ([assets/checkout/page.tsx:51–75](../../app/assets/checkout/page.tsx#L51)); recover state/later logs together ([inventory.ts:2018–2040](../../app/lib/inventory.ts#L2018), [2139–2160](../../app/lib/inventory.ts#L2139)). Show partial batch results; ask before changing return-ownership policy. **Done when:** correct serial/holder/location survives single/bulk return, retry, competing checkout.
11. [ ] **05 · Retry-safe receiving · M; fix when touching that code.** Dedupe, stock, and ledgers are separate ([audit-actions.ts:235–263](../../app/lib/audit-actions.ts#L235), [287–335](../../app/lib/audit-actions.ts#L287)). Keep stable operation IDs; atomically commit stock/evidence with client Firestore transactions where possible. **Done when:** receipt/retry changes stock once; intentional identical deliveries still work.

## Reduce manual labor — candidates, not commitments

Ranked by estimated labor saved per effort. Promote only ideas that remove a real step. Compute on relevant page visits/existing actions, with bounded reads/writes: no scheduler, server, email, or paid API.

1. **Explicit match or blind count · S.** Extend drawer count/submission ([audit-action-drawer.tsx:182–200](../../app/components/audit-action-drawer.tsx#L182), [audit-helpers.ts:360](../../app/lib/audit-helpers.ts#L360)) with “Matches expected (N)” or blank blind-count input. Removes typing only after physical confirmation; no silent expected-count prefill. Address automation bias in 1a.
2. **Restock/refill pick list · M.** Combine `getPackShortages` ([statpack-shortages.ts:35](../../app/lib/statpack-shortages.ts#L35)), `computeBagStock`/`isShelfCheckCurrent` ([item-status.ts:56](../../app/lib/item-status.ts#L56), [228](../../app/lib/item-status.ts#L228)), and `refillShelf` ([restock-actions.ts:88](../../app/lib/restock-actions.ts#L88)). Removes figuring out what to fetch; stale shelves request counts, not invented deficits.
3. **Bin/tote/pack QR context · S/M.** Extend `resolveScan` ([scan-resolve.ts:79](../../app/lib/scan-resolve.ts#L79)) and bin entry with printable labels/static query links + manual lookup. Removes searching/typing; no paid scanner service.
4. **Claimable exception tasks · M.** Extend `buildExceptions` ([reconciliation.ts:68](../../app/lib/reconciliation.ts#L68)) and `flagStatpackRestock`'s linked/unclaimed `team_tasks` pattern ([statpack-restock-flag.ts:46–97](../../app/lib/statpack-restock-flag.ts#L46)). Removes remembering to check another page; reconcile/dedupe on actions/page visits, no parallel system.
5. **Weekly dashboard digest · S/M.** Extend `buildExceptions` ([reconciliation.ts:68](../../app/lib/reconciliation.ts#L68)) and `isShelfCheckCurrent` ([item-status.ts:228](../../app/lib/item-status.ts#L228)) plus canonical status into a logistics-only stale/expiring summary. Removes page-by-page scanning; weekly is a view window on load, not scheduled delivery.
6. **Bulk common jobs · M.** Extend `moveItemsBulk` ([audit-actions.ts:157](../../app/lib/audit-actions.ts#L157)), batch `submitAuditEntries`, and refill UI for one physical job. Removes reopening forms; preserve per-item units/results and retry unfinished work only.
7. **Log-based reorder suggestions · L, last.** Evaluate `computeMostUsedItems` ([statpack-stats.ts:189–206](../../app/lib/statpack-stats.ts#L189)) with reserve thresholds. Par-minus-count is shortfall, not measured consumption; recurring shortages/fast returns bias it. Removes manual trend calculation only when evidence supports it; suggestions, never auto-orders.

## Appendix — Logistics team practices (not release gates)

- **09 · Inventory day:** count active supplies/packs by location using improved tools. Keep unknowns unknown. Future live repairs require separate scope, dry run, and recovery—not a new engineering program.
- **16 · Feature value review:** after use, ask what saved work or caused duplicate entry. Keep/simplify/hide/retire one thing at a time; preserve history/deep links and update onboarding after workflow changes.
- **19 · Small trial + semester handoff:** try changes during normal work with 1–2 volunteers; note friction and check stale/unclaimed work periodically. Give the next team a short how-to/known-issues list. Useful habits, not a pilot committee or release gate.
