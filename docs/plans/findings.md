# Platform overhaul: open findings

Companion to [platform-overhaul.md](platform-overhaul.md). **Read only your branch's section.**

Rules (O maintains this file):
- Each finding lives in **one** place: here under the branch that will act on it, in plan §10 if no branch owns it
  yet, or in plan §8 if it needs the user's decision.
- **Fixed → delete the line** (git history keeps it). **Resolved into a real decision → move it to `decisions.md`**
  and delete it here.
- Format: `- date · finding · action (packet)`. No member PII.

## feat/inventory-hygiene

- 2026-09-30 · Once unverified items are excluded, `/reconciliation` goes quiet until items are re-audited after
  2026-06-01. · Build the H5 Unverified queue **before this branch merges**; H-seam adds "N unverified not shown".
- 2026-09-30 · `/audit` low/expired chips still count unverified items. `useAuditTaskCards.ts`, the `/audit` header and
  other pages still call `isAuditedThisMonth`, so they stay monthly whatever the cadence setting. · Switch to
  `isAuditCurrent` (H-seam).
- 2026-09-30 · Retire is one-way (no restore helper), so "Found it" on a retired item has nothing to call. · Add a
  restore helper (H5).
- 2026-09-30 · `parseLegacyName` only splits on `()`, the last comma, or ` - `, so `NPA 28 Fr` gets no variant; the fuzzy
  matcher misses `NPA 28 Fr` vs `NPA, 28 French`. · Split on `variantSignature` tokens (H3/H6).
- 2026-09-30 · `additemmodal.tsx` duplicate suggestions have the same cross-size false positives (suggestion-only, not
  fixed). · Use `variantsMatch` (H6).
- 2026-09-30 · The v2 packet text for H3–H7 isn't in this repo (not in git history either); only the §1 summary exists. ·
  Wave-2 agents work from §1; O expands a packet there before launch if the summary is too thin.

## feat/roles-access

- 2026-09-30 · Stopgap gaps: every signed-in user (including self-registered strangers) can read all user docs and
  read/write every other collection; anyone signed in can write the published `dashboards` doc. Comments in
  `app/hooks/useStatsData.ts`, `app/stats/page.tsx`, `app/lib/dashboards.ts` claiming "role-gated by firestore.rules"
  are false until R4. · R4 (+ S-D1).
- 2026-09-30 · Treasurer can't be assigned yet: missing from roster `ROLE_OPTIONS`; `getRoleColor`
  (`profile/page.tsx`) and `tourRoleFor` fall through to member; no treasurer in test identities or emulator logins. · R3.
- 2026-09-30 · Left unconverted on purpose in R2: medops event-manager gates; three-role checks that include
  `inventory_helper` (`member-dashboard.tsx:397,430`, `assets/page.tsx:1011`); `AUDIT_ROLES`; admin-only checks.
  `isAdmin`/`isRealAdmin` in `profile/page.tsx` and `mobile-bottom-nav.tsx` mean "real account is admin/QM". · Revisit
  in R3.
- 2026-09-30 · `canManageEvents` (`roles.ts`) duplicates `isEventManagerRole` (`events.ts` imports Firebase, so
  `roles.ts` can't import it); a test asserts they agree. · `events.ts` re-exports from `roles.ts` (R-seam).

## feat/ui-system

- 2026-09-30 · The user-level `bmrc-ui` skill is stale (claims the dashboard has no gradient; wrong font/tokens; the repo
  uses `--font-hanken-grotesk`). Anti-clutter rules are drafted in the branch log. · Update the skill (U-seam).
- 2026-09-30 · `/inventory` uses `alert()`/`confirm()`; merge/delete dialogs aren't full-screen on phones. ·
  `ResponsiveModal` (U3).
- 2026-09-30 · Float `toFixed(2)` money formatting in `purchase-modal.tsx`, `statpack-widget.tsx`,
  `statpack-editor-modal.tsx`, `purchase-history.tsx`, plus a separate formatter in `app/lib/stats/shared.ts`. ·
  `MoneyText`/`formatCents` (U3, or P4 for purchase files).

## feat/purchases-budget

- 2026-09-30 · `/settings` has no editor for `privateFinanceRoles` (the value already round-trips). · P6.

## feat/assets-expiry · feat/uniforms

None yet.
