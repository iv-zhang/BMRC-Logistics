---
name: bmrc-org-config
description: >
  The runtime organization-config system for BMRC Logistics. USE THIS SKILL
  whenever code needs a threshold, location list, room list, category list,
  statpack type, vehicle, asset-category check, or org name — or when adding a
  new admin-editable setting to the /settings page. Config is data in
  Firestore, not code; reading it wrong makes admin edits silently ignored.
  Keywords: org config, settings, thresholds, THRESHOLDS, LOCATIONS,
  categories, statpack types, vehicles, org_settings, configurable, editable,
  defaults, useOrgConfig, getThresholds, expiration window, reorder threshold.
---

# BMRC Org Configuration (runtime, admin-editable)

Org configuration is **data, not code**. The live values come from one
Firestore doc — `org_settings/current` — merged over the defaults in
`app/config/org-config.ts`. Admins edit it in `/settings` (no JSON, no
deploy). This is how the org moves HQ, retunes thresholds, or rebrands for
another agency.

## The three layers

1. **`app/config/org-config.ts`** — `DEFAULT_ORG_CONFIG`, all type interfaces,
   and helper functions (`getInventoryAreaOptions`, `getAssetCategoryConfig`,
   `getStatpackTypeConfig`, `getLocationConfig`, `getRoomNames`, …). The helper
   functions read the **runtime** config, so they're always safe. The raw
   constant exports (`THRESHOLDS`, `LOCATIONS`, `STATPACK_TYPES`, …) are
   **frozen defaults only — never read them for live values**.
2. **`app/lib/org-config-store.ts`** — the runtime singleton + Firestore I/O.
   Getters for pure lib code: `getThresholds()`, `getLocationsRuntime()`,
   `getItemCategoriesRuntime()`, `getAssetCategoriesRuntime()`,
   `getStatpackTypesRuntime()`, `getVehiclesRuntime()`, `getOrgInfoRuntime()`.
   Write API: `saveOrgConfig(patch, actor)` (merge-write, only provided keys
   change), `resetOrgConfigToDefaults(actor)`. Plus `subscribeOrgConfig(cb)`
   and `seedOrgConfigIfMissing()`.
3. **`useOrgConfig()`** (`app/hooks/useOrgConfig.ts`) — the React hook.
   `OrgConfigProvider` (wired in `app/providers.tsx`) subscribes to the doc
   and seeds it if missing. The hook exposes the merged live config plus
   `loading` and convenience lookups (`getAssetCategory`, `locationNames`,
   `assetCategoryIds`, …). It falls back to defaults with no provider, so it
   never throws.

## How to read config (the rules)

- **In a component:** `const { thresholds, locations, ... } = useOrgConfig();`
- **In pure lib code** (`item-status.ts`, `inventory.ts`, …): the store
  getters, e.g. `getThresholds().expirationWarningDays`.
- **Never** import `THRESHOLDS` / `LOCATIONS` / other frozen constants for a
  live read. They ignore admin overrides.
- **Never read config at module scope.** `const OPTS =
  getInventoryAreaOptions()` at the top of a file captures a snapshot before
  the Firestore doc loads and never updates. Move the call inside the render
  function (or a `useMemo` keyed on the hook's values) to stay reactive.
- Location filter dropdowns derive from `getInventoryAreaOptions()` — never
  hardcode location lists in pages.

## Merge semantics (gotchas)

`applyOrgConfigDoc()` shallow-merges the doc over defaults:

- `org` and `thresholds` merge **per key** — a partial doc is fine.
- Array keys (`locations`, `vehicles`, `assetCategories`, `statpackTypes`,
  `itemCategories`) use `pickArray`: **an empty or missing array falls back to
  the defaults.** You cannot configure an empty list — deleting the last
  location resurrects the default set. Keep this in mind when building
  editors; don't "fix" it casually either, since it's what makes a partial or
  corrupt doc harmless.
- Renaming a category/site does **not** relabel already-saved records
  (v1 soft-warning). Old docs keep old strings; display code must tolerate
  unknown values.

## What's editable vs. code-owned

- **Editable in `/settings`:** `org`, `locations` (+rooms), `vehicles`,
  `assetCategories` (+their checks), `statpackTypes` (+pockets),
  `itemCategories`, `thresholds`.
- **Code-owned (not in the doc):** `VERIFICATION_FIELDS` (the check-field
  palette) and `ROLES`.
- **Physical zones/shelves/containers/floors** are documents, not config —
  edited in Storage Management (`/storage`), never in `/settings`.

## Recipe: add a new admin-editable setting

Example: a new threshold `foobarDays`.

1. **Type + default** — add the field to the interface (`ThresholdConfig` or a
   new section type) and to `DEFAULT_ORG_CONFIG` in `app/config/org-config.ts`.
2. **Merge** — per-key sections (`org`, `thresholds`) need no change in
   `applyOrgConfigDoc`; a **new top-level key** must be added there and to the
   `OrgConfigDoc` type, or overrides will be dropped.
3. **Getter** — if lib code needs it, it's already covered by `getThresholds()`
   (or add a getter in `org-config-store.ts` for a new section).
4. **Hook** — new sections must be added to `buildResult()` in
   `app/hooks/useOrgConfig.ts`; threshold fields flow through automatically.
5. **Editor UI** — add the form control in the matching tab under
   `app/components/settings/` (`org-and-thresholds-tab.tsx`,
   `sites-rooms-tab.tsx`, `categories-tab.tsx`,
   `statpacks-vehicles-tab.tsx`). Follow the existing controls; save goes
   through `saveOrgConfig(patch, actor)`. Gate nothing extra — the page is
   already admin/quartermaster-only.
6. **Consume** — via the hook (components) or getter (lib). Never the frozen
   constant.
7. **Verify** — with `npm run dev:emulator`, change the value in `/settings`
   and confirm the consuming page updates live without a reload.

## Seeding & permissions

`seedOrgConfigIfMissing()` runs on every mount (fire-and-forget). Non-admins
can't write `org_settings`; the permission error is swallowed and the app runs
on defaults. Don't "fix" that console warning.
