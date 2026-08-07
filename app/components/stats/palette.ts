/**
 * Shared color & style tokens for the /stats chart-kit (chart-kit.tsx).
 *
 * THEME AWARENESS — read this before changing a color here.
 *
 * Every non-categorical color below is a live CSS custom property reference
 * (`hsl(var(--heroui-<token>))`), never a literal hex. HeroUI's Tailwind
 * plugin (see tailwind.config.ts) already injects `--heroui-<token>` custom
 * properties on `:root` (light theme) and re-defines them under `.dark`.
 * `next-themes` is configured with `attribute="class"` (app/providers.tsx),
 * so toggling the theme flips the `dark` class on `<html>` — the same
 * mechanism `.dark` already targets. Because these are CSS custom
 * properties, the browser re-resolves them the instant the class flips, for
 * every chart on the page, with no React state and no hydration mismatch.
 * This is the exact same source of truth as `bg-content1` / `text-
 * foreground-400` / `border-divider` elsewhere in the app — charts just
 * consume the raw variable because Recharts needs a concrete CSS value, not
 * a Tailwind class name.
 *
 * CHART_COLORS is the one deliberate exception: it is fixed hex, not CSS
 * vars, because it is the `dataviz` skill's validated 8-hue categorical
 * palette (fixed order = the colorblind-safety mechanism; re-ordering it
 * defeats the point). The eight hex values used here are the palette's
 * documented *dark*-surface steps — verified below to ALSO clear the
 * validator against this app's light chart surface, so one static array is
 * correct in both themes without needing a light/dark swap:
 *
 *   node scripts/validate_palette.js \
 *     "#3987e5,#d95926,#199e70,#c98500,#d55181,#008300,#9085e9,#e66767" --mode light
 *   → ALL CHECKS PASS (one WARN: #c98500 at 2.99:1 vs the 3:1 mark-contrast
 *     target — a WARN obligates a "relief channel", which every chart here
 *     ships: tooltips, legends, and DataTable all carry the same values as
 *     text, never color alone).
 *   node scripts/validate_palette.js \
 *     "#3987e5,#d95926,#199e70,#c98500,#d55181,#008300,#9085e9,#e66767" --mode dark
 *   → ALL CHECKS PASS.
 */

/** Fixed-order categorical series palette (see file header for validation). */
export const CHART_COLORS: string[] = [
  '#3987e5', // 1 blue
  '#d95926', // 2 orange
  '#199e70', // 3 aqua
  '#c98500', // 4 yellow
  '#d55181', // 5 magenta
  '#008300', // 6 green
  '#9085e9', // 7 violet
  '#e66767', // 8 red
];

/**
 * Ordinal ramp for order-carries-meaning series (funnel stages, tiers).
 * Steps 250–600 of the dataviz skill's single-hue sequential blue ramp —
 * this window sits inside BOTH documented clipping bounds at once (light:
 * no lighter than step 250; dark: no darker than step 600), so — like
 * CHART_COLORS — one static array is correct on both chart surfaces.
 */
export const CHART_ORDINAL_RAMP: string[] = [
  '#86b6ef', // 250
  '#6da7ec', // 300
  '#5598e7', // 350
  '#3987e5', // 400
  '#2a78d6', // 450
  '#256abf', // 500
  '#1c5cab', // 550
  '#184f95', // 600
];

/**
 * Status colors. Sourced from the app's own HeroUI theme tokens (the same
 * `success` / `warning` / `danger` that power `<Chip color="...">`, `text-
 * success`, `bg-danger-50`, etc. everywhere else) rather than the dataviz
 * skill's generic status scale — so a chart's "bad" red is the identical
 * pixel as the "Expired" chip's red on the same page. `neutral` uses the
 * app's mid-weight foreground token, matching secondary/caption text.
 */
export const CHART_SEMANTIC = {
  good: 'hsl(var(--heroui-success))',
  warn: 'hsl(var(--heroui-warning))',
  bad: 'hsl(var(--heroui-danger))',
  neutral: 'hsl(var(--heroui-default-500))',
} as const;

/** Shared axis styling — hairline axis line, small muted ticks (11px, per the type scale's dense-label floor). */
export const axisProps = {
  tick: { fontSize: 11, fill: 'hsl(var(--heroui-foreground-400))' },
  tickLine: false,
  axisLine: { stroke: 'hsl(var(--heroui-divider))' },
  tickMargin: 8,
} as const;

/** Shared CartesianGrid styling — one-step-off-surface hairline, solid, recessive. */
export const gridProps = {
  stroke: 'hsl(var(--heroui-divider))',
  strokeDasharray: '0',
  vertical: false,
} as const;

/** Shared tooltip chrome — bg-content1 card, border-divider, matches the app's card surface exactly. */
export const tooltipStyle = {
  contentStyle: {
    background: 'hsl(var(--heroui-content1))',
    border: '1px solid hsl(var(--heroui-divider))',
    borderRadius: 'var(--heroui-radius-large, 14px)',
    boxShadow: '0 4px 14px rgba(0,0,0,0.12)',
    padding: '8px 12px',
    fontSize: 12,
  },
  labelStyle: {
    color: 'hsl(var(--heroui-foreground-500))',
    fontWeight: 600,
    fontSize: 11,
    marginBottom: 4,
  },
  itemStyle: {
    color: 'hsl(var(--heroui-foreground))',
    fontSize: 12,
  },
  /** Hover cursor fill/stroke for Bar/Area cursors — a faint content2 wash, never a solid block. */
  cursor: { fill: 'hsl(var(--heroui-content2))', stroke: 'hsl(var(--heroui-divider))' },
} as const;
