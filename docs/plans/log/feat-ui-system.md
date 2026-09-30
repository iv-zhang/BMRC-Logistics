# Log: feat/ui-system

## Packets done
- U1 primitives in `app/components/ui/` (PageShell, PageHeader, StatRow, SectionCard, Callout, EmptyState, ResponsiveModal, DataList, MoneyText/formatCents) · a980c8d (+ 9b01e34 log) · tsc 0 errors in `app/components/ui` (5 known o2 errors), eslint pass, `npm run build` pass (emulator-env); not runtime-verified, no page uses them yet

## Open questions
- Touch targets: `Callout` dismiss (28px) and `ResponsiveModalFooter` buttons follow inventory/HeroUI sizing, but the skill demands 44px on phone surfaces. Enlarge in U1?
- `SectionCard variant="stripe"` hard-codes `rounded-[18px]` and `text-[14.5px] font-bold` to match the dashboard (arbitrary values the skill otherwise bans).
- `MoneyText` assumes USD / en-US.

## Unfolded findings
- Dashboard header is `bg-content1/60` (skill says `/80`); `/inventory` header is a bare `<h1>` with no stats row. (U3)

### Anti-clutter rules (for the `bmrc-ui` skill)

The skill is **not in this repo** (`.claude/skills/` has no `bmrc-ui`; it is a user-level skill), so I did not edit it. Text to paste into the skill when O/user ports it:

1. Use the primitives; do not hand-roll a header, stat line, empty state, banner, list wrapper or money string.
2. One primary action per view. Everything else is `bordered` or `light`.
3. One bordered surface per region. A card contains insets (`bg-content2`) or dividers, never another bordered card.
4. At most one banner (`Callout`) visible at once per page; dismissible unless it blocks an action.
5. Page header shows at most ~4 stats; color only a stat that needs attention.
6. Unknown is `—`, never `0` / `$0.00` (`MoneyText`, stats).
7. Empty lists use `EmptyState` with a next step, not a blank area.
8. Dialogs: title, body, at most two footer buttons. Anything bigger is a page or a `PanelShell` drawer.
9. Tailwind classes must be full literals (no `bg-${tone}`).

