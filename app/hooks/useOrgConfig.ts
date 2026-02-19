'use client';

import { useMemo } from 'react';
import {
  LOCATIONS,
  VEHICLE_TYPES,
  ASSET_CATEGORIES_CONFIG,
  STATPACK_TYPES,
  THRESHOLDS,
  ROLES,
  VERIFICATION_FIELDS,
  ITEM_CATEGORIES,
  ORG_INFO,
  getAssetCategoryConfig,
  getVerificationFieldsForCategory,
  getStatpackTypeConfig,
  getLocationConfig,
  getLegacyLocationConfig,
  type LocationDef,
  type VehicleDef,
  type AssetCategoryDef,
  type StatpackTypeDef,
  type ThresholdConfig,
  type RoleDef,
  type VerificationFieldDef,
  type OrgInfo,
} from '@/app/config/org-config';

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

/**
 * Hook providing typed access to the organization configuration.
 * All UI components should use this instead of hardcoded values.
 *
 * Future: This hook can be extended to load overrides from Firestore,
 * enabling runtime config changes without code deploys.
 */
export function useOrgConfig(): OrgConfigResult {
  return useMemo(() => ({
    org: ORG_INFO,
    locations: LOCATIONS,
    vehicles: VEHICLE_TYPES,
    assetCategories: ASSET_CATEGORIES_CONFIG,
    statpackTypes: STATPACK_TYPES,
    thresholds: THRESHOLDS,
    roles: ROLES,
    verificationFields: VERIFICATION_FIELDS,
    itemCategories: ITEM_CATEGORIES,
    getAssetCategory: getAssetCategoryConfig,
    getVerificationFieldsFor: getVerificationFieldsForCategory,
    getStatpackType: getStatpackTypeConfig,
    getLocation: getLocationConfig,
    getLegacyLocation: getLegacyLocationConfig,
    locationNames: LOCATIONS.map(l => l.name),
    assetCategoryNames: ASSET_CATEGORIES_CONFIG.map(c => c.name),
    assetCategoryIds: ASSET_CATEGORIES_CONFIG.map(c => c.id),
  }), []);
}
