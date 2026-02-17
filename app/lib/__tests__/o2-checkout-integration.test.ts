/**
 * Integration test for O₂ PSI checkout flow
 * Tests: modal input → checkout → log persistence → display
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logStatpackCheckOff } from '../inventory';
import type { StatpackLog } from '@/app/types';

// Mock Firestore
const mockRunTransaction = vi.fn();
const mockDoc = vi.fn();
const mockCollection = vi.fn();
const mockGetDoc = vi.fn();
const mockServerTimestamp = vi.fn(() => new Date('2024-01-15T10:00:00Z'));

vi.mock('@/firebase', () => ({
  db: {},
  auth: {},
}));

vi.mock('firebase/firestore', () => ({
  doc: mockDoc,
  getDoc: mockGetDoc,
  collection: mockCollection,
  runTransaction: mockRunTransaction,
  serverTimestamp: mockServerTimestamp,
}));

describe('O₂ PSI Checkout Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Setup default mocks
    mockDoc.mockReturnValue({ id: 'statpack-001' });
    mockCollection.mockReturnValue({ id: 'statpack_logs' });
    
    // Mock transaction
    mockRunTransaction.mockImplementation(async (db, callback) => {
      const tx = {
        get: vi.fn().mockResolvedValue({
          exists: () => true,
          data: () => ({
            id: 'statpack-001',
            name: 'Primary ALS Statpack',
            isCheckedOut: false,
            status: 'Ready',
          }),
        }),
        set: vi.fn(),
        update: vi.fn(),
      };
      return callback(tx);
    });
  });

  describe('Checkout with O₂ PSI', () => {
    it('should persist O₂ PSI in checkEntries.assetCheckResult', async () => {
      const checkEntries = [
        {
          itemId: 'oxygen-tank-001',
          itemName: 'Oxygen Tank D-Cylinder',
          requiredQuantity: 1,
          countedQuantity: 1,
          ok: true,
          assetCheckResult: {
            oxygenPsi: 2000,
          },
        },
      ];

      await logStatpackCheckOff({
        statpackId: 'statpack-001',
        statpackName: 'Primary ALS Statpack',
        action: 'checkout',
        userId: 'user-123',
        userName: 'Test User',
        userRole: 'member',
        checkEntries,
      });

      // Verify transaction was called
      expect(mockRunTransaction).toHaveBeenCalled();
      
      // Get the transaction callback
      const txCallback = mockRunTransaction.mock.calls[0][1];
      const tx = {
        get: vi.fn().mockResolvedValue({
          exists: () => true,
          data: () => ({ isCheckedOut: false }),
        }),
        set: vi.fn(),
        update: vi.fn(),
      };
      
      await txCallback(tx);
      
      // Verify log was written with O₂ PSI in checkEntries
      const logData = tx.set.mock.calls[0]?.[1];
      expect(logData.checkEntries).toBeDefined();
      expect(logData.checkEntries[0].assetCheckResult).toBeDefined();
      expect(logData.checkEntries[0].assetCheckResult.oxygenPsi).toBe(2000);
    });

    it('should handle multiple O₂ tanks in one checkout', async () => {
      const checkEntries = [
        {
          itemId: 'oxygen-tank-001',
          itemName: 'Oxygen Tank D-Cylinder',
          requiredQuantity: 1,
          countedQuantity: 1,
          ok: true,
          assetCheckResult: { oxygenPsi: 2000 },
        },
        {
          itemId: 'oxygen-tank-002',
          itemName: 'Spare Oxygen Tank',
          requiredQuantity: 1,
          countedQuantity: 1,
          ok: true,
          assetCheckResult: { oxygenPsi: 1950 },
        },
        {
          itemId: 'aed-001',
          itemName: 'AED',
          requiredQuantity: 1,
          countedQuantity: 1,
          ok: true,
        },
      ];

      await logStatpackCheckOff({
        statpackId: 'statpack-001',
        statpackName: 'Primary ALS Statpack',
        action: 'checkout',
        userId: 'user-123',
        userName: 'Test User',
        checkEntries,
      });

      const tx = {
        get: vi.fn().mockResolvedValue({
          exists: () => true,
          data: () => ({ isCheckedOut: false }),
        }),
        set: vi.fn(),
        update: vi.fn(),
      };
      
      await mockRunTransaction.mock.calls[0][1](tx);
      
      const logData = tx.set.mock.calls[0]?.[1];
      expect(logData.checkEntries).toHaveLength(3);
      expect(logData.checkEntries[0].assetCheckResult.oxygenPsi).toBe(2000);
      expect(logData.checkEntries[1].assetCheckResult.oxygenPsi).toBe(1950);
      expect(logData.checkEntries[2].assetCheckResult).toBeUndefined();
    });

    it('should preserve O₂ PSI through transaction sanitization', async () => {
      const checkEntries = [
        {
          itemId: 'oxygen-tank-001',
          itemName: 'Oxygen Tank D-Cylinder',
          requiredQuantity: 1,
          countedQuantity: 1,
          ok: true,
          assetCheckResult: {
            oxygenPsi: 1850,
            batteryPct: undefined, // Should be stripped
          },
        },
      ];

      await logStatpackCheckOff({
        statpackId: 'statpack-001',
        statpackName: 'Primary ALS Statpack',
        action: 'checkout',
        userId: 'user-123',
        userName: 'Test User',
        checkEntries,
      });

      const tx = {
        get: vi.fn().mockResolvedValue({
          exists: () => true,
          data: () => ({ isCheckedOut: false }),
        }),
        set: vi.fn(),
        update: vi.fn(),
      };
      
      await mockRunTransaction.mock.calls[0][1](tx);
      
      const logData = tx.set.mock.calls[0]?.[1];
      expect(logData.checkEntries[0].assetCheckResult.oxygenPsi).toBe(1850);
      expect(logData.checkEntries[0].assetCheckResult.batteryPct).toBeUndefined();
    });
  });

  describe('Edge Cases', () => {
    it('should handle O₂ PSI of 0 (empty tank)', async () => {
      const checkEntries = [
        {
          itemId: 'oxygen-tank-001',
          itemName: 'Oxygen Tank D-Cylinder',
          requiredQuantity: 1,
          countedQuantity: 1,
          ok: true,
          assetCheckResult: { oxygenPsi: 0 },
        },
      ];

      await logStatpackCheckOff({
        statpackId: 'statpack-001',
        statpackName: 'Primary ALS Statpack',
        action: 'checkout',
        userId: 'user-123',
        userName: 'Test User',
        checkEntries,
      });

      const tx = {
        get: vi.fn().mockResolvedValue({
          exists: () => true,
          data: () => ({ isCheckedOut: false }),
        }),
        set: vi.fn(),
        update: vi.fn(),
      };
      
      await mockRunTransaction.mock.calls[0][1](tx);
      
      const logData = tx.set.mock.calls[0]?.[1];
      expect(logData.checkEntries[0].assetCheckResult.oxygenPsi).toBe(0);
    });

    it('should handle checkout without O₂ items', async () => {
      const checkEntries = [
        {
          itemId: 'aed-001',
          itemName: 'AED',
          requiredQuantity: 1,
          countedQuantity: 1,
          ok: true,
        },
      ];

      await logStatpackCheckOff({
        statpackId: 'statpack-001',
        statpackName: 'Primary ALS Statpack',
        action: 'checkout',
        userId: 'user-123',
        userName: 'Test User',
        checkEntries,
      });

      const tx = {
        get: vi.fn().mockResolvedValue({
          exists: () => true,
          data: () => ({ isCheckedOut: false }),
        }),
        set: vi.fn(),
        update: vi.fn(),
      };
      
      await mockRunTransaction.mock.calls[0][1](tx);
      
      const logData = tx.set.mock.calls[0]?.[1];
      expect(logData.checkEntries[0].assetCheckResult).toBeUndefined();
    });

    it('should handle undefined assetCheckResult', async () => {
      const checkEntries = [
        {
          itemId: 'oxygen-tank-001',
          itemName: 'Oxygen Tank D-Cylinder',
          requiredQuantity: 1,
          countedQuantity: 1,
          ok: true,
          assetCheckResult: undefined,
        },
      ];

      await logStatpackCheckOff({
        statpackId: 'statpack-001',
        statpackName: 'Primary ALS Statpack',
        action: 'checkout',
        userId: 'user-123',
        userName: 'Test User',
        checkEntries,
      });

      const tx = {
        get: vi.fn().mockResolvedValue({
          exists: () => true,
          data: () => ({ isCheckedOut: false }),
        }),
        set: vi.fn(),
        update: vi.fn(),
      };
      
      await mockRunTransaction.mock.calls[0][1](tx);
      
      const logData = tx.set.mock.calls[0]?.[1];
      // Sanitization should remove undefined fields
      expect(logData.checkEntries[0].assetCheckResult).toBeUndefined();
    });
  });

  describe('Timestamp Handling', () => {
    it('should set both server and client timestamps', async () => {
      const checkEntries = [
        {
          itemId: 'oxygen-tank-001',
          itemName: 'Oxygen Tank D-Cylinder',
          requiredQuantity: 1,
          countedQuantity: 1,
          ok: true,
          assetCheckResult: { oxygenPsi: 2000 },
        },
      ];

      await logStatpackCheckOff({
        statpackId: 'statpack-001',
        statpackName: 'Primary ALS Statpack',
        action: 'checkout',
        userId: 'user-123',
        userName: 'Test User',
        checkEntries,
      });

      const tx = {
        get: vi.fn().mockResolvedValue({
          exists: () => true,
          data: () => ({ isCheckedOut: false }),
        }),
        set: vi.fn(),
        update: vi.fn(),
      };
      
      await mockRunTransaction.mock.calls[0][1](tx);
      
      const logData = tx.set.mock.calls[0]?.[1];
      expect(logData.timestamp).toBeDefined();
      expect(logData.clientTimestamp).toBeInstanceOf(Date);
      expect(logData.checkEntries[0].checkedAt).toBeInstanceOf(Date);
    });
  });
});
