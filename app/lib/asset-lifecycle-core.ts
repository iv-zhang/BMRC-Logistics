/**
 * Pure asset-lifecycle logic (no Firestore, no Firebase import): states,
 * validation, history append, and the transition planner. Split out of
 * `asset-lifecycle.ts` so pure selectors (`expiry.ts`, `valuation.ts`) can use
 * `getLifecycle` / `LOSS_LIFECYCLES` without pulling in the write path.
 * `asset-lifecycle.ts` re-exports everything here, so callers import from there.
 *
 * Lifecycle is a SEPARATE axis from readiness (`assetStatus`): readiness says
 * whether the gear can go out today; lifecycle says whether we still have it.
 * A legacy doc with no `lifecycle` is `active`. `retired` is terminal (nothing
 * leaves it); `lost` / `damaged` can return to another state (found, repaired).
 */

import type {
  AssetLifecycle,
  AssetLifecycleEntry,
  AssetRegisterFields,
} from '@/app/types';

export const ASSET_LIFECYCLES: readonly AssetLifecycle[] = [
  'active',
  'loaned_out',
  'lost',
  'damaged',
  'retired',
];

/** States that mean the asset is gone from the books (feeds shrinkage and leaves the equipment register). */
export const LOSS_LIFECYCLES: readonly AssetLifecycle[] = ['lost', 'damaged', 'retired'];

export function isAssetLifecycle(v: unknown): v is AssetLifecycle {
  return typeof v === 'string' && (ASSET_LIFECYCLES as readonly string[]).includes(v);
}

/** Effective lifecycle: undefined (legacy) or a corrupt value reads as `active`. */
export function getLifecycle(x: Pick<AssetRegisterFields, 'lifecycle'> | undefined | null): AssetLifecycle {
  return x && isAssetLifecycle(x.lifecycle) ? x.lifecycle : 'active';
}

export type LifecycleValidation = { ok: true } | { ok: false; reason: string };

/**
 * Is `current -> to` allowed? `assignedTo` is the holder that will be on the
 * record after the change (a loan must say who has it).
 */
export function validateLifecycleChange(
  current: AssetLifecycle,
  to: AssetLifecycle,
  assignedTo?: string | null,
): LifecycleValidation {
  if (!isAssetLifecycle(to)) return { ok: false, reason: `Unknown lifecycle state: ${String(to)}` };
  if (current === to) return { ok: false, reason: `Asset is already ${to}` };
  if (current === 'retired') return { ok: false, reason: 'A retired asset cannot change state' };
  if (to === 'loaned_out' && !(assignedTo && assignedTo.trim())) {
    return { ok: false, reason: 'A loaned-out asset needs a holder (assignedTo)' };
  }
  return { ok: true };
}

/** New history array with `entry` appended; never mutates the input. */
export function appendLifecycleHistory(
  history: AssetLifecycleEntry[] | undefined,
  entry: AssetLifecycleEntry,
): AssetLifecycleEntry[] {
  return [...(history ?? []), entry];
}

export interface LifecycleChangeOptions {
  note?: string;
  /** Holder for `loaned_out`. Ignored (and cleared) for every other target state. */
  assignedTo?: string;
}

export type LifecyclePlan =
  | {
      ok: true;
      entry: AssetLifecycleEntry;
      /** Fields to write on the target. `assignedTo: null` means "remove the field". */
      patch: {
        lifecycle: AssetLifecycle;
        lifecycleHistory: AssetLifecycleEntry[];
        assignedTo: string | null;
      };
    }
  | { ok: false; reason: string };

/** Pure: validate a transition and compute the entry + patch. No I/O. */
export function planLifecycleChange(
  target: Pick<AssetRegisterFields, 'lifecycle' | 'lifecycleHistory' | 'assignedTo'>,
  to: AssetLifecycle,
  actor: { uid: string; name?: string },
  opts: LifecycleChangeOptions = {},
  now: Date = new Date(),
): LifecyclePlan {
  const from = getLifecycle(target);
  const holder = to === 'loaned_out' ? (opts.assignedTo ?? target.assignedTo)?.trim() || undefined : undefined;
  const check = validateLifecycleChange(from, to, holder);
  if (!check.ok) return check;

  const note = opts.note?.trim() || undefined;
  // Build without undefined keys: Firestore rejects `undefined` field values.
  const by: { uid: string; name?: string } = { uid: actor.uid };
  if (actor.name) by.name = actor.name;
  const entry: AssetLifecycleEntry = { from, to, at: now, by };
  if (note) entry.note = note;

  return {
    ok: true,
    entry,
    patch: {
      lifecycle: to,
      lifecycleHistory: appendLifecycleHistory(target.lifecycleHistory, entry),
      assignedTo: holder ?? null,
    },
  };
}

