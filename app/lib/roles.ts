/**
 * Role capabilities (platform-overhaul plan §2).
 *
 * This file is the ONLY place that maps a role string to what that role may do.
 * Pages, components and libs call these functions; they never compare role
 * strings inline (`role === 'admin' || role === 'quartermaster'` is exactly the
 * pattern this replaces).
 *
 * Deliberately PURE: no Firebase, no React, no org-config imports. That keeps it
 * usable from pages, libs, scripts and tests alike, and keeps the org-config
 * <-> store import cycle out of it. Anything configurable (only
 * `privateFinanceRoles` today) is passed in by the caller, who reads the live
 * value via `getPrivateFinanceRolesRuntime()` / `useOrgConfig()`.
 *
 * Role params are typed `string | null | undefined` (not the `User['role']`
 * union) on purpose: call sites hold roles as `User['role'] | null`,
 * `string | undefined` (actor objects) or `userData?.role`, and the old inline
 * comparisons accepted all of those. An unknown/absent role is always `false`.
 *
 * Matrix (plan §2):
 *
 * | Capability            | admin | QM | treasurer | medops                      | member |
 * |-----------------------|-------|----|-----------|-----------------------------|--------|
 * | canManageLogistics    |  yes  | yes|           |                             |        |
 * | canViewLogistics      |  yes  | yes|    yes    | inventory + expirations only|        |
 * | canRecordPayment      |  yes  |    |    yes    |                             |        |
 * | canRequestSupplies    |  yes  | yes|           |            yes              |        |
 * | canSeePrivateFinance  |  yes  | cfg|    cfg    |            cfg              |        |
 * | canManageEvents       |  yes  | yes|           |            yes              |        |
 *
 * `inventory_helper`, `FTO`, `fto_intern` and `member` hold NO capability here.
 * Their existing behavior (audit, restock, statpack checkout) is gated by other
 * mechanisms (`canAudit`, `AUDIT_ROLES`, per-page role lists) that this file does
 * not replace.
 */

/** Default for `org_settings.privateFinanceRoles`: admin only (plan §8, resolved). */
export const DEFAULT_PRIVATE_FINANCE_ROLES: readonly string[] = ['admin'];

/**
 * The roles that hold `canManageLogistics`. Exported ONLY for places that need
 * the role set as data, e.g. a Firestore `where('role', 'in', [...])` recipient
 * query. Everything else must call `canManageLogistics(role)`.
 */
export const MANAGE_LOGISTICS_ROLES: readonly string[] = ['admin', 'quartermaster'];

/**
 * Purchases, inventory, assets, statpacks, uniforms: the old `isAdmin`.
 * `medops` and `treasurer` are intentionally NOT included (decisions.md D-13).
 */
export function canManageLogistics(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'quartermaster';
}

/** How much of the logistics surface a role may READ. */
export type LogisticsViewScope = 'full' | 'inventory_expirations' | 'none';

/**
 * Full read access to logistics surfaces: admin, quartermaster, treasurer.
 * `medops` is `false` here: its read access is the narrower
 * `'inventory_expirations'` scope, see `getLogisticsViewScope`.
 */
export function canViewLogistics(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'quartermaster' || role === 'treasurer';
}

/**
 * The medops-scoped variant of `canViewLogistics`: what subset of logistics a
 * role may read. `'full'` for admin/QM/treasurer, `'inventory_expirations'` for
 * medops (inventory + expiration views ONLY, never purchases, assets, storage,
 * finance), `'none'` for everyone else.
 *
 * Consumers gate a specific surface with `canViewLogisticsArea` below rather than
 * switching on the scope string themselves.
 */
export function getLogisticsViewScope(role: string | null | undefined): LogisticsViewScope {
  if (canViewLogistics(role)) return 'full';
  if (role === 'medops') return 'inventory_expirations';
  return 'none';
}

/** Logistics areas a scoped reader may be allowed into. */
export type LogisticsArea = 'inventory' | 'expirations' | 'purchases' | 'assets' | 'storage' | 'finance' | 'uniforms';

/**
 * May `role` read this logistics `area`? `'full'` scope reads everything;
 * `'inventory_expirations'` scope (medops) reads only `inventory` + `expirations`.
 */
export function canViewLogisticsArea(role: string | null | undefined, area: LogisticsArea): boolean {
  const scope = getLogisticsViewScope(role);
  if (scope === 'full') return true;
  if (scope === 'inventory_expirations') return area === 'inventory' || area === 'expirations';
  return false;
}

/** Mark paid / reimbursed / payment confirmed. Admin and treasurer only. */
export function canRecordPayment(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'treasurer';
}

/** File a supply request into `buyList`. Admin, quartermaster, medops. */
export function canRequestSupplies(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'quartermaster' || role === 'medops';
}

/**
 * Payee names + Zelle/Venmo handles (the `…/private/*` docs).
 *
 * `admin` is ALWAYS allowed: an admin can't lock themselves out by editing the
 * setting. Every other role (quartermaster, treasurer, medops, …) is allowed only
 * if the org lists it in `org_settings.privateFinanceRoles`. Pass the live list
 * from `getPrivateFinanceRolesRuntime()` / `useOrgConfig().privateFinanceRoles`;
 * when omitted it falls back to the default (admin only).
 */
export function canSeePrivateFinance(
  role: string | null | undefined,
  privateFinanceRoles: readonly string[] = DEFAULT_PRIVATE_FINANCE_ROLES,
): boolean {
  if (!role) return false;
  if (role === 'admin') return true;
  return privateFinanceRoles.includes(role);
}

/**
 * Create / edit / staff events, roster status. Same role set as
 * `isEventManagerRole` in app/lib/events.ts (admin | quartermaster | medops).
 *
 * Duplicated rather than imported because events.ts is a `'use client'` module
 * that pulls in the Firebase SDK, which would make this file impure. Keep the two
 * in lockstep; `scripts/test-roles.ts` asserts they agree.
 */
export function canManageEvents(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'quartermaster' || role === 'medops';
}
