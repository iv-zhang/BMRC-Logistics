---
name: bmrc-ui
description: Apply BMRC Logistics UI, UX, and writing standards when reviewing or changing screens, components, navigation, forms, user-facing copy, or new feature flows.
---

# BMRC UI and UX

Read [the shared standards](../../../docs/ui-ux-standards.md) before UI work. This is the same source for Codex and Claude Code. Do not recreate its rules in another skill or copy an existing screen without checking them.

Use its Confirmed users and checkout purpose section for the owner's context: member phones first, usually experienced FTOs, first-use instruction, and physical verification of bag contents and quantities every checkout. Planned biweekly logistics checks are not active safeguards. Keep documentation-only requests separate from future implementation.

For the requested surface:

1. Identify the role, task, essential information, and next action. Remove repeated explanations, metrics, warnings, and steps that add no decision value. Keep required safety information.
2. Choose the existing component and layout family from the standards. Inspect only the relevant implementation. Use live theme tokens and shared primitives; preserve documented workspace and panel exceptions.
3. Write short, direct app copy with consistent terms and no em dashes. Use explicit units and distinguish recorded stock, physical observations, targets, and unknown values.
4. Check loading, empty, failure, cached, partial-success, and interruption states that apply. Preserve role permissions and domain policy from CLAUDE.md and decisions.md. A UI cleanup does not authorize data migrations or policy changes.
5. Review the changed flow on phone/desktop and keyboard/touch when implementation is in scope. Follow the repository's verification tiers and state what was actually verified.

For an audit, list issues before fixes. Cite current code or observed behavior, distinguish confirmed problems from hypotheses, and give a small proposed fix with acceptance criteria. Use [the current audit plan](../../../docs/plans/2026-10-22-ui-ux-audit-and-plan.md) to avoid duplicating completed work.

Read relevant domain skills only when the task touches their behavior. For stock/status use `bmrc-domain`; for pack workflows use `bmrc-statpack-flows`; for events use `bmrc-events`. If old guidance conflicts with current domain decisions, record the conflict instead of silently changing policy.
