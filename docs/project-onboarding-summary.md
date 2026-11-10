# Project summary for Lang and new contributors

Planning brief, 2026-10-22. Current scope is documentation and design planning. Product changes below are proposed, not implemented by this update.

## Goal of the app

- Give BMRC one place to check gear out/in, track pack contents and supply needs, and coordinate shifts and related member records.
- Make member gear checkout straightforward on a phone. The person checking out a pack should physically verify what is in the bag and its quantities.
- Help logistics identify and correct missing, expired, or incorrectly recorded supplies, without treating a saved number as guaranteed physical stock.
- Current priority: member checkout, usually performed by an experienced FTO. Admin/logistics improvements can follow.

## What needs to change or be fixed

- Simplify checkout: remove repeated progress indicators, duplicate warnings, unnecessary descriptions, and optional steps that interrupt required work.
- Standardize screens and wording: use shared components, consistent action names, short instructions, and no em dashes in authored app copy. The shared standards are already drafted; adoption across screens remains.
- Require explicit physical confirmation during checkout. The current completion gate does not require confirmation of every applicable item's quantity/presence, even though this is the intended purpose of checkout.
- Make counts trustworthy: distinguish saved count, actual observed count, target quantity, and unknown data. Make it easy to confirm or correct the physical count without simply setting it to target.
- Separate shortages from checkout blockers. A below-target count should remain visible without changing the existing policy that allows eligible short packs to check out. Preserve required safety and seal checks.
- Improve phone and occasional one-handed use: reachable quantity controls, readable labels, clear actions, and no footer/input overlap.
- Fix member-facing navigation and recovery problems, including assigned-pack links that lead to a restricted management page and load failures that look like empty data.
- Validate Statpack 2's Band-Aid count manually before choosing a data fix. A wrong earlier entry is possible, but the current low-stock warning has not been proven wrong.
- Treat the password-reset story as unconfirmed. The person may have selected Reset password; no automatic forced-reset path was found in the app source.

## What needs to be added or strengthened

- A short checkout-specific first-use tutorial that teaches the actual quantity and verification controls. The existing tour mainly explains navigation. Keep help replayable and repeat checkout simple.
- Clear count confirmation/correction and follow-up when physical stock differs from the record. Start with the existing count/report flows before proposing another system.
- Useful verification history, such as when/by whom an entry was physically counted, where existing data is insufficient. Exact metadata/schema is still a planning decision.
- A focused member-phone validation pass covering first use, repeat use, differing counts, shortages, equipment checks, and one-handed operation.
- Roll out the planned biweekly logistics checks. This is an operational process that has not started, not a reason to build a duplicate audit system or remove member checkout checks.
- Later: address the admin/logistics backlog, including stock-unit labels, stale shelf suggestions, delivery versus intake wording, inaccurate usage summaries, and report-to-correction follow-up.

## References for the team

- [UI/UX audit and plan](plans/2026-10-22-ui-ux-audit-and-plan.md): 25 issues, evidence, proposed fixes, and member-first scope.
- [Shared UI/UX standards](ui-ux-standards.md): necessary information, writing, interactions, and reuse rules for both Codex and Claude Code.
- [Tech stack and production gaps](tech-stack-and-gaps.md): architecture and separate engineering-readiness backlog; deployment/console claims need their own verification.
- [Repository workflow](../CLAUDE.md): plan/review before implementation, safe testing, and commit/PR expectations.

Agree on the member checkout proposal before assigning implementation. Use the existing app and domain rules as context; this is an improvement project, not a rewrite.
