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
2. `app/inventory/page.tsx` — the canonical reference for list/table/filter/drawer UI.
3. The existing component most similar to what you're building. Match it exactly.

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
for a danger tint, or `dark:bg-sky-900/30` for a category badge tint).

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
   meaning (below) — with one exception: category-identification badges may use
   per-type hues (see Category code badges below).
5. **Every UI string is a label, not a sentence.** Name controls by what they do:
   "Check out", "Mark restocked", "Run audit." Same word through the whole flow.

## Layout & page container

Every page uses the identical shell. The nav and the body share one container.

```tsx
<div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
  <main className="max-w-7xl mx-auto px-6 py-8">
    {/* page content */}
  </main>
</div>
```

- Container: `max-w-7xl` (≈ 1280 px). Horizontal padding: `px-6` desktop, `px-4` on small.
- Top padding: `py-8`. Never vary this across pages.

### Page header block

Every page starts with a header block: title on one line, summary stats or description
on the second, and action buttons (export, primary CTA) to the right.

```tsx
<div className="flex items-end justify-between gap-4 mb-6 flex-wrap">
  <div>
    <h1 className="text-2xl font-semibold text-foreground mb-1.5">Page Title</h1>
    {/* Optional summary stats row */}
    <div className="flex items-center gap-3 text-sm text-foreground-500 flex-wrap">
      <span>
        <span className="font-semibold text-foreground tabular-nums">{total}</span> items
      </span>
      <span className="w-1 h-1 rounded-full bg-divider" />
      <span>
        <span className="font-semibold text-warning tabular-nums">{lowCount}</span> low stock
      </span>
      <span className="w-1 h-1 rounded-full bg-divider" />
      <span>
        <span className="font-semibold text-danger tabular-nums">{expiredCount}</span> expired
      </span>
    </div>
  </div>
  <div className="flex items-center gap-3">
    {/* view toggle, export, primary CTA */}
  </div>
</div>
```

Rules:
- Dot separators between stats: `<span className="w-1 h-1 rounded-full bg-divider" />`.
- Status numbers in the stats row use their semantic color (`text-warning`, `text-danger`).
- Plain counts use `text-foreground font-semibold`.
- All numbers: `tabular-nums`.

### Brand wordmark (navbar)

The navbar brand consists of the BMRC logo image followed by a two-line wordmark:

```tsx
<div className="flex flex-col leading-none">
  <span className="font-bold text-sm text-foreground tracking-tight">BMRC</span>
  <span className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">Logistics</span>
</div>
```

- "BMRC" line: `font-bold text-sm text-foreground tracking-tight`
- "Logistics" line: `text-[11px] font-semibold uppercase tracking-widest text-foreground-400`
- Always place the wordmark immediately after the logo image `<Link>`, before the nav link group.

### Nav item active pill

Desktop nav links use a pill-shaped background highlight for the active state — the entire icon+label is wrapped in a rounded-full container.

**Active:**
```
flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary-50 dark:bg-primary-900/20 text-primary font-semibold transition-colors duration-150
```

**Inactive:**
```
flex items-center gap-1.5 px-3 py-1.5 rounded-full text-foreground-500 hover:bg-content2 transition-colors duration-150
```

Apply this to both `<Link>` nav items and `<button>` dropdown triggers. The `color` prop on HeroUI `Link` components conflicts — use `className` only and omit `color`.

### Colored stat boxes (page header)

For pages that track status categories (inventory, assets), replace inline text stats with tinted stat boxes — each has a colored background, matching border, a small colored square indicator, a monospace count, and a label.

```tsx
<div className="flex items-center gap-2 flex-wrap mt-1">
  {/* Neutral total */}
  <div className="flex items-center gap-2 bg-content1 border border-divider rounded-large px-3 py-1.5">
    <span className="font-mono font-semibold tabular-nums text-foreground">{total}</span>
    <span className="text-xs text-foreground-400">total</span>
  </div>
  {/* Warning status */}
  <div className="flex items-center gap-2 bg-warning-50 dark:bg-warning-900/20 border border-warning/30 rounded-large px-3 py-1.5">
    <span className="w-2 h-2 rounded-sm bg-warning flex-none" />
    <span className="font-mono font-semibold tabular-nums text-warning">{count}</span>
    <span className="text-xs text-warning/80 font-medium">low stock</span>
  </div>
  {/* Danger status */}
  <div className="flex items-center gap-2 bg-danger-50 dark:bg-danger-900/20 border border-danger/30 rounded-large px-3 py-1.5">
    <span className="w-2 h-2 rounded-sm bg-danger flex-none" />
    <span className="font-mono font-semibold tabular-nums text-danger">{count}</span>
    <span className="text-xs text-danger/80 font-medium">expired</span>
  </div>
</div>
```

Rules:
- Use `bg-warning-50 dark:bg-warning-900/20 border-warning/30` for low/partial/expiring states.
- Use `bg-danger-50 dark:bg-danger-900/20 border-danger/30` for out/expired/critical states.
- Neutral totals: `bg-content1 border-divider`.
- Each box: `rounded-large px-3 py-1.5`. Never make these too tall — they're summary counts, not cards.
- Count: `font-mono font-semibold tabular-nums` in the semantic color.
- Label: `text-xs font-medium` in the semantic color at 80% opacity (`text-warning/80`, `text-danger/80`).
- The small square: `w-2 h-2 rounded-sm` in the semantic color.

## Loading states

Every loading screen must use the page gradient so there's no color shift as the page
loads. Never use `bg-background` or no background on a loading state.

```tsx
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
| Card   | `bg-content1` + `border border-divider rounded-large`                | primary cards, list wrappers, sidebar panels |
| Inset  | `bg-content2 rounded-large` (no border)                              | rows, sub-panels, stat boxes inside a card   |

Rule: a `content1` card may contain `content2` insets, but **never** another bordered
`content1` card. One outline per surface. Separate items inside a card with a divider
line or spacing — not a second box.

For danger/warning insets (e.g. expired batches):
```tsx
<div className="bg-danger-50/60 dark:bg-danger-950/20 rounded-large p-3">
```

## Layout patterns

### 1. Simple list page (no sidebar)

Use when filters are few and fit in a top bar. Single column, full width.

```tsx
{/* Top filter bar */}
<div className="flex gap-3 mb-4">
  {/* search input, selects, chips */}
</div>
{/* List */}
<div className="space-y-3">
  {items.map(item => (
    <div key={item.id} className="bg-content1 border border-divider rounded-large px-4 py-4">
      {/* row content */}
    </div>
  ))}
</div>
```

### 2. Sidebar filter + main column (inventory, assets, roster)

Use when there are multiple filter dimensions (status, category, location). The sidebar
sticks as the user scrolls the list.

```tsx
<div className="flex gap-6 items-start">
  {/* Sidebar — 256 px, sticky */}
  <aside className="w-64 flex-none sticky top-20 flex flex-col gap-4">
    {/* Each filter group is its own content1 card */}
    <div className="bg-content1 border border-divider rounded-large p-4">
      <p className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-3">
        Section Label
      </p>
      {/* filter controls */}
    </div>
  </aside>

  {/* Main column */}
  <main className="flex-1 min-w-0 flex flex-col gap-3">
    {/* search bar + item cards */}
  </main>
</div>
```

Sidebar rules:
- Width: `w-64 flex-none`. Never vary.
- Sticky: `sticky top-20`. (Accounts for the app navbar height.)
- Each filter group: its own `bg-content1 border border-divider rounded-large p-4`.
- Section labels: `text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-3`.
- Active filter button: `bg-primary-50 border-primary/30 text-primary dark:bg-primary-900/20`.
- Reset link at the bottom of the last filter group: `text-xs font-semibold text-primary`.

### 3. Grid table (dense data, secondary view)

Use for compact data views — typically paired with the list view via a view toggle.
Build with CSS grid, NOT HeroUI `<Table>`. HeroUI Table breaks expand patterns and
isn't tested with this theme.

```tsx
{/* Column header */}
<div
  className="grid gap-4 px-5 py-3 bg-content2 border-b border-divider text-[11px] font-semibold uppercase tracking-wide text-foreground-400"
  style={{ gridTemplateColumns: '2.3fr 1.3fr 1.2fr 100px 1.5fr 104px' }}
>
  <span>Item</span>
  <span>Location</span>
  <span>Lot · Expires</span>
  <span className="text-center">On Hand</span>
  <span>Status</span>
  <span className="text-right">Actions</span>
</div>

{/* Rows */}
<div className="divide-y divide-divider">
  {items.map(item => (
    <div key={item.id}>
      <div
        className="grid gap-4 px-5 py-3 cursor-pointer hover:bg-content2 transition-colors duration-150"
        style={{ gridTemplateColumns: '2.3fr 1.3fr 1.2fr 100px 1.5fr 104px' }}
        onClick={() => setDetailItem(item)}
      >
        {/* cells */}
      </div>
      {/* expandable batch rows below */}
    </div>
  ))}
</div>
```

Table rules:
- Wrapper: `bg-content1 border border-divider rounded-large overflow-hidden`.
- Header: `bg-content2`, separated from rows by `border-b border-divider`.
- Rows: `divide-y divide-divider` on the wrapper; row hover is `hover:bg-content2`.
- Column proportions via `gridTemplateColumns` inline style — use `fr` units.
- Clicking a row opens the **detail drawer** (see below), not an in-place expand.
- Action column: right-aligned `+`/`−` steppers and an expand chevron for sub-rows.
- Expanded sub-rows: `bg-content2/50` inset with `bg-content1 border border-divider rounded-medium` sub-items.

## Search input

Two variants depending on context:

### Top-bar search (simple pages)

Use HeroUI `<Input>` with `startContent`:

```tsx
import { Input } from "@heroui/react";
<Input
  placeholder="Search..."
  startContent={<Search size={16} className="text-foreground-400" />}
  value={searchTerm}
  onValueChange={setSearchTerm}
  className="flex-1"
  isClearable
/>
```

### Inline search (sidebar-layout pages)

When search lives inside the main column alongside a sidebar, use a plain input wrapper
so it doesn't fight the sidebar card styling:

```tsx
<div className="flex items-center gap-3 bg-content1 border border-divider rounded-large px-4 py-1">
  <Search size={16} className="text-foreground-400 flex-none" />
  <input
    value={searchTerm}
    onChange={e => setSearchTerm(e.target.value)}
    placeholder="Search items, locations…"
    className="flex-1 text-sm bg-transparent outline-none py-2.5 text-foreground placeholder:text-foreground-400"
  />
  {searchTerm && (
    <button onClick={() => setSearchTerm('')} className="text-foreground-400 hover:text-foreground-600">
      <X size={15} />
    </button>
  )}
</div>
```

## View mode toggle

Use when a page offers two display modes (e.g. List / Table). Placed in the page
header row, to the left of Export and the primary CTA.

```tsx
<div className="flex bg-content1 border border-divider rounded-large p-1 gap-1">
  {([
    { mode: 'list' as const, icon: <LayoutList size={14} />, label: 'List' },
    { mode: 'table' as const, icon: <Table2 size={14} />, label: 'Table' },
  ]).map(({ mode, icon, label }) => (
    <button
      key={mode}
      onClick={() => setViewMode(mode)}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-medium text-sm font-semibold transition-colors duration-150 ${
        viewMode === mode
          ? 'bg-primary text-white'
          : 'text-foreground-500 hover:bg-content2'
      }`}
    >
      {icon} {label}
    </button>
  ))}
</div>
```

Rules:
- Container: `bg-content1 border border-divider rounded-large p-1`.
- Active segment: `bg-primary text-white rounded-medium`.
- Inactive segment: `text-foreground-500 hover:bg-content2 rounded-medium`.
- Always pair with an icon + text label. Never use text-only tabs here.

## Detail drawer

Use when an item row is clicked and you need to show full details without leaving the
page. Replaces in-place expand when detail content is rich enough to warrant it
(multiple sections, action buttons, scrollable history).

```tsx
{detailItem && (
  <>
    {/* Backdrop */}
    <div
      className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
      onClick={() => setDetailItem(null)}
    />
    {/* Drawer */}
    <div className="fixed top-0 right-0 bottom-0 z-50 w-[480px] max-w-[94vw] bg-content1 shadow-2xl flex flex-col">

      {/* Header — entity identity + close */}
      <div className="px-6 py-5 border-b border-divider">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            {/* entity icon/badge */}
            <div>
              <div className="font-semibold text-lg text-foreground leading-tight">{item.name}</div>
              <div className="flex items-center gap-1 text-xs text-foreground-500 mt-0.5">
                <MapPin size={11} /> {location}
              </div>
            </div>
          </div>
          <button
            onClick={() => setDetailItem(null)}
            className="w-8 h-8 rounded-medium bg-content2 hover:bg-content3 text-foreground-400 flex items-center justify-center transition-colors flex-none"
          >
            <X size={16} />
          </button>
        </div>
        {/* Status chips */}
        <div className="flex gap-1.5 flex-wrap mt-4">
          <Chip size="sm" variant="flat" color="warning">Low Stock</Chip>
        </div>
      </div>

      {/* Body — scrollable */}
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {/* Stat pair */}
        <div className="flex gap-3">
          <div className="flex-1 bg-content2 rounded-large p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">On Hand</div>
            <div className="font-mono text-[28px] font-semibold tabular-nums leading-tight text-success">
              42 <span className="text-sm text-foreground-400 font-normal ml-1">units</span>
            </div>
          </div>
          <div className="flex-1 bg-content2 rounded-large p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">Reorder At</div>
            <div className="font-mono text-[28px] font-semibold tabular-nums leading-tight text-foreground-600">10</div>
            <div className="text-xs font-semibold mt-1 text-success">Well stocked</div>
          </div>
        </div>
        {/* Additional sections */}
      </div>

      {/* Footer — primary actions */}
      <div className="px-6 py-4 border-t border-divider flex gap-3">
        <Button variant="bordered" className="flex-1" startContent={<Plus size={15} />}>
          Edit / Add batch
        </Button>
        <Button color="primary" className="flex-1" startContent={<ArrowRight size={15} />}>
          Restock forward
        </Button>
      </div>
    </div>
  </>
)}
```

Drawer rules:
- Backdrop: `fixed inset-0 z-40 bg-black/40 backdrop-blur-sm`. Click dismisses.
- Drawer: `fixed top-0 right-0 bottom-0 z-50 w-[480px] max-w-[94vw]`.
- Background: `bg-content1` (not gradient, not white).
- Three zones: header (`border-b border-divider`), scrollable body (`flex-1 overflow-y-auto`), footer (`border-t border-divider`).
- Stat boxes in body: `bg-content2 rounded-large p-4` side by side in `flex gap-3`.
- Stat labels: `text-[11px] font-semibold uppercase tracking-wide text-foreground-400`.
- Stat numbers: `font-mono text-[28px] font-semibold tabular-nums` in semantic color.
- Sub-sections in body: `border border-divider rounded-large p-4` per item.
- Footer: two equal-width buttons (`flex-1`): secondary (`variant="bordered"`) + primary (`color="primary"`).

## Card-list expandable pattern

Still the default for simpler list pages. Use when items expand in-place to reveal a
small amount of additional detail (a few fields, a short list of sub-items).

```tsx
{/* List wrapper */}
<div className="bg-content1 border border-divider rounded-large divide-y divide-divider">
  {items.map(item => {
    const isExpanded = expandedId === item.id;
    return (
      <div key={item.id}>
        <button
          className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-content2 transition-colors duration-150"
          onClick={() => setExpandedId(isExpanded ? null : item.id)}
        >
          <div className="flex-1 min-w-0">
            <p className="text-base font-semibold truncate">{item.name}</p>
            <p className="text-xs text-foreground-500 mt-0.5">{item.subtitle}</p>
            <div className="flex gap-2 mt-1">
              <Chip size="sm" variant="flat" color="warning">Low Stock</Chip>
            </div>
          </div>
          <div className="flex items-center gap-3 ml-3 shrink-0">
            <div className="text-right">
              <p className="text-xl font-semibold tabular-nums">{item.count}</p>
              <p className="text-xs text-foreground-400">units</p>
            </div>
            <ChevronDown size={16} className={`text-foreground-400 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
          </div>
        </button>

        {isExpanded && (
          <div className="px-4 pb-4 bg-content2/50">
            <div className="space-y-2 pt-3">
              <div className="bg-content2 rounded-large p-3">{/* detail */}</div>
            </div>
            <div className="flex gap-2 mt-3">
              <Button size="sm" color="primary" variant="flat">Edit</Button>
            </div>
          </div>
        )}
      </div>
    );
  })}
</div>
```

**Choose between expand-in-place vs. detail drawer:**
- In-place expand: ≤ 3 fields or a short sub-list. Stays in flow, fast to scan.
- Detail drawer: rich content (multiple sections, action footer, scrollable history). Slides in from the right without leaving the page.

## Item card (standalone, not in a list wrapper)

Use when items must be individually clickable with their own border and hover state
(as in the sidebar-layout list view).

```tsx
<div
  onClick={() => setDetailItem(item)}
  className="flex gap-4 items-center bg-content1 border border-divider rounded-large px-4 py-4 cursor-pointer hover:border-primary/30 hover:shadow-sm transition-all duration-150"
>
  {/* category badge */}
  {/* info: name, location, status chips */}
  {/* right: quantity stepper */}
</div>
```

Rules:
- Background: `bg-content1 border border-divider rounded-large`.
- Hover: `hover:border-primary/30 hover:shadow-sm` — border brightens, faint shadow lifts it.
- No `hover:scale-*`. No `hover:bg-content2` (that's for rows inside a shared wrapper).

## Category code badges

Pages that display entity types (inventory categories, asset types, etc.) use a
two-letter code badge to let users scan category at a glance.

```tsx
// Config — define once per entity domain, co-located with the page or in a shared config
const CAT_CFG: Record<ItemCategory, { code: string; bg: string; text: string }> = {
  Airway:    { code: 'AW', bg: 'bg-sky-100 dark:bg-sky-900/30',         text: 'text-sky-700 dark:text-sky-300' },
  Trauma:    { code: 'TR', bg: 'bg-red-100 dark:bg-red-900/30',         text: 'text-red-700 dark:text-red-300' },
  Vitals:    { code: 'VT', bg: 'bg-violet-100 dark:bg-violet-900/30',   text: 'text-violet-700 dark:text-violet-300' },
  Meds:      { code: 'MD', bg: 'bg-pink-100 dark:bg-pink-900/30',       text: 'text-pink-700 dark:text-pink-300' },
  PPE:       { code: 'PP', bg: 'bg-amber-100 dark:bg-amber-900/30',     text: 'text-amber-700 dark:text-amber-300' },
  Splinting: { code: 'SP', bg: 'bg-orange-100 dark:bg-orange-900/30',   text: 'text-orange-700 dark:text-orange-300' },
  Hygiene:   { code: 'HY', bg: 'bg-emerald-100 dark:bg-emerald-900/30', text: 'text-emerald-700 dark:text-emerald-300' },
  Other:     { code: 'OT', bg: 'bg-content3',                            text: 'text-foreground-500' },
};

// Large badge (card view) — 50 × 50 px
<div className={`w-[50px] h-[50px] rounded-[13px] flex items-center justify-center font-mono font-semibold text-[15px] flex-none ${cfg.bg} ${cfg.text}`}>
  {cfg.code}
</div>

// Small badge (table row) — 36 × 36 px
<div className={`w-9 h-9 rounded-[9px] flex items-center justify-center font-mono font-semibold text-[11px] flex-none ${cfg.bg} ${cfg.text}`}>
  {cfg.code}
</div>

// Tiny inline badge (sidebar category list) — 18 × 18 px
<span className={`w-[18px] h-[18px] rounded flex items-center justify-center text-[9px] font-semibold flex-none ${cfg.bg} ${cfg.text}`}>
  {cfg.code}
</span>
```

**Color rule exception:** Category badges use hue-per-type (sky, red, violet, pink,
amber, orange, emerald) because their purpose is *identification*, not *status*. This
is the only context where raw Tailwind color classes (`bg-sky-100`, `text-sky-700`) are
permitted. Always include the `dark:` variants. Never use category colors for status
indicators or decorative accents elsewhere.

The category chip inline (next to item name):
```tsx
<span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${cfg.bg} ${cfg.text}`}>
  {item.category}
</span>
```

## Quick-adjust stepper (inline ±1)

Use on list rows and table action columns for instant stock adjustments. Always
`stopPropagation` so clicking ± doesn't trigger row selection or drawer open.

```tsx
{/* Minus */}
<button
  onClick={e => { e.stopPropagation(); handleAdjust(item.id, -1); }}
  className="w-8 h-8 rounded-medium bg-content2 hover:bg-content3 text-foreground-500 flex items-center justify-center transition-colors duration-150"
  aria-label="Decrease stock"
>
  <Minus size={14} />
</button>

{/* Count display */}
<div className="text-center min-w-[54px]">
  <div className={`font-mono text-3xl font-semibold tabular-nums leading-none ${qtyColor}`}>
    {qty}
  </div>
  <div className="text-[9px] uppercase tracking-wider text-foreground-400 mt-1 font-semibold">
    {unit}
  </div>
</div>

{/* Plus */}
<button
  onClick={e => { e.stopPropagation(); handleAdjust(item.id, 1); }}
  className="w-8 h-8 rounded-medium bg-primary-50 hover:bg-primary-100 text-primary flex items-center justify-center transition-colors duration-150 dark:bg-primary-900/20 dark:hover:bg-primary-800/30"
  aria-label="Increase stock"
>
  <Plus size={14} />
</button>
```

The small table-row variant uses `w-7 h-7 rounded-[7px]` and `size={12}` icons.

Progress bar below the stepper:
```tsx
{threshold > 0 && (
  <div className="w-full h-1.5 rounded-full bg-content3 overflow-hidden">
    <div
      className={`h-full rounded-full transition-all ${barColorClass}`}
      style={{ width: `${pct}%` }}
    />
  </div>
)}
```

Bar color: `bg-success` when OK, `bg-warning` when low, `bg-danger` when out/expired.

## Saving toast

Show during any async write operation so the user knows something is happening.
Fixed at the bottom-center, above all other content.

```tsx
{opLoading && (
  <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] bg-content1 border border-divider rounded-large px-4 py-2 shadow-lg flex items-center gap-2 text-sm text-foreground-600">
    <Spinner size="sm" color="primary" /> Saving…
  </div>
)}
```

Rules:
- `z-[60]` — above the drawer (`z-50`) and backdrop (`z-40`).
- `bg-content1 border border-divider` — same surface as cards; never a colored background.
- No duration or countdown — disappears when `opLoading` goes false.

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
| Sidebar to main column gap       | 24 px    | `gap-6`           |

- Icon + text is always one flex row: `inline-flex items-center gap-2`. Vertically
  centered, never baseline-misaligned.
- If a card has actions, all action buttons live in one row with one gap value,
  separated from content above by `mt-4`.

## Typography

One UI font everywhere. The repo uses Geist Sans (set in `app/layout.tsx`). Never mix fonts.

| Role                         | Size / weight   | Tailwind                              |
|------------------------------|-----------------|---------------------------------------|
| Page title                   | 22 px / 600     | `text-2xl font-semibold`              |
| Section heading              | 16 px / 600     | `text-base font-semibold`             |
| Body / list row              | 14 px / 400     | `text-sm`                             |
| Secondary label              | 13 px / 400     | `text-[13px] text-foreground-500`     |
| Caption / meta               | 12 px / 400     | `text-xs text-foreground-400`         |
| Dense section label (sidebar, table header) | 11 px / 600 | `text-[11px] font-semibold uppercase tracking-widest text-foreground-400` |
| Micro label (unit beneath a number) | 9 px / 600 | `text-[9px] uppercase tracking-wider text-foreground-400 font-semibold` |
| Numbers / counts             | same as context | add `tabular-nums`                    |
| Monospaced (lot #, qty, PSI) | same size       | add `font-mono`                       |

- The 11 px dense label is only for sidebar section headers and table column headers.
- The 9 px micro label is only for the unit beneath a large monospaced quantity (e.g., "UNITS" under "42").
- Do not use `text-[10px]` or any other arbitrary size not in this table.
- Use `tabular-nums` on **all** quantities, stock numbers, asset values, and stat counters.
- Use `font-mono` on lot numbers, barcodes, PSI values, and any number where digit alignment matters.
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
| Ready / in-service / OK / verified       | `success`  | status chips, "Ready", stock OK, bar color |
| Not ready / critical / out / low         | `danger`   | "Not Ready", low stock, overdue, expired   |
| Warning / in-progress / expiring         | `warning`  | "In Progress", expiring soon, partial      |
| Primary action / info / count            | `primary`  | buttons, links, info badges, totals, icons |
| Brand / identity accent only             | `secondary`| logo, avatar — **not** status              |

Rules:
- A color may only appear for its single meaning. Don't use purple for a status; don't
  use blue for a warning.
- **Exception — category identification:** Entity-type badges (inventory categories,
  asset types) may use per-type hues (`bg-sky-*`, `bg-red-*`, etc.) to aid visual
  scanning. Always include `dark:` variants. Never bleed these colors into status chips
  or anywhere else on the page.
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
<Chip size="sm" variant="flat" color="success">OK</Chip>
<Chip size="sm" variant="flat" color="danger">Expired</Chip>
<Chip size="sm" variant="flat" color="warning">Low Stock</Chip>
<Chip size="sm" variant="flat" color="warning">Exp. Soon</Chip>
<Chip size="sm" variant="flat" color="danger">Out of Stock</Chip>
```

All chips: `size="sm"`, `variant="flat"`. Label in sentence case, 1–3 words.
Never hand-roll a badge with `<span className="bg-green-100 text-green-700 ...">`.
Status chips live: in item card chip row, in detail drawer header, in table status column.

### Buttons

- Primary action: `<Button color="primary">` (solid). One per view, the main verb.
- Secondary: `<Button variant="bordered">`. Tertiary: `<Button variant="light">`.
- Sizes: `sm` for inline/table actions, `md` for page-level. Consistent within a screen.
- Icon buttons: `isIconOnly` + `aria-label`.
- Drawer footer: two `flex-1` buttons side by side — `variant="bordered"` + `color="primary"`.

### Cards

`bg-content1 border border-divider rounded-large p-4` (or `p-5` for more breathing room).
Header row (title + optional action) then content with `mt-4`. Never nest bordered cards.

### Stat counters (in drawer / dashboard)

```tsx
<div className="bg-content2 rounded-large p-4">
  <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">
    Label
  </div>
  <div className={`font-mono text-[28px] font-semibold tabular-nums leading-tight ${semanticColor}`}>
    {value}
    <span className="text-sm text-foreground-400 font-normal ml-1.5">{unit}</span>
  </div>
  <div className="text-xs font-semibold mt-1 text-success">Status message</div>
</div>
```

All counters in a row (`flex gap-3`) share identical structure and `flex-1` width.

## Motion

Operational tools should feel quick, not animated.

- Durations: `duration-150` (hover/press), `duration-200` (default), `duration-300`
  (panels/modals expanding). Nothing slower.
- Easing: `ease-out` for enters, `ease-in` for exits.
- What animates: hover/press states, expand/collapse chevron (`transition-transform duration-200`), progress bars.
- What does NOT animate: page content, numbers, table rows on load. No decorative or
  staggered entrance animations. No `hover:scale-*`.
- Always honor reduced motion: gate non-essential motion behind `motion-safe:`.

## z-index layers

| Layer            | z-index      | Used for                         |
|------------------|--------------|----------------------------------|
| Page content     | (default)    | cards, tables, sidebars          |
| Drawer backdrop  | `z-40`       | `bg-black/40` overlay            |
| Detail drawer    | `z-50`       | right-side panel                 |
| Saving toast     | `z-[60]`     | bottom-center operation feedback |
| Modals (HeroUI)  | (HeroUI own) | `Modal` component handles itself |

Never use arbitrary z-index values outside this table.

## Before you code

1. Read `tailwind.config.ts` and `app/inventory/page.tsx`. Match exactly.
2. Identify the one job of the screen/component. Design around it.
3. Pick the right layout pattern: simple list, sidebar+list, or sidebar+table.
4. Use theme tokens only — no inline hexes, no off-scale spacing, no new fonts.
5. Reuse shared components (Chip, Button, Spinner) instead of hand-rolling.

## Definition of done (self-check)

- [ ] Page wrapper uses the gradient; loading state uses the gradient.
- [ ] `max-w-7xl mx-auto px-6 py-8` on the content container.
- [ ] Page header: `text-2xl font-semibold` title + stats row + action buttons, `mb-6`.
- [ ] No bordered card nested inside another bordered card.
- [ ] All spacing is on the 4 px scale; icon ↔ text is `gap-2` and vertically centered.
- [ ] Font sizes match the type scale; `text-[11px]` only for sidebar/table section labels; `text-[9px]` only for unit micro-labels.
- [ ] No `font-bold` — use `font-semibold`. No `tabular-nums` missing on any number.
- [ ] `font-mono` on lot numbers, barcodes, PSI, and quantity displays.
- [ ] Every color maps to its single meaning; category-type colors only on identity badges.
- [ ] No `text-gray-*`, no `text-indigo-*`, no `text-blue-*` for status or icons.
- [ ] Status chips: `<Chip size="sm" variant="flat">`. No hand-rolled badges.
- [ ] Sidebar layout: `w-64 flex-none sticky top-20`; section labels `text-[11px] uppercase tracking-widest`.
- [ ] Detail drawer: backdrop `z-40`, panel `z-50`, `w-[480px] max-w-[94vw] bg-content1`.
- [ ] Saving toast uses `z-[60]` and `bg-content1 border border-divider`.
- [ ] Quick-adjust buttons call `e.stopPropagation()` to prevent row/drawer triggers.
- [ ] Grid table uses CSS grid (`gridTemplateColumns`), NOT HeroUI `<Table>`.
- [ ] View toggle: active segment `bg-primary text-white`; inactive `text-foreground-500 hover:bg-content2`.
- [ ] Motion: `duration-150` hover, `duration-200` default; no `hover:scale-*`.
- [ ] Looks correct in both light and dark mode. Looks correct at mobile width.

## Anti-patterns

- A new color "for variety," a second font, or a different card style on one screen.
- Arbitrary spacing (`p-[18px]`, `gap-[7px]`). `text-[10px]` or any size not in the type scale.
- `font-bold` — use `font-semibold`.
- Raw `text-gray-*` — replace with `text-foreground-*`.
- `text-indigo-*` or `text-blue-*` for icons or status — use `text-primary` or `text-danger`.
- `dark:bg-slate-900`, `dark:bg-gray-900` — use `bg-content2` or `bg-content1`.
- `bg-background` on the outermost page wrapper — use the gradient instead.
- Loading state without the gradient — causes flash on dark mode.
- HeroUI `<Table>` — use the CSS grid table pattern instead.
- Nested borders / double boxes.
- Decorative or staggered load animations on dashboards/tables.
- `hover:scale-105` or any scale-on-hover — no transform animations on cards.
- Hand-rolled badges (`<span className="bg-green-100 text-green-700 rounded px-1">`).
- Missing `e.stopPropagation()` on stepper buttons inside a clickable card/row.
- `z-index` values outside the documented layer table.
- Omitting `font-mono` on quantities, lot numbers, or PSI values.
- Sidebar width other than `w-64` or sticky offset other than `top-20`.
- Inline text stats for status counts (e.g. `3 low stock` plain text) — use colored stat boxes instead.
- Tooltip wrappers on nav links — they compete with the pill hover state.
- `color` prop on HeroUI `Link` inside nav — use `className` only so pill styles apply.
