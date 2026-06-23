# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start dev server (Next.js)
npm run build        # Production build
npm run lint         # ESLint
npm run test         # Run audit/restock integration test (scripts/test-audit-restock.cjs)
```

Migration scripts run against live Firestore; always pass `--dry-run` first:
```bash
npm run migrate:batch-locations       # --dry-run by default
npm run migrate:normalize-inventory   # --dry-run by default
```

Firebase environment variables are required in `.env.local` (`NEXT_PUBLIC_FIREBASE_*`). The file already exists; do not commit it.

## Architecture

### Framework & Stack
- **Next.js 16** App Router — all routes live under `app/`, no `src/` directory.
- **Firebase**: Firestore (real-time `onSnapshot` listeners everywhere, no REST layer), Firebase Auth.
- **HeroUI** (`@heroui/react`) for all UI components; **Tailwind CSS 4** for utility classes; **Lucide React** for icons.
- **`next-themes`** for dark/light mode; theme wrapping lives in `app/providers.tsx`.

### Auth & Roles
`app/hooks/useUserRole.tsx` is the single source of auth state. It combines Firebase Auth with a Firestore `users/{uid}` doc fetch to expose `{ user, userData, role, loading }`.

Role values: `'admin' | 'quartermaster' | 'inventory_helper' | 'FTO' | 'member'`

The admin check used throughout the app:
```ts
const isAdmin = role === 'admin' || role === 'quartermaster';
```

For local testing, set `localStorage.bmrc_role_override` to any role string; the hook listens for the `bmrc-role-changed` custom event and `storage` events to pick it up immediately.

### Configuration (single source of truth)
`app/config/org-config.ts` owns all business constants: locations, vehicle types, asset categories, statpack types/pocket layouts, verification field definitions, role definitions, inventory categories, and numeric thresholds. **Change values here, not scattered across pages.** Helper functions (`getAssetCategoryConfig`, `getStatpackTypeConfig`, etc.) are exported for lookups.

### Type System
`app/types.ts` defines all domain types: `User`, `InventoryItem`, `Statpack`, `StatpackItem`, `StatpackLog`, `AssetInstance`, `InventoryBatch`, `StorageZone`, `Shelf`, `Container`, `IssueReport`, `BuyListItem`, `TaskItem`, `MedicationLog`, etc.

### Key Page Areas

| Route | Purpose |
|---|---|
| `/dashboard` | Splits into `member-dashboard.tsx` vs. admin view based on role |
| `/statpacks` | Admin statpack list |
| `/statpacks/checkout` | Member pack selection for checkout (then navigates to check-off) |
| `/statpacks/checkin` | Member pack selection for check-in (then navigates to check-off) |
| `/statpacks/check-off` | Unified pocket-by-pocket verification page (checkout / checkin / audit); receives `?id=<packId>&mode=<mode>` query params |
| `/statpacks/[id]` | Admin statpack detail/edit |
| `/assets` | Admin asset management |
| `/inventory` | Admin inventory management |
| `/restock` | Restock shelf management |
| `/member/report` | Member issue report form |
| `/audit` | Admin audit tools |
| `/roster` | Admin member roster |
| `/storage` | Storage zone/shelf/container management |

### Shared Components
Key reusable components in `app/components/`:
- `appnavbar.tsx` — global nav; assets/statpacks admin links are gated with `{isAdmin && ...}`
- `statpack-checkoff-modal.tsx` — shared between admin full-pack audits and member pocket verification; `skipLogging={true}` + `pocketName` props put it in pocket mode
- `tutorial-overlay.tsx` — first-login onboarding overlay (6 steps); marks `tutorialCompleted` on the user doc when finished

### Statpack Checkout / Check-in / Audit Flow
All three modes share one page: `app/statpacks/check-off/page.tsx` (static route). The checkout and check-in list pages (`/statpacks/checkout`, `/statpacks/checkin`) let the member pick a pack, then navigate to `/statpacks/check-off?id=<packId>&mode=<checkout|checkin>`. The admin detail page (`/statpacks/[id]`) links to `?mode=audit`.

The check-off page reads `id` and `mode` from `window.location.search` (not `useSearchParams` — avoids Suspense) and manages the full pocket-by-pocket flow locally before calling `logStatpackCheckOff` once at the end.

**`output: export` routing constraint:** All pack IDs are Firestore runtime IDs not known at build time, so dynamic `[id]/checkoff` routes cannot work. The pattern is: static route + query params. Always use `/statpacks/check-off?id=${packId}&mode=${mode}` — never a nested `[id]` segment — when navigating to the verification flow.

### Firestore Collections (notable)
`inventory`, `statpacks`, `statpack_logs`, `assets`, `restock_shelves`, `restock_logs`, `audit_events`, `issue_reports`, `buy_list`, `tasks`, `users`, `storage_zones`, `shelves`, `containers`, `box_logs`, `medication_logs`

### Business Logic Helpers
`app/lib/` contains pure helpers for audits (`audit.ts`, `audit-helpers.ts`), statpack operations (`statpacks.ts`), inventory (`inventory.ts`), logging (`logs.ts`), reporting (`reports.ts`), and PDF/label printing (`print.ts`).
