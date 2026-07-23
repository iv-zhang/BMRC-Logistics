'use client';

import * as React from 'react';
import {
  ROLES,
  VERIFICATION_FIELDS,
  DEFAULT_ORG_CONFIG,
  getAssetCategoryConfig,
  getVerificationFieldsForCategory,
  getStatpackTypeConfig,
  getLocationConfig,
  getLegacyLocationConfig,
  type OrgConfigDoc,
  type LocationDef,
  type VehicleDef,
  type AssetCategoryDef,
  type StatpackTypeDef,
  type ThresholdConfig,
  type RoleDef,
  type VerificationFieldDef,
  type OrgInfo,
} from '@/app/config/org-config';
import {
  subscribeOrgConfig,
  seedOrgConfigIfMissing,
} from '@/app/lib/org-config-store';

export interface OrgConfigResult {
  org: OrgInfo;
  locations: LocationDef[];
  vehicles: VehicleDef[];
  assetCategories: AssetCategoryDef[];
  statpackTypes: StatpackTypeDef[];
  thresholds: ThresholdConfig;
  roles: RoleDef[];
  verificationFields: Record<string, VerificationFieldDef>;
  itemCategories: readonly string[];
  itemFamilies: readonly string[];
  /** True until the first Firestore snapshot resolves (defaults are used meanwhile). */
  loading: boolean;
  // Convenience lookups
  getAssetCategory: (id: string) => AssetCategoryDef | undefined;
  getVerificationFieldsFor: (categoryId: string) => VerificationFieldDef[];
  getStatpackType: (typeId: string) => StatpackTypeDef | undefined;
  getLocation: (id: string) => LocationDef | undefined;
  getLegacyLocation: (name: string) => LocationDef | undefined;
  /** Get all location names for dropdowns */
  locationNames: string[];
  /** Get all asset category names for dropdowns */
  assetCategoryNames: string[];
  /** Get all asset category IDs */
  assetCategoryIds: string[];
}

/** Build the public hook result from a raw config doc (defaults or live override). */
function buildResult(cfg: OrgConfigDoc, loading: boolean): OrgConfigResult {
  return {
    org: cfg.org,
    locations: cfg.locations,
    vehicles: cfg.vehicles,
    assetCategories: cfg.assetCategories,
    statpackTypes: cfg.statpackTypes,
    thresholds: cfg.thresholds,
    roles: ROLES,
    verificationFields: VERIFICATION_FIELDS,
    itemCategories: cfg.itemCategories,
    itemFamilies: cfg.itemFamilies,
    loading,
    // Helper fns read the same runtime store the subscription updates, so they
    // stay in sync with the live config.
    getAssetCategory: getAssetCategoryConfig,
    getVerificationFieldsFor: getVerificationFieldsForCategory,
    getStatpackType: getStatpackTypeConfig,
    getLocation: getLocationConfig,
    getLegacyLocation: getLegacyLocationConfig,
    locationNames: cfg.locations.map(l => l.name),
    assetCategoryNames: cfg.assetCategories.map(c => c.name),
    assetCategoryIds: cfg.assetCategories.map(c => c.id),
  };
}

const OrgConfigContext = React.createContext<OrgConfigResult | null>(null);

/**
 * Provides the live organization config to the tree. On mount it seeds the
 * Firestore doc if missing, then subscribes to it; until the first snapshot
 * arrives the built-in DEFAULT_ORG_CONFIG is used, so the app never blocks.
 */
export function OrgConfigProvider({ children }: { children: React.ReactNode }) {
  const [cfg, setCfg] = React.useState<OrgConfigDoc>(DEFAULT_ORG_CONFIG);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let active = true;
    // Fire-and-forget seed (no-op / swallowed for non-admins).
    seedOrgConfigIfMissing();
    const unsub = subscribeOrgConfig((next) => {
      if (!active) return;
      setCfg(next);
      setLoading(false);
    });
    return () => {
      active = false;
      unsub();
    };
  }, []);

  const value = React.useMemo(() => buildResult(cfg, loading), [cfg, loading]);

  return React.createElement(OrgConfigContext.Provider, { value }, children);
}

/**
 * Typed access to the live organization configuration. Falls back to the
 * built-in defaults when no provider is mounted, so it never throws.
 */
export function useOrgConfig(): OrgConfigResult {
  const ctx = React.useContext(OrgConfigContext);
  const fallback = React.useMemo(() => buildResult(DEFAULT_ORG_CONFIG, false), []);
  return ctx ?? fallback;
}
