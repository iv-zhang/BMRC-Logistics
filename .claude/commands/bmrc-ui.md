---
name: bmrc-ui
description: >
  Design system and front-end rules for the BMRC Logistics app. USE THIS SKILL
  for any UI work — building or editing a page, screen, component, card, table,
  modal, badge, button, form, layout, spacing, color, typography, or animation.
  Built for React + HeroUI + Tailwind CSS. Apply it whenever you touch anything
  the user can see. Keywords: UI, frontend, component, styling, layout, spacing,
  alignment, color, font, HeroUI, Tailwind, dashboard, screen, page.
---

# BMRC Logistics — UI Design System

This app is an operational logistics tool for an EMS volunteer corps: people use it
under time pressure to check gear in/out, find where equipment lives, see what's low
or expiring, run audits, and manage BLS QRS / transport readiness. **Clarity beats
decoration.** A volunteer should read status at a glance, on a laptop or a phone,
in bad lighting. Calm, dense, consistent — not flashy.

The palette and icon set are already good and the user likes them. **Your job is
consistency, not reinvention.** Do not introduce new colors, new fonts, new icon
libraries, new card styles, or new animation patterns. Reuse the tokens below.

## Source of truth: read these first

Before writing any UI code, open and follow the repo's real config — it overrides any
placeholder values in this file:

1. `tailwind.config.ts` — the **actual** color tokens and font family live here.
2. The existing component most similar to what you're building. Match it exactly.

If a token below differs from the repo, the repo wins. Never hardcode a hex value
inline; always use the theme token (e.g. `text-foreground`, `bg-content1`,
`text-success`) so one change propagates everywhere.

## HeroUI theme (tailwind.config.ts)

The custom HeroUI theme is configured in `tailwind.config.ts`. These are the canonical
values — they replace HeroUI's default pure-black/white backgrounds that cause the
"black screen" bug in dark mode:

```ts
import type { Config } from "tailwindcss";
import { heroui } from "@heroui/react";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx}",
  ],
  theme: { extend: {} },
  darkMode: "class",
  plugins: [
    heroui({
      themes: {
        light: {
          colors: {
            background: "#F4F5FA",   // subtle cool lavender-white
            content1:   "#FFFFFF",
            content2:   "#EEF0F8",
            content3:   "#E4E6F2",
            divider:    "#DDE0EE",
          },
        },
        dark: {
          colors: {
            background: "#0C0E14",   // deep navy, not pure black
            content1:   "#141820",
            content2:   "#1C2030",
            content3:   "#242840",
            divider:    "#2A2F45",
          },
        },
      },
    }),
  ],
};
export default config;
```

**Because the HeroUI theme handles dark/light automatically, never write `dark:bg-*`
or `dark:text-*` variants for surfaces covered by these tokens.** Only add a `dark:`
override when applying a color that has no HeroUI token (e.g. `dark:bg-danger-950/20`
for a danger tint that doesn't map to a content token).

## Page background gradient

The page-level background is a blue gradient, not a flat color. This applies to every
outermost page wrapper and every loading state. `bg-background` is reserved for cards,
modals, navbars, and inset surfaces — **not** the page itself.

```tsx
// Standard page wrapper background
"min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800"

// Loading state
<div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
  <Spinner size="lg" color="primary" />
</div>
```

The gradient is always `from-indigo-50 to-blue-50` in light mode and
`from-slate-900 to-slate-800` in dark mode. Do not vary the direction (`to-br`) or
the stops — consistency across every page is the goal.

## The five rules (the 90% fix)

These resolve almost every issue raised in review. When in doubt, re-read this list.

1. **One container width.** Nav bar contents and page contents sit in the *same*
   centered container. The nav background may go edge-to-edge, but its inner content
   aligns with the body. No screen is wider than another.
2. **One surface, one border.** Never nest a bordered card inside a bordered card.
   Separate things with background shade or spacing, not stacked outlines.
3. **One spacing scale.** Only use the steps below (multiples of 4 px). No arbitrary
   `px` values, no `mt-[13px]`.
4. **Color means status, never decoration.** Green/red/amber/blue/purple each have one
   meaning (below). If two things are different colors, that difference must mean
   something.
5. **Every UI string is a label, not a sentence.** Name controls by what they do:
   "Check out", "Mark restocked", "Run audit." Same word through the whole flow.

## Layout & page container

Every page uses the identical shell. The nav and the body share one container.

```tsx
<div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 text-foreground">
  <header className="border-b border-divider bg-background/80 backdrop-blur-sm">
    <div className="mx-auto max-w-7xl px-6 h-14 flex items-center justify-between">
      {/* logo + nav links left, search + avatar right */}
    </div>
  </header>

  <main className="mx-auto max-w-7xl px-6 py-8">
    {/* page content — SAME max-w-7xl px-6 as the header above */}
  </main>
</div>
```

- Container: `max-w-7xl` (≈ 1280 px). Horizontal padding: `px-6` desktop, `px-4` on small.
- The header's inner `<div>` must use the exact same `max-w-7xl px-6` as `<main>`.
- Page header block on each screen: title + one-line description, then `py-8` breathing
  room before content. Keep it identical across screens.

## Loading states

Every loading screen must use the page gradient so there's no color shift as the page
loads. Never use `bg-background` or no background on a loading state.

```tsx
// Correct loading state
<div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
  <Spinner size="lg" color="primary" />
</div>
```

Never use a plain `<div className="flex items-center justify-center">` without a
background — it flashes black in dark mode.

## Surfaces & elevation

Three surface levels, distinguished by **background**, not by stacking borders:

| Level  | Class / Token                                                        | Use                                          |
|--------|----------------------------------------------------------------------|----------------------------------------------|
| Page   | `bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800` | outermost page wrapper and loading states |
| Card   | `bg-content1` + `border border-divider rounded-large`                | primary cards, list wrappers                 |
| Inset  | `bg-content2 rounded-large` (no border)                              | rows, sub-panels, expanded details inside a card |

Rule: a `content1` card may contain `content2` insets, but **never** another bordered
`content1` card. One outline per surface. Separate items inside a card with a divider
line or spacing — not a second box.

For danger/warning insets (e.g. expired batches):
```tsx
<div className="bg-danger-50/60 dark:bg-danger-950/20 rounded-large p-3">
```

## Card-list expandable pattern

The standard pattern for list pages (inventory, assets, any entity list) is a
vertically stacked card list where each item expands in-place to show details.
**Do not use HeroUI `Table` for these pages** — tables don't expand well on mobile
and the card list reads faster at a glance.

```tsx
{/* Search + filter bar */}
<div className="flex gap-3 mb-4">
  <Input
    placeholder="Search..."
    startContent={<Search size={16} className="text-foreground-400" />}
    value={searchTerm}
    onValueChange={setSearchTerm}
    className="flex-1"
  />
  {/* Category filter chips */}
  <div className="flex gap-2 flex-wrap">
    {CATEGORIES.map(cat => (
      <Chip
        key={cat}
        variant={activeFilter === cat ? "solid" : "flat"}
        color={activeFilter === cat ? "primary" : "default"}
        className="cursor-pointer"
        onClick={() => setActiveFilter(cat)}
      >
        {cat}
      </Chip>
    ))}
  </div>
</div>

{/* List wrapper */}
<div className="bg-content1 border border-divider rounded-large divide-y divide-divider">
  {items.map(item => {
    const isExpanded = expandedId === item.id;
    return (
      <div key={item.id}>
        {/* Row — always visible */}
        <button
          className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-content2 transition-colors duration-150"
          onClick={() => setExpandedId(isExpanded ? null : item.id)}
        >
          <div className="flex-1 min-w-0">
            <p className="text-base font-semibold truncate">{item.name}</p>
            <p className="text-xs text-foreground-500 mt-0.5">{item.subtitle}</p>
            <div className="flex gap-2 mt-1">
              <Chip size="sm" variant="flat" color={statusColor}>{status}</Chip>
              {/* additional chips */}
            </div>
          </div>
          <div className="flex items-center gap-3 ml-3 shrink-0">
            {/* Right-side metric: stock count, value, etc. */}
            <div className="text-right">
              <p className="text-xl font-semibold tabular-nums">{item.count}</p>
              <p className="text-xs text-foreground-400">units</p>
            </div>
            <ChevronDown
              size={16}
              className={`text-foreground-400 transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
            />
          </div>
        </button>

        {/* Expanded panel — bg-content2 inset, no extra border */}
        {isExpanded && (
          <div className="px-4 pb-4 bg-content2/50">
            <div className="space-y-2 pt-3">
              {/* sub-items, batches, metadata */}
              <div className="bg-content2 rounded-large p-3">
                {/* detail row */}
              </div>
            </div>
            {/* Action buttons */}
            <div className="flex gap-2 mt-3">
              <Button size="sm" color="primary" variant="flat">Edit</Button>
              <Button size="sm" color="danger" variant="flat">Delete</Button>
            </div>
          </div>
        )}
      </div>
    );
  })}
</div>
```

Key rules for this pattern:
- The list wrapper is `bg-content1 border border-divider rounded-large` — one border only.
- Items are separated by `divide-y divide-divider` on the wrapper — no per-row border.
- The expanded panel uses `bg-content2/50` (translucent) — no new border.
- Sub-items inside the expanded panel use `bg-content2 rounded-large p-3` insets — no border.
- Row hover is `hover:bg-content2` — the same inset color.
- The chevron rotates `rotate-180` when expanded.
- `expandedId` state: `useState<string | null>(null)`.

## Spacing scale

Tailwind steps only. No arbitrary `px` values.

| Purpose                          | Value    | Tailwind          |
|----------------------------------|----------|-------------------|
| Icon ↔ its text label            | 8 px     | `gap-2`           |
| Items inside one group           | 8–12 px  | `gap-2` / `gap-3` |
| Between distinct groups          | 16–24 px | `gap-4` / `gap-6` |
| Card padding                     | 16–20 px | `p-4` / `p-5`    |
| Vertical rhythm between sections | 24–32 px | `space-y-6` / `space-y-8` |
| Page horizontal padding          | 24 px    | `px-6`            |

- Icon + text is always one flex row: `inline-flex items-center gap-2`. Vertically
  centered, never baseline-misaligned.
- If a card has actions, all action buttons live in one row with one gap value,
  separated from content above by `mt-4`.

## Typography

One UI font everywhere. The repo uses Inter (HeroUI default). Never mix fonts.

| Role              | Size / weight   | Tailwind                              |
|-------------------|-----------------|---------------------------------------|
| Page title        | 22 px / 600     | `text-2xl font-semibold`              |
| Section heading   | 16 px / 600     | `text-base font-semibold`             |
| Body / list row   | 14 px / 400     | `text-sm`                             |
| Secondary label   | 13 px / 400     | `text-[13px] text-foreground-500`     |
| Caption / meta    | 12 px / 400     | `text-xs text-foreground-400`         |
| Numbers / counts  | same as context | add `tabular-nums`                    |

- Never set a font size that isn't in this table. No `text-[10px]`, no `text-[11px]`.
- Use `tabular-nums` on **all** quantities, stock numbers, asset values, and stat counters.
- Buttons and chips: `text-sm` or `text-xs` only.
- `font-bold` is banned — use `font-semibold` everywhere.

## Icons

All icons come from `lucide-react`. Accent icons (the main icon representing a section
or entity type) use `text-primary`. Never use raw Tailwind color classes like
`text-indigo-600` or `text-blue-500` for icons — map to a semantic token:

| Context                | Token          |
|------------------------|----------------|
| Section/entity accent  | `text-primary` |
| Destructive/danger     | `text-danger`  |
| OK/ready               | `text-success` |
| Warning/expiring       | `text-warning` |
| Inactive/secondary     | `text-foreground-400` |

## Color = meaning

Keep the existing palette; use it semantically only.

| Meaning                                  | Token      | Used for                                   |
|------------------------------------------|------------|--------------------------------------------|
| Ready / in-service / OK / verified       | `success`  | status chips, "Ready", stock OK            |
| Not ready / critical / out / low         | `danger`   | "Not Ready", low stock, overdue, expired   |
| Warning / in-progress / expiring         | `warning`  | "In Progress", expiring soon, partial      |
| Primary action / info / count            | `primary`  | buttons, links, info badges, totals, icons |
| Brand / identity accent only             | `secondary`| logo, avatar — **not** status              |

Rules:
- A color may only appear for its single meaning. Don't use purple for a status; don't
  use blue for a warning.
- **Text contrast:** body text is `text-foreground`; secondary is `text-foreground-500`.
  Never put low-contrast gray on a gray surface. Target WCAG AA (4.5:1 for body text).
- Status color always pairs with a text label or icon — never color alone.
- Replace all raw `text-gray-*` with foreground tokens:
  - `text-gray-400` → `text-foreground-400`
  - `text-gray-500` → `text-foreground-500`
  - `text-gray-300` → `text-foreground-300`
- Replace `text-indigo-600`, `text-blue-600` → `text-primary`.
- Replace `text-red-500`, `text-red-600` → `text-danger`.

## Components

### Status chip

```tsx
import { Chip } from "@heroui/react";
<Chip size="sm" variant="flat" color="success">Ready</Chip>
<Chip size="sm" variant="flat" color="danger">Not Ready</Chip>
<Chip size="sm" variant="flat" color="warning">Expiring</Chip>
```

All chips: `size="sm"`, `variant="flat"`. Label in sentence case, 1–2 words.
Never hand-roll a badge with `<span className="bg-green-100 text-green-700 ...">`.

### Quantity stepper

```tsx
<div className="inline-flex items-center rounded-medium border border-divider overflow-hidden">
  <button aria-label="Decrease" className="px-2.5 py-1.5 bg-content2 hover:bg-content3 text-foreground-500">−</button>
  <span className="px-3 min-w-[2.5rem] text-center text-sm tabular-nums">{qty}</span>
  <button aria-label="Increase" className="px-2.5 py-1.5 bg-content2 hover:bg-content3 text-foreground-500">+</button>
</div>
```

### Buttons

- Primary action: `<Button color="primary">` (solid). One per view, the main verb.
- Secondary: `<Button variant="bordered">`. Tertiary: `<Button variant="light">`.
- Sizes: `sm` for inline/table actions, `md` for page-level. Consistent within a screen.
- Icon buttons: `isIconOnly` + `aria-label`.

### Cards

`bg-content1 border border-divider rounded-large p-5`. Header row (title + optional
action) then content with `mt-4`. Never nest bordered cards inside bordered cards.

### Stat counters

Big number `text-2xl font-semibold tabular-nums` in the semantic color, small label
`text-xs text-foreground-400` beneath. All counters in a row share identical structure.

## Motion

Operational tools should feel quick, not animated.

- Durations: `duration-150` (hover/press), `duration-200` (default), `duration-300`
  (panels/modals expanding). Nothing slower.
- Easing: `ease-out` for enters, `ease-in` for exits.
- What animates: hover/press states, expand/collapse chevron, toast/modal enter-exit.
- What does NOT animate: page content, numbers, table rows on load. No decorative or
  staggered entrance animations. No `hover:scale-*`.
- Always honor reduced motion: gate non-essential motion behind `motion-safe:`.

## Before you code

1. Read `tailwind.config.ts` and the nearest existing component. Match it exactly.
2. Identify the one job of the screen/component. Design around it.
3. Use theme tokens only — no inline hexes, no off-scale spacing, no new fonts.
4. Reuse shared components (Chip, Button, Spinner) instead of hand-rolling.

## Definition of done (self-check)

- [ ] Nav and page content share the same `max-w-7xl px-6` container.
- [ ] Every page wrapper and loading state uses the gradient `from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800`, not `bg-background`.
- [ ] No bordered card nested inside another bordered card.
- [ ] All spacing is on the 4 px scale; icon ↔ text is `gap-2` and vertically centered.
- [ ] One font family; every text size is from the type scale; numbers use `tabular-nums`.
- [ ] No `font-bold` — use `font-semibold`. No `text-[10px]` or `text-[11px]`.
- [ ] Every color maps to its single meaning; no `text-gray-*`, no `text-indigo-*`.
- [ ] Icon accents use `text-primary`, not raw color classes.
- [ ] No `dark:bg-*` overrides for surfaces covered by HeroUI tokens.
- [ ] All body/secondary text meets contrast; status has a label, not just color.
- [ ] Status badges use `<Chip size="sm" variant="flat">`. No hand-rolled badges.
- [ ] Motion uses the standard durations/easing; no `hover:scale-*`.
- [ ] Looks correct in both light and dark mode. Looks correct at mobile width.

## Anti-patterns

- A new color "for variety," a second font, or a different card style on one screen.
- Arbitrary spacing (`p-[18px]`, `gap-[7px]`). No `text-[10px]` or `text-[11px]`.
- `font-bold` — use `font-semibold`.
- Raw `text-gray-*` classes — replace with `text-foreground-*` tokens.
- `text-indigo-*` or `text-blue-*` for icons — use `text-primary`.
- `dark:bg-slate-900`, `dark:bg-gray-900` — use `bg-content2` or `bg-content1`.
- `bg-background` on the outermost page wrapper — use the gradient instead.
- Loading state div without the gradient — causes a flat/black background before content loads.
- HeroUI `<Table>` for entity list pages — use card-list expandable pattern instead.
- Nested borders / double boxes.
- Decorative or staggered load animations on dashboards/tables.
- `hover:scale-105` or any scale-on-hover — no transform animations on cards.
- Hand-rolled badges (`<span className="bg-green-100 text-green-700 rounded px-1">`).
