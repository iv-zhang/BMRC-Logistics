/**
 *   NEXT_PUBLIC_FIREBASE_API_KEY=fake-key NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-bmrc-logistics \
 *     npx tsx --test app/lib/__tests__/inventory-merge-fuzzy.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicateCandidates, isFuzzyNameMatch } from '../inventory-merge';
import type { InventoryItem } from '@/app/types';

const mk = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ id, name, ...extra }) as unknown as InventoryItem;
const names = (groups: ReturnType<typeof findDuplicateCandidates>) =>
  groups.map((g) => g.items.map((i) => i.name).sort());

describe('isFuzzyNameMatch', () => {
  it('rejects short names', () => {
    assert.equal(isFuzzyNameMatch('tape', 'tap'), false);
  });
  it('rejects differing numeric tokens', () => {
    assert.equal(isFuzzyNameMatch('gauze 2x2', 'gauze 4x4'), false);
    assert.equal(isFuzzyNameMatch('syringe 3ml', 'syringe 5ml'), false);
  });
  it('accepts a typo', () => {
    assert.equal(isFuzzyNameMatch('trauma shears', 'truama shears'), true);
  });
});

describe('findDuplicateCandidates tightened matching', () => {
  it('does not group Tape / Tap', () => {
    assert.deepEqual(findDuplicateCandidates([mk('1', 'Tape'), mk('2', 'Tap')]), []);
  });
  it('does not group Gauze 2x2 / Gauze 4x4', () => {
    assert.deepEqual(findDuplicateCandidates([mk('1', 'Gauze 2x2'), mk('2', 'Gauze 4x4')]), []);
  });
  it('groups a typo pair', () => {
    assert.deepEqual(names(findDuplicateCandidates([mk('1', 'Trauma Shears'), mk('2', 'Truama Shears')])), [
      ['Trauma Shears', 'Truama Shears'],
    ]);
  });
  it('does not chain fuzzy links A~B~C when A and C differ', () => {
    // 15 chars -> threshold 2. A-B dist 2, B-C dist 2, A-C dist 4.
    const groups = findDuplicateCandidates([
      mk('1', 'abcdefghijklmno'),
      mk('2', 'abcdefghijklmxy'),
      mk('3', 'abcdefghijkxyxy'),
    ]);
    assert.ok(groups.every((g) => g.items.length < 3));
  });
  it('still groups exact SKU transitively', () => {
    const groups = findDuplicateCandidates([
      mk('1', 'Alpha item', { sku: 'S1' }),
      mk('2', 'Beta thing', { sku: 'S1', barcode: 'B1' }),
      mk('3', 'Gamma widget', { barcode: 'B1' }),
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].items.length, 3);
  });
});
