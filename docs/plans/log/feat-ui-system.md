# Log: feat/ui-system

Plan: `docs/plans/platform-overhaul.md` §6 (on `plan/platform-overhaul`). Packet in scope: **U1 only** (primitives). No existing page migrated (that is U3).

## U1: primitives in `app/components/ui/`

Extracted from `/inventory` (`app/inventory/page.tsx`) and `/dashboard` (`app/dashboard/page.tsx`). HeroUI + Tailwind 4 + lucide-react. Theme tokens only (no hex), both themes, phone-safe. Import from the barrel: `import { PageShell, ... } from '@/app/components/ui'`.

| Component | Props | Notes |
|---|---|---|
| `PageShell` | `children`, `fixedHeight?`, `loading?`, `maxWidthClassName?='max-w-7xl'`, `className?` | Gradient wrapper + `max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8`. `fixedHeight` adds the inventory rule (`md:h-screen md:overflow-hidden`, inner `md:pb-3 md:h-full md:min-h-0`); caller makes exactly one descendant `md:overflow-y-auto`. `loading` renders gradient + spinner. Also exports `PAGE_GRADIENT`. |
| `PageHeader` | `title`, `subtitle?` (node, usually `StatRow`), `actions?`, `className?` | `text-2xl font-semibold` title, `mb-6`, `flex-wrap` so actions wrap on phones. |
| `StatRow` | `items: {key,value,label,tone?}[]`, `variant?='plain'\|'boxes'`, `className?` | `tone`: `default\|success\|warning\|danger\|primary`. `plain` = dot-separated inline stats; `boxes` = tinted boxes with colored square. All tone classes are spelled out as literals (Tailwind cannot see `bg-${tone}`). |
| `SectionCard` | `title?`, `action?`, `variant?='card'\|'stripe'`, `maxBodyHeight?`, `dense?`, `padding?='md'\|'sm'\|'none'`, `className?` | `card` = `bg-content1 border-divider rounded-large`. `stripe` = dashboard card (`rounded-[18px]`, `bg-content2` header, shadow). `maxBodyHeight` adds `overflow-y-auto` + cap. `dense` = 11px uppercase label (sidebar groups). |
| `Callout` | `tone?='info'\|'success'\|'warning'\|'danger'`, `children`, `actions?`, `onDismiss?`, `icon?` | The duplicates/"on the way"/selection banners. Dismiss button is 28px (matches inventory); see open questions on the 44px floor. |
| `EmptyState` | `title`, `description?`, `icon?`, `action?`, `variant?='dashed'\|'plain'` | Matches the inventory "No items match" card. |
| `ResponsiveModal` (+ `ResponsiveModalFooter`) | `isOpen`, `onClose`, `title?`, `children`, `footer?`, `size?='lg'`, `scrollBehavior?='inside'`, `mobileFullScreen?=true`, `className?` | Wraps HeroUI `Modal` (same pieces `/inventory` uses for merge/delete). Below `md` goes full-screen (same `max-md:` classes as `PanelShell`). `ResponsiveModalFooter`: Cancel (bordered) + Confirm (primary/danger), `isConfirmDisabled`, `isConfirmLoading`. Not a replacement for `PanelShell` (drawer/center preference pop-outs). |
| `DataList<T>` | `items`, `getKey`, `renderItem`, `onItemClick?`, `variant?='divided'\|'cards'`, `empty?`, `className?` | `divided` = one bordered wrapper with `divide-y`; `cards` = separate hoverable bordered cards. Owns the empty state. |
| `MoneyText` / `formatCents` | `cents: number\|null\|undefined`, `signed?`, `className?` | Integer cents in. `null`/`undefined`/non-finite renders `—` (muted), never `$0.00`. Rounds non-integers to the nearest cent; normalizes `-0`. `font-mono tabular-nums`. `signed` colors negative danger / positive success. |

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

## Verification

- `npx tsc --noEmit`: **5 errors, all pre-existing, all in `app/lib/__tests__/o2-*.test.ts`** (`vitest` not installed). **0 errors in `app/components/ui`.** (Baseline not re-run on a clean tree; the errors are in files this branch does not touch.)
- `npx eslint app/components/ui`: **pass** (exit 0, no output).
- `npm run build`: see "Build" entry below.
- Not runtime-verified: the smoke driver was not run (per CLAUDE.md tier rules) and no page renders these yet. Visual/dark-mode/phone checks are untested.
- `npm install` was needed in the worktree (no `node_modules`); it did not modify tracked files.

## Open questions

1. `bmrc-ui` skill is outside the repo: who ports the docs above? (Skill text is also stale, see findings.)
2. Touch targets: `Callout` dismiss (28px) and `ResponsiveModalFooter` buttons follow inventory/HeroUI sizing; the skill demands 44px on phone surfaces. Kept canonical look for now; say if U1 should enlarge.
3. `SectionCard variant="stripe"` hard-codes `rounded-[18px]` and `text-[14.5px] font-bold` to match the dashboard; both are arbitrary values the skill otherwise bans outside the dashboard.
4. `MoneyText` assumes USD / en-US.

## Dead-file candidates (reported only; nothing deleted)

| File | Evidence | Verdict |
|---|---|---|
| `app/components/tutorial-overlay.tsx` | Only self-references (its own interface/default export); no importer anywhere in `app/` or `scripts/`. CLAUDE.md says `onboarding-tour.tsx` "replaces the old `tutorial-overlay.tsx`". | Dead. |
| `app/components/statpack-import-modal.tsx.new` | Not importable (`.new` extension). Differs from `statpack-import-modal.tsx` only by a trailing newline (192 vs 191 lines). Added in commit 129f7ec "asset maangement changes". The real `.tsx` is imported by `app/statpacks/page.tsx:33`. | Dead duplicate. |
| `app/fix-timestamps/page.tsx` (route `/fix-timestamps`) | No link/navigation references to the route in `app/`. BUT `app/lib/fix-timestamps.ts` is used by `statpack-history.tsx` and `log-timeline.tsx`, so the lib must stay. The page is a one-off admin repair tool (role-checked). | Probably dead page; keep the lib. Needs your call on whether the repair is still needed. |

## Findings for U3 (noticed, not touched)

- **Skill vs reality:** the `bmrc-ui` skill says the dashboard uses `bg-background` and no gradient; `app/dashboard/page.tsx` lines 253/339/856 use the standard gradient (CLAUDE.md is right). The skill's `tailwind.config.ts` colors and "Geist Sans" also differ from the repo (`content2 #F9FAFB`, font `--font-hanken-grotesk`); repo wins.
- Dashboard header is `bg-content1/60` (skill says `/80`); dashboard tile cards use `rounded-[18px]` widely (lines 936, 952, 969).
- `/inventory` uses `alert()` / `confirm()` (handleOpenBag, handleRestockForward, add/update failures); viewer-hostile on phones, candidates for `ResponsiveModal` (U4).
- `/inventory` page header is a bare `<h1>` (no stats); the skill's stat-box pattern is not used there.
- `/inventory` drawer batches and history rows are bordered cards inside the panel (fine) but use `border border-divider` sub-cards, which is the one nesting the skill tolerates only in drawers.
- `toFixed(2)` dollar formatting on floats: `purchase-modal.tsx` (551, 606, 633, 636, 652), `statpack-widget.tsx:126`, `statpack-editor-modal.tsx:767`, `purchase-history.tsx` (113, 143). These should move to integer cents + `MoneyText` with the purchases work.
- `app/lib/stats/shared.ts:223` has its own `Intl.NumberFormat` currency formatter; candidate to reuse `formatCents`.
- `Modal` dialogs in `/inventory` (dup review, merge, delete) are full-width on phones (HeroUI default), not full-screen like `PanelShell`; `ResponsiveModal` fixes this on migration.
- `tsc` baseline is red because `vitest` is not in `package.json` but two tests import it.
