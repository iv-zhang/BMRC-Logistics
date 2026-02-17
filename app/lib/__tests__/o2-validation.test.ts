/**
 * Unit tests for O₂ PSI validation in asset verification
 * Tests verifyAssetAgainstRules function with various O₂ scenarios
 */

import { describe, it, expect, vi } from 'vitest';
import { verifyAssetAgainstRules } from '../inventory';
import type { StatpackItem, AssetVerificationRules } from '@/app/types';

// Mock Firestore
vi.mock('@/firebase', () => ({
  db: {},
  auth: {},
}));

vi.mock('firebase/firestore', () => ({
  doc: vi.fn(),
  getDoc: vi.fn(),
  collection: vi.fn(),
  runTransaction: vi.fn(),
  serverTimestamp: vi.fn(() => new Date()),
}));

describe('O₂ PSI Validation', () => {
  const createMockStatpackItem = (rules?: AssetVerificationRules): StatpackItem => ({
    itemId: 'oxygen-tank-001',
    itemDetails: {
      name: 'Oxygen Tank D-Cylinder',
      isOxygen: true,
      verificationPolicy: rules,
    },
    requiredQuantity: 1,
    pocket: 'main',
  });

  describe('Missing O₂ PSI', () => {
    it('should return warning when O₂ PSI is required but not provided', async () => {
      const statpackItem = createMockStatpackItem({ requireO2PsiMin: 1800 });

      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: undefined,
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0].warningType).toBe('asset_status');
      expect(warnings[0].message).toContain('O₂ PSI reading required');
      expect(warnings[0].message).toContain('1800');
    });

    it('should return warning when O₂ PSI is null', async () => {
      const statpackItem = createMockStatpackItem({ requireO2PsiMin: 1800 });

      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: null as any,
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0].warningType).toBe('asset_status');
      expect(warnings[0].message).toContain('O₂ PSI reading required');
    });
  });

  describe('Low O₂ PSI', () => {
    it('should return warning when O₂ PSI is below minimum threshold', async () => {
      const statpackItem = createMockStatpackItem({ requireO2PsiMin: 1800 });

      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: 1500,
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0].warningType).toBe('asset_status');
      expect(warnings[0].message).toContain('O₂ PSI too low');
      expect(warnings[0].message).toContain('1500');
      expect(warnings[0].message).toContain('1800');
    });

    it('should return warning when O₂ PSI is at minimum threshold minus 1', async () => {
      const statpackItem = createMockStatpackItem({ requireO2PsiMin: 2000 });

      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: 1999,
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toContain('O₂ PSI too low');
    });

    it('should return warning for very low O₂ PSI (near empty)', async () => {
      const statpackItem = createMockStatpackItem({ requireO2PsiMin: 1800 });

      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: 500,
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toContain('500');
      expect(warnings[0].warningType).toBe('asset_status');
    });
  });

  describe('Good O₂ PSI', () => {
    it('should return no warnings when O₂ PSI meets minimum threshold', async () => {
      const statpackItem = createMockStatpackItem({ requireO2PsiMin: 1800 });

      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: 1800,
      });

      expect(warnings).toHaveLength(0);
    });

    it('should return no warnings when O₂ PSI is above minimum threshold', async () => {
      const statpackItem = createMockStatpackItem({ requireO2PsiMin: 1800 });

      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: 2000,
      });

      expect(warnings).toHaveLength(0);
    });

    it('should return no warnings when O₂ PSI is at full capacity', async () => {
      const statpackItem = createMockStatpackItem({ requireO2PsiMin: 1800 });

      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: 2200,
      });

      expect(warnings).toHaveLength(0);
    });
  });

  describe('Edge Cases', () => {
    it('should return no warnings when O₂ PSI is not required (no rules)', async () => {
      const statpackItem = createMockStatpackItem();

      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: undefined,
      });

      expect(warnings).toHaveLength(0);
    });

    it('should return no warnings when requireO2PsiMin is 0', async () => {
      const statpackItem = createMockStatpackItem({ requireO2PsiMin: 0 });

      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: undefined,
      });

      expect(warnings).toHaveLength(0);
    });

    it('should handle O₂ PSI of 0 (empty tank)', async () => {
      const statpackItem = createMockStatpackItem({ requireO2PsiMin: 1800 });

      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: 0,
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toContain('O₂ PSI too low');
      expect(warnings[0].message).toContain('0');
    });

    it('should handle negative O₂ PSI (sensor error)', async () => {
      const statpackItem = createMockStatpackItem({ requireO2PsiMin: 1800 });

      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: -100,
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toContain('O₂ PSI too low');
    });

    it('should handle extremely high O₂ PSI (overpressure)', async () => {
      const statpackItem = createMockStatpackItem({ requireO2PsiMin: 1800 });

      // Note: Current implementation doesn't check for max PSI, only min
      // This test documents current behavior
      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: 5000,
      });

      expect(warnings).toHaveLength(0);
    });
  });

  describe('Advisory Only Mode', () => {
    it('should still return warnings in advisory mode', async () => {
      const statpackItem = createMockStatpackItem({
        requireO2PsiMin: 1800,
        advisoryOnly: true,
      });

      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: 1500,
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toContain('O₂ PSI too low');
      // Advisory only affects severity, not whether warnings are returned
    });
  });
});
