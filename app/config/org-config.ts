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
} from '@/app/lib/org-config-store';

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
}

export const VEHICLE_TYPES: VehicleDef[] = [
  { id: 'ambulance', name: 'Ambulance', icon: 'Ambulance', hasStatpacks: true, maxStatpacks: 2 },
  // Uncomment / add as fleet grows:
  // { id: 'ebike', name: 'E-Bike', icon: 'Bike', hasStatpacks: true, maxStatpacks: 1 },
  // { id: 'utv', name: 'UTV', icon: 'Truck', hasStatpacks: true, maxStatpacks: 2 },
  // { id: 'golf_cart', name: 'Golf Cart', icon: 'Car', hasStatpacks: false },
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
}

export const THRESHOLDS: ThresholdConfig = {
  assetValueThreshold: 500,
  lowStockPercent: 25,
  expirationWarningDays: 90,
  expirationCriticalDays: 30,
  o2PsiMin: 1800,
  o2PsiWarning: 500,
  statpackAuditIntervalDays: 14,
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
  thresholds: ThresholdConfig;
};

export const DEFAULT_ORG_CONFIG: OrgConfigDoc = {
  org: ORG_INFO,
  locations: LOCATIONS,
  vehicles: VEHICLE_TYPES,
  assetCategories: ASSET_CATEGORIES_CONFIG,
  statpackTypes: STATPACK_TYPES,
  itemCategories: [...ITEM_CATEGORIES],
  thresholds: THRESHOLDS,
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
