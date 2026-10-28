/**
 * Unit tests for O₂ PSI validation in asset verification
 * Tests verifyAssetAgainstRules function with various O₂ scenarios
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The app's Firebase client is created at import time; point it at the (never
// contacted here) emulator project so no real credentials are needed. Every test
// passes `inventoryItem`, so verifyAssetAgainstRules never reads Firestore.
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
await import('../../../scripts/emulator/guard');
const { verifyAssetAgainstRules: verifyRaw } = await import('../inventory');
import type { StatpackItem, AssetVerificationRules, InventoryItem } from '@/app/types';

const verifyAssetAgainstRules = (params: Parameters<typeof verifyRaw>[0]) =>
  verifyRaw({ inventoryItem: params.statpackItem.itemDetails, ...params });

describe('O₂ PSI Validation', () => {
  // Partial fixture cast: only the fields verifyAssetAgainstRules reads are populated.
  const createMockStatpackItem = (rules?: AssetVerificationRules): StatpackItem =>
    ({
      itemId: 'oxygen-tank-001',
      itemDetails: {
        name: 'Oxygen Tank D-Cylinder',
        isOxygen: true,
        verificationPolicy: rules,
      } as unknown as InventoryItem,
      requiredQuantity: 1,
      currentQuantity: 1,
      batchId: 'batch-001',
      pocket: 'main',
    }) as unknown as StatpackItem;

  describe('Missing O₂ PSI', () => {
    it('should return warning when O₂ PSI is required but not provided', async () => {
      const statpackItem = createMockStatpackItem({ requireO2PsiMin: 1800 });

      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: undefined,
      });

      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].warningType, 'asset_status');
      assert.ok(warnings[0].message.includes('O₂ PSI reading required'));
      assert.ok(warnings[0].message.includes('1800'));
    });

    it('should return warning when O₂ PSI is null', async () => {
      const statpackItem = createMockStatpackItem({ requireO2PsiMin: 1800 });

      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: null as unknown as number,
      });

      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].warningType, 'asset_status');
      assert.ok(warnings[0].message.includes('O₂ PSI reading required'));
    });
  });

  describe('Low O₂ PSI', () => {
    it('should return warning when O₂ PSI is below minimum threshold', async () => {
      const statpackItem = createMockStatpackItem({ requireO2PsiMin: 1800 });

      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: 1500,
      });

      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].warningType, 'asset_status');
      assert.ok(warnings[0].message.includes('O₂ PSI too low'));
      assert.ok(warnings[0].message.includes('1500'));
      assert.ok(warnings[0].message.includes('1800'));
    });

    it('should return warning when O₂ PSI is at minimum threshold minus 1', async () => {
      const statpackItem = createMockStatpackItem({ requireO2PsiMin: 2000 });

      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: 1999,
      });

      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].message.includes('O₂ PSI too low'));
    });

    it('should return warning for very low O₂ PSI (near empty)', async () => {
      const statpackItem = createMockStatpackItem({ requireO2PsiMin: 1800 });

      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: 500,
      });

      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].message.includes('500'));
      assert.equal(warnings[0].warningType, 'asset_status');
    });
  });

  describe('Good O₂ PSI', () => {
    it('should return no warnings when O₂ PSI meets minimum threshold', async () => {
      const statpackItem = createMockStatpackItem({ requireO2PsiMin: 1800 });

      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: 1800,
      });

      assert.equal(warnings.length, 0);
    });

    it('should return no warnings when O₂ PSI is above minimum threshold', async () => {
      const statpackItem = createMockStatpackItem({ requireO2PsiMin: 1800 });

      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: 2000,
      });

      assert.equal(warnings.length, 0);
    });

    it('should return no warnings when O₂ PSI is at full capacity', async () => {
      const statpackItem = createMockStatpackItem({ requireO2PsiMin: 1800 });

      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: 2200,
      });

      assert.equal(warnings.length, 0);
    });
  });

  describe('Edge Cases', () => {
    it('should return no warnings when O₂ PSI is not required (no rules)', async () => {
      const statpackItem = createMockStatpackItem();

      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: undefined,
      });

      assert.equal(warnings.length, 0);
    });

    it('should return no warnings when requireO2PsiMin is 0', async () => {
      const statpackItem = createMockStatpackItem({ requireO2PsiMin: 0 });

      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: undefined,
      });

      assert.equal(warnings.length, 0);
    });

    it('should handle O₂ PSI of 0 (empty tank)', async () => {
      const statpackItem = createMockStatpackItem({ requireO2PsiMin: 1800 });

      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: 0,
      });

      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].message.includes('O₂ PSI too low'));
      assert.ok(warnings[0].message.includes('0'));
    });

    it('should handle negative O₂ PSI (sensor error)', async () => {
      const statpackItem = createMockStatpackItem({ requireO2PsiMin: 1800 });

      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: -100,
      });

      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].message.includes('O₂ PSI too low'));
    });

    it('should handle extremely high O₂ PSI (overpressure)', async () => {
      const statpackItem = createMockStatpackItem({ requireO2PsiMin: 1800 });

      // Note: Current implementation doesn't check for max PSI, only min
      // This test documents current behavior
      const warnings = await verifyAssetAgainstRules({
        statpackItem,
        scannedO2Psi: 5000,
      });

      assert.equal(warnings.length, 0);
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

      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].message.includes('O₂ PSI too low'));
      // Advisory only affects severity, not whether warnings are returned
    });
  });
});
