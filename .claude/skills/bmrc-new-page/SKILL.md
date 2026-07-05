---
name: bmrc-new-page
description: >
  How to add a new page, route, or feature surface to the BMRC Logistics app —
  routing under static export, nav registration, role gating, Firestore
  subscription patterns, and page skeleton. USE THIS SKILL when creating a new
  route/page/screen/tab, adding a nav entry, wiring auth/role checks, or
  navigating between pages. Keywords: new page, new route, add page, nav,
  sidebar link, navigation, App Router, dynamic route, query params, role,
  admin gate, useUserRole, onSnapshot, redirect, static export.
---

# Adding a Page / Route to BMRC Logistics

Next.js 16 App Router, all routes under `app/` (no `src/`). Every page is a
`'use client'` component talking straight to Firestore. For anything visual,
**also invoke the `bmrc-ui` skill** — this skill covers wiring, not styling.

## Routing under `output: 'export'` (the #1 constraint)

`next.config.ts` sets `output: 'export'` + `trailingSlash: true`. The app is
**fully static** — every route must be known at build time:

- **No dynamic segments for runtime IDs.** Firestore IDs don't exist at build
  time, so `app/foo/[id]/page.tsx` cannot be added for them. The repo pattern
  is **static route + query params**: `/foo/detail?id=<docId>`.
  (The existing `/statpacks/[id]` predates this and uses `generateStaticParams`
  workarounds — do not copy it for new work.)
- **Read query params from `window.location.search`**, not `useSearchParams()`
  — the hook forces a Suspense boundary that breaks under static export.
  Canonical example: `app/statpacks/check-off/page.tsx`.

```tsx
const [params, setParams] = useState<{ id?: string }>({});
useEffect(() => {
  const sp = new URLSearchParams(window.location.search);
  setParams({ id: sp.get('id') ?? undefined });
}, []);
```

- No API routes, no server actions, no server components with data. Guard all
  browser-only code with `typeof window !== 'undefined'` if it can run at
  build/SSR time.

## Page skeleton

```tsx
'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { collection, onSnapshot, query } from 'firebase/firestore';
import { db } from '@/firebase';
import { useUserRole } from '@/app/hooks/useUserRole';
import { useOrgConfig } from '@/app/hooks/useOrgConfig';

export default function FooPage() {
  const router = useRouter();
  const { user, role, loading: authLoading } = useUserRole();
  const isAdmin = role === 'admin' || role === 'quartermaster';
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) { router.push('/login'); return; }
    const unsub = onSnapshot(query(collection(db, 'inventory')), snap => {
      setItems(snap.docs.map(d => hydrateItem({ id: d.id, ...d.data() })));
    });
    return () => unsub();
  }, [user, authLoading, router]);
  // … render (see bmrc-ui for layout/loading patterns)
}
```

Rules baked into that skeleton:

- **Auth/role:** `useUserRole()` (`app/hooks/useUserRole.tsx`) is the single
  source of auth state — `{ user, userData, role, loading }`. Admin check is
  always `role === 'admin' || role === 'quartermaster'`. Admin-only pages
  redirect or render a member variant (see `app/dashboard/page.tsx`). Nav
  links to admin pages are additionally gated with `{isAdmin && …}`.
- **Data:** real-time `onSnapshot` listeners, never one-shot fetch loops, and
  **always return the unsubscribe** from `useEffect`. Convert Firestore
  `Timestamp`s to `Date` on read (`.toDate()`) before passing docs to the
  `item-status.ts` helpers.
- **Config:** lists/thresholds via `useOrgConfig()` or
  `getInventoryAreaOptions()` **called inside render** — never at module
  scope, never from the frozen constants (see **bmrc-org-config**).
- **Domain writes:** go through `app/lib/` helpers; see **bmrc-domain** /
  **bmrc-audit-workbench** / **bmrc-statpack-flows** before writing Firestore
  directly.

## Register the page in navigation

1. **Sidebar:** add a `NavItem` to `ADMIN_NAV` (or `MEMBER_NAV`) in
   `app/components/app-sidebar.tsx` — sections: Dashboard / Assets /
   Inventory / Admin. Icon from `lucide-react`.
2. **Mobile:** the shared bottom bar is `app/components/mobile-bottom-nav.tsx`
   (role-aware; admin overflow lives in its "More" sheet — a sidebar entry is
   usually enough).
3. **Exceptions:** full-screen flows with their own sticky footer must be
   added to `NO_BOTTOM_NAV_PATHS` in `app/components/sidebar-layout.tsx`;
   unauthenticated pages to `NO_SIDEBAR_PATHS`.

## Local testing

- `npm run dev:emulator` + `npm run seed` runs the app against the Firestore
  emulator with seeded data (never develop against prod; see **bmrc-testing**).
- Fake any role without re-login: set `localStorage.bmrc_role_override` to a
  role string (`'admin'`, `'member'`, …) — the hook picks it up via the
  `bmrc-role-changed` event and `storage` events. The sidebar has a built-in
  toggle. Remove the key to restore your real role.

## Ship checklist

1. `npm run build` passes — static export catches routing violations
   (`useSearchParams`, dynamic segments) that `dev` tolerates.
2. `npm run lint` clean.
3. Page renders in both roles (override trick) and both themes, and at ~360 px
   width with no horizontal scroll (see **bmrc-ui**'s responsive section).
4. Nav entry appears for the right roles; deep-link with query params works on
   a hard reload (not just client navigation).
