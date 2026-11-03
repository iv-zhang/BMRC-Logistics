/**
 *   npx tsx --test app/lib/__tests__/audit-condition.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  worstCondition, deriveAuditCondition, validateConditionCounts, formatConditionCounts,
} from '../audit-condition';

describe('worstCondition', () => {
  it('orders Expired > Damaged > Good', () => {
    assert.equal(worstCondition(), 'Good');
    assert.equal(worstCondition('Good', 'Damaged'), 'Damaged');
    assert.equal(worstCondition('Damaged', 'Expired', 'Good'), 'Expired');
    assert.equal(worstCondition('Good', 'Good'), 'Good');
  });
});

describe('deriveAuditCondition', () => {
  it('takes the worst of package and counts', () => {
    assert.equal(deriveAuditCondition('Damaged', { damaged: 0, expired: 2 }), 'Expired');
    assert.equal(deriveAuditCondition('Good', { damaged: 1, expired: 0 }), 'Damaged');
    assert.equal(deriveAuditCondition('Expired', { damaged: 1, expired: 0 }), 'Expired');
  });
  it('treats zeros and missing counts as Good', () => {
    assert.equal(deriveAuditCondition('Good', { damaged: 0, expired: 0 }), 'Good');
    assert.equal(deriveAuditCondition('Good', null), 'Good');
    assert.equal(deriveAuditCondition('Damaged', undefined), 'Damaged');
  });
});

describe('validateConditionCounts', () => {
  it('rejects negatives and non-integers', () => {
    assert.ok(validateConditionCounts({ damaged: -1, expired: 0 }, 5));
    assert.ok(validateConditionCounts({ damaged: 0, expired: 1.5 }, 5));
    assert.ok(validateConditionCounts({ damaged: NaN, expired: 0 }, 5));
  });
  it('rejects sum above loose, allows equal', () => {
    assert.ok(validateConditionCounts({ damaged: 3, expired: 3 }, 5));
    assert.equal(validateConditionCounts({ damaged: 3, expired: 2 }, 5), null);
    assert.equal(validateConditionCounts({ damaged: 0, expired: 0 }, 0), null);
  });
});

describe('formatConditionCounts', () => {
  it('formats combinations', () => {
    assert.equal(formatConditionCounts({ damaged: 2, expired: 1 }), '2 damaged · 1 expired');
    assert.equal(formatConditionCounts({ damaged: 1, expired: 0 }), '1 damaged');
    assert.equal(formatConditionCounts({ damaged: 0, expired: 3 }), '3 expired');
  });
  it('returns null for zero or missing', () => {
    assert.equal(formatConditionCounts({ damaged: 0, expired: 0 }), null);
    assert.equal(formatConditionCounts(null), null);
    assert.equal(formatConditionCounts(), null);
  });
});
