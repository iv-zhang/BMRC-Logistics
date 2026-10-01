/**
 * Fiscal-year helpers (`app/lib/fiscal.ts`) and the A1 org-config keys
 * (`fiscalYearStartMonth`, `assetOwners`, `thresholds.expiryBuckets`).
 *
 *   NEXT_PUBLIC_FIREBASE_API_KEY=fake-key NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-bmrc-logistics \
 *     npx tsx --test app/lib/__tests__/fiscal.test.ts
 *
 * (The fake env only satisfies the Firebase client's constructor; nothing connects.)
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fiscalYearOf, fyLabel, fyRange, isInFY, currentFiscalYear } from '../fiscal';
import {
  applyOrgConfigDoc,
  getFiscalYearStartMonthRuntime,
  getAssetOwnersRuntime,
  getExpiryBuckets,
} from '../org-config-store';
import { DEFAULT_ORG_CONFIG } from '@/app/config/org-config';

const d = (y: number, m: number, day = 15, h = 12) => new Date(y, m - 1, day, h);

afterEach(() => applyOrgConfigDoc(undefined));

describe('fiscalYearOf (July start)', () => {
  it('FY27 is Jul 2026 - Jun 2027', () => {
    assert.equal(fiscalYearOf(d(2026, 7, 1, 0), 7), 2027);
    assert.equal(fiscalYearOf(d(2026, 9, 30), 7), 2027);
    assert.equal(fiscalYearOf(d(2026, 12, 31, 23), 7), 2027);
    assert.equal(fiscalYearOf(d(2027, 1, 1, 0), 7), 2027);
    assert.equal(fiscalYearOf(d(2027, 6, 30, 23), 7), 2027);
  });
  it('rolls over at midnight Jul 1', () => {
    assert.equal(fiscalYearOf(new Date(2026, 5, 30, 23, 59, 59), 7), 2026); // Jun 30 -> FY26
    assert.equal(fiscalYearOf(new Date(2026, 6, 1, 0, 0, 0), 7), 2027); // Jul 1 -> FY27
  });
  it('matches the workbook fixtures (Fall 2024 -> FY25, Fall 2025 and Spring 2026 -> FY26)', () => {
    assert.equal(fiscalYearOf(d(2024, 10, 1), 7), 2025);
    assert.equal(fiscalYearOf(d(2025, 10, 8), 7), 2026);
    assert.equal(fiscalYearOf(d(2026, 3, 1), 7), 2026);
  });
  it('January start is the calendar year', () => {
    assert.equal(fiscalYearOf(d(2026, 1, 1), 1), 2026);
    assert.equal(fiscalYearOf(d(2026, 12, 31), 1), 2026);
  });
  it('other start months (October)', () => {
    assert.equal(fiscalYearOf(d(2026, 9, 30), 10), 2026);
    assert.equal(fiscalYearOf(d(2026, 10, 1), 10), 2027);
  });
  it('an out-of-range start month falls back to July', () => {
    assert.equal(fiscalYearOf(d(2026, 8, 1), 0), 2027);
    assert.equal(fiscalYearOf(d(2026, 8, 1), 13), 2027);
    assert.equal(fiscalYearOf(d(2026, 8, 1), 7.5), 2027);
    assert.equal(fiscalYearOf(d(2026, 8, 1), Number.NaN), 2027);
  });
});

describe('fyLabel', () => {
  it('renders FYyy', () => {
    assert.equal(fyLabel(2027), 'FY27');
    assert.equal(fyLabel(2025), 'FY25');
    assert.equal(fyLabel(2009), 'FY09');
    assert.equal(fyLabel(2100), 'FY00');
    assert.equal(fyLabel(27), 'FY27');
  });
});

describe('fyRange / isInFY', () => {
  it('FY27 spans Jul 1 2026 up to (not including) Jul 1 2027', () => {
    const r = fyRange(2027, 7);
    assert.deepEqual(r.start, new Date(2026, 6, 1));
    assert.deepEqual(r.endExclusive, new Date(2027, 6, 1));
  });
  it('calendar-year FY', () => {
    const r = fyRange(2026, 1);
    assert.deepEqual(r.start, new Date(2026, 0, 1));
    assert.deepEqual(r.endExclusive, new Date(2027, 0, 1));
  });
  it('isInFY boundaries are half-open', () => {
    assert.equal(isInFY(new Date(2026, 6, 1, 0, 0, 0), 2027, 7), true);
    assert.equal(isInFY(new Date(2026, 5, 30, 23, 59, 59), 2027, 7), false);
    assert.equal(isInFY(new Date(2027, 5, 30, 23, 59, 59), 2027, 7), true);
    assert.equal(isInFY(new Date(2027, 6, 1, 0, 0, 0), 2027, 7), false);
  });
  it('an invalid date is in no FY', () => {
    assert.equal(isInFY(new Date('nope'), 2027, 7), false);
  });
  it('fiscalYearOf and isInFY agree over a sweep', () => {
    for (let y = 2024; y <= 2028; y++) {
      for (let m = 1; m <= 12; m++) {
        for (const start of [1, 7, 10]) {
          const dt = d(y, m, 1, 0);
          const fy = fiscalYearOf(dt, start);
          assert.equal(isInFY(dt, fy, start), true, `${dt.toISOString()} start ${start}`);
          assert.equal(isInFY(dt, fy + 1, start), false);
          assert.equal(isInFY(dt, fy - 1, start), false);
        }
      }
    }
  });
});

describe('runtime start month', () => {
  it('defaults to July with no override', () => {
    assert.equal(DEFAULT_ORG_CONFIG.fiscalYearStartMonth, 7);
    assert.equal(getFiscalYearStartMonthRuntime(), 7);
    assert.equal(fiscalYearOf(d(2026, 9, 30)), 2027);
    assert.equal(currentFiscalYear(d(2026, 9, 30)), 2027);
  });
  it('follows an admin override (not the frozen constant)', () => {
    applyOrgConfigDoc({ fiscalYearStartMonth: 1 });
    assert.equal(getFiscalYearStartMonthRuntime(), 1);
    assert.equal(fiscalYearOf(d(2026, 9, 30)), 2026);
    assert.deepEqual(fyRange(2026).start, new Date(2026, 0, 1));
  });
});

describe('org-config round-trip for the A1 keys', () => {
  it('defaults: July, owners incl. BMRC/OEM/UCPD, buckets 30/60/90', () => {
    applyOrgConfigDoc(undefined);
    assert.equal(getFiscalYearStartMonthRuntime(), 7);
    assert.deepEqual(getAssetOwnersRuntime(), ['BMRC', 'OEM', 'UCPD']);
    assert.deepEqual(getExpiryBuckets(), [30, 60, 90]);
  });
  it('a partial doc without the keys keeps the defaults', () => {
    applyOrgConfigDoc({ semesterStartDate: '2026-08-25' });
    assert.equal(getFiscalYearStartMonthRuntime(), 7);
    assert.deepEqual(getAssetOwnersRuntime(), ['BMRC', 'OEM', 'UCPD']);
    assert.deepEqual(getExpiryBuckets(), [30, 60, 90]);
  });
  it('a partial thresholds doc keeps the default buckets', () => {
    applyOrgConfigDoc({ thresholds: { expirationWarningDays: 60 } as never });
    assert.deepEqual(getExpiryBuckets(), [30, 60, 90]);
  });
  it('stored overrides win', () => {
    applyOrgConfigDoc({
      fiscalYearStartMonth: 9,
      assetOwners: ['BMRC', 'Campus'],
      thresholds: { ...DEFAULT_ORG_CONFIG.thresholds, expiryBuckets: [14, 45] },
    });
    assert.equal(getFiscalYearStartMonthRuntime(), 9);
    assert.deepEqual(getAssetOwnersRuntime(), ['BMRC', 'Campus']);
    assert.deepEqual(getExpiryBuckets(), [14, 45]);
  });
  it('buckets are sanitized: sorted, deduped, positive whole days', () => {
    applyOrgConfigDoc({ thresholds: { expiryBuckets: [90, 30, 30, 0, -5, 60.9, 'x'] } as never });
    assert.deepEqual(getExpiryBuckets(), [30, 60, 90]);
  });
  it('corrupt values fall back to the defaults', () => {
    applyOrgConfigDoc({
      fiscalYearStartMonth: 13,
      assetOwners: [] as never,
      thresholds: { expiryBuckets: [] } as never,
    });
    assert.equal(getFiscalYearStartMonthRuntime(), 7);
    assert.deepEqual(getAssetOwnersRuntime(), ['BMRC', 'OEM', 'UCPD']);
    assert.deepEqual(getExpiryBuckets(), [30, 60, 90]);
    applyOrgConfigDoc({ fiscalYearStartMonth: 'July' as never, thresholds: { expiryBuckets: 'soon' } as never });
    assert.equal(getFiscalYearStartMonthRuntime(), 7);
    assert.deepEqual(getExpiryBuckets(), [30, 60, 90]);
  });
});
