# UI and UX audit and improvement plan

2026-10-22. Source snapshot: `main`, `9a0ca617f83f73382a7257d5b0ee9afb3068c2cc`.

Publication check: fetched `origin/main` at `8f1b580` before preparing the documentation PR. The intervening commits update rules, tests, and documentation; the reviewed application UX source is unchanged. Preserve those newer changes when integrating these documents. [Lang's onboarding summary](../project-onboarding-summary.md) is the short meeting brief; [tech stack and production gaps](../tech-stack-and-gaps.md) is the separate engineering-readiness reference.

The owner wants an issues-first review, then a fix for each issue, plus shared standards for Codex and Claude Code. The main concerns are excessive information, inconsistent interactions and wording, trust in pack counts, and a reported password-reset incident. Later clarification: the admin view currently shows Band-Aids as **low stock** for Statpack 2. That does not establish a zero count or prove the current badge is incorrect.

This is a source audit and implementation proposal. Three lower-cost `gpt-6-luna` agents reviewed separate areas; the primary agent checked findings and integrated the plan. No app behavior, account, production record, or deployment was changed. No browser walkthrough or real-user observation was performed. Confidence labels below distinguish source evidence from reports that still need investigation.

The [shared standards](../ui-ux-standards.md), [bmrc-ui skill](../../.claude/skills/bmrc-ui/SKILL.md), and Codex/Claude entrypoints are the documentation deliverables. They apply to future UI work. Product fixes below remain proposals for review. This complements the [earlier remediation plan](2026-10-16-workflow-and-ux-remediation-plan.md); it does not reopen its completed fixes.

This change covers documentation and agent entrypoints only. Product implementation, policy changes, and live-data corrections require their own reviewed scope under the repository workflow.

## Confirmed direction from the owner

The owner answered the clarification questions and explicitly asked to keep the current work focused on context and plan documents, not implementation.

| Topic | Confirmed answer | Effect on the plan |
|---|---|---|
| Primary audience | Members checking out gear; admin/logistics can work around current issues | Member checkout is the first proposed product scope. Retain admin findings as a later backlog. |
| Experience | Usually experienced FTOs, with a tutorial needed at the beginning | Provide a short first-use checkout introduction and a simple repeat-use flow. Do not assume app familiarity from field experience. |
| Device/context | Mainly phones, reliable eduroam, sometimes one hand, not particularly rushed | Review narrow screens, reachable quantity controls, and one-handed operation first. Retain normal failure recovery without making offline work the central project. |
| Checkout purpose | Team physically checks what is in each bag and its quantities | Preserve per-checkout physical verification. Simplify presentation and repeated steps, not the verification itself. |
| Logistics checks | Biweekly pack checks are planned but have not begun | Treat this as a process gap; do not imply packs already receive this verification or substitute it for member checks. |
| Band-Aid incident | A wrong prior entry and missing correction may explain the warning; no physical count supplied | Manually compare the actual count with the exact pack record before selecting a data fix. Do not assume a software calculation defect. |
| Password incident | The person may have pressed Reset password | Deprioritize the unconfirmed forced-reset hypothesis. Revisit if a concrete message or repeat report appears. |
| Feedback | Too much information and work; no additional specific complaints supplied | Use this as owner feedback, not evidence of broad member dissatisfaction or measured task failure. The new logistics member's visual impression supports consistency review, not a diagnosis of app correctness. |

The next planning deliverable is a concrete member phone-checkout proposal: information hierarchy, necessary fields, first-use tutorial, count confirmation/correction, and proposed before/after copy. It must show how an FTO physically verifies a pack without treating the saved count as proof. Admin redesign, a broad visual rewrite, offline architecture, and changes to checkout eligibility are outside that first scope.

## 1. Issues first

P1 = trust, access, or core member-checkout requirement. P2 = workflow or comprehension problem. P3 = lower-impact follow-up. Member checkout takes precedence in execution over admin-only P1 findings. Priority does not establish an incident's root cause.

| ID | Priority | What is wrong | Evidence status |
|---|---|---|---|
| UX-01 | P1 | Agents have a long, contradictory UI guide and no clear shared copy/interaction standard. | Confirmed; documentation consolidated in this change |
| UX-02 | P2 | Copy explains obvious actions, mixes terminology, and repeats instructions. The owner explicitly wants shorter text and no em dashes. | Owner feedback plus source examples |
| UX-03 | P2 | Checkout repeats global progress, pocket progress, totals, and status in several places. | Confirmed structure; density needs device review |
| UX-04 | P1 | Restock flags compete with blockers; Ready can be mistaken for fully stocked. | Confirmed presentation/policy mismatch risk |
| UX-05 | P2 | An optional event selection interrupts every selected pack's checkout. | Confirmed |
| UX-06 | P2 | Refresh/navigation discards a long check-off's in-progress work. | Confirmed state model |
| UX-07 | P2 | Used-item return adds a picker Continue step and another confirmation screen. | Confirmed; desirability needs user review |
| UX-08 | P1 investigate | Statpack 2 shows Band-Aids as low stock; no physical count has been supplied to validate the warning. | Reported concern, cause unverified |
| UX-09 | P1 | Default zero, unknown count, target quantity, and physical observation are not consistently distinguished. | Confirmed code/data-semantics conflict |
| UX-10 | P1 | Set to par can record a full pack without an explicit physical-count/refill assertion. | Confirmed behavior; misuse is a risk |
| UX-11 | P1 | Full-form usage summary subtracts from target, so an old shortage can be described as new usage. | Confirmed calculation |
| UX-12 | P1 | Stock labels omit reserve/shelf/pack scope; quantity and reorder threshold can use unclear units. | Confirmed |
| UX-13 | P1 | A stale shelf count can still produce a precise Restock N suggestion. | Confirmed |
| UX-14 | P2 | Received totals include deliveries whose inventory intake is still pending. | Confirmed |
| UX-15 | P3 monitor | The initial password-reset report is unconfirmed; the owner says the person may have selected Reset password. | No automatic reset path found; revisit on concrete/repeated evidence |
| UX-16 | P1 | Some failed reads look like empty results, zero activity, or an endless spinner. | Confirmed across remaining surfaces |
| UX-17 | P1 | Resolving a report does not establish that the incorrect stock record was corrected. | Confirmed workflow gap |
| UX-18 | P2 | Navigation differs by device/role, and assigned-pack cards send members to a restricted management screen. | Confirmed |
| UX-19 | P2 | Several interactive rows and icon controls lack complete keyboard/screen-reader behavior. | Confirmed |
| UX-20 | P2 | Calendar dates show only three events; the +N more label cannot open the hidden ones. | Confirmed |
| UX-21 | P3 | Certification warnings tell members to contact MedOps without a nearby contact/upload action. | Source-confirmed missing adjacent action; user impact unverified |
| UX-22 | P1 | The Exceptions success message claims more than the checks establish. | Confirmed |
| UX-23 | P2 | Print Labels silently drops selected records that fail to load. | Confirmed |
| UX-24 | P2 | Vehicle return can render before its checkout-reading baseline loads. | Confirmed race; real-world frequency unverified |
| UX-25 | P1 member focus | The first-use tour does not teach checkout, and checkout completion does not require explicit physical confirmation of every item's count/presence. | Source-confirmed gap against the owner's clarified requirement |

## 2. Fix each issue

### UX-01. One maintained standard

**Evidence:** the previous `.claude/commands/bmrc-ui.md` prescribed both sticky and non-sticky sidebars, both dashboard gradient and flat background, and universal headers despite distinct flow layouts. It copied large token/snippet sections instead of routing to current code. `app/components/ui/` already provides shared primitives.

**Change delivered:** one [shared standard](../ui-ux-standards.md), a short reusable skill, a compatible `/bmrc-ui` entrypoint, and references in `AGENTS.md` and `CLAUDE.md`. Separate ordinary pages, workspaces, dashboard, and guided flows. Keep domain decisions separate from presentation rules. Fix defects in primitives before spreading them.

**Done when:** both agents are routed to the same rules for reviews and new features; old instructions no longer conflict. This does not mean existing screens have been converted.

### UX-02. Short, useful copy

**Evidence:** check-off's restock instruction includes multiple sentences about logistics notification and Set to par ([check-off](../../app/statpacks/check-off/page.tsx#L1375)); the dashboard leads with a large Keep Us Safe appeal ([member dashboard](../../app/dashboard/member-dashboard.tsx#L318)). The owner reports unnecessary descriptions and em dashes.

**Proposed fix:** rewrite visible copy by task, starting with checkout. Remove repeated titles/explanations and developer-facing wording. Use sentence case, stable action names, explicit units, and no em dashes in authored app text. Keep safety explanations where they change a decision. Do not bulk-replace punctuation in user data or technical strings.

**Done when:** each sentence has a task-related purpose; optional help is disclosed; the same action has the same name across screens. Review before/after strings alongside the actual flow.

### UX-03. Simplify checkout hierarchy

**Evidence:** hero progress, percent, total/short/expiring counts, pocket shortcuts, accordion counts, and footer progress coexist ([check-off](../../app/statpacks/check-off/page.tsx#L1986), [footer](../../app/statpacks/check-off/page.tsx#L2234)).

**Proposed fix:** retain one global progress indicator, a compact required-check summary, and pocket-local progress where useful. Keep the physical pocket order. Remove duplicate metrics and hide secondary details. Keep the main action reachable without a tall summary stack.

**Done when:** an FTO can identify the pack, each item's quantity/physical confirmation, unfinished required checks, and next action without coaching on a phone after the first-use introduction. Physical verification stays explicit; density, one-handed controls, and sticky-footer overlap are checked at 360/390 px and enlarged text.

### UX-04. Separate readiness, shortages, and blockers

**Evidence:** shortages appear in hero chips, counts, a flag card, picker chips, and footer ([check-off](../../app/statpacks/check-off/page.tsx#L1948)). Partial shortages may intentionally retain Ready under [D-8](../../decisions.md#L99).

**Proposed fix:** show one compact `Restock follow-up` disclosure, separate from `Required before checkout`. Explain Ready through concise context, not a permanent paragraph. Show item, recorded quantity/target, and pocket in shortage details. A status badge must not imply an extra checkout gate.

**Done when:** a short pack remains checkout-eligible under existing policy. Expiry, oxygen, required checks, broken checkout seals, and maintenance handling keep their approved rules. A user can tell low from out and can see what the warning refers to.

### UX-05. Optional event without a mandatory detour

**Evidence:** selecting a pack opens the event picker before verification ([checkout](../../app/statpacks/checkout/page.tsx#L94)).

**Proposed fix:** move `Event (optional)` into the checkout flow as a secondary field/disclosure. Preserve selection and its saved event link. Do not guess an event or silently start/end a shift.

**Done when:** a member can choose a pack and start required checks directly. Event tagging remains available; failed event loads do not prevent an unlinked checkout.

### UX-06. Recover interrupted checks

**Evidence:** counts/checks/resolutions are component state; initialization reloads persisted values ([check-off](../../app/statpacks/check-off/page.tsx#L955), [initial counts](../../app/statpacks/check-off/page.tsx#L1085)).

**Proposed fix:** first preserve input during local retries. Add a small user/pack/mode/version-scoped draft if interruption is a common problem. Offer Resume/Discard and invalidate changed records. Revalidate safety checks rather than treating a restored check as fresh evidence.

**Done when:** a reload can recover eligible work without crossing users/packs/modes or overwriting intervening changes. Successful submission clears the draft; failed submission does not.

### UX-07. One meaningful return submission

**Evidence:** the used-item picker queues a separate review sheet ([check-off](../../app/statpacks/check-off/page.tsx#L1698)). No-use return already submits directly and preserves counts ([no-use path](../../app/statpacks/check-off/page.tsx#L1693)).

**Proposed fix:** combine picked quantities and final review when this removes repetition. Keep one explicit final submit and clear per-item quantities. Do not remove the existing no-use shortcut.

**Done when:** used items can be reviewed and returned with one deliberate final action; untouched counts stay unchanged and failures can be retried safely.

### UX-08. Reconcile the Statpack 2 report

**Known:** the owner currently sees Band-Aids marked low stock in the admin view. Physical presence is compatible with a below-target count. The owner suspects a mistaken earlier entry that nobody corrected, but has not supplied a physical count. Biweekly logistics checks are planned and have not started. The initial description mentioned none; the exact earlier screen/count is still unknown.

**Investigation:** identify the exact pack, item/variant, pocket, recorded count, target, warning, observation time, and deployed version. Compare a physical count with its create/import/edit/check-off history. Distinguish reserve inventory from pack contents. Imported/default zero or an unrecorded refill are plausible explanations, not findings about this incident.

**Proposed fix:** choose correction based on evidence. If a mismatch is confirmed and the existing count flow is insufficient, consider `Count differs` beside the exact entry, recording the observation and routing canonical correction through an authorized count flow. Do not assume the badge is wrong, auto-fill target, or mass-change historical zeros.

**Done when:** the discrepancy is explained or remains explicitly unresolved; a confirmed physical correction updates the correct entry and retains provenance. No production data was accessed or repaired in this audit.

### UX-09. Model what is known about counts

**Evidence:** added/imported contents initialize to zero ([editor](../../app/components/statpack-editor-modal.tsx#L286), [import](../../app/lib/statpack-import.ts#L180)). Check-off substitutes target when count is missing ([check-off](../../app/statpacks/check-off/page.tsx#L1085)); missing values are excluded from shortage chips ([helper](../../app/lib/statpack-shortages.ts#L28)) and untouched zero scanning ([writer](../../app/lib/inventory.ts#L707)).

**Proposed fix:** represent count provenance/verification explicitly. Separate expected contents, known count including zero, and uncounted entries. Prefer additive observation metadata where feasible; select the schema after review. Label assumed/default values honestly and require an explicit physical assertion before verification.

**Decision needed:** current comments/docs conflict about unknown-count readiness, especially quick return. Agree that policy and legacy-record treatment before changing behavior. The intentional zero-for-new-expected-item assumption must be reviewed, not silently reversed.

**Done when:** unknown never appears as measured zero/full target; true zero survives no-use return; two pockets retain independent counts; historical zero is not reinterpreted without evidence.

### UX-10. Make restock an explicit physical action

**Evidence:** Set to par writes the target into local count and marks restocked ([check-off](../../app/statpacks/check-off/page.tsx#L2132)); pack restock intentionally does not decrement a linked shelf/reserve record.

**Proposed fix:** use `Record restock` with an actual count after refill or an explicit `Physically refilled to N` assertion. Keep partial restock possible. Do not imply stock was moved automatically.

**Done when:** the user understands what physical action they attest to; arbitrary target fill is not a shortcut to dismiss a warning. No stock-transfer model is added without a separate decision.

### UX-11. Stop calling old shortages usage

**Evidence:** full-form review uses `requiredQuantity - found` ([check-off](../../app/statpacks/check-off/page.tsx#L1531)). Fast return starts from recorded current quantity ([picker](../../app/components/statpacks/checkin-used-picker.tsx#L53)).

**Proposed fix:** distinguish below-target shortage from a decrease since a known starting count. Use reported usage when explicitly supplied. Without a reliable baseline, show a count/shortage rather than inventing consumption; a decrease alone may not establish use.

**Done when:** target 10, start 3, end 2 is a shortage of 8 and a decrease of 1, not 8 newly used. Unknown baseline, refills, checkout, and audit do not generate false usage claims.

### UX-12. Name stock scope and units

**Evidence:** Inventory's Low Stock describes reserve ([status helper](../../app/lib/item-status.ts#L118), [badge](../../app/inventory/page.tsx#L1202)). Detail shows boxes beside `Reorder At` without the unit used by status math ([detail](../../app/inventory/page.tsx#L182)). Member report uses a generic saved `totalStockQuantity` with `Current Stock` ([report](../../app/member/report/page.tsx#L95), [label](../../app/member/report/page.tsx#L365)).

**Proposed fix:** use `Reserve low/out`, label `Reserve units`, show package breakdown and usable units together, and label thresholds in the same units. Identify shelf/pack scope explicitly. Reuse canonical stock/date helpers instead of legacy totals and ad hoc expiry scans, including the member dashboard's remaining expiry banner logic.

**Done when:** loose/bag/box and expired/quarantined fixtures agree across detail, inventory, report, and dashboard. A stocked pack and low reserve can coexist without contradictory wording. This does not change the two-pool model.

### UX-13. Count stale shelves before suggesting a deficit

**Evidence:** Restock N is calculated from saved shelf quantity even beside Shelf check due ([restock](../../app/restock/page.tsx#L138)).

**Proposed fix:** stale shelf rows offer `Count shelf`. Calculate a refill only after a current observation, with target and available reserve visible.

**Done when:** stale data produces no authoritative numeric refill suggestion; a new observation re-anchors the suggestion and existing transfer math still governs the write.

### UX-14. Separate delivery from intake everywhere

**Evidence:** rows correctly say Delivered, intake needed, while the top-level Received count includes that order ([buy-list panel](../../app/components/buy-list-panel.tsx#L69), [totals](../../app/components/buy-list-panel.tsx#L209)).

**Proposed fix:** call the delivery metric `Delivered` and track `Intake needed` separately. Reserve `In stock` for posted intake. Reuse the existing intake workflow.

**Done when:** a delivered-but-unposted order increases delivery/intake-needed counts and never claims its quantity is already available stock.

### UX-15. Monitor the unconfirmed password incident

**Evidence:** login only signs in ([login](../../app/login/page.tsx#L22)); password reset is explicitly user-selected ([forgot password](../../app/forgot-password/page.tsx#L17)). No automatic reset-enforcement, password-update, or reauthentication path was found in app source. Auth defaults were not tested, and backend/admin behavior was not inspected.

**Owner clarification:** the person may simply have pressed Reset password. There is no current evidence that this is an automatic reset requirement, and no account investigation is needed to proceed with member-checkout planning.

**If repeated:** collect exact screen/email wording, approximate time, and whether Forgot password was clicked. Distinguish sign-in failure, session expiry, missing profile, and actual reset requirement before considering account/provider investigation.

**Proposed follow-up:** retain the report as unconfirmed. Clear login errors/accessibility can be addressed when that screen is in scope; do not build a forced-reset fix without a verified trigger.

**Status:** monitor, outside the first member-checkout scope. User-requested reset remains available. No session/password policy change is proposed.

### UX-16. Failed reads must stay visible

**Evidence:** member report has no listener error UI ([report](../../app/member/report/page.tsx#L95)); asset load catches only log ([equipment](../../app/assets/checkout/page.tsx#L51)); report subscriptions lack full failure state ([reports](../../app/lib/reports.ts#L213)); history errors only stop loading ([history](../../app/history/page.tsx#L72)); roster failures can yield No members or zero shift totals ([roster](../../app/roster/page.tsx#L123)). Exceptions can spin indefinitely ([reconciliation](../../app/reconciliation/page.tsx#L113)); failed notification reads replace the list with empty ([notifications](../../app/lib/notifications.ts#L112)), concealing potential staffing alerts.

**Proposed fix:** extend the existing `LoadFailureNotice` pattern to these remaining surfaces, with independent loading/error/cache states and retry. Preserve known data with a stale notice. Keep unaffected sections usable.

**Done when:** denied/offline/failed requests never claim no equipment, no history, no members, zero shifts, or no reports. Successful empty results remain concise. Do not redo surfaces already repaired in the earlier plan.

### UX-17. Carry reports through source correction

**Evidence:** member reports save observations; Resolve only stamps report metadata ([resolution](../../app/issue-reports/page.tsx#L210)). Statpack selection in the member report is a name rather than a stable exact content-entry correction.

**Proposed fix:** attach pack/item/pocket identity where available; show the observation, current record, assigned follow-up, and source action. Separate `Resolved` from `Count corrected` or `Restocked`. Preserve cases legitimately resolved without changing stock, with a reason.

**Done when:** someone reporting a discrepancy can see what happens next, and admins can reach the correct source record without retyping. Closing a report never silently edits stock or claims it was verified.

### UX-18. Consistent destinations and member-safe links

**Evidence:** member desktop sidebar has Dashboard/Uniform Exchange while mobile exposes Shifts/History ([sidebar](../../app/components/app-sidebar.tsx#L81), [mobile](../../app/components/mobile-bottom-nav.tsx#L24)); member dashboard also hides the bottom nav ([layout](../../app/components/sidebar-layout.tsx#L34)). Assigned pack cards link to management ([card](../../app/dashboard/member-dashboard.tsx#L638)), which denies members ([management](../../app/statpacks/page.tsx#L598)).

**Proposed fix:** define destinations per role and expose equivalent tasks across devices. Point assigned packs to a member-safe detail/return route. Keep logistics gated and give MedOps/FTO the routes appropriate to their roles.

**Done when:** member checkout, return, shifts, history, profile, and reporting can be found without coaching; clicking an assigned pack never lands on Access Denied. Review dashboard navigation hiding with users before retaining it as a pattern.

### UX-19. Fix shared interaction semantics

**Evidence:** check-in picker rows are clickable divs ([picker](../../app/components/statpacks/checkin-used-picker.tsx#L170)); event cards have the same problem ([event list](../../app/components/events/event-list.tsx#L43)); shared `DataList` has clickable div rows ([primitive](../../app/components/ui/DataList.tsx#L47)); committee cards likewise lack a semantic opener ([board](../../app/committee-board/page.tsx#L151)). Apparel and board filters communicate selection only visually ([apparel](../../app/apparel/page.tsx#L370), [board toggles](../../app/committee-board/page.tsx#L608)). Login password visibility lacks an accessible name ([login](../../app/login/page.tsx#L75)); errors are not announced.

**Proposed fix:** use semantic selection/open controls without nesting buttons; name icon controls, retain focus, announce errors, and provide appropriate autofill semantics. Inspect primitives before reusing them widely. Review small touch hit areas, including Callout's dismiss button.

**Done when:** Tab and Enter/Space reach every action; selection and quantities are announced; touch hit areas fit a phone. Validate light/dark contrast and enlarged text in the changed surfaces.

### UX-20. Reach every calendar event

**Evidence:** dates render only three events followed by a noninteractive +N more label ([calendar](../../app/components/events/event-calendar.tsx#L151)).

**Proposed fix:** make the overflow control open all events for that date or a date-filtered list. Keep focus and selection predictable.

**Done when:** every event on a crowded day can be opened by keyboard and touch, including events beyond the first three.

### UX-21. Give certification recovery a destination

**Evidence:** profile warnings instruct members to send updated documents to MedOps without an adjacent action ([profile](../../app/profile/page.tsx#L307)).

**Proposed fix:** use the organization's existing approved contact/submission channel, with a link or concrete instruction. Do not introduce an upload/data-retention system merely to shorten a sentence.

**Done when:** a member with missing/expired certification knows where to submit it and what happens next; signup gating remains unchanged.

### UX-22. Make success claims match actual coverage

**Evidence:** Exceptions says every item has a location, expiration, and current audit ([page](../../app/reconciliation/page.tsx#L231)). The engine performs a bounded set of checks; expiry checks apply to stocked dated items ([engine](../../app/lib/reconciliation.ts#L98)).

**Proposed fix:** say `No tracked exceptions found` and name the checks performed. Distinguish incomplete data loads from a clean result. Apply the same rule to dashboard summaries and reports: an empty exception list is not a guarantee that all real equipment is correct.

**Done when:** non-expiring/no-date items do not cause an inaccurate all-items-have-expiration claim. Partial/failed checks cannot produce the clean result.

### UX-23. Disclose partial label selection

**Evidence:** per-ID print-label fetch errors are logged and omitted ([print labels](../../app/print-labels/page.tsx#L148)); all failures can look like no selection ([empty state](../../app/print-labels/page.tsx#L277)).

**Proposed fix:** show selected, loaded, and failed counts. Let the user retry or remove unavailable records and explicitly review a partial export before generating it.

**Done when:** one valid and one unavailable ID produce a clearly partial queue. All-failed reads show recovery, distinct from an intentionally empty selection.

### UX-24. Load vehicle return context before submission

**Evidence:** open checkout log fetch has no loading/error state ([vehicle check-off](../../app/vehicles/check-off/page.tsx#L86)); comparisons depend on that log while form readiness does not wait for it. The writer still rejects readings below checkout ([writer](../../app/lib/vehicles.ts#L292)), so this is a missing-context/save-error issue, not evidence of corrupt mileage.

**Proposed fix:** track baseline loading/error, show checkout readings with units, and hold return submission until the required baseline resolves. Keep entered return readings on retry.

**Done when:** a slow/failed checkout-log read shows a clear waiting/retry state; a user sees the comparison baseline before submitting. Existing transaction validation remains intact.

### UX-25. Teach checkout once and require physical verification each time

**Evidence:** the current tour's checkout step points at navigation and says to verify pockets ([tour step](../../app/lib/tutorial-tours.ts#L77)); account-level skip/finish marks the general tutorial complete ([controller](../../app/components/onboarding-tour.tsx#L76)). It does not teach the actual quantity controls. Checkout initializes counts from saved values ([initialization](../../app/statpacks/check-off/page.tsx#L1085)). Item readiness uses the verified set for simple items but safety fields for rule-bearing items ([readiness](../../app/statpacks/check-off/page.tsx#L162)); the final completion path gates on `fixList`, without requiring every physical-count/presence confirmation ([submit gate](../../app/statpacks/check-off/page.tsx#L1659)). Even simple-item verification is not itself a final completion gate.

**Proposed fix:** keep a short checkout-specific first-use introduction, replayable through Help. Explain how to identify the physical pack, check a pocket, count and confirm/correct its contents, complete equipment checks, and handle a shortage. The tutorial itself must not write stock or require a real checkout. Keep later checkouts compact. Require a deliberate physical confirmation for every applicable entry at checkout: quantity for consumables, presence plus the existing equipment checks for assets. Display stored counts as references, never already-confirmed observations. Do not add an all-items-confirmed shortcut. Keep approved sealed-content rules and nonblocking shortage eligibility unchanged.

**Done when:** first use teaches the actual controls; skipping/replaying the tutorial never skips physical verification or writes stock. Subsequent checkouts do not repeat the full introduction. A rule-bearing entry cannot bypass physical confirmation by completing its safety fields; a simple entry cannot be left unconfirmed while finishing. Adjusting a count and confirming it is clear on a phone and saves the observed value, including below-target counts. Asset presence is not represented by invented consumable quantities.

**Planning constraint:** existing seal exemptions must be mapped before finalizing entry-level confirmation behavior. Do not interpret the owner's general physical-check requirement as permission to break approved seal policy. Biweekly logistics auditing is a complementary planned process, not a replacement for checkout checks.

## 3. Planning scope and proposed implementation order

Current work stops at updating context, the issue list, standards, and the proposed flow. The sequence below organizes future review; it does not start implementation.

1. **Member phone-checkout proposal first:** UX-25, UX-02 through UX-05, and checkout-specific parts of UX-08/09/10/18/19. Specify tutorial behavior, essential item/quantity controls, confirmation/correction, shortage handling, and concise copy. Preserve approved safety and seal rules. Do not block this planning on the password incident or admin-only redesign.
2. **Review the proposed member journey:** walk through first use, repeat checkout, a differing physical count, a short pack, and required equipment checks. Define what is necessary versus disclosed or removed. Record remaining policy decisions and before/after examples without changing the application.
3. **Future member implementation, only when requested:** take the reviewed checkout scope in small batches. Include relevant count-truth, navigation, semantic-control, and load-failure fixes so the member journey works as a whole. Count enforcement is distinct from tightening shortage eligibility.
4. **Later member follow-up:** return simplification (UX-07), interruption recovery if warranted (UX-06), and other member destinations/errors (UX-16/18/19/20/21/24). A slow or lost-connection case remains worth checking, but offline architecture is not the priority on reliable eduroam.
5. **Later admin/logistics backlog:** UX-11 through UX-14, admin report correction, reconciliation, print labels, and other admin-only issues. Retain the findings rather than requiring admins to solve them before member checkout improves. The biweekly physical audit rollout is an operational follow-up, not an implemented safeguard.

### Proposed member checkout outline for review

1. Select the physical pack. Offer event tagging as optional context without a separate mandatory interruption.
2. On first use, offer a short introduction to the actual checkout controls. Keep it replayable; normal repeat use opens the task directly.
3. Work pocket by pocket. Show item identity, target and unit, saved count as a reference, a clear observed count/confirmation action, and any required equipment fields. Make controls practical with one hand; preserve physical pocket order and approved sealed-content handling.
4. If the physical count differs, enter and confirm the observed count. Do not require the member to restock to target to make a warning disappear. Preserve below-target checkout eligibility and clearly separate follow-up from blockers.
5. Show one compact completion summary and one final checkout action. Unconfirmed applicable entries and existing unresolved required checks lead directly to the relevant item. Save observed counts and ownership through the existing authorized write path.

Illustrative copy for the later design review: `Count in bag`, `Recorded: 3`, `Target: 10`, `Counted: 5`, `Confirm count`, `Restock needed. Checkout allowed.`, and `How checkout works`. These are examples, not final button or form specifications. Avoid permanently repeating the tutorial instructions beside every item.

Acceptance scenarios for that proposal: an FTO checks out on a 390 px phone with one hand; a new app user can learn without a real stock write; a returning user sees no repeated full tour; recorded 3 versus physically counted 5 saves 5, not target 10; a below-target count stays eligible under D-8; an untouched or unconfirmed applicable entry cannot silently count as checked; required equipment and seal checks keep their approved handling.

Use lower-cost implementation agents for bounded tasks with non-overlapping files. Keep cross-file integration and count/permission review with the primary agent. Do not make separate agents concurrently edit the shared check-off page. Keep this issue list and standards current with each approved batch.

For implementation, follow existing checks: touched-code lint/typecheck, production build and relevant tests before claiming completion; stock-writer/helper changes also need the applicable invariant/property checks. Runtime checks use emulator fixtures and the repository's smoke-test timing rules. Source review, emulator behavior, deployed version, and natural real-user observation are distinct evidence.

## 4. Coverage and pending evidence

| Area | Current coverage | Remaining evidence |
|---|---|---|
| Auth/account recovery | Login, registration, reset, session/profile source paths | Monitor only unless repeated/concrete forced-reset evidence appears |
| Member packs | Checkout, full check-off, quick return, counts, reports, assigned links, navigation tour and physical-confirmation gates | First-use/repeat-use phone and one-handed walkthrough; Statpack 2 physical count/history; sealed-entry mapping |
| Inventory operations | Stock math/labels, audit context, receiving, shelf refill, buy-list intake, reports | Real task observation and mixed-unit fixtures |
| Events/FTO/MedOps | Signup/attendance safeguards, roster, history, calendar/list, certification warnings | Role-by-role task walkthrough, including FTO intern; crowded calendar fixture |
| Shared UI/navigation | Existing guide, primitives, panels, desktop/mobile role navigation | Visual consistency, focus, keyboard viewport, contrast, enlarged text |
| Other routes | Vehicles, apparel, committee/tasks, stats, storage/settings, reconciliation and print-label breadth sweep | Vehicle latency, partial label selection, inventory-helper permissions, accessibility walkthrough; deeper settings/stats task review |

The six clarification questions have been answered and incorporated in Confirmed direction above. No more broad clarification is needed to continue checkout planning. The first natural-work review should involve an experienced FTO using a phone and a person learning the app: identify a pack, physically check quantities, correct a differing count, understand a shortage, and complete checkout without coaching. Capture one-handed friction as well as excess reading. Later reviews can cover return, shifts, and admin supply work. These observations have not yet taken place; do not present source findings as measured user failure or infer broad dissatisfaction from one logistics member's design impression.

### Decisions before affected implementation

- Unknown-count readiness and treatment of existing default-zero records (UX-09).
- How entry-level physical confirmation respects the existing sealed-content rules (UX-25).
- Which existing channel members should use for certification updates (UX-21).
- Whether interrupted draft recovery is needed frequently enough to justify persistence (UX-06).
- Exact physical/recorded count and stock scope behind the Band-Aid report. This affects any incident repair, not the ability to continue UX planning.

The password report is no longer a planning blocker. Existing eligibility policy remains in place. The decisions above do not prevent documenting copy, hierarchy, tutorial, semantic-control, and clear error-state proposals now. No production count repair or application implementation is authorized by this plan update.

## 5. Documentation verification

Local link targets, skill frontmatter, and the issue-to-fix mappings were checked. The plan now has 25 issues, including the checkout tutorial/physical-confirmation gap added after the owner's answers. The skill also received an independent lower-cost agent review using a realistic feature request; a lower-cost source review checked the tutorial and confirmation gates. The bundled skill validator could not start because this environment lacks PyYAML; YAML parsing and required-field checks were performed separately. No application tests/build were needed for these documentation-only edits. Runtime and natural-work validation remain pending as listed above.
