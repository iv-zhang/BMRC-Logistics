/**
 * EVT — the Phase 1 waitlist queue (medops-signup-plan.md §3.2–§3.6, §8 Phase 1).
 *
 * These suites drive the REAL app code paths (app/lib/events.ts) against the
 * Firestore emulator: events are created, teams filled to capacity, members
 * queued, offers made/accepted/declined/expired, exactly the way the UI does
 * it, then read back from the database to confirm what actually persisted.
 * Assertions are always against re-read documents, never against the values
 * passed in — this suite exists to prove persistence, not to re-test
 * in-memory logic.
 *
 * Decisions protected:
 *  - §3.2 transition table: the ONLY organic seat-freeing path is
 *    `cancelRequest` on an `approved` doc, which must trigger
 *    `promoteNextFromWaitlist` automatically.
 *  - §3.5 / P13: the queue is EVENT-scoped by default, not team-scoped — a
 *    member who prefers one team can be promoted into another team's freed
 *    seat ("the path most likely to surprise").
 *  - §3.5 soft-hold: `heldUntil` on a `TeamSlot` reserves it without placing
 *    anyone; a direct `approveRequest` into a held slot is refused, not
 *    silently clobbered; an elapsed hold reads as open with NO release write.
 *  - §3.6 lazy expiry: `sweepExpiredOffers` is the only thing that
 *    materializes `expired` and rolls the queue forward on that branch.
 *  - P4 / §3.3 / D2 (§10.3): `commitmentBinding` on ACCEPT is `noticeClass
 *    === 'long'`, computed from the OFFERED TEAM's `startTime`, never the
 *    event-level `callTime` approximation — a short-notice pickup can never
 *    carry no-show liability, even if it starts earlier than the event's
 *    nominal call time.
 *  - P2: `getWaitlistPosition` is a read-time computation over N docs, never
 *    a stored rank; `skippedAt` reorders reads without touching
 *    `waitlistedAt` on disk.
 *  - §3.2 `leaveWaitlist` / `declineOffer`: both are explicitly NEVER
 *    punitive — no `lateCancellation`, no stat impact, regardless of notice.
 *  - §2.1: the "one active request per event" guard is widened to include
 *    `waitlisted`/`offered`, not just `pending`/`approved`.
 */
import { defineInvariant, db } from '../harness';
import {
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  query,
  where,
  writeBatch,
  updateDoc,
  setDoc,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import {
  createEvent,
  createEmptyTeam,
  requestShift,
  approveRequest,
  cancelRequest,
  joinWaitlist,
  leaveWaitlist,
  promoteNextFromWaitlist,
  acceptOffer,
  declineOffer,
  sweepExpiredOffers,
  getWaitlistPosition,
  resolveEventPolicy,
  skipWaitlistEntry,
  unskipWaitlistEntry,
  isSlotHeld,
  getShiftStartInstant,
  getMemberShiftStats,
  type EventActor,
  type ShiftRequester,
} from '@/app/lib/events';
import type { Event, EventTeam, ShiftRequest } from '@/app/types';
import type { EventPolicyOverride } from '@/app/config/org-config';

// ── local helpers (mirrors evt-shifts.test.ts's shape) ──────────────────────

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

/**
 * A cert-valid requester (EMT + CPR unexpired) so cert gating never masks a
 * result. ALSO seeds a matching `users/{uid}` doc: `promoteNextFromWaitlist`'s
 * eligibility re-check (plan §3.5 step 3, "a queued member can go stale") does
 * a live `getDoc(users/{uid})`, not a re-read of the denormalized request
 * fields — a candidate with no user doc is silently skipped as ineligible
 * ("not found") rather than promoted. Real app users always have this doc;
 * we seed it here so promotion has something to re-check against, matching
 * production shape rather than special-casing it.
 */
async function requester(uid: string, name: string, role: string): Promise<ShiftRequester> {
  const future = new Date(Date.now() + 365 * 86400000);
  const certifications = { emt: { expiresOn: future }, cpr: { expiresOn: future } };
  await setDoc(
    doc(db, 'users', uid),
    { uid, name, role, certifications, memberStatus: 'general' },
    { merge: true },
  );
  return { uid, name, role, certifications, memberStatus: 'general' };
}

function at(dayOffset: number, hhmm: string): Date {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  const [h, m] = hhmm.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d;
}

/** Create an event and read it straight back as the app would see it. */
async function makeEvent(opts: {
  name: string;
  date: Date;
  callTime?: string;
  endTime?: string;
  teams: EventTeam[];
}): Promise<Event> {
  const ref = await createEvent(
    { name: opts.name, date: opts.date, callTime: opts.callTime, endTime: opts.endTime, status: 'open', teams: opts.teams },
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

/** Request → approve in one step, returning the persisted approved request. */
async function signUp(event: Event, teamId: string, role: 'FTO' | 'FTO_INTERN' | 'EMT', who: ShiftRequester) {
  await requestShift(event, teamId, role, who);
  const pending = (await readRequests(event.id!)).find((r) => r.userId === who.uid && r.status === 'pending');
  if (!pending) throw new Error(`no pending request created for ${who.uid}`);
  await approveRequest(pending, MANAGER);
  const approved = (await readRequests(event.id!)).find((r) => r.id === pending.id)!;
  return approved;
}

/**
 * Set the per-event `policy` override directly (there is no dedicated
 * setter on the Phase 1 lib layer yet — `CreateEventInput`/`updateEvent`'s
 * patch type don't expose `policy` — so this is the same raw write an
 * eventual settings UI would make).
 */
async function setPolicy(eventId: string, policy: EventPolicyOverride): Promise<void> {
  await updateDoc(doc(db, 'events', eventId), { policy });
}

// ─────────────────────────────────────────────────────────────────────────────
// EVT-05 — waitlisted → offered → accepted (the full happy path)
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-05', 'waitlisted -> offered -> accepted: the full happy path genuinely fills the slot', async (t) => {
  await wipeEvents();

  const team = { ...createEmptyTeam('Team 1', 2, false), id: 'team-1' };
  let event = await makeEvent({ name: 'EVT-05 Football', date: at(3, '18:00'), callTime: '18:00', endTime: '22:00', teams: [team] });

  const a = await signUp(event, 'team-1', 'EMT', await requester('emt-a', 'Ada', 'member'));
  event = await readEvent(event.id!);
  await signUp(event, 'team-1', 'EMT', await requester('emt-b', 'Bo', 'member'));
  event = await readEvent(event.id!);

  // Team is now full — a third member's request queues instead of landing
  // directly. Uses `joinWaitlist` (the thin UI-facing wrapper) once here to
  // exercise it too; every other test in this suite queues via requestShift
  // directly, which is what joinWaitlist delegates to.
  const carla = await requester('emt-c', 'Carla', 'member');
  await joinWaitlist(event, 'EMT', carla, { preferredTeamId: 'team-1' });
  const carlaQueued = (await readRequests(event.id!)).find((r) => r.userId === 'emt-c')!;
  t.equal(carlaQueued.status, 'waitlisted', 'a third EMT request queues once the team is full');
  t.ok(!!carlaQueued.waitlistedAt, 'the queue entry is timestamped on arrival');

  // A seat frees via cancelRequest on an approved request — this is the ONLY
  // organic seat-freeing path (§3.2's transition table) and must trigger
  // promotion automatically, with no separate call needed.
  await cancelRequest(a, MANAGER);

  const afterCancel = (await readRequests(event.id!)).find((r) => r.userId === 'emt-c')!;
  t.equal(afterCancel.status, 'offered', 'promotion fires automatically off the freed seat and offers Carla');
  t.ok(!!afterCancel.offer, 'the offer block is present');
  t.equal(afterCancel.offer?.teamId, 'team-1', 'the offer names the (only) team');
  t.equal(afterCancel.offer?.binding, true, 'a >24h-out shift offers as long-notice, binding on accept');
  t.ok(!!afterCancel.offer?.respondBy, 'the offer carries a response deadline');

  const eventAfterOffer = await readEvent(event.id!);
  const heldSlot = eventAfterOffer.teams[0].emtSlots.find((s) => s.requestId === afterCancel.id);
  t.ok(!!heldSlot && !!heldSlot.heldUntil, 'the event doc carries a soft hold on the offered slot');
  t.ok(!heldSlot?.userId, 'the hold does not yet place Carla — acceptOffer does that');

  await acceptOffer(afterCancel, { uid: 'emt-c', name: 'Carla' });

  const finalReq = (await readRequests(event.id!)).find((r) => r.userId === 'emt-c')!;
  t.equal(finalReq.status, 'approved', 'accepting the offer lands the member as approved');
  t.equal(finalReq.offer?.response, 'accepted', 'the offer block records the acceptance');
  t.equal(finalReq.commitmentBinding, true, 'a long-notice acceptance is binding');

  const finalEvent = await readEvent(event.id!);
  const filled = finalEvent.teams[0].emtSlots.find((s) => s.userId === 'emt-c');
  t.ok(!!filled, 'the slot is genuinely filled in the EVENT doc, not just the request');
  t.ok(!filled?.heldUntil, 'the hold is cleared once the slot is actually filled');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-06 — offered → expired → next
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-06', 'offered -> expired -> next: an unanswered offer expires and the queue rolls forward', async (t) => {
  await wipeEvents();

  const team = { ...createEmptyTeam('Team 1', 2, false), id: 'team-1' };
  let event = await makeEvent({ name: 'EVT-06 Concert', date: at(3, '18:00'), callTime: '18:00', endTime: '22:00', teams: [team] });

  // A tiny response window via the per-event policy override — there is no
  // clock injection, so we shrink the window rather than the clock. The
  // event stays >24h out (long notice) so this exercises the LONG window.
  await setPolicy(event.id!, { longNoticeResponseWindowHours: 3 / 3600 }); // ~3 seconds
  event = await readEvent(event.id!);

  const a = await signUp(event, 'team-1', 'EMT', await requester('emt-a', 'Ada', 'member'));
  event = await readEvent(event.id!);
  await signUp(event, 'team-1', 'EMT', await requester('emt-b', 'Bo', 'member'));
  event = await readEvent(event.id!);

  await requestShift(event, 'team-1', 'EMT', await requester('emt-c', 'Carla', 'member'));
  await requestShift(event, 'team-1', 'EMT', await requester('emt-d', 'Dana', 'member'));
  const all = await readRequests(event.id!);
  t.equal(all.find((r) => r.userId === 'emt-c')?.status, 'waitlisted', 'Carla queues first');
  t.equal(all.find((r) => r.userId === 'emt-d')?.status, 'waitlisted', 'Dana queues second');

  await cancelRequest(a, MANAGER);
  let carla = (await readRequests(event.id!)).find((r) => r.userId === 'emt-c')!;
  t.equal(carla.status, 'offered', 'Carla (first in line) is offered the freed seat');
  const respondBy = carla.offer!.respondBy.toDate();
  t.ok(respondBy.getTime() - Date.now() < 10_000, 'the shrunk response window really is only a few seconds', `${respondBy.getTime() - Date.now()}ms`);

  // Wait past the window — a real wall-clock wait, since there is no clock
  // to fast-forward.
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, respondBy.getTime() - Date.now()) + 500));
  t.ok(Date.now() > respondBy.getTime(), 'confirmed: respondBy has actually elapsed before sweeping');

  const eventNow = await readEvent(event.id!);
  await sweepExpiredOffers(eventNow, MANAGER);

  carla = (await readRequests(event.id!)).find((r) => r.userId === 'emt-c')!;
  t.equal(carla.status, 'expired', 'the sweep materializes the expired status');
  t.equal(carla.offer?.response, 'expired', 'the offer block itself is stamped expired');

  const dana = (await readRequests(event.id!)).find((r) => r.userId === 'emt-d')!;
  t.equal(dana.status, 'offered', 'the sweep rolls the queue forward to the NEXT candidate');

  const eventAfterSweep = await readEvent(event.id!);
  const carlaHold = eventAfterSweep.teams[0].emtSlots.find((s) => s.requestId === carla.id);
  t.ok(!carlaHold, "Carla's expired offer no longer holds the slot's requestId");
  const danaHold = eventAfterSweep.teams[0].emtSlots.find((s) => s.requestId === dana.id);
  t.ok(!!danaHold?.heldUntil, "Dana's new offer now holds the slot");
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-07 — cross-team promotion (P13 — event-scoped queue, "most likely to surprise")
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-07', 'cross-team promotion: queued preferring Team Alpha, promoted into Team Bravo', async (t) => {
  await wipeEvents();

  const alpha = { ...createEmptyTeam('Team Alpha', 2, false), id: 'team-alpha' };
  const bravo = { ...createEmptyTeam('Team Bravo', 2, false), id: 'team-bravo' };
  let event = await makeEvent({ name: 'EVT-07 Festival', date: at(3, '12:00'), callTime: '12:00', endTime: '18:00', teams: [alpha, bravo] });

  const fills = [
    { uid: 'a1', name: 'Alpha One', teamId: 'team-alpha' },
    { uid: 'a2', name: 'Alpha Two', teamId: 'team-alpha' },
    { uid: 'b1', name: 'Bravo One', teamId: 'team-bravo' },
    { uid: 'b2', name: 'Bravo Two', teamId: 'team-bravo' },
  ];
  for (const f of fills) {
    event = await readEvent(event.id!);
    await signUp(event, f.teamId, 'EMT', await requester(f.uid, f.name, 'member'));
  }
  event = await readEvent(event.id!);

  // Both teams are full — the event-scoped queue (default) means requesting
  // via team-alpha now queues rather than landing directly, and records
  // team-alpha as her preference (the default when opts.preferredTeamId is
  // omitted — the team she actually clicked).
  await requestShift(event, 'team-alpha', 'EMT', await requester('emt-c', 'Cara', 'member'));
  const queued = (await readRequests(event.id!)).find((r) => r.userId === 'emt-c')!;
  t.equal(queued.status, 'waitlisted', 'both teams full -> she queues, event-scoped, regardless of which team she clicked');
  t.equal(queued.preferredTeamId, 'team-alpha', 'her preference defaults to the team she actually clicked');

  // A Bravo seat frees.
  const b1 = (await readRequests(event.id!)).find((r) => r.userId === 'b1')!;
  await cancelRequest(b1, MANAGER);

  const promoted = (await readRequests(event.id!)).find((r) => r.userId === 'emt-c')!;
  t.equal(promoted.status, 'offered', 'she is promoted into the freed Bravo seat under the default soft-preference mode');
  t.equal(promoted.offer?.teamId, 'team-bravo', 'the OFFER names Bravo, not her preferred Alpha');
  t.equal(promoted.offer?.teamName, 'Team Bravo', 'and the human-readable team name matches');
  t.equal(promoted.teamId, 'team-bravo', 'the request itself is now attached to Bravo');
  t.equal(promoted.preferredTeamId, 'team-alpha', "her preference is UNTOUCHED — it's a hint, never rewritten by promotion");
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-08 — P4: notice class and binding, long vs. short
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-08', 'P4: a long-notice promotion is binding on accept; a short-notice one never is, even accepted', async (t) => {
  await wipeEvents();

  // --- Long-notice case: shift starts comfortably >24h out. ---
  const longTeam = { ...createEmptyTeam('Team 1', 2, false), id: 'team-1' };
  let longEvent = await makeEvent({ name: 'EVT-08 Long', date: at(3, '18:00'), callTime: '18:00', endTime: '22:00', teams: [longTeam] });
  await signUp(longEvent, 'team-1', 'EMT', await requester('la', 'LA', 'member'));
  longEvent = await readEvent(longEvent.id!);
  const lb = await signUp(longEvent, 'team-1', 'EMT', await requester('lb', 'LB', 'member'));
  longEvent = await readEvent(longEvent.id!);
  await requestShift(longEvent, 'team-1', 'EMT', await requester('lc', 'LC', 'member'));

  await cancelRequest(lb, MANAGER);
  let lc = (await readRequests(longEvent.id!)).find((r) => r.userId === 'lc')!;
  t.equal(lc.offer?.noticeClass, 'long', 'a >24h-out shift offers as long-notice');
  t.equal(lc.offer?.binding, true, 'and the FROZEN offer.binding is true');
  await acceptOffer(lc, { uid: 'lc', name: 'LC' });
  lc = (await readRequests(longEvent.id!)).find((r) => r.userId === 'lc')!;
  t.equal(lc.commitmentBinding, true, 'accepting a long-notice offer IS binding');

  // --- Short-notice case: shift starts well under 24h out. ---
  const soon = new Date(Date.now() + 5 * 3600000); // 5h out
  const shortCallTime = `${String(soon.getHours()).padStart(2, '0')}:${String(soon.getMinutes()).padStart(2, '0')}`;
  const shortTeam = { ...createEmptyTeam('Team 1', 2, false), id: 'team-1' };
  let shortEvent = await makeEvent({ name: 'EVT-08 Short', date: soon, callTime: shortCallTime, teams: [shortTeam] });
  await signUp(shortEvent, 'team-1', 'EMT', await requester('sa', 'SA', 'member'));
  shortEvent = await readEvent(shortEvent.id!);
  const sb = await signUp(shortEvent, 'team-1', 'EMT', await requester('sb', 'SB', 'member'));
  shortEvent = await readEvent(shortEvent.id!);
  await requestShift(shortEvent, 'team-1', 'EMT', await requester('sc', 'SC', 'member'));

  await cancelRequest(sb, MANAGER);
  let sc = (await readRequests(shortEvent.id!)).find((r) => r.userId === 'sc')!;
  t.equal(sc.offer?.noticeClass, 'short', 'a <24h-out shift offers as short-notice');
  t.equal(sc.offer?.binding, false, 'and the frozen offer.binding is false');
  await acceptOffer(sc, { uid: 'sc', name: 'SC' });
  sc = (await readRequests(shortEvent.id!)).find((r) => r.userId === 'sc')!;
  t.equal(sc.commitmentBinding, false, 'P4: accepting a short-notice offer is STILL never binding, even though she said yes');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-09 — D2: a team-level startTime overrides the event-level callTime
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-09', 'D2: a team startTime overrides event.callTime for notice classification', async (t) => {
  await wipeEvents();

  const now = new Date();
  const boundary = new Date(now.getTime() + 24 * 3600000); // exactly the long/short threshold instant

  // event.callTime and team.startTime both resolve against event.date's
  // CALENDAR DAY only (getShiftStartInstant ignores event.date's own
  // time-of-day) — so both live on `boundary`'s day, with the team's time
  // placed BEFORE boundary (comfortably short) and the event's placed AFTER
  // it (comfortably long). This is exactly the shape plan §10.3's D2 entry
  // warns about: classing from the event-level approximation would wrongly
  // stamp binding:true on a shift that's actually inside the short-notice
  // window.
  const day = boundary;
  const callTime = '23:55'; // event-level approximation: late in the day -> LONG if naively used
  const startTime = '00:05'; // real team start: early in the day -> SHORT

  const team = { ...createEmptyTeam('Team 1', 2, false), id: 'team-1', startTime };
  const event = await makeEvent({ name: 'EVT-09 Straddle', date: day, callTime, teams: [team] });

  // Precondition guard: fails loudly (rather than silently mis-scoring) in
  // the rare case this run's wall-clock time landed in the few minutes where
  // the straddle construction above doesn't hold.
  const eventLevelInstant = getShiftStartInstant(event)!;
  const teamLevelInstant = getShiftStartInstant(event, event.teams[0])!;
  const hoursEventLevel = (eventLevelInstant.getTime() - Date.now()) / 3_600_000;
  const hoursTeamLevel = (teamLevelInstant.getTime() - Date.now()) / 3_600_000;
  t.ok(hoursEventLevel >= 24, 'precondition: the EVENT-LEVEL approximation reads as long-notice', `${hoursEventLevel.toFixed(2)}h`);
  t.ok(hoursTeamLevel < 24, 'precondition: the TEAM-LEVEL real start reads as short-notice', `${hoursTeamLevel.toFixed(2)}h`);

  let ev = event;
  await signUp(ev, 'team-1', 'EMT', await requester('da', 'DA', 'member'));
  ev = await readEvent(ev.id!);
  const dbApproved = await signUp(ev, 'team-1', 'EMT', await requester('db', 'DB', 'member'));
  ev = await readEvent(ev.id!);
  await requestShift(ev, 'team-1', 'EMT', await requester('dc', 'DC', 'member'));

  await cancelRequest(dbApproved, MANAGER);

  const dc = (await readRequests(event.id!)).find((r) => r.userId === 'dc')!;
  t.equal(dc.offer?.noticeClass, 'short', 'promotion classifies from the TEAM start, not the event call time');
  t.equal(dc.offer?.binding, false, 'so the offer is correctly non-binding');
  const offerStart = dc.offer!.shiftStartAt.toDate();
  t.equal(offerStart.getHours(), 0, "offer.shiftStartAt is the TEAM's start hour (00:xx)…");
  t.equal(offerStart.getMinutes(), 5, '…specifically 00:05, not the event callTime 23:55');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-10 — the soft hold is real
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant(
  'EVT-10',
  'the soft hold is real: a live offer blocks a competing direct approval, and an elapsed hold reads as open again with no release write',
  async (t) => {
    await wipeEvents();

    const team = { ...createEmptyTeam('Team 1', 2, false), id: 'team-1' };
    let event = await makeEvent({ name: 'EVT-10 Hold', date: at(3, '18:00'), callTime: '18:00', teams: [team] });

    const x = await signUp(event, 'team-1', 'FTO', await requester('hx', 'HX', 'FTO'));
    event = await readEvent(event.id!);

    await requestShift(event, 'team-1', 'FTO', await requester('hy', 'HY', 'FTO'));
    const yQueued = (await readRequests(event.id!)).find((r) => r.userId === 'hy')!;
    t.equal(yQueued.status, 'waitlisted', 'HY queues behind the filled FTO slot');

    await cancelRequest(x, MANAGER);
    const y = (await readRequests(event.id!)).find((r) => r.userId === 'hy')!;
    t.equal(y.status, 'offered', 'cancelling HX auto-promotes HY into an offer on the freed FTO slot');

    const eventHeld = await readEvent(event.id!);
    t.ok(!!eventHeld.teams[0].ftoSlot.heldUntil, 'the FTO slot carries a live soft hold for HY');
    t.equal(eventHeld.teams[0].ftoSlot.requestId, y.id, "the hold names HY's request");

    // An ad-hoc manager placement for a THIRD member into the same slot,
    // while the hold is live — written as a real Firestore doc (a manager UI
    // could write exactly this) so the refusal below is a genuine occupancy
    // check, not an artifact of a missing document.
    const zRef = await addDoc(collection(db, 'shift_requests'), {
      eventId: event.id!,
      eventName: event.name,
      teamId: 'team-1',
      teamName: 'Team 1',
      role: 'FTO',
      userId: 'hz',
      userName: 'HZ',
      status: 'pending',
      requestedAt: serverTimestamp(),
      commitmentBinding: false,
    });
    const zPending = (await readRequests(event.id!)).find((r) => r.id === zRef.id)!;
    await t.rejects(
      approveRequest(zPending, MANAGER),
      "approveRequest REFUSES to clobber a slot live-held by another member's outstanding offer",
    );
    const zStillPending = (await readRequests(event.id!)).find((r) => r.id === zRef.id)!;
    t.equal(zStillPending.status, 'pending', "the refused attempt left HZ's request untouched");

    // Age the hold past its deadline directly (no clock injection — this
    // reproduces real elapsed time exactly the way `isSlotHeld` is
    // documented to treat it) WITHOUT going through any release code path.
    const pastTs = Timestamp.fromDate(new Date(Date.now() - 60000));
    const agedTeams = eventHeld.teams.map((tm) =>
      tm.id === 'team-1' ? { ...tm, ftoSlot: { ...tm.ftoSlot, heldUntil: pastTs } } : tm,
    );
    await updateDoc(doc(db, 'events', event.id!), { teams: agedTeams });

    const stale = await readEvent(event.id!);
    t.ok(!!stale.teams[0].ftoSlot.heldUntil, 'the stale heldUntil is still PHYSICALLY present on the doc — nothing "released" it');
    t.ok(!isSlotHeld(stale.teams[0].ftoSlot, new Date()), 'but isSlotHeld reads an elapsed hold as open again, with no write required');

    await approveRequest(zPending, MANAGER);
    const zApproved = (await readRequests(event.id!)).find((r) => r.id === zRef.id)!;
    t.equal(
      zApproved.status,
      'approved',
      'once the hold has lapsed, the SAME real write path succeeds — occupancy is read through isSlotHeld everywhere, never a raw heldUntil truthiness check',
    );
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// EVT-11 — getWaitlistPosition ordering, including skip/unskip (P2)
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-11', 'getWaitlistPosition is derived at read time, never stored — skip/unskip only reorders reads', async (t) => {
  await wipeEvents();

  const team = { ...createEmptyTeam('Team 1', 2, false), id: 'team-1' };
  let event = await makeEvent({ name: 'EVT-11 Queue', date: at(3, '18:00'), callTime: '18:00', teams: [team] });

  await signUp(event, 'team-1', 'EMT', await requester('fa', 'FA', 'member'));
  event = await readEvent(event.id!);
  await signUp(event, 'team-1', 'EMT', await requester('fb', 'FB', 'member'));
  event = await readEvent(event.id!);

  await requestShift(event, 'team-1', 'EMT', await requester('m1', 'M1', 'member'));
  await requestShift(event, 'team-1', 'EMT', await requester('m2', 'M2', 'member'));
  await requestShift(event, 'team-1', 'EMT', await requester('m3', 'M3', 'member'));

  const policy = resolveEventPolicy(event);
  let all = await readRequests(event.id!);
  const m1 = all.find((r) => r.userId === 'm1')!;
  const m2 = all.find((r) => r.userId === 'm2')!;
  const m3 = all.find((r) => r.userId === 'm3')!;
  const waitlistedAt1 = m1.waitlistedAt!;

  t.equal(getWaitlistPosition(all, m1, policy), 1, 'M1 requested first -> position 1');
  t.equal(getWaitlistPosition(all, m2, policy), 2, 'M2 -> position 2');
  t.equal(getWaitlistPosition(all, m3, policy), 3, 'M3 -> position 3');

  await skipWaitlistEntry(m1, MANAGER);
  all = await readRequests(event.id!);
  const m1skipped = all.find((r) => r.userId === 'm1')!;
  t.equal(getWaitlistPosition(all, m1skipped, policy), 3, 'skipping M1 drops them to the BACK of the queue');
  t.equal(getWaitlistPosition(all, all.find((r) => r.userId === 'm2')!, policy), 1, 'M2 moves up to position 1');
  t.equal(
    getWaitlistPosition(all, all.find((r) => r.userId === 'm3')!, policy),
    2,
    'M3 moves up to position 2 — their RELATIVE order to each other is unchanged',
  );
  t.ok(
    m1skipped.waitlistedAt?.isEqual(waitlistedAt1) ?? false,
    'nothing was renumbered on disk — waitlistedAt is untouched by a skip; only skippedAt was added',
  );

  await unskipWaitlistEntry(m1skipped, MANAGER);
  all = await readRequests(event.id!);
  const m1restored = all.find((r) => r.userId === 'm1')!;
  t.ok(!m1restored.skippedAt, 'unskip clears skippedAt');
  t.equal(getWaitlistPosition(all, m1restored, policy), 1, 'unskipping restores position 1');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-12 — leaveWaitlist is free
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-12', 'leaveWaitlist costs nothing: no lateCancellation flag, no promotion, no stat impact', async (t) => {
  await wipeEvents();

  const team = { ...createEmptyTeam('Team 1', 2, false), id: 'team-1' };
  // Scheduled well inside the default 48h cancellation-notice window, so that
  // IF the cancellation policy were mistakenly evaluated on a queue
  // withdrawal, it would flag late — leaveWaitlist must never even reach
  // that code path in the first place.
  let event = await makeEvent({ name: 'EVT-12 Queue', date: at(1, '10:00'), callTime: '10:00', teams: [team] });

  await signUp(event, 'team-1', 'EMT', await requester('ga', 'GA', 'member'));
  event = await readEvent(event.id!);
  await signUp(event, 'team-1', 'EMT', await requester('gb', 'GB', 'member'));
  event = await readEvent(event.id!);

  await requestShift(event, 'team-1', 'EMT', await requester('gc', 'GC', 'member'));
  const gc = (await readRequests(event.id!)).find((r) => r.userId === 'gc')!;
  t.equal(gc.status, 'waitlisted', 'GC queues');

  await leaveWaitlist(gc, MANAGER);
  const left = (await readRequests(event.id!)).find((r) => r.userId === 'gc')!;
  t.equal(left.status, 'cancelled', 'leaving the waitlist cancels the entry');
  t.ok(!left.lateCancellation, 'no lateCancellation flag is EVER stamped on a queue withdrawal, even this close to the shift');
  t.ok(!left.lateCancellationHours, 'and no notice-hours snapshot is recorded either');

  const stats = getMemberShiftStats([left], new Date(Date.now() - 30 * 86400000));
  t.equal(stats.lateCancellations, 0, 'getMemberShiftStats counts nothing against a free queue withdrawal');
  t.equal(stats.shiftsAllTime, 0, 'and it never counted as a shift at all — it was never approved');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-13 — declineOffer is never punitive, and rolls forward
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-13', 'declineOffer is never punitive under the default terminal behavior, and rolls the queue forward', async (t) => {
  await wipeEvents();

  const team = { ...createEmptyTeam('Team 1', 2, false), id: 'team-1' };
  let event = await makeEvent({ name: 'EVT-13 Decline', date: at(3, '18:00'), callTime: '18:00', teams: [team] });

  await signUp(event, 'team-1', 'EMT', await requester('ia', 'IA', 'member'));
  event = await readEvent(event.id!);
  const ib = await signUp(event, 'team-1', 'EMT', await requester('ib', 'IB', 'member'));
  event = await readEvent(event.id!);

  await requestShift(event, 'team-1', 'EMT', await requester('ic', 'IC', 'member'));
  await requestShift(event, 'team-1', 'EMT', await requester('idm', 'IDM', 'member'));

  await cancelRequest(ib, MANAGER);
  let ic = (await readRequests(event.id!)).find((r) => r.userId === 'ic')!;
  t.equal(ic.status, 'offered', 'IC (first in line) is offered the freed seat');

  await declineOffer(ic, { uid: 'ic', name: 'IC' });
  ic = (await readRequests(event.id!)).find((r) => r.userId === 'ic')!;
  t.equal(ic.status, 'declined', 'the default declinedOfferBehavior (terminal) sends a decline to a terminal state');
  t.equal(ic.offer?.response, 'declined', 'the offer block records the decline');
  t.equal(ic.offerCount, 1, 'offerCount increments (used only to cap requeue-back attempts, never as a penalty counter)');
  t.equal(ic.offerHistory?.length, 1, 'the superseded offer is appended to offerHistory, not discarded');
  t.ok(!ic.lateCancellation, 'a decline is not a cancellation — never flagged as one');
  t.ok(!ic.commitmentBinding, 'a declined offer carries no commitment liability');

  const eventAfterId = await readEvent(event.id!);
  const slot = eventAfterId.teams[0].emtSlots.find((s) => s.requestId === ic.id);
  t.ok(!slot, "IC's decline released the slot's soft hold");

  const idReq = (await readRequests(event.id!)).find((r) => r.userId === 'idm')!;
  t.equal(idReq.status, 'offered', 'declining rolls the queue forward to the next candidate (IDM)');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-14 — one active request per event (widened active check)
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-14', 'one active request per event: the widened active check blocks a duplicate while waitlisted or offered', async (t) => {
  await wipeEvents();

  const team = { ...createEmptyTeam('Team 1', 2, false), id: 'team-1' };
  let event = await makeEvent({ name: 'EVT-14 Duplicate', date: at(3, '18:00'), callTime: '18:00', teams: [team] });

  const ja = await signUp(event, 'team-1', 'EMT', await requester('ja', 'JA', 'member'));
  event = await readEvent(event.id!);
  await signUp(event, 'team-1', 'EMT', await requester('jb', 'JB', 'member'));
  event = await readEvent(event.id!);

  const jc = await requester('jc', 'JC', 'member');
  await requestShift(event, 'team-1', 'EMT', jc);
  const queued = (await readRequests(event.id!)).find((r) => r.userId === 'jc')!;
  t.equal(queued.status, 'waitlisted', 'JC queues (team is full)');

  await t.rejects(
    requestShift(event, 'team-1', 'EMT', jc),
    'a member who is already WAITLISTED is refused a second request for the same event',
  );

  // Also true once promoted to `offered`.
  await cancelRequest(ja, MANAGER);
  const offered = (await readRequests(event.id!)).find((r) => r.userId === 'jc')!;
  t.equal(offered.status, 'offered', 'JC is promoted to offered');
  await t.rejects(
    requestShift(event, 'team-1', 'EMT', jc),
    'and refused again while merely OFFERED (not yet approved)',
  );

  const after = await readRequests(event.id!);
  t.equal(after.filter((r) => r.userId === 'jc').length, 1, 'no duplicate doc was ever created for JC');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-15 — autoPromote:false leaves the slot open until a manager forces it
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-15', 'autoPromote:false leaves a freed slot open until a manager forces the offer by hand', async (t) => {
  await wipeEvents();

  const team = { ...createEmptyTeam('Team 1', 2, false), id: 'team-1' };
  let event = await makeEvent({ name: 'EVT-15 Manual', date: at(3, '18:00'), callTime: '18:00', teams: [team] });
  await setPolicy(event.id!, { autoPromote: false });
  event = await readEvent(event.id!);

  await signUp(event, 'team-1', 'EMT', await requester('ka', 'KA', 'member'));
  event = await readEvent(event.id!);
  const kb = await signUp(event, 'team-1', 'EMT', await requester('kb', 'KB', 'member'));
  event = await readEvent(event.id!);

  await requestShift(event, 'team-1', 'EMT', await requester('kc', 'KC', 'member'));

  await cancelRequest(kb, MANAGER);
  let kc = (await readRequests(event.id!)).find((r) => r.userId === 'kc')!;
  t.equal(kc.status, 'waitlisted', 'with autoPromote off, the freed seat does NOT auto-offer — KC stays queued');

  const eventOpen = await readEvent(event.id!);
  const kbSlot = eventOpen.teams[0].emtSlots.find((s) => !s.userId && !s.heldUntil);
  t.ok(!!kbSlot, "the freed slot genuinely sits open, neither filled nor held");

  // The manager fires the SAME function by hand with force:true — one code
  // path, one config switch, never a second implementation.
  await promoteNextFromWaitlist(eventOpen, 'team-1', 'EMT', MANAGER, { force: true });
  kc = (await readRequests(event.id!)).find((r) => r.userId === 'kc')!;
  t.equal(kc.status, 'offered', 'force:true drives the exact same promotion the auto path would have');
});
