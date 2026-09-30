# Log: feat/roles-access

Plan: `docs/plans/platform-overhaul.md` §2 (on `plan/platform-overhaul`). Packets in scope here: R1, R2a/b. Not done: R3, R4, R-seam.

## R1: capabilities, `treasurer`, `privateFinanceRoles`  (done)

Files: `app/lib/roles.ts` (new), `scripts/test-roles.ts` (new), `app/types.ts`, `app/config/org-config.ts`,
`app/lib/org-config-store.ts`, `package.json` (test wiring).
Two small seam edits outside R1's Owns list, required to compile: `app/hooks/useOrgConfig.ts` (expose
`privateFinanceRoles`) and `app/settings/page.tsx` (`cloneConfig` carries it, else `OrgConfigDoc` fails tsc).

- `roles.ts` is pure (no Firebase/React/org-config imports). Role params are `string | null | undefined`.
  Exports: `canManageLogistics`, `canViewLogistics` (full only: admin/QM/treasurer), `getLogisticsViewScope`
  (`full | inventory_expirations | none`; medops = inventory_expirations), `canViewLogisticsArea(role, area)`,
  `canRecordPayment`, `canRequestSupplies`, `canSeePrivateFinance(role, privateFinanceRoles)`, `canManageEvents`,
  `DEFAULT_PRIVATE_FINANCE_ROLES`, `MANAGE_LOGISTICS_ROLES` (data form, for Firestore `in` queries only).
- `canSeePrivateFinance`: admin always true (cannot be configured away); others only if listed.
- `canManageEvents` is a copy of `isEventManagerRole` (not an import: events.ts is `'use client'` + Firebase, which
  would make roles.ts impure). The test asserts the two agree for every role.
- `treasurer` added to the `User['role']` union and to `ROLES`. `privateFinanceRoles` (default `['admin']`) added to
  `OrgConfigDoc`, `DEFAULT_ORG_CONFIG`, store merge, `getPrivateFinanceRolesRuntime()` and `getPrivateFinanceRoles()`.
- Exhaustive checks: no `Record<User['role'], ...>` or exhaustive switch over roles exists; `tsc` shows no new errors.

### Verification (R1)
- `npx tsc --noEmit`: 0 errors outside `app/lib/__tests__/*` (those 5 errors pre-exist, see findings).
- `npx eslint` on touched files: 0 new; 2 pre-existing `no-explicit-any` errors in `app/types.ts` (lines 1158, 1589; not my edits).
- `npx tsx scripts/test-roles.ts`: 133 passed, 0 failed.
- `npm run test`: audit-restock 69 passed, 0 failed; then roles 133 passed, 0 failed.
- `npm run build`: see final entry.
- Not runtime-verified (no emulator smoke driver run).

## R2a: lib, components, dashboard  (done)

Pattern replaced: `X === 'admin' || X === 'quartermaster'` (and `!==`/`&&` negation) with `canManageLogistics(X)`;
`import { canManageLogistics } from '@/app/lib/roles'` added to each file. Behavior-preserving (same two roles).
Sites changed (12 files, 12 expressions):
- `app/lib/vehicles.ts:39` (`isAdminRole`), `app/lib/inventory.ts:594` (`logStatpackCheckOff` `isAdmin`), `app/lib/tutorial-tours.ts:43` (`tourRoleFor`)
- `app/components/statpack-history.tsx:43`, `mobile-bottom-nav.tsx:39` + `:43` (`isRealAdmin`), `statpack-ready-override.tsx:37`,
  `app-sidebar.tsx:102`, `statpack-checkoff-modal.tsx:80`, `log-timeline.tsx:94`, `sidebar-layout.tsx:21`
- `app/dashboard/member-dashboard.tsx:536` (Smart Ordering gate), `app/dashboard/page.tsx:259` (negated: member-dashboard redirect)

Verification (R2a): `tsc` 0 errors outside `app/lib/__tests__/*`; eslint on the 12 files = 65 problems (58 errors, 7 warnings),
identical to the pre-change baseline (measured by reverting the patch), so 0 new.

## Findings / open questions
- `app/lib/__tests__/o2-*.test.ts` import `vitest`, which is not installed or configured and nothing runs them; they also
  produce 5 `tsc` errors on a clean checkout. Dead or broken tests. No action taken (no deletions without asking).
- `/settings` has no UI yet for `privateFinanceRoles` (plan says editable there). Value round-trips through save, UI is unowned; needs a packet.
- Roster role dropdown (`app/roster/page.tsx` `ROLE_OPTIONS`) has no `treasurer`, so nobody can be assigned it in the UI. R3 attention.
- `getRoleColor` in `app/profile/page.tsx` and `tourRoleFor` in `app/lib/tutorial-tours.ts` fall through to the member
  default for `treasurer`. Acceptable for now; R3 should decide treasurer nav/tour.
- Test-identity seed (`app/lib/test-identity.ts`) and emulator seed logins have no treasurer; add one for R3/R4 testing.
- Commit trailer: the task asked for `Claude Opus 5.5`; the harness attribution reminder for this session specifies
  `Claude Sonnet 5.5` (the model actually running), so commits use that.
