## Purpose

This file gives AI coding assistants the minimal, actionable context needed to be productive in the BMRC Logistics Next.js app.

## Big picture

- Framework: Next.js app directory (app/) using React 19 and TypeScript.
- Hosting: The repo is configured to export a static site (see [next.config.ts](next.config.ts)). `firebase.json` expects the static export in `out/`.
- Auth + DB: Firebase Auth + Firestore are the primary backend services (see [firebase.ts](firebase.ts)).
- UI: Uses `@heroui/react` components plus `next-themes` for theming. Global providers are in [app/providers.tsx](app/providers.tsx).

## Key files you should read first

- App shell + navbar: [app/layout.tsx](app/layout.tsx) and [app/components/appnavbar.tsx](app/components/appnavbar.tsx) — show how auth sync and routing are wired.
- Firebase initialization and required env keys: [firebase.ts](firebase.ts).
- Static export / hosting: [next.config.ts](next.config.ts) and [firebase.json](firebase.json).
- Central types / domain model: [app/types.ts](app/types.ts) — defines InventoryItem, Statpack, User, and log shapes used across UI and Firestore.
- Scripts & deps: [package.json](package.json) — dev/build/start/lint commands and dependency versions.

## Developer workflows & commands

- Start dev server: `npm run dev` (Next app uses port 3000 by default). See README.md.
- Build for production (static export):
  - `npm run build` (runs `next build`) — with `output: 'export'` Next may emit static files to `out/`.
  - If `out/` missing, run `npx next export` after `npm run build` to produce `out/` for Firebase hosting.
- Deploy to Firebase hosting: ensure `out/` exists then `firebase deploy` (the failing `firebase deploy` you ran likely indicates `out/` was not present).
- Lint: `npm run lint` (uses `eslint`).

## Environment variables

- Create a local `.env.local` with the NEXT*PUBLIC*\* keys referenced in [firebase.ts](firebase.ts):
  - `NEXT_PUBLIC_FIREBASE_API_KEY`
  - `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
  - `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
  - `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
  - `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
  - `NEXT_PUBLIC_FIREBASE_APP_ID`
  - `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` (optional)
- Avoid committing `.env.local` to git.

## Project-specific conventions & patterns

- Client-first components: files that use browser-only APIs or hooks include `'use client'` at top (see [app/providers.tsx](app/providers.tsx) and many components). Keep server components free of client-only code.
- Firebase usage: `firebase.ts` exports `auth` and `db`. Most components import `auth`/`db` from `@/firebase` and use client-side SDKs (e.g., `onAuthStateChanged`, `getDoc`, `setDoc`) — check [app/components/appnavbar.tsx](app/components/appnavbar.tsx) for the canonical auth-sync pattern.
- Types: shared interfaces live in [app/types.ts](app/types.ts). Use these to keep Firestore read/writes consistent (InventoryItem, Statpack, StatpackLog, User).
- Theming & navigation: `HeroUIProvider` wraps the app in [app/providers.tsx](app/providers.tsx) and navigation uses `next/navigation` helpers. Keep navigation side-effects within client components.

## Integration points and gotchas

- Static export: `next.config.ts` sets `output: 'export'` and `trailingSlash: true`. This influences routing and hosting (relative paths). When changing pages, verify exported URLs in `out/`.
- Analytics: initialized only on the client in [firebase.ts](firebase.ts) — be cautious when referencing `analytics` in SSR paths.
- Firestore serverTimestamp: code sometimes uses `serverTimestamp()` (see navbar). Tests or mocks should account for Firestore sentinel values.
- Missing `.env.local.example`: the repo references an example but none exists; create `.env.local` manually from keys above.

## How to ask for changes from humans

- When you need missing secrets, ask: "Please provide Firebase project env vars or a `.env.local.example` to proceed."
- When you change types in `app/types.ts`, request a brief migration note because schema changes must align with Firestore documents.

```markdown
## Purpose

This file gives AI coding assistants the minimal, actionable context needed to be productive in the BMRC Logistics Next.js app — a student-focused logistics platform that models real EMS/ambulance inventory workflows (e.g., Falck-style operations).

## Big picture

- Framework: Next.js app directory (`app/`) using React 19 + TypeScript. UI components are a mix of server and client components.
- Hosting: App is exported as a static site (`next.config.ts` sets `output: 'export'`) and hosted via Firebase Hosting; the static export should land in `out/` (see `firebase.json`).
- Backend: Firebase Auth + Firestore are used exclusively for auth and data (`firebase.ts` exports `auth` and `db`). Analytics initialized only on the client.

## Domain & notable business rules (important)

- Asset vs Disposable policy: items below a dollar threshold are treated as disposables (tracked as unopened boxes only). Items above that threshold are assets requiring full lifecycle tracking (status, maintenance reason, and location).
- Disposables workflow: unopened boxes are stored in the back; when a box is opened it is considered "used" (even if physically moved to a front shelf). Opened boxes are moved to the front for members to restock statpacks; only unopened box counts are kept for disposables.
- Assets workflow: track `status`, `maintenanceReason`, `location`, and history logs (see `app/types.ts` for `InventoryItem`, `Statpack`, and related types). Treat asset state transitions carefully; Firestore documents mirror these types.

## Key files (read first)

- App shell & auth: [app/layout.tsx](app/layout.tsx) and [app/components/appnavbar.tsx](app/components/appnavbar.tsx) — auth sync + routing.
- Firebase init: [firebase.ts](firebase.ts) — env keys and exported `auth`/`db`.
- Types & domain model: [app/types.ts](app/types.ts) — canonical interfaces (InventoryItem, Statpack, StatpackLog, User).
- Important UX components: [app/components/statpackvisualizer.tsx](app/components/statpackvisualizer.tsx), `additemmodal.tsx`, `assetmodal.tsx`, and `restock-*` modals in `app/components/` illustrate how disposables vs assets are presented to users.
- Data helpers: `app/lib/inventory.ts` and `app/lib/audit.ts` — show Firestore reads/writes and audit/event shapes.
- Scripts & migrations: `scripts/` contains utilities used for inventory normalization and migrations; useful when changing types or Firestore structure.

## Developer workflows & commands

- Dev server: `npm run dev` (Next dev server, port 3000).
- Build & static export: `npm run build` then `npx next export` (if `out/` not produced automatically). Confirm `out/` exists before `firebase deploy`.
- Deploy: `firebase deploy` (requires `out/` and Firebase CLI auth).
- Linting: `npm run lint`.

## Environment variables

- Create `.env.local` with the `NEXT_PUBLIC_FIREBASE_*` keys used by `firebase.ts`.

## Project-specific conventions & patterns

- Client/server boundary: Components that use browser APIs include `'use client'` at the top. Keep server components free of client-only hooks.
- Firebase usage: Use `auth`/`db` imported from `@/firebase`. Most data flows are client-driven (onAuthStateChanged, getDoc/setDoc). Follow patterns in `app/components/appnavbar.tsx`.
- Types-first: Use interfaces in `app/types.ts` as the source of truth for Firestore documents. When updating types, coordinate a data migration or update `scripts/` utilities.

## Integration points & gotchas

- Static export implications: `trailingSlash: true` and `output: 'export'` affect URLs; validate exported routes in `out/` after build.
- Firestore sentinels: code uses `serverTimestamp()` in places — tests/mocks must accommodate sentinel values.
- Missing `.env.local.example`: create one or provide envs to run locally.

## Examples (where to look for patterns)

- Auth sync: [app/components/appnavbar.tsx](app/components/appnavbar.tsx)
- Inventory read/write and normalizations: [app/lib/inventory.ts](app/lib/inventory.ts), `scripts/normalize-inventory.js`
- Statpack interactions and disposable handling: [app/components/statpackvisualizer.tsx](app/components/statpackvisualizer.tsx) and `app/components/restock-alert-modal.tsx`

## How to request help from humans

- Missing secrets or Firebase access: "Please provide Firebase project env vars or a `.env.local.example`."
- Types/schema changes: ask for a brief migration note describing Firestore doc changes and whether `scripts/` migration utilities should run.

End of guidance
```
