'use client';

/**
 * Runtime organization-config store.
 *
 * Holds the *live* org configuration as a module-level singleton so that both
 * React components (via useOrgConfig) and pure library functions (item-status,
 * inventory, and the org-config helper fns themselves) read the same
 * admin-overridable values.
 *
 * The static constants in `app/config/org-config.ts` are the DEFAULTS/seed —
 * they always work offline, during SSR/static export, and for a fresh agency.
 * Firestore overrides (doc `org_settings/current`) are shallow-merged on top.
 *
 * Circular-import note: this file imports `DEFAULT_ORG_CONFIG` from org-config,
 * and org-config imports the getters below. That cycle is safe because the
 * runtime state is initialised lazily — `DEFAULT_ORG_CONFIG` is only read
 * inside function bodies (never at module-eval time), so there is no TDZ hazard
 * regardless of which module is evaluated first.
 */

import { doc, onSnapshot, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '@/firebase';
import {
  DEFAULT_ORG_CONFIG,
  type OrgConfigDoc,
  type ThresholdConfig,
  type LocationDef,
  type AssetCategoryDef,
  type StatpackTypeDef,
  type VehicleDef,
  type OrgInfo,
  type VenueDef,
  type WaitlistConfig,
  type CancellationPolicyConfig,
  type PriorityTierConfig,
  type ShiftReminderConfig,
  type TermDef,
  type NotificationDeliveryConfig,
} from '@/app/config/org-config';

export type { OrgConfigDoc } from '@/app/config/org-config';

/** Firestore document that holds the live overrides. */
export const ORG_CONFIG_DOC_PATH = 'org_settings/current';
const ORG_CONFIG_COLLECTION = 'org_settings';
const ORG_CONFIG_DOC_ID = 'current';
const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Runtime singleton (lazily initialised — see circular-import note above)
// ---------------------------------------------------------------------------

let _runtime: OrgConfigDoc | undefined;

/** Prefer a non-empty override array; otherwise fall back to the default. */
function pickArray<T>(v: T[] | undefined, fallback: T[]): T[] {
  return Array.isArray(v) && v.length > 0 ? v : fallback;
}

/**
 * Like `pickArray`, but treats an explicitly-saved **empty** list as a real
 * value rather than as "unset".
 *
 * `pickArray`'s empty-means-default rule is right for lists an org always has
 * (locations, venues, item categories): an empty one is a corrupt doc, and
 * restoring the defaults is the recovery. It is WRONG for opt-out lists, where
 * emptying the list is exactly how an admin turns the behaviour off. Under
 * `pickArray`, deleting every reminder row silently restores `[48, 12]` and
 * reminders keep firing; deleting every default tier row silently restores the
 * shipped tier, so every new event sprouts windows the admin removed. Both
 * read as "the settings page ignored my edit" — the failure the org-config
 * system exists to prevent (P11: a behaviour that can only be changed by
 * editing TypeScript is a defect in the plan, not a simplification).
 *
 * `undefined` still falls back — that is a doc that has never set the key, not
 * an admin choosing emptiness. Firestore round-trips `[]` faithfully and
 * `deepRemoveUndefined` preserves it, so the two stay distinguishable.
 */
function pickList<T>(v: T[] | undefined, fallback: T[]): T[] {
  return Array.isArray(v) ? v : fallback;
}

/**
 * Merge a (possibly partial/absent) override doc over the defaults and store
 * the result as the live runtime config. Any missing or empty top-level key
 * falls back to its default, so this never throws on a partial doc.
 *
 * [Phase 0 / waitlist plan §4.1] `waitlist`, `cancellationPolicy`,
 * `priorityTiers`, `shiftReminders`, `terms`, and `notificationDelivery` are
 * NESTED objects (some two/three levels deep: `waitlist.copy`,
 * `priorityTiers.defaultTiers[].criteria`, `notificationDelivery.email`), so
 * a whole-object fallback (`data.waitlist ?? d.waitlist`) is wrong for them:
 * if an org has customized *anything* in `waitlist`, `data.waitlist` is
 * truthy and the entire stale saved object wins outright — any key added to
 * `WAITLIST_DEFAULTS.copy` after that org saved would read `undefined`
 * forever, rendering silently blank with no error anywhere. The fix is a
 * NESTED merge: every nested object gets its own spread line so a missing key
 * falls through to the current code default field-by-field, and every array
 * (`defaultTiers`, `hoursBefore`, `channels`, `terms`) is taken wholesale via
 * `pickList` (NOT `pickArray` — these are opt-out lists where an explicit
 * empty list is a real admin choice) rather than element-merged — element-wise merging a list the
 * admin can reorder/delete would resurrect zombie entries.
 */
export function applyOrgConfigDoc(data: Partial<OrgConfigDoc> | undefined): void {
  const d = DEFAULT_ORG_CONFIG;
  if (!data) {
    _runtime = d;
    return;
  }
  _runtime = {
    org: { ...d.org, ...(data.org ?? {}) },
    locations: pickArray(data.locations, d.locations),
    vehicles: pickArray(data.vehicles, d.vehicles),
    assetCategories: pickArray(data.assetCategories, d.assetCategories),
    statpackTypes: pickArray(data.statpackTypes, d.statpackTypes),
    itemCategories: pickArray(data.itemCategories, d.itemCategories),
    itemFamilies: pickArray(data.itemFamilies, d.itemFamilies),
    thresholds: { ...d.thresholds, ...(data.thresholds ?? {}) },
    venues: pickArray(data.venues, d.venues),
    eventTypes: pickArray(data.eventTypes, d.eventTypes),
    semesterStartDate: data.semesterStartDate || d.semesterStartDate,
    requireCertsForShiftSignup:
      typeof data.requireCertsForShiftSignup === 'boolean'
        ? data.requireCertsForShiftSignup
        : d.requireCertsForShiftSignup,
    waitlist: {
      ...d.waitlist,
      ...(data.waitlist ?? {}),
      copy: { ...d.waitlist.copy, ...(data.waitlist?.copy ?? {}) },
    },
    cancellationPolicy: { ...d.cancellationPolicy, ...(data.cancellationPolicy ?? {}) },
    priorityTiers: {
      ...d.priorityTiers,
      ...(data.priorityTiers ?? {}),
      // Array of objects: take the saved list wholesale or fall back — do NOT element-merge.
      defaultTiers: pickList(data.priorityTiers?.defaultTiers, d.priorityTiers.defaultTiers),
    },
    shiftReminders: {
      ...d.shiftReminders,
      ...(data.shiftReminders ?? {}),
      hoursBefore: pickList(data.shiftReminders?.hoursBefore, d.shiftReminders.hoursBefore),
      channels: pickList(data.shiftReminders?.channels, d.shiftReminders.channels),
    },
    terms: pickList(data.terms, d.terms),
    notificationDelivery: {
      ...d.notificationDelivery,
      ...(data.notificationDelivery ?? {}),
      email: { ...d.notificationDelivery.email, ...(data.notificationDelivery?.email ?? {}) },
    },
  };
}

// ---------------------------------------------------------------------------
// Getters — used by the org-config helper fns and pure libs
// ---------------------------------------------------------------------------

export function getRuntimeConfig(): OrgConfigDoc {
  return _runtime ?? DEFAULT_ORG_CONFIG;
}

export function getThresholds(): ThresholdConfig {
  return getRuntimeConfig().thresholds;
}

export function getLocationsRuntime(): LocationDef[] {
  return getRuntimeConfig().locations;
}

export function getItemCategoriesRuntime(): string[] {
  return getRuntimeConfig().itemCategories;
}

export function getItemFamiliesRuntime(): string[] {
  return getRuntimeConfig().itemFamilies;
}

export function getAssetCategoriesRuntime(): AssetCategoryDef[] {
  return getRuntimeConfig().assetCategories;
}

export function getStatpackTypesRuntime(): StatpackTypeDef[] {
  return getRuntimeConfig().statpackTypes;
}

export function getVehiclesRuntime(): VehicleDef[] {
  return getRuntimeConfig().vehicles;
}

export function getOrgInfoRuntime(): OrgInfo {
  return getRuntimeConfig().org;
}

export function getVenuesRuntime(): VenueDef[] {
  return getRuntimeConfig().venues;
}

export function getEventTypesRuntime(): string[] {
  return getRuntimeConfig().eventTypes;
}

export function getSemesterStartRuntime(): string {
  return getRuntimeConfig().semesterStartDate;
}

export function getRequireCertsRuntime(): boolean {
  return getRuntimeConfig().requireCertsForShiftSignup;
}

// [Phase 0 / waitlist plan §4.1] — same one-line pattern as the getters above.
export function getWaitlistRuntime(): WaitlistConfig {
  return getRuntimeConfig().waitlist;
}

export function getCancellationPolicyRuntime(): CancellationPolicyConfig {
  return getRuntimeConfig().cancellationPolicy;
}

export function getPriorityTiersRuntime(): PriorityTierConfig {
  return getRuntimeConfig().priorityTiers;
}

export function getShiftRemindersRuntime(): ShiftReminderConfig {
  return getRuntimeConfig().shiftReminders;
}

export function getTermsRuntime(): TermDef[] {
  return getRuntimeConfig().terms;
}

export function getNotificationDeliveryRuntime(): NotificationDeliveryConfig {
  return getRuntimeConfig().notificationDelivery;
}

// ---------------------------------------------------------------------------
// Firestore I/O (client-only; guarded for SSR/static export)
// ---------------------------------------------------------------------------

function configDocRef() {
  return doc(db, ORG_CONFIG_COLLECTION, ORG_CONFIG_DOC_ID);
}

/**
 * Subscribe to the live config doc. On every snapshot, merges the doc over the
 * defaults and invokes `cb` with the resulting runtime config. Returns an
 * unsubscribe fn. Safe on the server — it applies defaults once and no-ops.
 */
export function subscribeOrgConfig(cb: (cfg: OrgConfigDoc) => void): () => void {
  if (typeof window === 'undefined') {
    applyOrgConfigDoc(undefined);
    cb(getRuntimeConfig());
    return () => {};
  }
  return onSnapshot(
    configDocRef(),
    (snap) => {
      applyOrgConfigDoc(snap.exists() ? (snap.data() as Partial<OrgConfigDoc>) : undefined);
      cb(getRuntimeConfig());
    },
    (err) => {
      console.warn('subscribeOrgConfig: snapshot error', err);
      cb(getRuntimeConfig());
    },
  );
}

/**
 * Seed the config doc with defaults if it does not exist yet. Non-admins can't
 * write, so permission errors are swallowed (the app still works off defaults).
 */
export async function seedOrgConfigIfMissing(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    const ref = configDocRef();
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        ...DEFAULT_ORG_CONFIG,
        schemaVersion: SCHEMA_VERSION,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (e) {
    // Non-admins can't write org_settings; that's expected — swallow.
    console.warn('seedOrgConfigIfMissing: skipped', e);
  }
}

// ---------------------------------------------------------------------------
// Public write API (imported by the Settings UI)
// ---------------------------------------------------------------------------

/**
 * Merge-write a partial config patch to `org_settings/current`, stamping the
 * actor and time. Only the provided keys are changed.
 */
export async function saveOrgConfig(
  patch: Partial<OrgConfigDoc>,
  actor: { uid: string; name: string },
): Promise<void> {
  await setDoc(
    configDocRef(),
    { ...patch, updatedAt: serverTimestamp(), updatedBy: actor },
    { merge: true },
  );
}

/**
 * Overwrite the config doc with the built-in defaults (audit-stamped).
 */
export async function resetOrgConfigToDefaults(
  actor: { uid: string; name: string },
): Promise<void> {
  await setDoc(configDocRef(), {
    ...DEFAULT_ORG_CONFIG,
    schemaVersion: SCHEMA_VERSION,
    updatedAt: serverTimestamp(),
    updatedBy: actor,
  });
}
