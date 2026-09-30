/**
 * The variant gate wired into duplicate detection (app/lib/inventory-merge.ts).
 * Only the pure functions are exercised; importing the module builds a Firestore
 * client handle but performs no reads or writes.
 *
 *   NEXT_PUBLIC_FIREBASE_API_KEY=fake-key NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-bmrc-logistics \
 *     npx tsx --test app/lib/__tests__/inventory-merge-variants.test.ts
 *
 * (The fake env only satisfies the Firebase client's constructor; nothing connects.)
 *
 * `mergeInventoryItems` / `buildMergePlan` need Firestore; their variant guard is
 * the same `checkVariantMerge` call covered in variant-signature.test.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicateCandidates, findVariantConflicts } from '../inventory-merge';
import type { InventoryItem } from '@/app/types';

const mk = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ id, name, ...extra }) as unknown as InventoryItem;

const names = (groups: ReturnType<typeof findDuplicateCandidates>) =>
  groups.map((g) => g.items.map((i) => i.name).sort());

describe('findDuplicateCandidates variant gate', () => {
  it('does not group different sizes despite near-identical names', () => {
    const groups = findDuplicateCandidates([
      mk('1', 'NPA 28 Fr'),
      mk('2', 'NPA 30 Fr'),
      mk('3', 'Gloves M'),
      mk('4', 'Gloves L'),
      mk('5', 'BVM adult'),
      mk('6', 'BVM peds'),
      mk('7', '14g IV'),
      mk('8', '18g IV'),
    ]);
    assert.deepEqual(groups, []);
  });

  it('does not chain S, M, L into one group', () => {
    assert.deepEqual(
      findDuplicateCandidates([mk('1', 'Gloves S'), mk('2', 'Gloves M'), mk('3', 'Gloves L')]),
      [],
    );
  });

  it('still groups true duplicates (same variant, different spelling)', () => {
    const groups = findDuplicateCandidates([
      mk('1', 'NPA 28 Fr'),
      mk('2', 'NPA 28Fr'),
      mk('3', 'NPA 30 Fr'),
    ]);
    assert.deepEqual(names(groups), [['NPA 28 Fr', 'NPA 28Fr']]);
  });

  it('still groups exact-name and same-SKU duplicates', () => {
    const groups = findDuplicateCandidates([
      mk('1', 'Trauma Shears'),
      mk('2', 'trauma shears'),
      mk('3', 'Tape, 1 in', { sku: 'T1' }),
      mk('4', 'Surgical Tape, 1 in', { sku: 't1' }),
    ]);
    assert.equal(groups.length, 2);
  });

  it('does not group a shared SKU across different variants', () => {
    assert.deepEqual(
      findDuplicateCandidates([mk('1', 'Gloves M', { sku: 'GL' }), mk('2', 'Gloves L', { sku: 'GL' })]),
      [],
    );
  });
});

describe('findVariantConflicts', () => {
  it('reports same SKU or barcode with different variants', () => {
    const c = findVariantConflicts([
      mk('1', 'Gloves M', { sku: 'GL' }),
      mk('2', 'Gloves L', { sku: 'gl' }),
      mk('3', 'BVM adult', { barcode: '123' }),
      mk('4', 'BVM peds', { barcode: '123' }),
    ]);
    assert.equal(c.length, 2);
    assert.deepEqual(c[0].shared, ['sku']);
    assert.deepEqual(c[1].shared, ['barcode']);
  });

  it('ignores same-variant pairs, unlinked pairs, and archived items', () => {
    const c = findVariantConflicts([
      mk('1', 'Gloves M', { sku: 'GL' }),
      mk('2', 'Gloves, Medium', { sku: 'GL' }),
      mk('3', 'NPA 28 Fr'),
      mk('4', 'NPA 30 Fr'),
      mk('5', 'Gloves L', { sku: 'GL', isArchived: true }),
    ]);
    assert.deepEqual(c, []);
  });
});
