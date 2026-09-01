'use client';

/**
 * Organization Configuration — Single source of truth for all customizable values.
 *
 * These constants are the DEFAULTS / seed: they always work offline, during
 * SSR/static export, and for a brand-new agency. A non-technical admin can
 * override most of them at runtime via Firestore (doc `org_settings/current`);
 * those overrides are shallow-merged on top by `app/lib/org-config-store.ts`.
 *
 * The exported helper FUNCTIONS below read from the RUNTIME config (live
 * overrides when present, defaults otherwise). The raw constant exports
 * (`LOCATIONS`, `THRESHOLDS`, …) represent the DEFAULTS only — prefer the
 * getters / `useOrgConfig()` for live reads.
 *
 * To customize the platform for a different org, vehicle fleet, or capability
 * level: edit this file (changes the defaults) or use the Settings UI (writes
 * runtime overrides). All dropdowns, filters, categories, and thresholds
 * auto-update. Zero code changes required for new locations, vehicles, etc.
 */

import {
  getLocationsRuntime,
  getAssetCategoriesRuntime,
  getStatpackTypesRuntime,
  getVehiclesRuntime,
  getVenuesRuntime,
  getEventTypesRuntime,
  getEventTemplatesRuntime,
  getSemesterStartRuntime,
  getRequireCertsRuntime,
  getWaitlistRuntime,
  getCancellationPolicyRuntime,
  getPriorityTiersRuntime,
  getShiftRemindersRuntime,
  getTermsRuntime,
  getNotificationDeliveryRuntime,
  getRuntimeConfig,
} from '@/app/lib/org-config-store';
// Type-only — see the reciprocal `import type { EventPolicyOverride }` in
// app/types.ts for why this circular type reference is safe under
// `isolatedModules` (both sides are fully erased at compile time).
import type { TierCriteria } from '@/app/types';

// ---------------------------------------------------------------------------
// Verification Field Definitions — what can be checked on an item
// ---------------------------------------------------------------------------

export interface VerificationFieldDef {
  /** Unique key used in code and Firestore */
  id: string;
  /** Human-readable label */
  label: string;
  /** Input type */
  type: 'boolean' | 'number' | 'date' | 'text' | 'select' | 'barcode_scan';
  /** Unit label (e.g., "PSI", "%") */
  unit?: string;
  /** For number type: min value */
  min?: number;
  /** For number type: max value */
  max?: number;
  /** For select type: allowed values */
  options?: string[];
  /** When true, blocks checkout/checkin if not filled */
  required?: boolean;
  /** Warn (yellow) vs block (red) on failure */
  severity?: 'warning' | 'critical';
  /** Threshold below which a warning is shown (for numeric fields) */
  warningThreshold?: number;
  /** Threshold below which it's critical (for numeric fields) */
  criticalThreshold?: number;
  /** Icon name from lucide-react */
  icon?: string;
}

export const VERIFICATION_FIELDS: Record<string, VerificationFieldDef> = {
  serial_scan: {
    id: 'serial_scan',
    label: 'Barcode / Serial Scan',
    type: 'barcode_scan',
    required: false,
    icon: 'ScanBarcode',
  },
  expiration_date: {
    id: 'expiration_date',
    label: 'Expiration Date',
    type: 'date',
    required: false,
    severity: 'critical',
    icon: 'CalendarClock',
  },
  battery_level: {
    id: 'battery_level',
    label: 'Battery Level',
    type: 'number',
    unit: '%',
    min: 0,
    max: 100,
    warningThreshold: 30,
    criticalThreshold: 10,
    severity: 'warning',
    icon: 'Battery',
  },
  o2_psi: {
    id: 'o2_psi',
    label: 'O₂ PSI Level',
    type: 'number',
    unit: 'PSI',
    min: 0,
    max: 2200,
    warningThreshold: 500,
    criticalThreshold: 200,
    severity: 'warning',
    icon: 'Gauge',
  },
  condition: {
    id: 'condition',
    label: 'Physical Condition',
    type: 'select',
    options: ['Good', 'Minor Issue', 'Major Issue', 'Needs Maintenance'],
    required: false,
    icon: 'ShieldCheck',
  },
  seal_intact: {
    id: 'seal_intact',
    label: 'Seal Intact',
    type: 'boolean',
    required: false,
    icon: 'Lock',
  },
  lot_number: {
    id: 'lot_number',
    label: 'Lot Number',
    type: 'text',
    required: false,
    icon: 'Hash',
  },
  power_on: {
    id: 'power_on',
    label: 'Powers On',
    type: 'boolean',
    required: false,
    icon: 'Power',
  },
  pads_sealed: {
    id: 'pads_sealed',
    label: 'Pads Sealed',
    type: 'boolean',
    required: false,
    icon: 'Package',
  },
};

// ---------------------------------------------------------------------------
// Location Definitions
// ---------------------------------------------------------------------------

export interface LocationDef {
  id: string;
  name: string;
  /** Broad type — maps to legacy LocationType */
  type: 'headquarters' | 'satellite' | 'vehicle' | 'event' | 'other';
  /** Sub-rooms / areas within this location */
  rooms: { id: string; name: string }[];
}

export const LOCATIONS: LocationDef[] = [
  {
    id: 'hq',
    name: 'HQ',
    type: 'headquarters',
    rooms: [
      { id: 'front', name: 'Front' },
      { id: 'forward_staging', name: 'Forward Staging' },
      { id: 'back_room', name: 'Back Room' },
      { id: 'med_cabinet', name: 'Med Cabinet' },
      { id: 'office', name: 'Office' },
    ],
  },
  { id: 'cpr_closet', name: 'CPR Closet', type: 'satellite', rooms: [] },
  { id: 'shed', name: 'Shed', type: 'satellite', rooms: [] },
  { id: 'other', name: 'Other', type: 'other', rooms: [] },
];

// ---------------------------------------------------------------------------
// Vehicle Types — extensible for future fleet changes
// ---------------------------------------------------------------------------

export interface VehicleDef {
  id: string;
  name: string;
  icon: string; // lucide-react icon name
  /** Whether this vehicle type can carry statpacks */
  hasStatpacks: boolean;
  /** How many statpacks it typically carries */
  maxStatpacks?: number;
  /**
   * Reading-field ids (from VEHICLE_READING_FIELDS) captured pre/post shift on
   * the vehicle checkout log. Optional + additive: when absent, the code
   * default in DEFAULT_VEHICLE_READING_FIELDS_BY_TYPE applies.
   */
  readingFields?: string[];
}

export const VEHICLE_TYPES: VehicleDef[] = [
  { id: 'ambulance', name: 'Ambulance', icon: 'Ambulance', hasStatpacks: true, maxStatpacks: 2 },
  { id: 'ebike', name: 'E-Bike', icon: 'Bike', hasStatpacks: true, maxStatpacks: 1 },
  { id: 'utv', name: 'UTV', icon: 'Truck', hasStatpacks: true, maxStatpacks: 2 },
  // Uncomment / add as fleet grows:
  // { id: 'golf_cart', name: 'Golf Cart', icon: 'Car', hasStatpacks: false },
];

// ---------------------------------------------------------------------------
// Vehicle Reading Fields — pre/post-shift readings on the vehicle checkout log
//
// Code-owned like VERIFICATION_FIELDS (kept separate so vehicle-only fields
// never pollute the asset-check palette). Which fields a vehicle type uses
// comes from VehicleDef.readingFields, falling back to the per-type defaults
// below. Fuel is a gauge read (E/¼/½/¾/F), stored numerically as
// 0/25/50/75/100 so it stays queryable.
// ---------------------------------------------------------------------------

export const VEHICLE_READING_FIELDS: Record<string, VerificationFieldDef> = {
  fuel_level: {
    id: 'fuel_level',
    label: 'Fuel Level',
    type: 'select',
    options: ['E', '¼', '½', '¾', 'F'],
    required: true,
    icon: 'Fuel',
  },
  mileage: {
    id: 'mileage',
    label: 'Mileage',
    type: 'number',
    unit: 'mi',
    min: 0,
    required: true,
    icon: 'Gauge',
  },
  battery_level: {
    id: 'battery_level',
    label: 'Battery Level',
    type: 'number',
    unit: '%',
    min: 0,
    max: 100,
    warningThreshold: 30,
    criticalThreshold: 10,
    severity: 'warning',
    required: true,
    icon: 'Battery',
  },
};

/** Code defaults when a VehicleDef doesn't specify readingFields.
 *  E-bikes are battery-only in v1 (whether they track mileage is an open
 *  question — add 'mileage' here or via readingFields once decided). */
export const DEFAULT_VEHICLE_READING_FIELDS_BY_TYPE: Record<string, string[]> = {
  ambulance: ['fuel_level', 'mileage'],
  utv: ['fuel_level', 'mileage'],
  ebike: ['battery_level'],
};

/** Fuel gauge label ⇄ stored value mapping (E/¼/½/¾/F → 0/25/50/75/100). */
export const FUEL_LEVEL_STEPS: { label: string; value: number }[] = [
  { label: 'E', value: 0 },
  { label: '¼', value: 25 },
  { label: '½', value: 50 },
  { label: '¾', value: 75 },
  { label: 'F', value: 100 },
];

// ---------------------------------------------------------------------------
// Asset Categories — each with default verification fields
//
// Note: some assets in a category (e.g. a "trainer" AED used only for
// practice/demos, or a CPR manikin) are non-deployable — they must never be
// dispatched into a statpack or vehicle. These are flagged per-instance via
// `InventoryItem.isTrainer` / `AssetInstance.isTrainer` (see app/types.ts),
// not via a separate category. They stay in the same category for reporting/
// verification purposes but should be excluded from "ready to deploy" lists.
// ---------------------------------------------------------------------------

export interface AssetCategoryDef {
  id: string;
  name: string;
  icon: string;
  /** Which verification fields apply by default when creating assets of this category */
  defaultVerificationFields: string[];
  /** Category-specific fields to show in the asset detail view */
  extraFields?: string[];
}

export const ASSET_CATEGORIES_CONFIG: AssetCategoryDef[] = [
  {
    id: 'AED',
    name: 'AED',
    icon: 'HeartPulse',
    defaultVerificationFields: ['serial_scan', 'battery_level', 'pads_sealed', 'expiration_date'],
    extraFields: ['padExpiration', 'batteryExpiration'],
  },
  {
    id: 'Radio',
    name: 'Radio',
    icon: 'Radio',
    defaultVerificationFields: ['serial_scan', 'power_on', 'battery_level'],
  },
  {
    id: 'Oxygen Tank',
    name: 'Oxygen Tank',
    icon: 'Wind',
    defaultVerificationFields: ['serial_scan', 'o2_psi', 'condition'],
  },
  {
    id: 'Generator',
    name: 'Generator',
    icon: 'Zap',
    defaultVerificationFields: ['serial_scan', 'condition'],
  },
  {
    id: 'Monitor',
    name: 'Monitor',
    icon: 'Monitor',
    defaultVerificationFields: ['serial_scan', 'battery_level', 'condition'],
  },
  {
    id: 'Epipen',
    name: 'Epipen',
    icon: 'Syringe',
    defaultVerificationFields: ['serial_scan', 'expiration_date'],
  },
  // Add new categories here — they auto-appear in all UIs:
  // { id: 'Stethoscope', name: 'Stethoscope', icon: 'Stethoscope', defaultVerificationFields: ['serial_scan'] },
];

// ---------------------------------------------------------------------------
// Statpack Types — pocket layouts for different bag types
// ---------------------------------------------------------------------------

export interface PocketDef {
  id: string;
  label: string;
  icon: string;
  /** Position in the bag visualizer */
  position: 'center' | 'front' | 'left' | 'right' | 'top' | 'bottom';
}

export interface StatpackTypeDef {
  id: string;
  name: string;
  pockets: PocketDef[];
}

export const STATPACK_TYPES: StatpackTypeDef[] = [
  {
    id: 'primary',
    name: 'Primary',
    pockets: [
      { id: 'main', label: 'Main Pocket', icon: 'Package', position: 'center' },
      { id: 'front_aux', label: 'Front Pocket', icon: 'PanelTop', position: 'front' },
      { id: 'side_left', label: 'Left Side', icon: 'PanelLeft', position: 'left' },
      { id: 'side_right', label: 'Right Side', icon: 'PanelRight', position: 'right' },
    ],
  },
  {
    id: 'secondary',
    name: 'Secondary',
    pockets: [
      { id: 'main', label: 'Main Pocket', icon: 'Package', position: 'center' },
      { id: 'front_aux', label: 'Front Pocket', icon: 'PanelTop', position: 'front' },
      { id: 'side_left', label: 'Left Side', icon: 'PanelLeft', position: 'left' },
      { id: 'side_right', label: 'Right Side', icon: 'PanelRight', position: 'right' },
    ],
  },
  {
    id: 'event_bag',
    name: 'Event Bag',
    pockets: [
      { id: 'main', label: 'Main Pocket', icon: 'Package', position: 'center' },
      { id: 'front_aux', label: 'Front Pocket', icon: 'PanelTop', position: 'front' },
    ],
  },
  // Add new statpack types here:
  // { id: 'als_bag', name: 'ALS Bag', pockets: [ ... ] },
];

// ---------------------------------------------------------------------------
// Thresholds & Business Rules
// ---------------------------------------------------------------------------

export interface ThresholdConfig {
  /** USD value above which an item is automatically classified as an asset */
  assetValueThreshold: number;
  /** % of par level below which a low-stock warning is shown */
  lowStockPercent: number;
  /** Days before expiration to show warnings */
  expirationWarningDays: number;
  /** Days before expiration to show critical alerts */
  expirationCriticalDays: number;
  /** Minimum O₂ PSI for checkout clearance */
  o2PsiMin: number;
  /** O₂ PSI below which a warning (not critical) is shown */
  o2PsiWarning: number;
  /** Days between required statpack audits (biweekly cadence) */
  statpackAuditIntervalDays: number;
  /** Days between required front restock-shelf checks (weekly cadence) */
  shelfCheckIntervalDays: number;
  /** Days a glucometer control test stays valid before a fresh passing test is required */
  glucometerControlTestIntervalDays: number;
  /** Days between required AED checks (battery/pads) before it reads out-of-date */
  aedCheckIntervalDays: number;
}

export const THRESHOLDS: ThresholdConfig = {
  assetValueThreshold: 500,
  lowStockPercent: 25,
  expirationWarningDays: 90,
  expirationCriticalDays: 30,
  o2PsiMin: 1800,
  o2PsiWarning: 500,
  statpackAuditIntervalDays: 14,
  shelfCheckIntervalDays: 7,
  glucometerControlTestIntervalDays: 30,
  aedCheckIntervalDays: 30,
};

// ---------------------------------------------------------------------------
// Role Definitions
// ---------------------------------------------------------------------------

export interface RoleDef {
  id: string;
  label: string;
  description: string;
  permissions: string[];
}

export const ROLES: RoleDef[] = [
  {
    id: 'admin',
    label: 'Admin',
    description: 'Full access to all features',
    permissions: ['*'],
  },
  {
    id: 'quartermaster',
    label: 'Quartermaster',
    description: 'Inventory management and audits',
    permissions: ['inventory.*', 'assets.*', 'statpacks.*', 'audit.*', 'buylist.*'],
  },
  {
    id: 'medops',
    label: 'MedOps',
    description: 'Staffs events and switches members between FTO/member; no logistics access',
    permissions: ['events.*', 'roster.roleswitch', 'certifications.*'],
  },
  {
    id: 'inventory_helper',
    label: 'Inventory Helper',
    description: 'Basic inventory operations',
    permissions: ['inventory.read', 'inventory.restock', 'statpacks.checkout', 'statpacks.checkin'],
  },
  {
    id: 'FTO',
    label: 'FTO',
    description: 'Field Training Officer',
    permissions: ['statpacks.checkout', 'statpacks.checkin', 'assets.checkout', 'assets.checkin'],
  },
  {
    id: 'fto_intern',
    label: 'FTO Intern',
    description: 'Field Training Officer in training — shadows an FTO for field experience',
    permissions: ['statpacks.checkout', 'statpacks.checkin', 'assets.checkout', 'assets.checkin'],
  },
  {
    id: 'member',
    label: 'Member',
    description: 'Standard member',
    permissions: ['statpacks.checkout', 'statpacks.checkin'],
  },
];

// ---------------------------------------------------------------------------
// Item Categories (for inventory)
// ---------------------------------------------------------------------------

export const ITEM_CATEGORIES = [
  'Airway', 'Trauma', 'Vitals', 'Meds', 'PPE', 'Splinting', 'Hygiene', 'First Aid', 'Other',
] as const;

/**
 * Controlled parent list for structured item naming. An item's `name` is derived
 * as `${family}, ${variantLabel}` so sizes/variations of one product sort and
 * group together. Admin-editable at /settings — these are only the seed values.
 */
export const ITEM_FAMILIES = [
  'Bandaids', 'Nitrile Gloves', 'OPAs',
] as const;

/**
 * Flat list of filterable inventory locations/areas, derived from LOCATIONS.
 * Rooms of multi-room sites are listed as "Site · Room"; single-room sites by
 * name. Use this for every location filter dropdown so pages stay in sync.
 */
export function getInventoryAreaOptions(): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (const loc of getLocationsRuntime()) {
    if (loc.id === 'other') continue;
    if (loc.rooms.length > 0) {
      for (const room of loc.rooms) {
        out.push({ value: room.name, label: `${loc.name} · ${room.name}` });
      }
    } else {
      out.push({ value: loc.name, label: loc.name });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Organization Info
// ---------------------------------------------------------------------------

export interface OrgInfo {
  name: string;
  shortName: string;
  timezone: string;
}

export const ORG_INFO: OrgInfo = {
  name: 'Berkeley Medical Reserve Corps',
  shortName: 'BMRC',
  timezone: 'America/Los_Angeles',
};

// ---------------------------------------------------------------------------
// Events config (venues, event types, semester boundary) — admin-editable at
// /settings. Selecting a venue on an event auto-fills its `location`.
// ---------------------------------------------------------------------------

export interface VenueDef {
  id: string;
  name: string;
  /** Address / area auto-filled into an event's location when this venue is picked. */
  location?: string;
}

export const VENUES: VenueDef[] = [
  { id: 'zellerbach', name: 'Zellerbach Auditorium', location: 'UC Berkeley' },
  { id: 'hertz_hall', name: 'Hertz Hall', location: 'UC Berkeley' },
  { id: 'greek_theatre', name: 'Greek Theatre', location: 'UC Berkeley' },
  { id: 'levis_stadium', name: "Levi's Stadium", location: 'Santa Clara' },
];

export const EVENT_TYPES: string[] = [
  'Concert', 'Sporting Event', 'Festival', 'Training', 'Community Event', 'Other',
];

/**
 * [Phase 5 / waitlist plan §4.1, §5.9] One team slot-shape inside a bulk
 * event-creation template — mirrors the shape `createEmptyTeam` builds, but
 * as data an admin edits rather than code.
 */
export interface EventTemplateTeamDef {
  name: string;
  emtCount: number;
  hasFtoIntern: boolean;
}

/**
 * [D29] The 2–4 EMT-count bound for `EventTemplateTeamDef.emtCount` /
 * `EventTeam.emtCount`, and its clamp. This lives here — the bottom-most
 * module every consumer (`app/lib/events.ts`, `app/lib/event-series.ts`, and
 * this file's own `validateEventTemplate`) already depends on — specifically
 * so those consumers can import the one copy instead of each mirroring it.
 * A mirrored copy in `event-series.ts` drifted from this rule once
 * (`Math.round(0) || 3` treated 0 as falsy and yielded 3 where the real
 * clamp yields 2) and shipped a real bug; see decisions.md D29.
 *
 * `app/lib/events.ts` re-exports all four names so existing importers of
 * `MIN_EMTS`/`MAX_EMTS`/`DEFAULT_EMTS`/`clampEmtCount` from that file are
 * unaffected.
 *
 * NOTE: these are plain code constants, NOT admin-editable org config — they
 * are intentionally not part of `OrgConfigDoc`, are never written to the
 * `org_settings/current` Firestore doc, and must not be surfaced in
 * `/settings`. That is why they sit here, beside the type they bound,
 * instead of inside `DEFAULT_ORG_CONFIG` below.
 */
export const MIN_EMTS = 2;
export const MAX_EMTS = 4;
export const DEFAULT_EMTS = 3;

export function clampEmtCount(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_EMTS;
  return Math.max(MIN_EMTS, Math.min(MAX_EMTS, Math.round(n)));
}

/** One staged-release window in a template, as LEAD DAYS — resolved against
 *  an individual event's own date at creation time (`resolveAccessTierForDate`
 *  in `app/lib/event-series.ts`), never stored as an absolute date. */
export interface EventTemplateTierWindowDef {
  label: string;
  /** Days BEFORE the event date that this window opens. > 0. */
  leadDays: number;
  /** Imported from app/types.ts — do NOT redeclare here. */
  criteria: TierCriteria;
}

/** A template's `priorityTiers`-shaped preset, in lead days (see `EventTemplateDef.accessTierPreset`). */
export interface EventTemplateAccessTierPreset {
  windows: EventTemplateTierWindowDef[];
  /** Days before the event date that signup opens to everyone. > 0. */
  generalLeadDays: number;
  rationale: string;
}

/**
 * [Phase 5 / waitlist plan §4.1, §5.9] A reusable event skeleton for bulk
 * creation — a manager applies one to a batch of dates (`app/lib/event-series.ts`
 * `expandEventSeries`) instead of retyping the same team/time shape every week.
 * Templates hold no dates of their own; `accessTierPreset` is lead days, not
 * instants, for the same reason — one absolute date on a template would give
 * every event in a whole series the same tier-opening moment (§5.9).
 */
export interface EventTemplateDef {
  id: string;
  /** Unique, non-empty. */
  name: string;
  eventType?: string;
  venue?: string;
  location?: string;
  /** P12: required — prefilling one is the point of a template. "HH:mm". */
  callTime: string;
  endTime?: string;
  description?: string;
  /** At least one. */
  teams: EventTemplateTeamDef[];
  waitlistEnabled?: boolean;
  /**
   * LEAD DAYS, never absolute dates — resolved per event against that event's
   * own date at creation time. Storing instants here would give a whole series
   * one opening date, the single worst bug bulk creation can produce (§5.9).
   */
  accessTierPreset?: EventTemplateAccessTierPreset;
}

/**
 * Start of the current semester (ISO 'YYYY-MM-DD'). "This semester" shift stats
 * count events on/after this date. Admin bumps it each new term at /settings.
 */
export const SEMESTER_START_DATE = '2026-01-01';

/**
 * When true (default), a member must have valid (present + unexpired) EMT and
 * CPR certifications to request a shift. Admins can turn this OFF during rollout
 * (before certs are entered) at /settings → Events & Venues.
 */
export const REQUIRE_CERTS_FOR_SHIFT_SIGNUP = true;

// ---------------------------------------------------------------------------
// Waitlist / offer / cancellation / tiering / reminders / terms config
// [Phase 0 — waitlist plan §4.1] Every policy number, mode, criterion, and
// member-facing string for the waitlist feature is org-config data (P11) —
// nothing about its behavior may be hardcoded. Config groups are nested
// objects; see `applyOrgConfigDoc` (app/lib/org-config-store.ts) for the
// nested-merge rule that keeps a partial `org_settings/current` doc from
// wiping sibling defaults.
// ---------------------------------------------------------------------------

export interface WaitlistConfig {
  enabled: boolean;
  /** 'event' = one queue per role per event (P13, the default). 'team' = the
   *  legacy per-team queue key, still reachable as an opt-in. */
  scope: 'event' | 'team';
  /** How a member's `preferredTeamId` affects promotion order. */
  honorTeamPreference: 'ignore' | 'soft' | 'strict';
  /** When false, a freed slot sits open until a manager sends the next offer by hand. */
  autoPromote: boolean;
  /** Offers made with more than this many hours' notice are "long notice" (binding on accept). */
  longNoticeThresholdHours: number;
  longNoticeResponseWindowHours: number;
  shortNoticeResponseWindowHours: number;
  /** Whether a declined/expired offer is terminal or returns to the back of the queue. */
  declinedOfferBehavior: 'terminal' | 'requeue_back';
  /** Caps the requeue loop; only meaningful with 'requeue_back'. */
  maxOffersPerMember: number;
  /** 0 = unlimited. A visible cap ("waitlist full") beats an invisible one. */
  maxQueueLength: number;
  /** Whether a member may still join a queue after the shift has started. */
  allowQueueAfterShiftStart: boolean;
  /** Member-facing copy, editable without a deploy. `{placeholder}` tokens are interpolated. */
  copy: {
    joinButtonLabel: string;
    /** e.g. "#{position} in line" */
    queuedLabel: string;
    /** The binding warning shown before accepting a long-notice offer. */
    offerLongNotice: string;
    /** The no-penalty reassurance shown before responding to a short-notice offer. */
    offerShortNotice: string;
    /** e.g. "A team preference is a hint — you may be offered another." */
    preferenceHint: string;
  };
}

export interface CancellationPolicyConfig {
  enabled: boolean;
  noticeHours: number;
  mode: 'ignore' | 'flag' | 'confirm' | 'block';
  /** Whether the policy applies only to binding requests, or to every cancellation. */
  appliesTo: 'binding' | 'all';
  countsAgainstRecord: boolean;
  /** `{hours}` interpolated. */
  memberMessage: string;
}

/** One staged-release window as CONFIGURED (lead days relative to the event's
 *  date, not absolute dates — the event editor resolves these to real
 *  `Timestamp`s at creation time; see `TierWindow` in app/types.ts). */
export interface DefaultTierWindow {
  id: string;
  label: string;
  /** Days before `event.date` this window opens. Must exceed `defaultGeneralLeadDays`. */
  leadDays: number;
  /** Imported from app/types.ts — do NOT redeclare here. */
  criteria: TierCriteria;
}

export interface PriorityTierConfig {
  enabled: boolean;
  /** Ordered list, earliest (largest `leadDays`) first. One entry reproduces
   *  the simplest possible single-priority-window behavior. */
  defaultTiers: DefaultTierWindow[];
  /** Days before `event.date` that general signup opens for everyone. */
  defaultGeneralLeadDays: number;
  defaultRationale: string;
}

export interface ShiftReminderConfig {
  enabled: boolean;
  /** Send a reminder this many hours before the shift start. */
  hoursBefore: number[];
  /** In-app only for now; 'email' becomes selectable once the external sweep
   *  worker (plan §6.4) is running. */
  channels: ('in_app' | 'email')[];
  /** `{event} {team} {role} {hours}` interpolated. */
  template: string;
}

/** The org's academic terms. Absorbs the standalone `semesterStartDate`
 *  setting — "the current term's `startDate`" is one concept, not two that
 *  can disagree. */
export interface TermDef {
  /** e.g. 'fa25' */
  id: string;
  /** e.g. 'Fall 2025' — what `User.joinedTerm` stores, what the roster picker shows. */
  label: string;
  /** 'YYYY-MM-DD', the date `User.joinedOn` derives from. */
  startDate: string;
  endDate?: string;
}

/** Which notification channels exist at all, and who drives them. */
export interface NotificationDeliveryConfig {
  inApp: boolean;
  email: {
    enabled: boolean;
    /** 'none' = in-app only (today). 'worker' = the free external clock
     *  (plan §6.4). 'functions' = a paid (Blaze-plan) Cloud Functions sender. */
    provider: 'none' | 'worker' | 'functions';
    fromName: string;
    replyTo: string;
    /** Batch manager-facing sends into one email per N minutes. 0 = send individually. */
    digestMinutes: number;
  };
  /** The zero-infrastructure fallback: a manager button that opens their mail client. */
  allowManagerMailto: boolean;
}

export const WAITLIST_DEFAULTS: WaitlistConfig = {
  enabled: true,
  scope: 'event',
  honorTeamPreference: 'soft',
  autoPromote: true,
  longNoticeThresholdHours: 24,
  longNoticeResponseWindowHours: 12,
  shortNoticeResponseWindowHours: 2,
  declinedOfferBehavior: 'terminal',
  maxOffersPerMember: 2,
  maxQueueLength: 0,
  allowQueueAfterShiftStart: false,
  copy: {
    joinButtonLabel: 'Join waitlist',
    queuedLabel: '#{position} in line',
    offerLongNotice:
      'Accepting this shift commits you to it. The {cancelHours}-hour cancellation policy applies once you accept.',
    offerShortNotice:
      'This is a short-notice offer. You can decline for any reason with no penalty — short-notice slots never count against your attendance record.',
    preferenceHint:
      'A team preference is a hint, not a guarantee — you may be offered a different team, and you can decline for free.',
  },
};

export const CANCELLATION_POLICY_DEFAULTS: CancellationPolicyConfig = {
  enabled: true,
  noticeHours: 48,
  mode: 'confirm',
  appliesTo: 'binding',
  countsAgainstRecord: true,
  memberMessage:
    'This shift starts in under {hours} hours. Cancelling now is recorded as a late cancellation — please let your FTO know.',
};

export const PRIORITY_TIERS_DEFAULTS: PriorityTierConfig = {
  enabled: true,
  defaultTiers: [
    { id: 'veterans', label: 'FTOs & experienced members', leadDays: 14,
      criteria: { roles: ['FTO'], minCompletedShifts: 5, combine: 'any' } },
  ],
  defaultGeneralLeadDays: 7,
  defaultRationale:
    'FTOs and members with 5+ completed shifts can sign up first. Everyone else can sign up once general registration opens.',
};

export const SHIFT_REMINDERS_DEFAULTS: ShiftReminderConfig = {
  enabled: true,
  hoursBefore: [48, 12],
  channels: ['in_app'],
  template: 'You have a {role} shift at {event} in {hours} hours.',
};

export const TERMS_DEFAULTS: TermDef[] = [
  // Seeded from the roster spreadsheet at setup; these are placeholders, not truth.
  { id: 'fa25', label: 'Fall 2025',   startDate: '2025-08-20' },
  { id: 'sp26', label: 'Spring 2026', startDate: '2026-01-13' },
  { id: 'fa26', label: 'Fall 2026',   startDate: '2026-08-19' },
];

export const NOTIFICATION_DELIVERY_DEFAULTS: NotificationDeliveryConfig = {
  inApp: true,
  email: { enabled: false, provider: 'none', fromName: 'BMRC MedOps', replyTo: '', digestMinutes: 15 },
  allowManagerMailto: true,
};

// ---------------------------------------------------------------------------
// Per-event policy override + resolution (waitlist plan §4.3)
// ---------------------------------------------------------------------------

/**
 * The per-event escape hatch required by P11. Every key optional;
 * `undefined` — on the whole `Event.policy` field or any key inside it —
 * means "inherit org config." Nothing should read this shape directly:
 * always go through `resolveEventPolicy(event)` (app/lib/events.ts), which is
 * the one place that knows the resolution order.
 *
 * Two override mechanisms exist and are deliberately different in kind:
 * `Event.accessTier` is a COPY taken once at event creation from
 * `priorityTiers` (non-retroactive — see `EventAccessTier` in app/types.ts),
 * whereas everything in `EventPolicyOverride` is a LIVE override, re-read on
 * every call to `resolveEventPolicy` — until an offer is actually made, at
 * which point the resolved values freeze onto `offer.policy` (P3).
 */
export interface EventPolicyOverride {
  waitlistEnabled?: boolean;
  scope?: 'event' | 'team';
  honorTeamPreference?: 'ignore' | 'soft' | 'strict';
  autoPromote?: boolean;
  longNoticeThresholdHours?: number;
  longNoticeResponseWindowHours?: number;
  shortNoticeResponseWindowHours?: number;
  declinedOfferBehavior?: 'terminal' | 'requeue_back';
  maxQueueLength?: number;
  /** Whether a member may still join a queue after the shift has started. */
  allowQueueAfterShiftStart?: boolean;
  cancellation?: Partial<CancellationPolicyConfig>;
  reminderHoursBefore?: number[];
}

/**
 * The fully-resolved policy for one event: `DEFAULT_ORG_CONFIG` ->
 * `org_settings/current` -> `Event.policy` merged into one object, so every
 * consumer takes this type rather than raw config — that is what keeps the
 * number of places that know about overrides at exactly one
 * (`resolveEventPolicy`, app/lib/events.ts).
 */
export interface ResolvedEventPolicy extends Required<Omit<EventPolicyOverride, 'cancellation' | 'reminderHoursBefore'>> {
  cancellation: CancellationPolicyConfig;
  reminderHoursBefore: number[];
  /**
   * [Phase 0] Org-wide only — deliberately absent from `EventPolicyOverride`,
   * because "how many offers may one member burn" is a fairness rule about the
   * member, not a property of any single event, and letting one event raise it
   * would let that event consume a member's allowance for every other event.
   *
   * It is surfaced here anyway so that `resolveEventPolicy` remains the ONLY
   * thing Phase 1's offer code has to read. Leaving it off would force the
   * offer path to take `(policy, config)` and reach into raw config for this
   * one field — exactly the split-source-of-truth the resolved-policy type
   * exists to prevent.
   */
  maxOffersPerMember: number;
}

// ---------------------------------------------------------------------------
// Runtime config document shape + defaults
//
// `OrgConfigDoc` is the admin-editable (v1) surface stored at Firestore doc
// `org_settings/current`. `VERIFICATION_FIELDS` and `ROLES` are intentionally
// NOT part of it — they stay code-owned. `DEFAULT_ORG_CONFIG` is the seed /
// fallback assembled from the constants above.
// ---------------------------------------------------------------------------

export type OrgConfigDoc = {
  org: OrgInfo;
  locations: LocationDef[];
  vehicles: VehicleDef[];
  assetCategories: AssetCategoryDef[];
  statpackTypes: StatpackTypeDef[];
  itemCategories: string[];
  itemFamilies: string[];
  thresholds: ThresholdConfig;
  venues: VenueDef[];
  eventTypes: string[];
  /** [Phase 5 / waitlist plan §4.1] Reusable bulk-event-creation templates.
   *  Empty by default — see `DEFAULT_ORG_CONFIG` for why no example ships. */
  eventTemplates: EventTemplateDef[];
  /** ISO 'YYYY-MM-DD' start of the current semester (for shift stats). */
  semesterStartDate: string;
  /** Gate shift signup on valid EMT + CPR certs (default true). */
  requireCertsForShiftSignup: boolean;
  /** [Phase 0 / waitlist plan §4.1] Waitlist/offer behavior. */
  waitlist: WaitlistConfig;
  /** [Phase 0 / waitlist plan §4.1] Late-cancellation policy. */
  cancellationPolicy: CancellationPolicyConfig;
  /** [Phase 0 / waitlist plan §4.1] Defaults new events prefill `accessTier` from (copied at creation, not live). */
  priorityTiers: PriorityTierConfig;
  /** [Phase 0 / waitlist plan §4.1] Pre-shift reminder config. */
  shiftReminders: ShiftReminderConfig;
  /** [Phase 0 / waitlist plan §4.1] The org's academic terms; absorbs `semesterStartDate` going forward. */
  terms: TermDef[];
  /** [Phase 0 / waitlist plan §4.1] Which notification channels exist and who drives them. */
  notificationDelivery: NotificationDeliveryConfig;
};

export const DEFAULT_ORG_CONFIG: OrgConfigDoc = {
  org: ORG_INFO,
  locations: LOCATIONS,
  vehicles: VEHICLE_TYPES,
  assetCategories: ASSET_CATEGORIES_CONFIG,
  statpackTypes: STATPACK_TYPES,
  itemCategories: [...ITEM_CATEGORIES],
  itemFamilies: [...ITEM_FAMILIES],
  thresholds: THRESHOLDS,
  venues: VENUES,
  eventTypes: [...EVENT_TYPES],
  // [Phase 5 / waitlist plan §4.1] No seeded example: a seeded "Football home
  // game" would presume this org's schedule, and the settings editor's "Add
  // template" button (Phase 5b) creates a blank one anyway.
  eventTemplates: [],
  semesterStartDate: SEMESTER_START_DATE,
  requireCertsForShiftSignup: REQUIRE_CERTS_FOR_SHIFT_SIGNUP,
  waitlist: WAITLIST_DEFAULTS,
  cancellationPolicy: CANCELLATION_POLICY_DEFAULTS,
  priorityTiers: PRIORITY_TIERS_DEFAULTS,
  shiftReminders: SHIFT_REMINDERS_DEFAULTS,
  terms: TERMS_DEFAULTS,
  notificationDelivery: NOTIFICATION_DELIVERY_DEFAULTS,
};

// ---------------------------------------------------------------------------
// Convenience: Get category config by ID
// ---------------------------------------------------------------------------

export function getAssetCategoryConfig(categoryId: string): AssetCategoryDef | undefined {
  return getAssetCategoriesRuntime().find(c => c.id === categoryId);
}

export function getVerificationFieldDef(fieldId: string): VerificationFieldDef | undefined {
  return VERIFICATION_FIELDS[fieldId];
}

export function getVerificationFieldsForCategory(categoryId: string): VerificationFieldDef[] {
  const cat = getAssetCategoryConfig(categoryId);
  if (!cat) return [];
  return cat.defaultVerificationFields
    .map(id => VERIFICATION_FIELDS[id])
    .filter((f): f is VerificationFieldDef => !!f);
}

export function getStatpackTypeConfig(typeId: string): StatpackTypeDef | undefined {
  return getStatpackTypesRuntime().find(t => t.id.toLowerCase() === typeId.toLowerCase());
}

export function getVehicleTypeConfig(typeId: string): VehicleDef | undefined {
  return getVehiclesRuntime().find(v => v.id === typeId);
}

/** Reading fields captured pre/post shift for a vehicle type: the runtime
 *  VehicleDef.readingFields override when present, else the code default map.
 *  A type created purely via the Settings UI (id outside the default map)
 *  falls back to fuel + mileage unless its readingFields is set. */
export function getReadingFieldsForVehicleType(typeId: string): VerificationFieldDef[] {
  const def = getVehicleTypeConfig(typeId);
  const ids = def?.readingFields && def.readingFields.length > 0
    ? def.readingFields
    : DEFAULT_VEHICLE_READING_FIELDS_BY_TYPE[typeId] ?? ['fuel_level', 'mileage'];
  return ids
    .map(id => VEHICLE_READING_FIELDS[id])
    .filter((f): f is VerificationFieldDef => !!f);
}

export function getLocationConfig(locationId: string): LocationDef | undefined {
  return getLocationsRuntime().find(l => l.id === locationId);
}

/** Map legacy LocationType string to config location */
export function getLegacyLocationConfig(locationType: string): LocationDef | undefined {
  const map: Record<string, string> = {
    'HQ': 'hq',
    'CPR Closet': 'cpr_closet',
    'Shed': 'shed',
    'Other': 'other',
  };
  return getLocationsRuntime().find(l => l.id === (map[locationType] ?? locationType));
}

/** Get all asset category IDs as a flat array (for backward compat with ASSET_CATEGORIES) */
export function getAssetCategoryIds(): string[] {
  return getAssetCategoriesRuntime().map(c => c.id);
}

/** Get all location names as a flat array (for backward compat with LocationType) */
export function getLocationNames(): string[] {
  return getLocationsRuntime().map(l => l.name);
}

/** Get rooms for a location (for backward compat with HQRoom) */
export function getRoomNames(locationId: string): string[] {
  const loc = getLocationConfig(locationId);
  return loc?.rooms.map(r => r.name) ?? [];
}

// ---------------------------------------------------------------------------
// Events config accessors (runtime)
// ---------------------------------------------------------------------------

/** All configured venues (runtime override, else defaults). */
export function getVenues(): VenueDef[] {
  return getVenuesRuntime();
}

export function getVenueById(venueId: string): VenueDef | undefined {
  return getVenuesRuntime().find(v => v.id === venueId);
}

/** Look up a venue by id OR name (events store the venue name). */
export function getVenueByName(name: string): VenueDef | undefined {
  return getVenuesRuntime().find(v => v.name === name);
}

/** Configured event-type options. */
export function getEventTypes(): string[] {
  return getEventTypesRuntime();
}

/** [Phase 5 / waitlist plan §4.1] Reusable bulk-event-creation templates (runtime override, else defaults — empty by default). */
export function getEventTemplates(): EventTemplateDef[] {
  return getEventTemplatesRuntime();
}

/** Look up one bulk-creation template by id. */
export function getEventTemplate(id: string): EventTemplateDef | undefined {
  return getEventTemplatesRuntime().find(t => t.id === id);
}

/**
 * [Phase 5 / waitlist plan §4.1, §5.9] Pure validation for one template
 * against its siblings — used by the Settings UI (Phase 5b) before save, and
 * safe to call from `event-series.ts`/tests since it has no I/O. Empty array
 * = valid.
 *
 * The 2–4 EMT bound uses `MIN_EMTS`/`MAX_EMTS`, defined above in this same
 * file (D29) — no inlining or mirroring needed since both live here.
 */
export function validateEventTemplate(t: EventTemplateDef, all: EventTemplateDef[]): string[] {
  const problems: string[] = [];

  const name = t.name.trim();
  if (!name) {
    problems.push('Name is required.');
  } else if (all.some(o => o.id !== t.id && o.name.trim().toLowerCase() === name.toLowerCase())) {
    problems.push(`Another template is already named "${name}".`);
  }

  if (!t.teams || t.teams.length === 0) {
    problems.push('At least one team is required.');
  } else {
    t.teams.forEach((team, i) => {
      if (team.emtCount < MIN_EMTS || team.emtCount > MAX_EMTS) {
        problems.push(`Team ${i + 1} ("${team.name || 'unnamed'}"): EMT count must be ${MIN_EMTS}–${MAX_EMTS}.`);
      }
    });
  }

  if (!t.callTime.trim()) {
    problems.push('Call time is required.');
  }

  if (t.accessTierPreset) {
    const { generalLeadDays, windows } = t.accessTierPreset;
    if (!(generalLeadDays > 0)) {
      problems.push('General access lead days must be greater than 0.');
    }
    windows.forEach((w, i) => {
      const label = w.label || `#${i + 1}`;
      if (!(w.leadDays > 0)) {
        problems.push(`Tier window "${label}": lead days must be greater than 0.`);
      } else if (!(w.leadDays > generalLeadDays)) {
        problems.push(`Tier window "${label}" must open before general access (lead days must exceed general access lead days).`);
      }
    });
  }

  return problems;
}

/**
 * [Phase 0 / waitlist plan §4.1] Current-semester start as a Date (local
 * midnight), DERIVED from `terms` — the `startDate` of the term containing
 * `now` (the latest configured term whose `startDate` is on/before today) —
 * rather than its own stored field. `semesterStartDate` remains readable for
 * one release as a fallback for an org that hasn't filled in `terms` yet; do
 * not write to it any more.
 */
export function getSemesterStart(): Date {
  const terms = getTermsRuntime();
  if (terms.length > 0) {
    const now = new Date();
    const sorted = [...terms].sort((a, b) => a.startDate.localeCompare(b.startDate));
    let current: TermDef | undefined;
    for (const t of sorted) {
      const d = new Date(`${t.startDate}T00:00:00`);
      if (!Number.isNaN(d.getTime()) && d <= now) current = t;
    }
    const chosen = current ?? sorted[0];
    const d = new Date(`${chosen.startDate}T00:00:00`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  // Fallback for one release only — orgs that haven't filled in `terms` yet.
  const iso = getSemesterStartRuntime();
  const d = iso ? new Date(`${iso}T00:00:00`) : null;
  return d && !Number.isNaN(d.getTime()) ? d : new Date(0);
}

/** Whether shift signup is gated on valid EMT + CPR certs (runtime). */
export function getRequireCertsForShiftSignup(): boolean {
  return getRequireCertsRuntime();
}

// ---------------------------------------------------------------------------
// Waitlist / offer / cancellation / tiering / reminders / terms accessors
// (runtime) — [Phase 0, waitlist plan §4.1]
// ---------------------------------------------------------------------------

/** Waitlist/offer behavior (runtime override, else defaults). */
export function getWaitlistConfig(): WaitlistConfig {
  return getWaitlistRuntime();
}

/** Late-cancellation policy (runtime override, else defaults). */
export function getCancellationPolicy(): CancellationPolicyConfig {
  return getCancellationPolicyRuntime();
}

/** Defaults new events prefill `accessTier` from at creation time (not live-linked afterward). */
export function getPriorityTierConfig(): PriorityTierConfig {
  return getPriorityTiersRuntime();
}

/** Pre-shift reminder config (runtime override, else defaults). */
export function getShiftReminderConfig(): ShiftReminderConfig {
  return getShiftRemindersRuntime();
}

/** The org's configured academic terms, ordered as saved (see `TermDef`). */
export function getTerms(): TermDef[] {
  return getTermsRuntime();
}

/** Which notification channels exist and who drives them (runtime override, else defaults). */
export function getNotificationDelivery(): NotificationDeliveryConfig {
  return getNotificationDeliveryRuntime();
}

/**
 * The full live runtime config document (overrides merged over defaults).
 * Exists so pure lib code that needs more than one config group in one call
 * — chiefly `resolveEventPolicy` (app/lib/events.ts) — has a single named
 * entry point rather than reaching into `org-config-store.ts` directly.
 * Thin wrapper over `getRuntimeConfig()`.
 */
export function getOrgConfig(): OrgConfigDoc {
  return getRuntimeConfig();
}
