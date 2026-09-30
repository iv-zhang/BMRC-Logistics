/**
 * Cadence-aware audit check (`isAuditCurrent`) and the `thresholds.auditCadence` setting.
 *
 *   NEXT_PUBLIC_FIREBASE_API_KEY=fake-key NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-bmrc-logistics \
 *     npx tsx --test app/lib/__tests__/audit-cadence.test.ts
 *
 * (The fake env only satisfies the Firebase client's constructor; nothing connects.)
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAuditCurrent,
  isAuditedThisMonth,
  getAuditCadence,
  auditCyclePeriod,
  auditCycleLabel,
} from '../item-status';
import { applyOrgConfigDoc } from '../org-config-store';
import { DEFAULT_ORG_CONFIG } from '@/app/config/org-config';

const d = (y: number, m: number, day = 15, h = 12) => new Date(y, m - 1, day, h);

afterEach(() => applyOrgConfigDoc(undefined));

describe('default / monthly', () => {
  it('default cadence is monthly', () => {
    assert.equal(DEFAULT_ORG_CONFIG.thresholds.auditCadence, 'monthly');
    applyOrgConfigDoc(undefined);
    assert.equal(getAuditCadence(), 'monthly');
  });

  it("monthly is identical to isAuditedThisMonth over a wide sweep", () => {
    const nows = [d(2026, 1, 1, 0), d(2026, 6, 30, 23), d(2026, 9, 30), d(2026, 12, 31, 23), d(2027, 1, 1, 0)];
    for (const now of nows) {
      for (let y = 2025; y <= 2027; y++) {
        for (let m = 1; m <= 12; m++) {
          for (const day of [1, 15, 28]) {
            const a = d(y, m, day);
            assert.equal(
              isAuditCurrent(a, now, 'monthly'),
              isAuditedThisMonth(a, now),
              `audit ${a.toISOString()} vs now ${now.toISOString()}`,
            );
          }
        }
      }
    }
  });

  it('never audited is never current, for every cadence', () => {
    for (const c of ['monthly', 'quarterly', 'semester', 'yearly'] as const) {
      assert.equal(isAuditCurrent(undefined, d(2026, 9, 30), c), false);
    }
  });

  it('with no explicit cadence it follows the configured one (monthly by default)', () => {
    const now = d(2026, 9, 30);
    assert.equal(isAuditCurrent(d(2026, 9, 1), now), true);
    assert.equal(isAuditCurrent(d(2026, 8, 31), now), false);
  });
});

describe('quarterly', () => {
  const now = d(2026, 8, 15); // Q3: Jul-Sep
  it('current within the same calendar quarter', () => {
    assert.equal(isAuditCurrent(d(2026, 7, 1, 0), now, 'quarterly'), true);
    assert.equal(isAuditCurrent(d(2026, 9, 30, 23), now, 'quarterly'), true);
  });
  it('not current in the previous or next quarter, or same quarter of another year', () => {
    assert.equal(isAuditCurrent(d(2026, 6, 30, 23), now, 'quarterly'), false);
    assert.equal(isAuditCurrent(d(2026, 10, 1, 0), now, 'quarterly'), false);
    assert.equal(isAuditCurrent(d(2025, 8, 15), now, 'quarterly'), false);
  });
  it('Q1 and Q4 boundaries', () => {
    assert.equal(isAuditCurrent(d(2026, 1, 1, 0), d(2026, 3, 31, 23), 'quarterly'), true);
    assert.equal(isAuditCurrent(d(2026, 3, 31, 23), d(2026, 4, 1, 0), 'quarterly'), false);
    assert.equal(isAuditCurrent(d(2026, 10, 1), d(2026, 12, 31), 'quarterly'), true);
  });
});

describe('yearly', () => {
  it('same calendar year only', () => {
    const now = d(2026, 9, 30);
    assert.equal(isAuditCurrent(d(2026, 1, 1, 0), now, 'yearly'), true);
    assert.equal(isAuditCurrent(d(2025, 12, 31, 23), now, 'yearly'), false);
  });
});

describe('semester', () => {
  const fallStart = new Date(2026, 7, 25); // Aug 25 2026
  it('current on/after the semester start, not before', () => {
    const now = d(2026, 10, 10);
    assert.equal(isAuditCurrent(d(2026, 8, 25, 0), now, 'semester', fallStart), true);
    assert.equal(isAuditCurrent(d(2026, 10, 1), now, 'semester', fallStart), true);
    assert.equal(isAuditCurrent(d(2026, 8, 24, 23), now, 'semester', fallStart), false);
  });
  it('a stale (old) semester start is clamped to the calendar half-year start', () => {
    const now = d(2026, 10, 10); // H2 starts Jul 1
    const stale = new Date(2026, 0, 1);
    assert.equal(isAuditCurrent(d(2026, 3, 1), now, 'semester', stale), false);
    assert.equal(isAuditCurrent(d(2026, 7, 2), now, 'semester', stale), true);
  });
  it('a future semester start is ignored (falls back to half-year start)', () => {
    const now = d(2026, 1, 5);
    const future = new Date(2026, 0, 20);
    assert.equal(isAuditCurrent(d(2026, 1, 2), now, 'semester', future), true);
    assert.equal(isAuditCurrent(d(2025, 12, 31), now, 'semester', future), false);
  });
  it('an audit dated far in the future is not current', () => {
    assert.equal(isAuditCurrent(d(2026, 12, 1), d(2026, 10, 10), 'semester', fallStart), false);
  });
  it('reads the configured semesterStartDate when none is passed', () => {
    applyOrgConfigDoc({ semesterStartDate: '2026-08-25' });
    const now = d(2026, 10, 10);
    assert.equal(isAuditCurrent(d(2026, 8, 30), now, 'semester'), true);
    assert.equal(isAuditCurrent(d(2026, 8, 1), now, 'semester'), false);
  });
});

describe('config wiring', () => {
  it('a stored auditCadence overrides the default', () => {
    applyOrgConfigDoc({ thresholds: { ...DEFAULT_ORG_CONFIG.thresholds, auditCadence: 'quarterly' } });
    assert.equal(getAuditCadence(), 'quarterly');
    const now = d(2026, 9, 30);
    assert.equal(isAuditCurrent(d(2026, 7, 5), now), true); // same quarter, different month
  });
  it('a partial thresholds doc without the key keeps monthly', () => {
    applyOrgConfigDoc({ thresholds: { expirationWarningDays: 60 } as never });
    assert.equal(getAuditCadence(), 'monthly');
  });
  it('a corrupt value falls back to monthly', () => {
    applyOrgConfigDoc({ thresholds: { auditCadence: 'weekly' } as never });
    assert.equal(getAuditCadence(), 'monthly');
  });
});

describe('labels', () => {
  it('period words and cycle labels', () => {
    assert.equal(auditCyclePeriod('monthly'), 'this month');
    assert.equal(auditCyclePeriod('quarterly'), 'this quarter');
    assert.equal(auditCyclePeriod('semester'), 'this semester');
    assert.equal(auditCyclePeriod('yearly'), 'this year');
    assert.equal(auditCycleLabel(d(2026, 7, 10), 'monthly'), 'July 2026');
    assert.equal(auditCycleLabel(d(2026, 8, 10), 'quarterly'), 'Q3 2026');
    assert.equal(auditCycleLabel(d(2026, 8, 10), 'yearly'), '2026');
  });
});
