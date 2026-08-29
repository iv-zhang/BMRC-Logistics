/**
 * EVT — Phase 2 priority access tiers (medops-signup-plan.md §3.7, §2.2, §8 Phase 2).
 *
 * These suites drive the REAL app code paths (app/lib/events.ts) against the
 * Firestore emulator: events are created (with real `accessTier` config) and
 * read back exactly the way the UI/lib layer would see them, requests are
 * filed through `requestShift`, and the queue is advanced through
 * `promoteNextFromWaitlist` — the same functions Phase 1 exercised. As with
 * evt-waitlist.test.ts: assertions are always against re-read documents,
 * never against the values passed in, EXCEPT where a tier decision is a pure
 * computation with no write (`getTierAccess`/`meetsTierCriteria` themselves).
 * For those, the return value is asserted directly, but every such call is
 * still driven from a real event created via `createEvent` and read back —
 * never a hand-built `Event` object — and, where a criterion needs a specific
 * `TierWindow.criteria`, that object is extracted from the RE-READ event's
 * `accessTier.tiers[]` rather than a freshly hand-built literal, so the test
 * is exercising exactly what round-tripped through Firestore.
 *
 * No wall-clock waiting anywhere in this suite (unlike EVT-06's real sleep):
 * `getTierAccess`/`meetsTierCriteria` take an explicit `now`, so every date is
 * computed as an offset from one `now` captured at the top of each suite and
 * that same `now` is threaded through every call — nothing here depends on
 * the wall clock at the moment the assertion runs.
 *
 * Decisions protected:
 *  - §3.7 [R2]: a member's access opens at the EARLIEST `opensAt` among the
 *    windows they satisfy, falling back to `generalOpensAt` — the sort is
 *    over MATCHED windows only, never all windows (EVT-17).
 *  - §3.7: after `generalOpensAt`, everyone is in — no manager override
 *    needed, and window criteria stop being consulted at all (EVT-19).
 *  - §3.7: `isEventManagerRole` (admin/quartermaster/medops) bypasses tiering
 *    entirely, at every phase, including before the earliest window opens.
 *    medops is covered explicitly — it's the role this feature exists for
 *    (EVT-20).
 *  - §2.2 [R2]: `combine` defaults to `'all'`; `'any'` is opt-in; `{}` means
 *    "anyone, once the window opens" under EITHER mode (EVT-21).
 *  - §3.7: `minTenureDays`/`minSemesters` FAIL CLOSED on a missing
 *    `joinedOn` — the plan's own words are that this is "the worst failure
 *    the feature can produce" (locking out real members), so it gets its own
 *    suite with an explicit comment, not a buried assertion (EVT-27).
 *  - §3.7 `completedTermsSince`: counts the term the member joined in — a
 *    term's `startDate` on/after `joinedOn` counts, so mid-list joins don't
 *    silently miss their own term (EVT-28).
 *  - §3.8: `requestShift`'s tier gate is the COARSEST guard (checked before
 *    certs/role) and is a REAL throw with NO doc written — not a UI-only
 *    disabled state (EVT-29).
 *  - §3.5 step 3 / §3.7: `promoteNextFromWaitlist`'s re-check SKIPS a queued
 *    member who has gone stale (their tier eligibility changed since they
 *    queued) — `continue`s to the next candidate, never deletes, expires, or
 *    reorders the skipped doc (EVT-30). Framing note: because both
 *    `requestShift` and `promoteNextFromWaitlist` evaluate tiering against
 *    the real wall clock with no injectable `now`, and eligibility windows
 *    only ever OPEN (never re-close) as real time advances, the only way a
 *    queued member can legitimately go stale between queueing and promotion
 *    in a deterministic test is a field mutation (memberStatus/role/etc.) —
 *    exactly the "certs lapse, role changes" staleness the function's own
 *    comment already documents. This suite reproduces that mechanism rather
 *    than one this codebase has no way to express (there is no per-call
 *    clock injection for promotion).
 *  - §3.7 optimisation: an untiered event never queries shift history at all
 *    (`if (event.accessTier?.enabled)` gates the stats fetch) — proven
 *    behaviourally with a member who has zero history and no `joinedOn`
 *    (EVT-31).
 *  - [Phase 2 DEFECT] `ShiftRequester`/`TierSubject` must carry `joinedOn`
 *    and `isCommitteeMember`, or tenure/committee criteria fail closed for
 *    EVERY member silently — this suite's `subject()` helper always seeds
 *    the matching `users/{uid}` doc so `promoteNextFromWaitlist`'s live
 *    re-fetch has real data to re-check against.
 */
import { defineInvariant, db } from '../harness';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  writeBatch,
  updateDoc,
  setDoc,
  Timestamp,
} from 'firebase/firestore';
import {
  createEvent,
  createEmptyTeam,
  requestShift,
  approveRequest,
  cancelRequest,
  getTierAccess,
  meetsTierCriteria,
  describeTierBlock,
  getMemberShiftStats,
  EMPTY_SHIFT_STATS,
  type EventActor,
  type ShiftRequester,
  type TierSubject,
} from '@/app/lib/events';
import type { Event, EventTeam, ShiftRequest, TierCriteria, TierWindow, EventAccessTier, User } from '@/app/types';
import { getSemesterStart, getTerms } from '@/app/config/org-config';
import { applyOrgConfigDoc } from '@/app/lib/org-config-store';
import { tenureDays, completedTermsSince } from '@/app/lib/tenure';

// ── local helpers (mirrors evt-waitlist.test.ts's shape) ────────────────────

/** `events`/`shift_requests` aren't in SEED_COLLECTIONS, so clear them per suite. */
async function wipeEvents(): Promise<void> {
  for (const name of ['events', 'shift_requests', 'notifications']) {
    const snap = await getDocs(collection(db, name));
    if (snap.empty) continue;
    const batch = writeBatch(db);
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

const MANAGER: EventActor = { uid: 'medops-1', name: 'Devon MedOps', role: 'medops' };

/** Reset the in-process org-config runtime singleton to defaults. Terms/other
 *  config live in a module-level singleton (`org-config-store.ts`), not a
 *  live Firestore subscription in this harness, so a suite that overrides
 *  `terms` must put it back or it bleeds into every later suite in this
 *  process (org_settings IS reseeded per-suite in Firestore, but nothing here
 *  subscribes to it, so that reseed has no effect on the singleton). */
function resetOrgConfig(): void {
  applyOrgConfigDoc(undefined);
}

/**
 * A cert-valid requester (EMT + CPR unexpired, so cert gating never masks a
 * tier result) that ALSO seeds a matching `users/{uid}` doc — needed because
 * `promoteNextFromWaitlist`'s eligibility re-check (§3.5 step 3) re-fetches
 * `users/{uid}` live rather than trusting the denormalized request fields.
 */
async function subject(
  uid: string,
  name: string,
  role: string,
  extra: { memberStatus?: User['memberStatus']; joinedOn?: Date; isCommitteeMember?: boolean } = {},
): Promise<ShiftRequester> {
  const future = new Date(Date.now() + 365 * 86400000);
  const certifications = { emt: { expiresOn: future }, cpr: { expiresOn: future } };
  const memberStatus = extra.memberStatus ?? 'general';
  const userDoc: Record<string, unknown> = { uid, name, role, certifications, memberStatus };
  if (extra.joinedOn) userDoc.joinedOn = Timestamp.fromDate(extra.joinedOn);
  if (extra.isCommitteeMember !== undefined) userDoc.isCommitteeMember = extra.isCommitteeMember;
  await setDoc(doc(db, 'users', uid), userDoc, { merge: true });
  return {
    uid,
    name,
    role,
    certifications,
    memberStatus,
    joinedOn: extra.joinedOn ? Timestamp.fromDate(extra.joinedOn) : undefined,
    isCommitteeMember: extra.isCommitteeMember,
  } as ShiftRequester;
}

/** A pure, non-persisted subject for `getTierAccess`/`meetsTierCriteria` —
 *  fine because both are pure functions; no write, so nothing to re-read. */
function plainSubject(role: string, extra: Partial<TierSubject> = {}): TierSubject {
  return { role, memberStatus: 'general', ...extra };
}

function at(dayOffset: number, hhmm: string): Date {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  const [h, m] = hhmm.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d;
}

function daysFromNow(now: Date, n: number): Date {
  return new Date(now.getTime() + n * 86_400_000);
}

/** Local midnight N days before `now`'s calendar day — matches how a real
 *  `joinedOn` is always derived (`deriveJoinedOn`: local midnight of a
 *  configured term's `startDate`), not an arbitrary time-of-day offset. */
function localMidnightDaysAgo(now: Date, n: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function ts(d: Date): Timestamp {
  return Timestamp.fromDate(d);
}

/** Compact inline date form, matching the private `formatTierDate` in
 *  app/lib/events.ts exactly (same locale/options) so `describeTierBlock`'s
 *  output can be asserted byte-for-byte rather than merely "is non-empty". */
function formatTierDateLocal(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function tierWindow(id: string, label: string, opensAt: Date, criteria: TierCriteria): TierWindow {
  return { id, label, opensAt: ts(opensAt), criteria };
}

function tieredConfig(opts: { tiers: TierWindow[]; generalOpensAt: Date; rationale?: string }): EventAccessTier {
  return {
    enabled: true,
    tiers: opts.tiers,
    generalOpensAt: ts(opts.generalOpensAt),
    rationale: opts.rationale ?? 'Priority signup window is in effect.',
  };
}

/** Create an event and read it straight back as the app would see it. */
async function makeEvent(opts: {
  name: string;
  date: Date;
  callTime?: string;
  endTime?: string;
  teams: EventTeam[];
  accessTier?: EventAccessTier;
  eventType?: string;
}): Promise<Event> {
  const ref = await createEvent(
    {
      name: opts.name,
      date: opts.date,
      callTime: opts.callTime,
      endTime: opts.endTime,
      status: 'open',
      teams: opts.teams,
      accessTier: opts.accessTier,
      eventType: opts.eventType,
    },
    MANAGER,
  );
  return readEvent(ref.id);
}

async function readEvent(id: string): Promise<Event> {
  const snap = await getDoc(doc(db, 'events', id));
  const data = snap.data() as Event;
  return { ...data, id: snap.id, date: (data.date as { toDate?: () => Date })?.toDate?.() ?? data.date };
}

async function readRequests(eventId: string): Promise<ShiftRequest[]> {
  const snap = await getDocs(query(collection(db, 'shift_requests'), where('eventId', '==', eventId)));
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as ShiftRequest) }));
}

async function readUserRequests(userId: string): Promise<ShiftRequest[]> {
  const snap = await getDocs(query(collection(db, 'shift_requests'), where('userId', '==', userId)));
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as ShiftRequest) }));
}

/** Request → approve in one step, returning the persisted approved request. */
async function signUp(event: Event, teamId: string, role: 'FTO' | 'FTO_INTERN' | 'EMT', who: ShiftRequester) {
  await requestShift(event, teamId, role, who);
  const pending = (await readRequests(event.id!)).find((r) => r.userId === who.uid && r.status === 'pending');
  if (!pending) throw new Error(`no pending request created for ${who.uid}`);
  await approveRequest(pending, MANAGER);
  const approved = (await readRequests(event.id!)).find((r) => r.id === pending.id)!;
  return approved;
}

/** Real approved-shift history for `uid`, via the actual `getMemberShiftStats`
 *  aggregator over re-read `shift_requests` docs — never a hand-built stats
 *  object (the plan explicitly calls this out for `minCompletedShifts`). */
async function statsFor(uid: string) {
  const reqs = await readUserRequests(uid);
  return getMemberShiftStats(reqs, getSemesterStart());
}

function team1(emtCount = 2): EventTeam {
  return { ...createEmptyTeam('Team 1', emtCount, false), id: 'team-1' };
}

// ─────────────────────────────────────────────────────────────────────────────
// EVT-16 — untiered event is unaffected (the regression guard)
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-16', 'an untiered event (absent, or enabled:false) is unaffected: general/eligible, and signup works', async (t) => {
  await wipeEvents();
  const now = new Date();

  // Sub-case 1: accessTier absent entirely (every event before this phase).
  const noTier = await makeEvent({ name: 'EVT-16 No Tier', date: at(3, '18:00'), callTime: '18:00', teams: [team1()] });
  const accessNoTier = getTierAccess(noTier, plainSubject('member'), EMPTY_SHIFT_STATS, now);
  t.equal(accessNoTier.phase, 'general', 'absent accessTier -> phase general');
  t.ok(accessNoTier.eligible, 'absent accessTier -> eligible');
  t.equal(accessNoTier.matchedTier, null, 'absent accessTier -> no matched window');

  const memberA = await subject('u-a', 'A', 'member');
  await requestShift(noTier, 'team-1', 'EMT', memberA);
  const aReq = (await readRequests(noTier.id!)).find((r) => r.userId === 'u-a');
  t.ok(!!aReq && aReq.status === 'pending', 'requestShift genuinely succeeds against an untiered event (persisted doc)');

  // Sub-case 2: accessTier present but enabled:false, WITH real windows on it
  // — the windows must be completely inert.
  const disabledTier: EventAccessTier = tieredConfig({
    tiers: [tierWindow('w1', 'Should never matter', daysFromNow(now, 30), { roles: ['FTO'] })],
    generalOpensAt: daysFromNow(now, 60),
  });
  disabledTier.enabled = false;
  const disabled = await makeEvent({ name: 'EVT-16 Disabled Tier', date: at(3, '18:00'), callTime: '18:00', teams: [team1()], accessTier: disabledTier });
  t.equal(disabled.accessTier?.enabled, false, 'the disabled tier config genuinely persisted as enabled:false');
  const accessDisabled = getTierAccess(disabled, plainSubject('member'), EMPTY_SHIFT_STATS, now);
  t.equal(accessDisabled.phase, 'general', 'enabled:false with windows present -> STILL phase general');
  t.ok(accessDisabled.eligible, 'enabled:false -> eligible regardless of window content');

  const memberB = await subject('u-b', 'B', 'member');
  await requestShift(disabled, 'team-1', 'EMT', memberB);
  const bReq = (await readRequests(disabled.id!)).find((r) => r.userId === 'u-b');
  t.ok(!!bReq && bReq.status === 'pending', 'requestShift succeeds against an enabled:false tiered event too');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-17 — earliest MATCHED window wins, not earliest window overall
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-17', 'a member is offered the EARLIEST window they actually match, never an earlier one they do not', async (t) => {
  await wipeEvents();
  const now = new Date();

  // Deliberately NOT sorted by opensAt in array order, so a sort-by-array-
  // position bug would fail this test.
  const wRole = tierWindow('w-role', 'FTOs', daysFromNow(now, 5), { roles: ['FTO'] });
  const wCommittee = tierWindow('w-committee', 'Committee', daysFromNow(now, 12), { requireCommitteeMember: true });
  const wStatus = tierWindow('w-status', 'New members', daysFromNow(now, 20), { memberStatus: ['new'] });
  const event = await makeEvent({
    name: 'EVT-17 Multi-window',
    date: at(3, '18:00'),
    callTime: '18:00',
    teams: [team1()],
    accessTier: tieredConfig({ tiers: [wRole, wCommittee, wStatus], generalOpensAt: daysFromNow(now, 30) }),
  });

  // Multi-match subject: qualifies for ALL three windows. Earliest (w-role,
  // +5d) must win even though it's listed first in the array purely by
  // coincidence of how we wrote it above — the sort is what matters, not
  // position.
  const multi = plainSubject('FTO', { memberStatus: 'new', isCommitteeMember: true });
  const accessMulti = getTierAccess(event, multi, EMPTY_SHIFT_STATS, now);
  t.equal(accessMulti.eligible, false, 'before any window opens, still not eligible');
  t.equal(accessMulti.phase, 'priority', 'a match exists -> phase priority even though not yet open');
  t.ok(!!accessMulti.opensForYouAt && accessMulti.opensForYouAt.getTime() === daysFromNow(now, 5).getTime(), 'opensForYouAt is the EARLIEST matched window (w-role, +5d)');
  t.equal(accessMulti.matchedTier?.id, 'w-role', 'matchedTier is w-role, not w-committee or w-status');

  const afterEarliest = daysFromNow(now, 5 + 0.01);
  const accessMultiOpen = getTierAccess(event, multi, EMPTY_SHIFT_STATS, afterEarliest);
  t.equal(accessMultiOpen.eligible, true, 'once the earliest matched window opens, eligible flips true');
  t.equal(accessMultiOpen.matchedTier?.id, 'w-role', 'still the same matched window');

  // Single-match subject: qualifies ONLY for the LAST (latest-opening)
  // window. Must get THAT window's date, not w-role's earlier one they never
  // actually qualified for — proves the sort runs over matched windows only.
  const onlyLast = plainSubject('member', { memberStatus: 'new', isCommitteeMember: false });
  const accessLast = getTierAccess(event, onlyLast, EMPTY_SHIFT_STATS, now);
  t.equal(accessLast.matchedTier?.id, 'w-status', 'matches only w-status (the latest-opening window)');
  t.ok(!!accessLast.opensForYouAt && accessLast.opensForYouAt.getTime() === daysFromNow(now, 20).getTime(), "opensForYouAt is w-status's OWN date (+20d), not w-role's earlier +5d");
  t.equal(accessLast.eligible, false, 'not yet open for them either');

  const afterLast = daysFromNow(now, 20 + 0.01);
  const accessLastOpen = getTierAccess(event, onlyLast, EMPTY_SHIFT_STATS, afterLast);
  t.equal(accessLastOpen.eligible, true, "once w-status's own opensAt arrives, THIS member becomes eligible");
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-18 — no matching window: falls back to generalOpensAt, and the block
// reason still names a date
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-18', 'a member matching no window still gets a date (opensForYouAt falls back to generalOpensAt) and describeTierBlock names it', async (t) => {
  await wipeEvents();
  const now = new Date();

  const general = daysFromNow(now, 15);
  const event = await makeEvent({
    name: 'EVT-18 No Match',
    date: at(3, '18:00'),
    callTime: '18:00',
    teams: [team1()],
    accessTier: tieredConfig({
      tiers: [tierWindow('w-fto-only', 'FTOs', daysFromNow(now, -1), { roles: ['FTO'] })],
      generalOpensAt: general,
      rationale: 'FTOs get first pick; everyone else waits for general signup.',
    }),
  });

  const nonMatch = plainSubject('member');
  const access = getTierAccess(event, nonMatch, EMPTY_SHIFT_STATS, now);
  t.equal(access.matchedTier, null, 'no window matched');
  t.equal(access.phase, 'closed', 'no match + general not yet open -> phase closed');
  t.equal(access.eligible, false, 'not eligible');
  t.ok(!!access.opensForYouAt && access.opensForYouAt.getTime() === general.getTime(), 'opensForYouAt falls back to generalOpensAt');

  const block = describeTierBlock(access, event);
  const expected = `Signup opens ${formatTierDateLocal(general)}.`;
  t.equal(block, expected, 'describeTierBlock names the fallback general date, not a bare "not eligible" message');
  t.ok(!block.toLowerCase().includes('not eligible'), 'the §5.3 regression this suite guards against: never a bare "not eligible" with no date');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-19 — after generalOpensAt, everyone is in (P5) — no override needed
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-19', 'once generalOpensAt has passed, everyone is eligible with no manager override and no matching window needed', async (t) => {
  await wipeEvents();
  const now = new Date();
  const general = daysFromNow(now, -1); // already open

  const event = await makeEvent({
    name: 'EVT-19 General Open',
    date: at(3, '18:00'),
    callTime: '18:00',
    teams: [team1()],
    accessTier: tieredConfig({
      tiers: [tierWindow('w-fto-only', 'FTOs', daysFromNow(now, 5), { roles: ['FTO'] })],
      generalOpensAt: general,
    }),
  });

  const nonMatch = plainSubject('member'); // fails the one window's criteria, and it hasn't even opened
  const access = getTierAccess(event, nonMatch, EMPTY_SHIFT_STATS, now);
  t.equal(access.phase, 'general', 'general has opened -> phase general regardless of window match');
  t.equal(access.eligible, true, 'eligible');
  t.equal(access.matchedTier, null, 'no window is consulted once general access has opened');
  t.ok(!!access.opensForYouAt && access.opensForYouAt.getTime() === general.getTime(), 'opensForYouAt reports the general date');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-20 — manager bypass (admin / quartermaster / medops), at every phase
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-20', 'isEventManagerRole (admin, quartermaster, medops) bypasses tiering entirely, even before the earliest window opens', async (t) => {
  await wipeEvents();
  const now = new Date();

  const event = await makeEvent({
    name: 'EVT-20 Manager Bypass',
    date: at(3, '18:00'),
    callTime: '18:00',
    teams: [team1()],
    accessTier: tieredConfig({
      tiers: [tierWindow('w-anyone-later', 'Opens later', daysFromNow(now, 5), {})],
      generalOpensAt: daysFromNow(now, 30),
    }),
  });

  for (const role of ['admin', 'quartermaster', 'medops']) {
    const access = getTierAccess(event, plainSubject(role), EMPTY_SHIFT_STATS, now);
    t.equal(access.phase, 'general', `${role}: manager bypass -> phase general, even before the earliest window opens`);
    t.equal(access.eligible, true, `${role}: eligible`);
    t.equal(access.matchedTier, null, `${role}: no window needed for the bypass`);
    t.equal(access.reason, 'Manager override.', `${role}: reason names the bypass explicitly`);
  }

  // Real, persisted proof for medops specifically — the role this feature
  // exists for — that the bypass is live in requestShift, not just the pure
  // function: a real signup succeeds well before ANY window (or general)
  // has opened for anyone else.
  const medopsRequester = await subject('medops-signup', 'Medops Signup', 'medops');
  await requestShift(event, 'team-1', 'EMT', medopsRequester);
  const req = (await readRequests(event.id!)).find((r) => r.userId === 'medops-signup');
  t.ok(!!req && req.status === 'pending', 'medops signup on a still-closed tiered event genuinely persists as pending');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-21 — combine 'all' vs 'any'; {} means "anyone" under either mode
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-21', "combine defaults to 'all'; 'any' is opt-in; {} means anyone under either mode", async (t) => {
  await wipeEvents();
  const now = new Date();

  const partial = plainSubject('FTO', { isCommitteeMember: false }); // satisfies roles, fails committee

  const wAll = tierWindow('w-all', 'All (default)', daysFromNow(now, -1), { roles: ['FTO'], requireCommitteeMember: true });
  const wAny = tierWindow('w-any', 'Any', daysFromNow(now, -1), { roles: ['FTO'], requireCommitteeMember: true, combine: 'any' });
  const wEmptyAll = tierWindow('w-empty-all', 'Empty/all', daysFromNow(now, -1), {});
  const wEmptyAny = tierWindow('w-empty-any', 'Empty/any', daysFromNow(now, -1), { combine: 'any' });
  const event = await makeEvent({
    name: 'EVT-21 Combine',
    date: at(3, '18:00'),
    callTime: '18:00',
    teams: [team1()],
    accessTier: tieredConfig({ tiers: [wAll, wAny, wEmptyAll, wEmptyAny], generalOpensAt: daysFromNow(now, 60) }),
  });

  const criteriaAll = event.accessTier!.tiers.find((w) => w.id === 'w-all')!.criteria;
  const criteriaAny = event.accessTier!.tiers.find((w) => w.id === 'w-any')!.criteria;
  const criteriaEmptyAll = event.accessTier!.tiers.find((w) => w.id === 'w-empty-all')!.criteria;
  const criteriaEmptyAny = event.accessTier!.tiers.find((w) => w.id === 'w-empty-any')!.criteria;

  t.equal(meetsTierCriteria(criteriaAll, partial, EMPTY_SHIFT_STATS, now), false, "default combine 'all': satisfying only ONE of two specified criteria is blocked");
  t.equal(meetsTierCriteria(criteriaAny, partial, EMPTY_SHIFT_STATS, now), true, "combine:'any': satisfying ONE of two specified criteria is enough");
  t.equal(meetsTierCriteria(criteriaEmptyAll, partial, EMPTY_SHIFT_STATS, now), true, "{} under combine 'all' (default) means anyone, once the window opens");
  t.equal(meetsTierCriteria(criteriaEmptyAny, partial, EMPTY_SHIFT_STATS, now), true, "{} under combine:'any' ALSO means anyone");

  // Real event integration: partial matches w-any (and both empty windows,
  // which open at the same instant) but NOT w-all — getTierAccess must
  // resolve to w-any (earliest among the ones that actually match, tied with
  // the empties at the same opensAt but w-any is listed as a real criteria
  // match too; we only assert eligibility + that w-all specifically never wins).
  const access = getTierAccess(event, partial, EMPTY_SHIFT_STATS, now);
  t.equal(access.eligible, true, "getTierAccess on the real event: eligible via the 'any'/empty windows");
  t.ok(access.matchedTier?.id !== 'w-all', 'the matched window is never w-all, which this subject genuinely fails');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-22 — criterion: roles (boundary: any listed role passes)
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-22', 'criterion: roles — an allowlisted role passes (incl. a non-first entry), anything else is blocked', async (t) => {
  await wipeEvents();
  const now = new Date();

  const w = tierWindow('w-roles', 'FTOs & interns', daysFromNow(now, -1), { roles: ['FTO', 'fto_intern'] });
  const event = await makeEvent({
    name: 'EVT-22 Roles',
    date: at(3, '18:00'),
    callTime: '18:00',
    teams: [team1()],
    accessTier: tieredConfig({ tiers: [w], generalOpensAt: daysFromNow(now, 60) }),
  });
  const criteria = event.accessTier!.tiers[0].criteria;

  t.equal(meetsTierCriteria(criteria, plainSubject('FTO'), EMPTY_SHIFT_STATS, now), true, "role 'FTO' (first in the list) passes");
  t.equal(meetsTierCriteria(criteria, plainSubject('fto_intern'), EMPTY_SHIFT_STATS, now), true, "role 'fto_intern' (second in the list, boundary) ALSO passes");
  t.equal(meetsTierCriteria(criteria, plainSubject('member'), EMPTY_SHIFT_STATS, now), false, "role 'member' (not listed) is blocked");

  const accessPass = getTierAccess(event, plainSubject('FTO'), EMPTY_SHIFT_STATS, now);
  t.equal(accessPass.eligible, true, 'real-event integration: an allowlisted role is eligible');
  t.equal(accessPass.matchedTier?.id, 'w-roles', 'matched the roles window');
  const accessFail = getTierAccess(event, plainSubject('member'), EMPTY_SHIFT_STATS, now);
  t.equal(accessFail.eligible, false, 'real-event integration: a non-listed role is blocked (falls to closed, general not yet open)');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-23 — criterion: memberStatus (boundary: a listed status passes, and a
// missing memberStatus defaults to 'general')
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-23', "criterion: memberStatus — a listed status passes, missing memberStatus defaults to 'general'", async (t) => {
  await wipeEvents();
  const now = new Date();

  const w = tierWindow('w-status', 'Probationary & general', daysFromNow(now, -1), { memberStatus: ['probationary', 'general'] });
  const event = await makeEvent({
    name: 'EVT-23 MemberStatus',
    date: at(3, '18:00'),
    callTime: '18:00',
    teams: [team1()],
    accessTier: tieredConfig({ tiers: [w], generalOpensAt: daysFromNow(now, 60) }),
  });
  const criteria = event.accessTier!.tiers[0].criteria;

  t.equal(meetsTierCriteria(criteria, plainSubject('member', { memberStatus: 'probationary' }), EMPTY_SHIFT_STATS, now), true, "'probationary' is listed -> passes");
  t.equal(meetsTierCriteria(criteria, { role: 'member' }, EMPTY_SHIFT_STATS, now), true, "no memberStatus at all defaults to 'general', which IS listed -> passes (boundary)");
  t.equal(meetsTierCriteria(criteria, plainSubject('member', { memberStatus: 'new' }), EMPTY_SHIFT_STATS, now), false, "'new' is not listed -> blocked");

  const accessPass = getTierAccess(event, plainSubject('member', { memberStatus: 'probationary' }), EMPTY_SHIFT_STATS, now);
  t.equal(accessPass.eligible, true, 'real-event integration: listed memberStatus is eligible');
  const accessFail = getTierAccess(event, plainSubject('member', { memberStatus: 'new' }), EMPTY_SHIFT_STATS, now);
  t.equal(accessFail.eligible, false, 'real-event integration: unlisted memberStatus is blocked');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-24 — criterion: minCompletedShifts, driven from REAL approved history
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-24', 'criterion: minCompletedShifts, computed via getMemberShiftStats over REAL approved shift_requests', async (t) => {
  await wipeEvents();
  const now = new Date();

  // Build exactly 2 approved shifts for this member across two unrelated,
  // untiered history events — never a hand-built {shiftsAllTime: 2} object.
  const member = await subject('history-member', 'History Member', 'member');
  const hist1 = await makeEvent({ name: 'EVT-24 History 1', date: at(3, '18:00'), callTime: '18:00', teams: [team1()] });
  await signUp(hist1, 'team-1', 'EMT', member);
  const hist2 = await makeEvent({ name: 'EVT-24 History 2', date: at(4, '18:00'), callTime: '18:00', teams: [team1()] });
  await signUp(hist2, 'team-1', 'EMT', member);

  const stats = await statsFor('history-member');
  t.equal(stats.shiftsAllTime, 2, 'sanity: the real approved history really is 2 shifts, read back from Firestore');

  const wPass = tierWindow('w-pass', '2+ shifts', daysFromNow(now, -1), { minCompletedShifts: 2 });
  const wFail = tierWindow('w-fail', '3+ shifts', daysFromNow(now, -1), { minCompletedShifts: 3 });
  const event = await makeEvent({
    name: 'EVT-24 Target',
    date: at(5, '18:00'),
    callTime: '18:00',
    teams: [team1()],
    accessTier: tieredConfig({ tiers: [wPass, wFail], generalOpensAt: daysFromNow(now, 60) }),
  });
  const critPass = event.accessTier!.tiers.find((w) => w.id === 'w-pass')!.criteria;
  const critFail = event.accessTier!.tiers.find((w) => w.id === 'w-fail')!.criteria;

  t.equal(meetsTierCriteria(critPass, plainSubject('member'), stats, now), true, 'exactly-at-the-minimum (2 >= 2) passes — boundary');
  t.equal(meetsTierCriteria(critFail, plainSubject('member'), stats, now), false, 'one shy of the minimum (2 < 3) fails');

  const zeroStats = await statsFor('never-signed-up');
  t.equal(zeroStats.shiftsAllTime, 0, 'a member with no history really reads back as 0 shifts');
  t.equal(meetsTierCriteria(critPass, plainSubject('member'), zeroStats, now), false, 'zero history fails even the 2-shift threshold');

  const access = getTierAccess(event, plainSubject('member'), stats, now);
  t.equal(access.eligible, true, 'real-event integration: the 2-shift member is eligible on the target event');
  t.equal(access.matchedTier?.id, 'w-pass', 'matched the 2-shift window, not the 3-shift one');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-25 — criterion: minShiftsByType, driven from REAL typed approved history
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-25', 'criterion: minShiftsByType, per-eventType minimums computed from REAL approved history', async (t) => {
  await wipeEvents();
  const now = new Date();

  const member = await subject('typed-member', 'Typed Member', 'member');
  const f1 = await makeEvent({ name: 'EVT-25 Football 1', date: at(3, '18:00'), callTime: '18:00', teams: [team1()], eventType: 'football' });
  await signUp(f1, 'team-1', 'EMT', member);
  const f2 = await makeEvent({ name: 'EVT-25 Football 2', date: at(4, '18:00'), callTime: '18:00', teams: [team1()], eventType: 'football' });
  await signUp(f2, 'team-1', 'EMT', member);
  const c1 = await makeEvent({ name: 'EVT-25 Concert', date: at(5, '18:00'), callTime: '18:00', teams: [team1()], eventType: 'concert' });
  await signUp(c1, 'team-1', 'EMT', member);

  const stats = await statsFor('typed-member');
  t.equal(stats.shiftsByType.football, 2, 'sanity: 2 real approved football shifts');
  t.equal(stats.shiftsByType.concert, 1, 'sanity: 1 real approved concert shift');

  const wPass = tierWindow('w-pass', '2+ football', daysFromNow(now, -1), { minShiftsByType: { football: 2 } });
  const wFail = tierWindow('w-fail', '3+ football', daysFromNow(now, -1), { minShiftsByType: { football: 3 } });
  const wZero = tierWindow('w-zero', '1+ basketball', daysFromNow(now, -1), { minShiftsByType: { basketball: 1 } });
  const event = await makeEvent({
    name: 'EVT-25 Target',
    date: at(6, '18:00'),
    callTime: '18:00',
    teams: [team1()],
    accessTier: tieredConfig({ tiers: [wPass, wFail, wZero], generalOpensAt: daysFromNow(now, 60) }),
  });
  const critPass = event.accessTier!.tiers.find((w) => w.id === 'w-pass')!.criteria;
  const critFail = event.accessTier!.tiers.find((w) => w.id === 'w-fail')!.criteria;
  const critZero = event.accessTier!.tiers.find((w) => w.id === 'w-zero')!.criteria;

  t.equal(meetsTierCriteria(critPass, plainSubject('member'), stats, now), true, 'exactly-at-the-minimum football count (2 >= 2) passes — boundary');
  t.equal(meetsTierCriteria(critFail, plainSubject('member'), stats, now), false, 'one shy of the football minimum (2 < 3) fails');
  t.equal(meetsTierCriteria(critZero, plainSubject('member'), stats, now), false, 'a type never worked at all (0 basketball) fails, no synthesized bucket');

  const access = getTierAccess(event, plainSubject('member'), stats, now);
  t.equal(access.eligible, true, 'real-event integration: eligible via the 2-football window');
  t.equal(access.matchedTier?.id, 'w-pass', 'matched w-pass only');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-26 — criterion: requireCommitteeMember
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-26', 'criterion: requireCommitteeMember — true passes, false or unset (undefined) is blocked', async (t) => {
  await wipeEvents();
  const now = new Date();

  const w = tierWindow('w-committee', 'Committee only', daysFromNow(now, -1), { requireCommitteeMember: true });
  const event = await makeEvent({
    name: 'EVT-26 Committee',
    date: at(3, '18:00'),
    callTime: '18:00',
    teams: [team1()],
    accessTier: tieredConfig({ tiers: [w], generalOpensAt: daysFromNow(now, 60) }),
  });
  const criteria = event.accessTier!.tiers[0].criteria;

  t.equal(meetsTierCriteria(criteria, plainSubject('member', { isCommitteeMember: true }), EMPTY_SHIFT_STATS, now), true, 'isCommitteeMember: true passes');
  t.equal(meetsTierCriteria(criteria, plainSubject('member', { isCommitteeMember: false }), EMPTY_SHIFT_STATS, now), false, 'isCommitteeMember: false is blocked');
  t.equal(meetsTierCriteria(criteria, plainSubject('member'), EMPTY_SHIFT_STATS, now), false, 'isCommitteeMember left unset (undefined) is ALSO blocked, not silently passed');

  const accessPass = getTierAccess(event, plainSubject('member', { isCommitteeMember: true }), EMPTY_SHIFT_STATS, now);
  t.equal(accessPass.eligible, true, 'real-event integration: a committee member is eligible');
  const accessFail = getTierAccess(event, plainSubject('member'), EMPTY_SHIFT_STATS, now);
  t.equal(accessFail.eligible, false, 'real-event integration: a non-committee member is blocked');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-27 — tenure fails closed on a missing joinedOn (the worst failure mode)
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-27', 'minTenureDays and minSemesters BOTH fail closed on a missing joinedOn — the plan calls this the worst failure the feature can produce', async (t) => {
  await wipeEvents();
  resetOrgConfig();
  const now = new Date();
  const joinDate = localMidnightDaysAgo(now, 200);

  // One configured term whose startDate matches joinDate exactly, so
  // completedTermsSince has exactly one term to count for the "present"
  // case, deterministically (no dependency on the real wall-clock date).
  applyOrgConfigDoc({ terms: [{ id: 'only-term', label: 'Only Term', startDate: ymd(joinDate) }] });

  t.equal(tenureDays(undefined, now), -1, 'primitive: tenureDays returns -1 (fail-closed) with no joinedOn at all');
  t.equal(completedTermsSince(undefined, now, getTerms()), -1, 'primitive: completedTermsSince ALSO returns -1 with no joinedOn');

  const wTenureZero = tierWindow('w-tenure-zero', 'Any tenure at all', daysFromNow(now, -1), { minTenureDays: 0 });
  const wTenurePass = tierWindow('w-tenure-pass', '200+ days', daysFromNow(now, -1), { minTenureDays: 200 });
  const wTenureFail = tierWindow('w-tenure-fail', '201+ days', daysFromNow(now, -1), { minTenureDays: 201 });
  const wSemZero = tierWindow('w-sem-zero', 'Any semester at all', daysFromNow(now, -1), { minSemesters: 0 });
  const wSemPass = tierWindow('w-sem-pass', '1+ semester', daysFromNow(now, -1), { minSemesters: 1 });
  const wSemFail = tierWindow('w-sem-fail', '2+ semesters', daysFromNow(now, -1), { minSemesters: 2 });
  const event = await makeEvent({
    name: 'EVT-27 Tenure',
    date: at(3, '18:00'),
    callTime: '18:00',
    teams: [team1()],
    accessTier: tieredConfig({ tiers: [wTenureZero, wTenurePass, wTenureFail, wSemZero, wSemPass, wSemFail], generalOpensAt: daysFromNow(now, 60) }),
  });
  const crit = (id: string) => event.accessTier!.tiers.find((w) => w.id === id)!.criteria;

  const noJoin = plainSubject('member'); // no joinedOn at all
  const joined = plainSubject('member', { joinedOn: ts(joinDate) });

  // The worst-failure case, named explicitly: even the LOOSEST possible
  // tenure requirement (minTenureDays: 0 / minSemesters: 0 — "have you been
  // here for any amount of time at all") must still lock out a real member
  // whose joinedOn was simply never backfilled. This is not a hypothetical
  // edge case; it's the exact scenario §3.7's sequencing note warns the
  // settings UI must guard against before enabling tenure criteria org-wide.
  t.equal(meetsTierCriteria(crit('w-tenure-zero'), noJoin, EMPTY_SHIFT_STATS, now), false, 'WORST FAILURE MODE: minTenureDays:0 still blocks a member with no joinedOn');
  t.equal(meetsTierCriteria(crit('w-sem-zero'), noJoin, EMPTY_SHIFT_STATS, now), false, 'WORST FAILURE MODE: minSemesters:0 still blocks a member with no joinedOn');

  t.equal(meetsTierCriteria(crit('w-tenure-zero'), joined, EMPTY_SHIFT_STATS, now), true, 'with joinedOn present, the loosest tenure requirement passes');
  t.equal(meetsTierCriteria(crit('w-tenure-pass'), joined, EMPTY_SHIFT_STATS, now), true, 'exactly-at-the-minimum tenure (200 >= 200 days) passes — boundary');
  t.equal(meetsTierCriteria(crit('w-tenure-fail'), joined, EMPTY_SHIFT_STATS, now), false, 'one day shy of the minimum (200 < 201) fails');

  t.equal(meetsTierCriteria(crit('w-sem-zero'), joined, EMPTY_SHIFT_STATS, now), true, 'with joinedOn present, the loosest semester requirement passes');
  t.equal(meetsTierCriteria(crit('w-sem-pass'), joined, EMPTY_SHIFT_STATS, now), true, 'exactly-at-the-minimum semesters (1 >= 1) passes — boundary');
  t.equal(meetsTierCriteria(crit('w-sem-fail'), joined, EMPTY_SHIFT_STATS, now), false, 'one semester shy of the minimum (1 < 2) fails');

  // Real-event integration: a member with no joinedOn is COMPLETELY locked
  // out of an event whose ONLY gates are "any tenure/semester at all".
  const accessNoJoin = getTierAccess(event, noJoin, EMPTY_SHIFT_STATS, now);
  t.equal(accessNoJoin.eligible, false, 'real-event integration: no joinedOn -> ineligible even against the loosest tenure gates on the event');
  t.equal(accessNoJoin.matchedTier, null, 'no window matches at all for a member with no joinedOn');

  const accessJoined = getTierAccess(event, joined, EMPTY_SHIFT_STATS, now);
  t.equal(accessJoined.eligible, true, 'real-event integration: with joinedOn present, the same event is passable');

  resetOrgConfig();
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-28 — completedTermsSince counts the term you joined in (mid-term join)
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-28', 'completedTermsSince counts the term the member joined in, including a mid-list join, against a realistic configured terms list', async (t) => {
  await wipeEvents();
  resetOrgConfig();
  const now = new Date();

  const term0 = localMidnightDaysAgo(now, 400); // BEFORE the member joined — must never count
  const term1 = localMidnightDaysAgo(now, 300); // the member joins HERE — mid-list, not the first term
  const term2 = localMidnightDaysAgo(now, 200);
  const term3 = localMidnightDaysAgo(now, 100);
  applyOrgConfigDoc({
    terms: [
      { id: 't0', label: 'Term 0', startDate: ymd(term0) },
      { id: 't1', label: 'Term 1', startDate: ymd(term1) },
      { id: 't2', label: 'Term 2', startDate: ymd(term2) },
      { id: 't3', label: 'Term 3', startDate: ymd(term3) },
    ],
  });
  const terms = getTerms();
  const joinedOn = ts(term1);

  t.equal(completedTermsSince(joinedOn, now, terms), 3, 'counts term1 (the one joined), term2, and term3 — NOT term0, which predates joining');

  // At an earlier "now", between term2 and term3's starts, only term1+term2
  // have started since joining — proves the count is genuinely time-varying,
  // not just "count everything from joinedOn to the list's end".
  const midway = localMidnightDaysAgo(now, 150);
  t.equal(completedTermsSince(joinedOn, midway, terms), 2, 'at an earlier "now" (before term3 starts), only 2 terms have started since joining');

  // A member joining in the LAST configured term counts only that one term,
  // even at the real "now" — term0/term1/term2 all predate their joining.
  const joinedLate = ts(term3);
  t.equal(completedTermsSince(joinedLate, now, terms), 1, 'joining in the last configured term counts only that term');

  // Real-event integration via meetsTierCriteria/getTierAccess.
  const wThree = tierWindow('w-three', '3+ semesters', daysFromNow(now, -1), { minSemesters: 3 });
  const event = await makeEvent({
    name: 'EVT-28 Semesters',
    date: at(3, '18:00'),
    callTime: '18:00',
    teams: [team1()],
    accessTier: tieredConfig({ tiers: [wThree], generalOpensAt: daysFromNow(now, 60) }),
  });
  const crit = event.accessTier!.tiers[0].criteria;

  const memberTerm1 = plainSubject('member', { joinedOn });
  t.equal(meetsTierCriteria(crit, memberTerm1, EMPTY_SHIFT_STATS, now), true, 'real-event: the term1 joiner (3 semesters) meets the 3-semester window');
  const accessTerm1 = getTierAccess(event, memberTerm1, EMPTY_SHIFT_STATS, now);
  t.equal(accessTerm1.eligible, true, 'real-event integration: eligible');
  t.equal(accessTerm1.matchedTier?.id, 'w-three', 'matched the 3-semester window');

  const memberTerm3 = plainSubject('member', { joinedOn: joinedLate });
  t.equal(meetsTierCriteria(crit, memberTerm3, EMPTY_SHIFT_STATS, now), false, 'real-event: the term3 joiner (only 1 semester) does NOT meet the 3-semester window');
  const accessTerm3 = getTierAccess(event, memberTerm3, EMPTY_SHIFT_STATS, now);
  t.equal(accessTerm3.eligible, false, 'real-event integration: not yet eligible (general still in the future)');

  resetOrgConfig();
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-29 — requestShift actually enforces the gate (a real throw, no doc written)
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-29', 'requestShift REJECTS a member outside their tier window with NO shift_requests doc written, and accepts one inside it', async (t) => {
  await wipeEvents();
  const now = new Date();

  const closedEvent = await makeEvent({
    name: 'EVT-29 Closed',
    date: at(3, '18:00'),
    callTime: '18:00',
    teams: [team1()],
    accessTier: tieredConfig({ tiers: [], generalOpensAt: daysFromNow(now, 10) }),
  });
  const outsider = await subject('outsider', 'Outsider', 'member');

  await t.rejects(requestShift(closedEvent, 'team-1', 'EMT', outsider), 'requestShift throws for a member outside every window, before general opens');
  const outsiderReqs = await readRequests(closedEvent.id!);
  t.equal(outsiderReqs.filter((r) => r.userId === 'outsider').length, 0, 'NO shift_requests doc was created for the rejected attempt — re-read the collection to prove it');

  const openEvent = await makeEvent({
    name: 'EVT-29 Open',
    date: at(3, '18:00'),
    callTime: '18:00',
    teams: [team1()],
    accessTier: tieredConfig({ tiers: [], generalOpensAt: daysFromNow(now, -1) }),
  });
  const insider = await subject('insider', 'Insider', 'member');
  await requestShift(openEvent, 'team-1', 'EMT', insider);
  const insiderReq = (await readRequests(openEvent.id!)).find((r) => r.userId === 'insider');
  t.ok(!!insiderReq && insiderReq.status === 'pending', 'a member inside their window (general already open) succeeds and genuinely persists');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-30 — promoteNextFromWaitlist skips a gone-stale queued member without
// dropping them (does not delete, expire, or reorder)
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-30', 'promoteNextFromWaitlist SKIPS a queued member who has gone tier-ineligible since queueing, without touching their queue entry', async (t) => {
  await wipeEvents();
  const now = new Date();

  // A window that's already open to 'general' members, with general access
  // itself still closed — so a member who is memberStatus:'general' can
  // both queue AND be promoted, while one who drifts to 'new' cannot.
  let event = await makeEvent({
    name: 'EVT-30 Stale Skip',
    date: at(3, '18:00'),
    callTime: '18:00',
    teams: [team1()],
    accessTier: tieredConfig({
      tiers: [tierWindow('w-general-status', 'General-status members', daysFromNow(now, -1), { memberStatus: ['general'] })],
      generalOpensAt: daysFromNow(now, 30),
    }),
  });

  const ma = await subject('m-a', 'MA', 'member', { memberStatus: 'general' });
  await signUp(event, 'team-1', 'EMT', ma);
  event = await readEvent(event.id!); // re-read: approveRequest mutated the event doc's slots
  const mb = await subject('m-b', 'MB', 'member', { memberStatus: 'general' });
  await signUp(event, 'team-1', 'EMT', mb);
  event = await readEvent(event.id!); // re-read: team is now genuinely full

  // Both C1 and C2 are ELIGIBLE at the moment they queue (memberStatus
  // 'general' matches the open window) — queueing an ineligible member is
  // refused by requestShift itself (§3.8), so staleness can only develop
  // AFTER a legitimately-eligible member has already queued.
  const c1 = await subject('c-1', 'C1', 'member', { memberStatus: 'general' });
  await requestShift(event, 'team-1', 'EMT', c1);
  const c2 = await subject('c-2', 'C2', 'member', { memberStatus: 'general' });
  await requestShift(event, 'team-1', 'EMT', c2);

  const beforeCancel = await readRequests(event.id!);
  const c1Queued = beforeCancel.find((r) => r.userId === 'c-1')!;
  const c2Queued = beforeCancel.find((r) => r.userId === 'c-2')!;
  t.equal(c1Queued.status, 'waitlisted', 'C1 queues first');
  t.equal(c2Queued.status, 'waitlisted', 'C2 queues second');
  const c1WaitlistedAt = c1Queued.waitlistedAt!;

  // C1 goes stale: their memberStatus drifts to 'new' between queueing and
  // promotion (exactly the "role changes" staleness class the promotion
  // loop's own eligibility re-check already handles for canRequestRole —
  // this is the tier-criteria analogue of the same mechanism). This is a
  // live mutation of the SAME users/{uid} doc promoteNextFromWaitlist
  // re-fetches, not a change to the queued request doc itself.
  await updateDoc(doc(db, 'users', 'c-1'), { memberStatus: 'new' });

  const ma2 = (await readRequests(event.id!)).find((r) => r.userId === 'm-a')!;
  await cancelRequest(ma2, MANAGER); // frees a seat -> triggers promotion automatically

  const afterPromotion = await readRequests(event.id!);
  const c1After = afterPromotion.find((r) => r.userId === 'c-1')!;
  const c2After = afterPromotion.find((r) => r.userId === 'c-2')!;

  t.equal(c2After.status, 'offered', 'C2 (now-eligible, next in line) receives the offer');
  t.equal(c1After.status, 'waitlisted', 'C1 (gone stale) is SKIPPED, not offered — still sitting on the waitlist');
  t.ok(c1After.waitlistedAt?.isEqual(c1WaitlistedAt) ?? false, "C1's waitlistedAt is UNTOUCHED — they were not silently reordered");
  t.ok(!c1After.skippedAt, 'C1 was not given a manager-facing skippedAt either — this is a transient re-check, not the explicit skipWaitlistEntry action');

  const eventAfter = await readEvent(event.id!);
  const holderRequestId = eventAfter.teams[0].emtSlots.find((s) => !!s.heldUntil)?.requestId;
  t.equal(holderRequestId, c2After.id, "the freed slot's soft hold names C2's request, not C1's");
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-31 — the tier gate is skipped entirely for untiered events (optimisation)
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-31', 'an untiered event works end-to-end for a member with ZERO history and no joinedOn — the stats query never runs', async (t) => {
  await wipeEvents();

  // No accessTier at all. If the `if (event.accessTier?.enabled)` guard in
  // requestShift were ever removed or the check reordered so tiering ran
  // unconditionally, a member with no joinedOn and no shift history would
  // still need to survive whatever tier evaluation ran against them — this
  // is exactly the population that would be silently locked out by the
  // fail-closed tenure behaviour (EVT-27) if it ever leaked into the
  // untiered path. There is no query-interception hook in this harness to
  // assert "zero reads" directly, so this is the behavioural proof the task
  // calls for: the signup simply has to work.
  const event = await makeEvent({ name: 'EVT-31 Untiered', date: at(3, '18:00'), callTime: '18:00', teams: [team1()] });
  const brandNew = await subject('brand-new', 'Brand New', 'member'); // no joinedOn, no history at all

  await requestShift(event, 'team-1', 'EMT', brandNew);
  const req = (await readRequests(event.id!)).find((r) => r.userId === 'brand-new');
  t.ok(!!req && req.status === 'pending', 'a member with zero history and no joinedOn signs up successfully on an untiered event');
});
