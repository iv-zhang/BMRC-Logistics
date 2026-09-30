/**
 * Unit tests for the variant signature (app/lib/variant-signature.ts).
 *
 * Runs on Node's built-in test runner, no extra dependencies and no Firebase:
 *   npx tsx --test app/lib/__tests__/variant-signature.test.ts
 *
 * (The repo has no vitest install; the older files in this folder import
 * vitest and are not runnable. This file deliberately does not.)
 *
 * Fixtures are generic supply names only.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  variantSignature,
  variantsMatch,
  checkVariantMerge,
  itemVariantSignature,
} from '../variant-signature';

const tokens = (n: string) => variantSignature(n).tokens;
const match = (a: string, b: string) => variantsMatch(a, b);

describe('must NOT match (different variants)', () => {
  const pairs: Array<[string, string]> = [
    // French sizes
    ['NPA 28 Fr', 'NPA 30 Fr'],
    ['NPA, 28 Fr', 'NPA, 30 Fr'],
    // letter sizes
    ['Gloves M', 'Gloves L'],
    ['Nitrile Gloves, S', 'Nitrile Gloves, XL'],
    ['Nitrile Gloves, Small', 'Nitrile Gloves, Large'],
    ['Nitrile Gloves, XL', 'Nitrile Gloves, XXL'],
    ['Nitrile Gloves, S/M', 'Nitrile Gloves, M/L'],
    ['Nitrile Gloves, S/M', 'Nitrile Gloves, S'],
    // age groups
    ['BVM adult', 'BVM peds'],
    ['BVM, Adult', 'BVM, Infant'],
    ['BVM, Pediatric', 'BVM, Infant'],
    ['Cervical Collar, Adult', 'Cervical Collar, Neonatal'],
    // gauge
    ['14g IV', '18g IV'],
    ['IV Catheter 20 ga', 'IV Catheter 22 ga'],
    // mm / inches / mL / L
    ['OPA 80 mm', 'OPA 90 mm'],
    ['Kerlix 4.5 in', 'Kerlix 3.4 in'],
    ['Normal Saline 500 mL', 'Normal Saline 1000 mL'],
    ['Syringe 3 mL', 'Syringe 10 mL'],
    // size N
    ['OPA size 3', 'OPA size 4'],
    ['Tourniquet size 2', 'Tourniquet sz 3'],
    // dimensions
    ['Gauze 4x4', 'Gauze 2x2'],
    ['Gauze 4 x 4', 'Gauze 4 x 3'],
    ['Tape 1 in x 10 yd', 'Tape 2 in x 10 yd'],
    // triage colors
    ['Triage Tag, Red', 'Triage Tag, Yellow'],
    ['Triage Tape Green', 'Triage Tape Black'],
    // bare numbers (numbered assets, tube sizes)
    ['Stat Pack 1', 'Stat Pack 2'],
    ['ET Tube 7.0', 'ET Tube 7.5'],
    // mask sizes / respirators
    ['N95 M', 'N95 L'],
    // unsized vs sized is a mismatch (an unsized record cannot be assumed to be M)
    ['Nitrile Gloves', 'Nitrile Gloves, M'],
    ['BVM', 'BVM, Peds'],
    // name/variant in either order still differs when the value differs
    ['Large Kerlix', 'Small Kerlix'],
  ];
  for (const [a, b] of pairs) {
    it(`"${a}" != "${b}"`, () => {
      assert.equal(match(a, b), false, `${JSON.stringify(tokens(a))} vs ${JSON.stringify(tokens(b))}`);
    });
  }
});

describe('must match (same variant, different spelling)', () => {
  const pairs: Array<[string, string]> = [
    ['NPA 28 Fr', 'NPA 28Fr'],
    ['NPA 28 Fr', 'NPA, 28 French'],
    ['NPA 28 Fr', 'npa 28 FR'],
    ['Nitrile Gloves, M', 'Nitrile Gloves, Medium'],
    ['Nitrile Gloves (M)', 'Nitrile Gloves, m'],
    ['Nitrile Gloves - XL', 'Nitrile Gloves, Extra Large'],
    ['Nitrile Gloves, XL', 'Nitrile Gloves, X-Large'],
    ['Nitrile Gloves, XXL', 'Nitrile Gloves, XX-Large'],
    ['Nitrile Gloves, S/M', 'Nitrile Gloves, S-M'],
    ['Nitrile Gloves, S/M', 'Nitrile Gloves, Small/Medium'],
    ['Nitrile Gloves, Med', 'Nitrile Gloves, M'],
    ['BVM Peds', 'BVM, Pediatric'],
    ['BVM Peds', 'BVM Paediatric'],
    ['BVM Adult', 'BVM, adult'],
    ['14g IV', '14 ga IV'],
    ['14g IV', '14 gauge IV'],
    ['IV Catheter 18G', 'IV Catheter 18 gauge'],
    ['OPA 80mm', 'OPA 80 mm'],
    ['Saline 1 L', 'Saline 1000 mL'],
    ['Saline 1000 cc', 'Saline 1000 mL'],
    ['Gauze 4x4', 'Gauze 4 x 4'],
    ['Gauze 4x4', 'Gauze 4 x 4 in'],
    ['Gauze 4x4', 'Gauze 4" x 4"'],
    ['ET Tube 7.0', 'ET Tube 7'],
    ['OPA size 3', 'OPA Size 3'],
    ['Triage Tag, Red', 'triage tag red'],
    ['Tape, Gray', 'Tape, Grey'],
    // pack counts are not part of the signature
    ['Nitrile Gloves, M', 'Nitrile Gloves, M (100 ct)'],
    ['Nitrile Gloves, M', 'Nitrile Gloves, M, box of 100'],
    ['Nitrile Gloves, M', 'Nitrile Gloves, M x100'],
    ['Nitrile Gloves, M', 'Nitrile Gloves, M 100/box'],
    ['Nitrile Gloves, M 50 pk', 'Nitrile Gloves, M 100 pk'],
    ['Bandaids, Small', 'Bandaids, Small, 100 count'],
    // names with no variant info at all
    ['Trauma Shears', 'trauma shears'],
    ['Trauma Shears', 'Trauma  Shears.'],
    // apostrophes do not create a stray "s" size
    ["Men's Shirt, M", 'Mens Shirt, M'],
  ];
  for (const [a, b] of pairs) {
    it(`"${a}" == "${b}"`, () => {
      assert.equal(match(a, b), true, `${JSON.stringify(tokens(a))} vs ${JSON.stringify(tokens(b))}`);
    });
  }
});

describe('token extraction', () => {
  it('french + gauge + mm + in + mL', () => {
    assert.deepEqual(tokens('NPA 28 Fr'), ['fr:28']);
    assert.deepEqual(tokens('14g IV'), ['g:14']);
    assert.deepEqual(tokens('OPA 80 mm'), ['mm:80']);
    assert.deepEqual(tokens('Kerlix 4.5 in'), ['in:4.5']);
    assert.deepEqual(tokens('NS 500 mL'), ['ml:500']);
    assert.deepEqual(tokens('NS 1 L'), ['ml:1000']);
  });
  it('letter sizes, words and ranges', () => {
    assert.deepEqual(tokens('Gloves, Small'), ['letter:s']);
    assert.deepEqual(tokens('Gloves, X-Large'), ['letter:xl']);
    assert.deepEqual(tokens('Gloves, S/M'), ['letter:s/m']);
  });
  it('age + color', () => {
    assert.deepEqual(tokens('BVM, Adult/Peds'), ['age:adult', 'age:peds']);
    assert.deepEqual(tokens('Triage Tag Red'), ['color:red']);
  });
  it('combined: size and color and age', () => {
    assert.deepEqual(tokens('Cold Pack, Peds, Blue, 4 in'), ['age:peds', 'color:blue', 'in:4']);
  });
  it('dimension keeps both numbers', () => {
    assert.deepEqual(tokens('Gauze 4x4'), ['dim:4x4']);
    assert.deepEqual(tokens('Tape 1 in x 10 yd'), ['dim:1x10']);
  });
  it('size N', () => {
    assert.deepEqual(tokens('OPA size 3'), ['size:3']);
  });
  it('no variant info yields an empty signature', () => {
    assert.deepEqual(tokens('Trauma Shears'), []);
    assert.equal(variantSignature('Trauma Shears').key, '');
    assert.deepEqual(tokens(''), []);
  });
  it('family names containing letters/digits are not mistaken for sizes', () => {
    assert.deepEqual(tokens('N95 Respirator'), []);
    assert.deepEqual(tokens('3M Tape'), []);
    assert.deepEqual(tokens('Med Kit'), []);
    assert.deepEqual(tokens('Medical Tape'), []);
    assert.deepEqual(tokens('Neosporin'), []);
  });
  it('tolerates null/undefined-ish input', () => {
    assert.deepEqual(variantSignature(undefined as unknown as string).tokens, []);
  });
});

describe('itemVariantSignature', () => {
  it('uses name and appends variantLabel when the name lacks it', () => {
    assert.deepEqual(itemVariantSignature({ name: 'Nitrile Gloves', variantLabel: 'L' }).tokens, ['letter:l']);
    assert.deepEqual(itemVariantSignature({ name: 'Nitrile Gloves, L', variantLabel: 'L' }).tokens, ['letter:l']);
    assert.deepEqual(itemVariantSignature({ name: 'Nitrile Gloves' }).tokens, []);
  });
});

describe('checkVariantMerge verdicts', () => {
  it('ok when signatures match', () => {
    assert.equal(checkVariantMerge({ name: 'NPA 28 Fr' }, { name: 'NPA, 28 French' }).verdict, 'ok');
  });
  it('ok for two unsized names', () => {
    assert.equal(checkVariantMerge({ name: 'Trauma Shears' }, { name: 'Trauma shears' }).verdict, 'ok');
  });
  it('blocked for different variants with no shared code', () => {
    const r = checkVariantMerge({ name: 'NPA 28 Fr', sku: 'A1' }, { name: 'NPA 30 Fr', sku: 'A2' });
    assert.equal(r.verdict, 'blocked');
    assert.match(r.reason, /different sizes\/variants/);
  });
  it('conflict for different variants that share a SKU', () => {
    const r = checkVariantMerge({ name: 'Gloves M', sku: 'GL-100' }, { name: 'Gloves L', sku: 'gl-100 ' });
    assert.equal(r.verdict, 'conflict');
    assert.match(r.reason, /share a SKU\/barcode/);
  });
  it('conflict for different variants that share a barcode', () => {
    const r = checkVariantMerge({ name: 'BVM adult', barcode: '0123' }, { name: 'BVM peds', barcode: '0123' });
    assert.equal(r.verdict, 'conflict');
  });
  it('empty SKU/barcode never counts as shared', () => {
    const r = checkVariantMerge({ name: 'Gloves M', sku: '', barcode: null }, { name: 'Gloves L', sku: '', barcode: null });
    assert.equal(r.verdict, 'blocked');
  });
  it('matching variants with a shared code are still ok', () => {
    assert.equal(
      checkVariantMerge({ name: 'Gloves M', sku: 'GL-1' }, { name: 'Gloves, Medium', sku: 'GL-1' }).verdict,
      'ok',
    );
  });
});
