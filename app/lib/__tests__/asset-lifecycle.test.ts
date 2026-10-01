/**
 * Pure asset-lifecycle logic (`app/lib/asset-lifecycle.ts`).
 *
 *   NEXT_PUBLIC_FIREBASE_API_KEY=fake-key NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-bmrc-logistics \
 *     npx tsx --test app/lib/__tests__/asset-lifecycle.test.ts
 *
 * (The fake env only satisfies the Firebase client's constructor; nothing connects.)
 * `changeAssetLifecycle` writes to Firestore and is not exercised here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSET_LIFECYCLES,
  LOSS_LIFECYCLES,
  getLifecycle,
  isAssetLifecycle,
  validateLifecycleChange,
  appendLifecycleHistory,
  planLifecycleChange,
} from '../asset-lifecycle';
import type { AssetLifecycleEntry } from '@/app/types';

const actor = { uid: 'u1', name: 'Test Actor' };
const t0 = new Date(2026, 8, 1);
const t1 = new Date(2026, 8, 15);

describe('getLifecycle', () => {
  it('undefined (legacy doc) reads as active', () => {
    assert.equal(getLifecycle({}), 'active');
    assert.equal(getLifecycle(undefined), 'active');
    assert.equal(getLifecycle(null), 'active');
  });
  it('a corrupt stored value reads as active', () => {
    assert.equal(getLifecycle({ lifecycle: 'gone' as never }), 'active');
  });
  it('a valid value is returned as-is', () => {
    for (const l of ASSET_LIFECYCLES) assert.equal(getLifecycle({ lifecycle: l }), l);
  });
  it('isAssetLifecycle and the loss set', () => {
    assert.equal(isAssetLifecycle('lost'), true);
    assert.equal(isAssetLifecycle('Ready'), false);
    assert.equal(isAssetLifecycle(undefined), false);
    assert.deepEqual([...LOSS_LIFECYCLES], ['lost', 'damaged', 'retired']);
  });
});

describe('validateLifecycleChange', () => {
  it('rejects a no-op', () => {
    const r = validateLifecycleChange('active', 'active');
    assert.equal(r.ok, false);
  });
  it('rejects an unknown target', () => {
    assert.equal(validateLifecycleChange('active', 'stolen' as never).ok, false);
  });
  it('retired is terminal', () => {
    for (const to of ASSET_LIFECYCLES) {
      if (to === 'retired') continue;
      assert.equal(validateLifecycleChange('retired', to, 'x').ok, false, `retired -> ${to}`);
    }
  });
  it('a loan needs a holder', () => {
    assert.equal(validateLifecycleChange('active', 'loaned_out').ok, false);
    assert.equal(validateLifecycleChange('active', 'loaned_out', '   ').ok, false);
    assert.equal(validateLifecycleChange('active', 'loaned_out', 'Team A').ok, true);
  });
  it('lost / damaged can come back; any non-terminal state can retire', () => {
    assert.equal(validateLifecycleChange('lost', 'active').ok, true);
    assert.equal(validateLifecycleChange('damaged', 'active').ok, true);
    for (const from of ['active', 'loaned_out', 'lost', 'damaged'] as const) {
      assert.equal(validateLifecycleChange(from, 'retired').ok, true, `${from} -> retired`);
    }
  });
});

describe('appendLifecycleHistory', () => {
  const e0: AssetLifecycleEntry = { from: 'active', to: 'damaged', at: t0 };
  const e1: AssetLifecycleEntry = { from: 'damaged', to: 'retired', at: t1 };
  it('starts a history from undefined', () => {
    assert.deepEqual(appendLifecycleHistory(undefined, e0), [e0]);
  });
  it('appends in order and does not mutate the input', () => {
    const h = [e0];
    const out = appendLifecycleHistory(h, e1);
    assert.deepEqual(out, [e0, e1]);
    assert.equal(h.length, 1);
    assert.notEqual(out, h);
  });
});

describe('planLifecycleChange', () => {
  it('active -> damaged stamps from/to/at/by/note and appends history', () => {
    const plan = planLifecycleChange({}, 'damaged', actor, { note: '  cracked case  ' }, t0);
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.deepEqual(plan.entry, { from: 'active', to: 'damaged', at: t0, by: { uid: 'u1', name: 'Test Actor' }, note: 'cracked case' });
    assert.equal(plan.patch.lifecycle, 'damaged');
    assert.deepEqual(plan.patch.lifecycleHistory, [plan.entry]);
    assert.equal(plan.patch.assignedTo, null);
  });
  it('omits an empty note instead of writing undefined', () => {
    const plan = planLifecycleChange({}, 'lost', actor, { note: '   ' }, t0);
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal('note' in plan.entry, false);
  });
  it('appends to an existing history', () => {
    const prior: AssetLifecycleEntry[] = [{ from: 'active', to: 'damaged', at: t0 }];
    const plan = planLifecycleChange({ lifecycle: 'damaged', lifecycleHistory: prior }, 'retired', actor, {}, t1);
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.patch.lifecycleHistory.length, 2);
    assert.equal(plan.patch.lifecycleHistory[0], prior[0]);
    assert.equal(plan.patch.lifecycleHistory[1].to, 'retired');
    assert.equal(prior.length, 1);
  });
  it('a loan records the holder; returning it clears the holder', () => {
    const out = planLifecycleChange({}, 'loaned_out', actor, { assignedTo: ' Team A ' }, t0);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.patch.assignedTo, 'Team A');
    const back = planLifecycleChange(
      { lifecycle: 'loaned_out', lifecycleHistory: out.patch.lifecycleHistory, assignedTo: 'Team A' },
      'active',
      actor,
      { assignedTo: 'ignored' },
      t1,
    );
    assert.equal(back.ok, true);
    if (!back.ok) return;
    assert.equal(back.patch.assignedTo, null);
    assert.equal(back.entry.from, 'loaned_out');
  });
  it('a loan with no holder anywhere is refused; an existing holder satisfies it', () => {
    assert.equal(planLifecycleChange({}, 'loaned_out', actor, {}, t0).ok, false);
    assert.equal(planLifecycleChange({ assignedTo: 'Team B' }, 'loaned_out', actor, {}, t0).ok, true);
  });
  it('invalid transitions return a reason and no patch', () => {
    const p = planLifecycleChange({ lifecycle: 'retired' }, 'active', actor, {}, t0);
    assert.equal(p.ok, false);
    if (p.ok) return;
    assert.match(p.reason, /retired/);
    const same = planLifecycleChange({ lifecycle: 'lost' }, 'lost', actor, {}, t0);
    assert.equal(same.ok, false);
  });
  it('never touches readiness fields', () => {
    const target = { lifecycle: undefined, assetStatus: 'Ready' } as never;
    const plan = planLifecycleChange(target, 'damaged', actor, {}, t0);
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.deepEqual(Object.keys(plan.patch).sort(), ['assignedTo', 'lifecycle', 'lifecycleHistory']);
  });
});
