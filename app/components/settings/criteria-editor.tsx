'use client';
import React from 'react';
import { Input, Select, SelectItem, Button, Switch, Chip } from '@heroui/react';
import { Plus } from 'lucide-react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '@/firebase';
import type { TierCriteria, User } from '@/app/types';

// ---------------------------------------------------------------------------
// Shared tier-criteria editor (`CriteriaEditor`), its roster join-date
// coverage gate (`useJoinDateCoverage` / `tenureGate`), and the types that go
// with them — used by both the Priority Access Tiers card
// (waitlist-tier-tab.tsx) and the Event Templates staged-release windows
// (events-tab.tsx).
//
// This module exists because of an incident, not just tidiness. D29
// (docs/medops-signup-plan.md) records the lesson from the phase before this
// one: "a copy of a rule, justified by 'we can't import it here', is a
// promise to keep two expressions equal forever, kept by nobody" — that
// mirror drifted at exactly one input and shipped a real bug. The very next
// phase then introduced a new mirror of exactly the same kind: because this
// editor previously lived unexported inside waitlist-tier-tab.tsx, the agent
// building the event-template editor hand-copied it into events-tab.tsx as
// `TemplateCriteriaEditor` — and the copy was already wrong. It silently
// dropped the `tenureGate` prop, so the template editor's tenure inputs (min
// semesters / min tenure days) were always enabled, even against a roster
// with no join-date coverage to trust them against. The fix both times was
// the same: delete the mirror. If you need a criteria editor, import
// `CriteriaEditor` from here — do not copy it a third time.
// ---------------------------------------------------------------------------

const ROLE_OPTIONS: { label: string; value: NonNullable<User['role']> }[] = [
  { label: 'FTO', value: 'FTO' },
  { label: 'FTO Intern', value: 'fto_intern' },
  { label: 'Member', value: 'member' },
  { label: 'MedOps', value: 'medops' },
  { label: 'Quartermaster', value: 'quartermaster' },
  { label: 'Inventory Helper', value: 'inventory_helper' },
  { label: 'Admin', value: 'admin' },
];

const MEMBER_STATUS_OPTIONS: { label: string; value: NonNullable<User['memberStatus']> }[] = [
  { label: 'New', value: 'new' },
  { label: 'Probationary', value: 'probationary' },
  { label: 'General', value: 'general' },
];

export function toggleInArray<T>(arr: T[] | undefined, v: T): T[] {
  const cur = arr ?? [];
  return cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
}

// ---------------------------------------------------------------------------
// [Phase 2 / waitlist plan §3.7, §8] Roster join-date coverage gate for the
// tenure criteria inputs (minSemesters / minTenureDays).
// ---------------------------------------------------------------------------

export interface JoinDateCoverage {
  status: 'loading' | 'ok' | 'error';
  /** Every `users` doc — the roster page (`app/roster/page.tsx`) applies no
   *  status/role filter when it reads this collection, so "members" here
   *  means the same: every user doc, unfiltered. */
  total: number;
  /** Has `User.joinedOn` — the field tenure criteria actually read (§3.7:
   *  `minTenureDays`/`minSemesters` both fail closed when it's absent). */
  withJoinedOn: number;
  /** Has `User.joinedTerm` (regardless of `joinedOn`) — lets the gate tell a
   *  "nobody has entered a term yet" roster apart from a "terms are entered
   *  but the backfill hasn't run" roster, so the warning can name the right
   *  next step instead of always pointing at all three. */
  withJoinedTerm: number;
  /** Neither field set — this is the exact "N" in the required copy, "_N of
   *  M members have no join term recorded_" (plan §8). */
  withNeither: number;
}

/**
 * One-shot roster read for the coverage gate below. A plain `getDocs`, not
 * `onSnapshot` — this is an advisory number on a settings form, not a figure
 * that needs to track roster edits live while the tab happens to be open.
 *
 * Tolerates a denied or failed read (e.g. a role without `users` access):
 * degrades to `status: 'error'` rather than throwing, same per-dataset
 * tolerance as `useStatsData` on /stats — the tab must never blank or crash
 * over this, only leave the tenure inputs disabled with an explanation.
 */
export function useJoinDateCoverage(): JoinDateCoverage {
  const [coverage, setCoverage] = React.useState<JoinDateCoverage>({
    status: 'loading',
    total: 0,
    withJoinedOn: 0,
    withJoinedTerm: 0,
    withNeither: 0,
  });

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(collection(db, 'users'));
        if (cancelled) return;
        let withJoinedOn = 0;
        let withJoinedTerm = 0;
        let withNeither = 0;
        snap.docs.forEach((d) => {
          const data = d.data() as Pick<User, 'joinedOn' | 'joinedTerm'>;
          const hasOn = !!data.joinedOn;
          const hasTerm = !!data.joinedTerm;
          if (hasOn) withJoinedOn++;
          if (hasTerm) withJoinedTerm++;
          if (!hasOn && !hasTerm) withNeither++;
        });
        setCoverage({ status: 'ok', total: snap.size, withJoinedOn, withJoinedTerm, withNeither });
      } catch (e) {
        // Expected for a role without roster access — log once, don't throw or blank the tab.
        console.warn('[criteria-editor] could not read "users" for join-date coverage', e);
        if (!cancelled) setCoverage({ status: 'error', total: 0, withJoinedOn: 0, withJoinedTerm: 0, withNeither: 0 });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return coverage;
}

/**
 * [Phase 2 / waitlist plan §3.7, §8] Coverage bar for unlocking the tenure
 * inputs. `minTenureDays`/`minSemesters` fail CLOSED on a missing `joinedOn`
 * (§3.7) — below this bar, enough of the roster would silently and
 * invisibly fail a saved tenure rule that shipping it would misfire for a
 * user-visible fraction of real members, which is exactly the failure this
 * gate exists to prevent (§8: "the worst failure this feature can produce").
 *
 * The plan deliberately doesn't fix a number ("until coverage is adequate").
 * 90% is the judgement call: it tolerates a handful of unrecoverable
 * legacy/service accounts (an old alumnus doc, a shared equipment login)
 * without blocking the feature indefinitely on 100% roster hygiene, while
 * still requiring the backfill to have actually reached the bulk of the
 * roster before a tenure rule can silently gate real members.
 */
const MIN_JOIN_DATE_COVERAGE = 0.9;

export interface TenureGate {
  enabled: boolean;
  message: string;
}

export function tenureGate(coverage: JoinDateCoverage): TenureGate {
  if (coverage.status === 'loading') {
    return { enabled: false, message: 'Checking roster join-date coverage…' };
  }
  if (coverage.status === 'error') {
    return {
      enabled: false,
      message:
        'Roster coverage could not be checked (the users list failed to load — likely a permissions issue for this ' +
        'role). Tenure criteria stay disabled until coverage can be verified.',
    };
  }
  if (coverage.total === 0) {
    return {
      enabled: false,
      message: 'No roster data found — tenure criteria stay disabled until there are members to check coverage against.',
    };
  }

  // The gate measures `joinedOn` coverage, because that is the field the tenure
  // criteria actually evaluate — so the headline number must report the SAME
  // metric. Leading with the `joinedTerm` count (the plan's literal wording)
  // reads as "0 of 40 members have no join term recorded" on a roster whose
  // terms are filled in but whose backfill has not run — a disabled input with
  // a statistic that looks like a pass. The join-term count is still surfaced,
  // in the one branch where it is the actual blocker.
  const missingJoinedOn = coverage.total - coverage.withJoinedOn;
  const stat = `${missingJoinedOn} of ${coverage.total} members have no join date on file`;
  const pctOn = coverage.withJoinedOn / coverage.total;

  if (pctOn >= MIN_JOIN_DATE_COVERAGE) {
    return {
      enabled: true,
      message: `${stat}. Coverage is adequate (${Math.round(pctOn * 100)}% of members have a join date on file) — tenure criteria are enabled below.`,
    };
  }

  // Below the bar — name the specific next step rather than always listing all three.
  if (coverage.withJoinedTerm === 0) {
    return {
      enabled: false,
      message:
        `${stat}, and ${coverage.withNeither} of ${coverage.total} members have no join term recorded either. `+
        `The sequence starts at step 1: configure ` +
        `Terms (Events & Venues tab), then set each member's joined term (Roster), then run the join-date backfill ` +
        '(`scripts/backfill-joined-on.cjs`) — tenure criteria unlock once coverage clears the bar.',
    };
  }
  if (coverage.withJoinedOn < coverage.withJoinedTerm) {
    return {
      enabled: false,
      message:
        `${stat}. Terms and join terms are entered for some members, but the join-date backfill (step 2) hasn't run ` +
        `(or hasn't reached everyone) — run \`scripts/backfill-joined-on.cjs\` (dry-run first) to derive join dates, ` +
        'then these inputs unlock automatically.',
    };
  }
  return {
    enabled: false,
    message:
      `${stat}. Coverage (${Math.round(pctOn * 100)}%) is below the ${Math.round(MIN_JOIN_DATE_COVERAGE * 100)}% ` +
      'needed to trust a tenure rule roster-wide — confirm Terms are configured (Events & Venues tab), then fill in ' +
      'the remaining members\' joined term and re-run the backfill.',
  };
}

export function CriteriaEditor({
  criteria,
  eventTypes,
  tenureGate: gate,
  onChange,
}: {
  criteria: TierCriteria;
  eventTypes: string[];
  /** [Phase 2 / waitlist plan §3.7, §8] Roster coverage gate — see `tenureGate()`.
   *  Required, not optional: a call site with no gate to supply must compute
   *  one via `useJoinDateCoverage()` + `tenureGate()` rather than silently
   *  reacquiring the always-enabled bug this module was created to fix. */
  tenureGate: TenureGate;
  onChange: (c: TierCriteria) => void;
}) {
  const [newTypeKey, setNewTypeKey] = React.useState(eventTypes[0] ?? '');
  const [newTypeVal, setNewTypeVal] = React.useState('1');
  const set = (patch: Partial<TierCriteria>) => onChange({ ...criteria, ...patch });

  const addShiftsByType = () => {
    const key = newTypeKey.trim();
    const n = Number(newTypeVal);
    if (!key || !Number.isFinite(n) || n <= 0) return;
    set({ minShiftsByType: { ...(criteria.minShiftsByType ?? {}), [key]: n } });
  };

  const removeShiftsByType = (key: string) => {
    const next = { ...(criteria.minShiftsByType ?? {}) };
    delete next[key];
    set({ minShiftsByType: next });
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-xs font-semibold text-foreground-500 mb-1.5">Roles</p>
        <div className="flex flex-wrap gap-1.5">
          {ROLE_OPTIONS.map((r) => {
            const active = (criteria.roles ?? []).includes(r.value);
            return (
              <button
                key={r.value}
                type="button"
                onClick={() => set({ roles: toggleInArray(criteria.roles, r.value) })}
                className={`text-xs font-semibold px-2.5 py-1 rounded-full border transition-colors duration-150 ${
                  active
                    ? 'bg-primary-50 dark:bg-primary-900/20 border-primary/30 text-primary'
                    : 'bg-content1 border-divider text-foreground-500 hover:bg-content3'
                }`}
              >
                {r.label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold text-foreground-500 mb-1.5">Member status</p>
        <div className="flex flex-wrap gap-1.5">
          {MEMBER_STATUS_OPTIONS.map((s) => {
            const active = (criteria.memberStatus ?? []).includes(s.value);
            return (
              <button
                key={s.value}
                type="button"
                onClick={() => set({ memberStatus: toggleInArray(criteria.memberStatus, s.value) })}
                className={`text-xs font-semibold px-2.5 py-1 rounded-full border transition-colors duration-150 ${
                  active
                    ? 'bg-primary-50 dark:bg-primary-900/20 border-primary/30 text-primary'
                    : 'bg-content1 border-divider text-foreground-500 hover:bg-content3'
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Input
          size="sm"
          type="number"
          min={0}
          label="Min completed shifts"
          value={String(criteria.minCompletedShifts ?? 0)}
          onValueChange={(v) => set({ minCompletedShifts: Number(v) || 0 })}
        />
        <div className="flex items-end gap-2">
          <Switch
            isSelected={!!criteria.requireCommitteeMember}
            onValueChange={(v) => set({ requireCommitteeMember: v })}
            size="sm"
          />
          <span className="text-sm text-foreground">Requires committee membership</span>
        </div>
      </div>

      <div>
        <p className="text-xs font-semibold text-foreground-500 mb-1.5">Min shifts by type</p>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {Object.entries(criteria.minShiftsByType ?? {}).map(([k, n]) => (
            <Chip key={k} size="sm" variant="flat" onClose={() => removeShiftsByType(k)}>
              {k}: {n}
            </Chip>
          ))}
        </div>
        <div className="flex items-end gap-2">
          <Select size="sm" label="Event type" className="max-w-[160px]" selectedKeys={newTypeKey ? [newTypeKey] : []} onChange={(e) => setNewTypeKey(e.target.value)}>
            {eventTypes.map((t) => (
              <SelectItem key={t}>{t}</SelectItem>
            ))}
          </Select>
          <Input size="sm" type="number" min={1} label="Min shifts" className="max-w-[100px]" value={newTypeVal} onValueChange={setNewTypeVal} />
          <Button size="sm" variant="flat" isIconOnly onPress={addShiftsByType} aria-label="Add">
            <Plus size={14} />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end pt-2 border-t border-divider">
        <Input
          size="sm"
          type="number"
          min={0}
          label="Min semesters"
          isDisabled={!gate.enabled}
          value={String(criteria.minSemesters ?? '')}
          onValueChange={(v) => set({ minSemesters: v === '' ? undefined : Number(v) || 0 })}
        />
        <Input
          size="sm"
          type="number"
          min={0}
          label="Min tenure days"
          isDisabled={!gate.enabled}
          value={String(criteria.minTenureDays ?? '')}
          onValueChange={(v) => set({ minTenureDays: v === '' ? undefined : Number(v) || 0 })}
        />
        <Select
          size="sm"
          label="Match"
          selectedKeys={[criteria.combine ?? 'all']}
          onChange={(e) => e.target.value && set({ combine: e.target.value as TierCriteria['combine'] })}
        >
          <SelectItem key="all">all of the above</SelectItem>
          <SelectItem key="any">any of the above</SelectItem>
        </Select>
      </div>
      {/* [Phase 2 / waitlist plan §8] Disabled or not, this always states the real coverage
          numbers ("N of M members have no join term recorded") — see `tenureGate()` above. A
          value saved here before the gate ever existed (or hand-edited while disabled) still
          displays and still round-trips through a save; the gate only blocks new edits. */}
      <p className="text-[11px] text-foreground-400 -mt-1">{gate.message}</p>
    </div>
  );
}
