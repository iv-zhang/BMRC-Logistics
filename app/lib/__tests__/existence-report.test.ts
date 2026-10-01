/**
 * Test the existence-baseline report script's pure functions against getExistence().
 *
 *   NEXT_PUBLIC_FIREBASE_API_KEY=fake-key NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-bmrc-logistics \
 *     npx tsx --test app/lib/__tests__/existence-report.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getExistence, EXISTENCE_BASELINE_CUTOFF } from '../item-status';
import {
  classifyExistence,
  classifyUnverified,
  parseDate,
  EXISTENCE_BASELINE_CUTOFF as SCRIPT_CUTOFF,
} from '../../../scripts/report-existence-baseline.cjs';
import type { InventoryItem } from '@/app/types';

const before = new Date(2026, 4, 31, 23, 59);
const onCutoff = new Date(2026, 5, 1, 0, 0);
const after = new Date(2026, 8, 1);

describe('parseDate matches the item-status asDate behavior', () => {
  it('parses native Date', () => {
    assert.equal(parseDate(after)?.getTime(), after.getTime());
    assert.equal(parseDate(before)?.getTime(), before.getTime());
  });

  it('returns undefined for invalid dates', () => {
    assert.equal(parseDate(new Date('nope')), undefined);
    assert.equal(parseDate(undefined), undefined);
    assert.equal(parseDate(null), undefined);
  });

  it('coerces Timestamp-like objects with toDate()', () => {
    const ts = { toDate: () => after } as unknown as Date;
    const parsed = parseDate(ts);
    assert.equal(parsed?.getTime(), after.getTime());
  });

  it('coerces {seconds, nanoseconds} maps from Firestore', () => {
    const seconds = Math.floor(after.getTime() / 1000);
    const timestampMap = { seconds, nanoseconds: 0 };
    const parsed = parseDate(timestampMap);
    assert.ok(parsed);
    assert.ok(Math.abs(parsed.getTime() - after.getTime()) < 1000);
  });

  it('coerces ISO strings', () => {
    const iso = after.toISOString();
    const parsed = parseDate(iso);
    assert.ok(parsed);
    assert.ok(Math.abs(parsed.getTime() - after.getTime()) < 1000);
  });
});

describe('classifyExistence matches getExistence', () => {
  it('cutoff is June 1 2026', () => {
    assert.equal(SCRIPT_CUTOFF, EXISTENCE_BASELINE_CUTOFF.getTime());
  });

  it('retired wins over everything', () => {
    const item = { existence: 'retired' as const, lastAuditDate: after };
    assert.equal(classifyExistence(item), 'retired');
    assert.equal(getExistence(item), 'retired');
  });

  it('confirmed when audited on/after cutoff', () => {
    const onCutoffItem = { lastAuditDate: onCutoff };
    const afterItem = { lastAuditDate: after };
    assert.equal(classifyExistence(onCutoffItem), 'confirmed');
    assert.equal(getExistence(onCutoffItem), 'confirmed');
    assert.equal(classifyExistence(afterItem), 'confirmed');
    assert.equal(getExistence(afterItem), 'confirmed');
  });

  it('unverified when audited before cutoff', () => {
    const item = { lastAuditDate: before };
    assert.equal(classifyExistence(item), 'unverified');
    assert.equal(getExistence(item), 'unverified');
  });

  it('unverified when never audited', () => {
    const item = {} as unknown as Pick<InventoryItem, 'existence' | 'lastAuditDate'>;
    assert.equal(classifyExistence(item), 'unverified');
    assert.equal(getExistence(item), 'unverified');
  });

  it('unverified with invalid date', () => {
    const item = { lastAuditDate: new Date('nope') };
    assert.equal(classifyExistence(item), 'unverified');
    assert.equal(getExistence(item), 'unverified');
  });

  it('ignores stored confirmed/unverified (derived only)', () => {
    const storedConfirmed = { existence: 'confirmed' as const };
    const storedUnverified = { existence: 'unverified' as const, lastAuditDate: after };
    assert.equal(classifyExistence(storedConfirmed), 'unverified');
    assert.equal(getExistence(storedConfirmed), 'unverified');
    assert.equal(classifyExistence(storedUnverified), 'confirmed');
    assert.equal(getExistence(storedUnverified), 'confirmed');
  });

  it('handles Timestamp-like objects', () => {
    const ts = { toDate: () => after } as unknown as Date;
    const item = { lastAuditDate: ts };
    assert.equal(classifyExistence(item), 'confirmed');
    assert.equal(getExistence(item), 'confirmed');
  });

  it('handles {seconds, nanoseconds} maps (from Firestore admin SDK)', () => {
    const seconds = Math.floor(after.getTime() / 1000);
    const item = { lastAuditDate: { seconds, nanoseconds: 0 } } as unknown as Pick<InventoryItem, 'existence' | 'lastAuditDate'>;
    assert.equal(classifyExistence(item), 'confirmed');
    // Note: getExistence doesn't handle this format because the browser SDK
    // converts Timestamps to Date objects. Only the admin SDK returns this format.
    assert.equal(getExistence(item), 'unverified');
  });

  it('handles ISO strings (from Firestore admin SDK)', () => {
    const iso = after.toISOString();
    const item = { lastAuditDate: iso } as unknown as Pick<InventoryItem, 'existence' | 'lastAuditDate'>;
    assert.equal(classifyExistence(item), 'confirmed');
    // Note: getExistence doesn't handle this format; only the script needs to.
    assert.equal(getExistence(item), 'unverified');
  });
});

describe('classifyUnverified splits unverified into subcategories', () => {
  it('never_audited when lastAuditDate is missing', () => {
    assert.equal(classifyUnverified({}), 'never_audited');
    assert.equal(classifyUnverified({ lastAuditDate: null }), 'never_audited');
    assert.equal(classifyUnverified({ lastAuditDate: undefined }), 'never_audited');
  });

  it('audited_before_cutoff when lastAuditDate is present but before cutoff', () => {
    const item = { lastAuditDate: before };
    assert.equal(classifyUnverified(item), 'audited_before_cutoff');
  });

  it('handles Timestamp-like objects', () => {
    const ts = { toDate: () => before } as unknown as Date;
    const item = { lastAuditDate: ts };
    assert.equal(classifyUnverified(item), 'audited_before_cutoff');
  });

  it('handles {seconds, nanoseconds} maps', () => {
    const seconds = Math.floor(before.getTime() / 1000);
    const item = { lastAuditDate: { seconds, nanoseconds: 0 } };
    assert.equal(classifyUnverified(item), 'audited_before_cutoff');
  });
});
