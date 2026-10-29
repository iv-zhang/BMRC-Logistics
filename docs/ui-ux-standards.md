# UI and UX standards

Applies to existing screens, fixes, and new features in BMRC Logistics. Shared by Codex, Claude Code, and human reviewers. Updated 2026-10-22 from the owner's request for consistent interactions, shorter copy, and less clutter.

## Purpose and authority

Help volunteers finish real tasks and understand what the app knows. Keep the existing brand, HeroUI components, theme, and domain rules. These standards govern presentation and interaction; they do not authorize a change to checkout, attendance, permissions, or stock policy.

Use this document for UI decisions. Read [CLAUDE.md](../CLAUDE.md) for workflow and architecture, [decisions.md](../decisions.md) for domain policy, and [invariants.md](../invariants.md) before changing stock behavior. If those sources disagree, record the conflict and resolve it before changing that behavior. Existing UI is implementation evidence, not an automatic standard to copy.

## Confirmed users and checkout purpose

The owner confirmed these priorities on 2026-10-22:

- Prioritize members checking out gear. Admin/logistics improvements can follow; those users can currently work around problems.
- Design first for phones, usually used by experienced FTOs on reliable eduroam. Support occasional one-handed use. Do not assume an emergency or a rushed checkout.
- Give new users a short first-use tutorial, with a simple everyday flow and help they can reopen. Being an experienced FTO does not mean knowing this app.
- Checkout is a physical check of bag contents and quantities. Simplification must preserve that check each checkout. A previously saved count is a reference, not proof that the item is present now.
- Logistics intends to check packs biweekly, but those checks have not started. Do not describe that process as active or rely on it to replace member verification.
- Treat the Band-Aid warning as a count needing physical validation. A mistaken prior entry is possible but unconfirmed. Manual counting and correction must remain possible.

Shorter copy and fewer repeated steps should make physical verification easier. Do not optimize for fewer checks, a bulk acceptance of stored quantities, or a tutorial that adds repeated work to every checkout. The owner has requested documentation/context updates only for the current task; the audit's proposed product fixes are not approved implementation.

## Decide what belongs on a screen

Before adding a field, sentence, badge, banner, or step, answer:

1. What task is this person doing, in this role?
2. Does this information change their next action or prevent a likely mistake?
3. Is it already visible elsewhere in this view?
4. Could it appear only when relevant, or under Details?

Show the task, essential context, required inputs, actionable blockers, and primary action. Show helpful instructions beside the relevant control. Put history, rationale, secondary metrics, and uncommon options behind a named disclosure. Remove copy that only restates the title, label, status, or obvious next step.

Do not add a subtitle, stat row, warning, review screen, or confirmation just to fill a template. Never hide a safety requirement to make a screen shorter. Several independent blockers can remain visible; group them in one actionable list instead of suppressing them to meet an arbitrary banner limit.

## Writing

- Use plain, direct English and sentence case. Prefer familiar verbs: Save, Count, Check out, Check in, Report issue, Retry.
- Do not use em dashes in authored app copy. Use a period, colon, parentheses, or a separate label. Do not change user-entered text or technical identifiers to enforce this rule.
- Button labels name the action. Prefer `Check in pack` to `Confirm`, `Proceed`, or `Yes` when the destination or consequence is otherwise unclear.
- A label is usually 1 to 4 words. Helper text is usually one short sentence. These are editing targets, not reasons to omit a necessary safety explanation.
- Give an instruction only when the action, meaning, unit, or consequence would otherwise be unclear. Avoid marketing copy, moral appeals, congratulations, repeated reassurance, and developer commentary.
- State the problem and recovery: `Could not load packs. Retry.` Preserve entered data when retrying.
- State success only after the corresponding operation succeeds. Distinguish a saved return from a failed follow-up task. Keep a persistent next step when action is still needed.
- Use explicit units and scope: `Recorded in pack: 3 bandages`, `Target: 10`, `Reserve: 40 units`. Avoid an unexplained `Stock: 0`.

| Situation | Prefer | Avoid |
|---|---|---|
| Optional event | `Event (optional)` | A paragraph explaining why an event can be selected |
| Short pack | `3 of 10 recorded. Restock needed.` | `No Band-Aids` when the record says 3 |
| Unverified count | `Not counted` | An invented zero or target quantity presented as observed stock |
| Nonblocking shortage | `2 restock flags. Checkout allowed.` | Repeating the same warning in multiple large cards |
| Required check | `Enter oxygen pressure (PSI)` | `Please ensure that you carefully verify...` |
| Physical refill | `Record restock` with `Count after restock` | `Set to par` without a clear physical meaning |
| Empty history | `No activity yet` after a successful empty read | The same message after a failed read |

## Shared vocabulary and data claims

| Term | Meaning |
|---|---|
| Check out / Check in | Actions; use `checkout` / `check-in` as nouns where needed |
| Recorded count | Saved count, not a guarantee about the physical pack now |
| Target | Desired quantity; `par` can be retained in admin contexts with a clear label |
| Low | A known positive count below the target |
| Out | A known zero count |
| Not counted | No trustworthy observation; distinct from low, out, and full |
| Ready | Existing operational status under D-8; does not guarantee every item is at target |
| Restock flag | Follow-up shortage; does not itself block eligible pack checkout |
| Reported / Resolved | Issue workflow state; does not by itself prove source stock was corrected |

Use the same term for the same action across navigation, forms, dialogs, and results. Keep item size, pocket, compartment, or serial visible when needed to distinguish entries. Separate pack counts, front-shelf observations, and back reserve. Use existing canonical helpers rather than copying quantity or status calculations.

Never replace unknown data with zero or target and call it observed. A default is not a physical count. Do not mark an item verified just because a form was opened or submitted. Show observation time/source where available and useful; do not invent it for legacy records. Unknown-count readiness and legacy-zero migration remain policy decisions in the audit plan, not changes approved by this document.

## Interaction patterns

- Give each view or task section one clear primary action. Keep secondary actions visually quieter.
- Optional information should not require its own blocking modal before required work. Preserve event tagging as optional.
- Confirm actions when the consequence needs a deliberate decision, such as deletion or replacing unsaved work. Do not repeat a review that adds no information. A final deliberate submit still matters for stock and ownership writes.
- Keep pocket-based pack work aligned with the physical pack. Do not reorder it into a forced safety-first wizard. Make unresolved required checks easy to reach from a compact summary.
- In member checkout, keep item identity, quantity/unit, target, and the physical confirmation/correction action clear. A stored number must not be silently accepted as a new observation. Preserve the existing approved treatment of sealed contents; do not invent new seal exemptions.
- Separate `Required before checkout` from `Restock follow-up`. Preserve expiry, oxygen, required equipment/seal checks, maintenance exclusions, and existing role rules. Shortages remain nonblocking under D-8.
- Keep the no-use return short. It preserves prior counts; it is not a fresh physical verification of every item.
- For long tasks, preserve input on errors. If adding drafts, scope them to user, pack, mode, and record version; recheck freshness before restoring or submitting. Do not restore stale safety confirmations as newly verified checks.
- Every disabled action that needs user intervention has a nearby reason and a reachable next step. A tooltip alone is insufficient on a phone.
- After completion, show the saved outcome and a useful destination. Do not send a member to a management page they cannot access.

## First-use tutorial and repeat use

Keep navigation orientation separate from task instruction. A checkout tutorial should briefly explain choosing the physical pack, checking each pocket's contents and quantities, correcting a differing count, handling a shortage, and submitting. Point at the controls actually available to the user's role and viewport. Do not require a real checkout or stock write to finish a tutorial.

Make the introduction dismissible and replayable. Skipping the tutorial does not skip checkout checks. After first use, keep ordinary instructions short and show help only where requested or needed to explain a specific condition. Do not replay the full tour every shift. The exact format and completion tracking remain part of the proposed checkout design, not an implemented feature.

## Components and layout

Reuse [shared UI components](../app/components/ui/index.ts), HeroUI, Lucide, and the live [theme configuration](../tailwind.config.ts). Do not copy theme values into this document or add a second visual system. Prefer the existing spacing scale and semantic tokens. A shared component still needs review if it has a usability defect.

| Need | Use |
|---|---|
| Ordinary page | `PageShell`, `PageHeader`; subtitle and stats only when useful |
| Inventory/stats workspace | Existing fixed-height desktop shell; preserve its single content scroll region |
| Dashboard | Existing compact dashboard shell; do not force the document-page header onto it |
| Guided pack workflow | Narrow responsive flow with reachable actions and pocket context |
| Working detail/edit panel | `PanelShell`; respect the user's panel preference and D-25 exceptions |
| One-time confirmation or small form | `ResponsiveModal`; size it to the task |
| Empty result | `EmptyState` with a useful next action, when one exists |
| Notice or recovery | `Callout` or `LoadFailureNotice`, chosen for the actual state |
| Shared list or metrics | `DataList`, `StatRow`, `SectionCard`; first check semantic interaction and fit |

Use one bordered surface per region, with insets or dividers inside it. Avoid turning every value into a card or badge. Color reinforces a text meaning: warning for low/expiring or follow-up; danger for out/expired/blocked conditions; success for confirmed success. A red stock badge must not imply a checkout gate that does not exist. Do not use color alone.

On inventory desktop, keep the filter sidebar short and the list/table body as the primary scroll area. On mobile, use unified page scroll and collapsible filters. Preserve the existing `sm` navigation switch and `md` workspace changes rather than inventing new breakpoints. A dashboard, workspace, and guided flow may have different widths because their tasks differ.

## Required states and accessibility

Distinguish loading, successful empty results, load failure, cached/offline data, and stale observations. Keep failures local when only one section failed. A failed history or roster request must not render factual zeros or `No activity yet`. A retry must not discard unrelated input or duplicate a successful write.

Use semantic buttons, links, checkboxes, and inputs. Clickable divs are insufficient. Provide accessible names for icon controls, visible keyboard focus, meaningful field labels and units, and announced errors/results. Keep critical details available on touch and keyboard, not only hover.

Check phone widths around 360 to 390 px, desktop, enlarged text, light/dark themes, and the on-screen keyboard. Aim for 44 px touch hit areas on primary phone controls without making the content bulky. Sticky actions must not cover the final input or compete with bottom navigation.

## Review every UI change

Before implementation, record the user task, necessary information, shared pattern, and state/permission implications. For a new feature, explain which real task it removes or improves before adding another destination.

Before handoff, check copy, duplicated information, status truth, keyboard/touch access, responsive layout, and recovery in the changed flow. Add focused behavior tests when data or workflow changes warrant them. Follow the repository's verification tiers; documentation-only edits do not need an app build. Report source review separately from runtime or real-user validation.

Keep these standards current when a product decision changes. Update the shared rule and its entrypoints together, rather than adding another competing guide. Existing screens are improved in scoped batches from the [audit plan](plans/2026-10-22-ui-ux-audit-and-plan.md).
