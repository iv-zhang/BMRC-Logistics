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

## If something is unclear

- Tell me which area (deployment, auth, data model, UI component) you want clarified and I will update this guide or open the most relevant files.

End of guidance
