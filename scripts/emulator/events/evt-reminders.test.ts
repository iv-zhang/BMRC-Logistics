/**
 * EVT — Phase 3 shift reminders (medops-signup-plan.md §6.2, §6.6, §8 Phase 3).
 *
 * These suites drive the REAL app code paths (app/lib/events.ts) against the
 * Firestore emulator: events are created, requests are filed through
 * `requestShift` and moved through the real waitlist/offer machinery exactly
 * the way evt-waitlist.test.ts and evt-tiers.test.ts do, then read back from
 * the database before being fed to the reminder functions. As with those two
 * suites: assertions are always against RE-READ documents, never against the
 * values passed in, EXCEPT where the function under test is a pure
 * computation with no write (`requestShiftStart`, `computeDueShiftReminders`,
 * `selectShiftReminderBanner`, `formatShiftReminder`) — for those the return
 * value is asserted directly, but every input is still built from documents
 * that actually round-tripped through Firestore via `createEvent`/
 * `requestShift`/`cancelRequest`/etc, never a hand-built `ShiftRequest`
 * literal (evt-tiers.test.ts's rule, explicitly repeated for
 * `getMemberShiftStats` here too — see EVT-39).
 *
 * `now` is threaded explicitly through every reminder call (no wall-clock
 * dependence in the pure functions), matching evt-tiers.test.ts's convention
 * — with two necessary exceptions, both already established by evt-waitlist's
 * EVT-06: EVT-39's swept-expiry case and EVT-40's lazy-expiry case shrink the
 * offer response window via a per-event `policy` override and do a real short
 * wall-clock wait, because `promoteNextFromWaitlist`/offer expiry have no
 * injectable clock either.
 *
 * Decisions protected:
 *  - D2 (§6.2, mirrors Phase 0's D2 for `WaitlistOffer.shiftStartAt`):
 *    `requestShiftStart` prefers the denormalized, team-`startTime`-aware
 *    `ShiftRequest.shiftStartAt` over the coarser `eventDate`, because a team
 *    override means the member's real start is NOT the event's nominal call
 *    time (EVT-32).
 *  - §6.2/§6.6 anti-spam guarantee: `computeDueShiftReminders` returns the
 *    SINGLE most specific due offset per request, never one per crossed
 *    threshold (EVT-33).
 *  - §6.6: `remindersSent` is a real idempotency key, proven at both the
 *    per-request field level and the `notifications` collection level — a
 *    second full compute+emit pass must not double-send (EVT-34).
 *  - Only `status === 'approved'` requests are reminded — a member does not
 *    get reminded about a shift they do not (yet, or no longer) have
 *    (EVT-35).
 *  - A past shift, `enabled: false`, an empty `hoursBefore`, and a `channels`
 *    array missing `'in_app'` each suppress reminders entirely. The empty-
 *    `hoursBefore` case is plan discovery D3: deleting every reminder row
 *    must actually silence reminders, not silently fall back to the
 *    `[48, 12]` defaults (EVT-36).
 *  - §6.2: `selectShiftReminderBanner` is independent of `remindersSent` — a
 *    fact displayed while true, not a one-shot send (EVT-37).
 *  - P11: `formatShiftReminder`'s template is admin-editable data, so an
 *    unrecognized `{placeholder}` degrades visibly (left untouched) rather
 *    than silently vanishing (EVT-38).
 *  - §5.5: the four new `MemberShiftStats` waitlist/offer fields are driven
 *    from real `shift_requests` docs through the real promotion path, and
 *    P4's load-bearing guarantee that none of that activity leaks into
 *    `shiftsAllTime`/`noShow`/`lateCount` (EVT-39).
 *  - §5.5 lazy evaluation (mirrors Phase 1's §3.6 for the dashboard): stats
 *    read an `offered` doc past its `respondBy` with no sweep yet as
 *    `offersExpired`, via `resolveOfferState`, never trusting the raw
 *    `status` field directly (EVT-40).
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
} from 'firebase/firestore';
import {
  createEvent,
  createEmptyTeam,
  requestShift,
  approveRequest,
  cancelRequest,
  declineOffer,
  sweepExpiredOffers,
  getShiftStartInstant,
  getMemberShiftStats,
  resolveOfferState,
  requestShiftStart,
  computeDueShiftReminders,
  selectShiftReminderBanner,
  formatShiftReminder,
  emitDueShiftReminders,
  slotRoleLabel,
  type EventActor,
  type ShiftRequester,
} from '@/app/lib/events';
import type { Event, EventTeam, ShiftRequest } from '@/app/types';
import type { EventPolicyOverride, ShiftReminderConfig } from '@/app/config/org-config';

// ── local helpers (mirrors evt-waitlist.test.ts's / evt-tiers.test.ts's shape) ──

/** `events`/`shift_requests`/`notifications` aren't in SEED_COLLECTIONS, so clear them per suite. */
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

/** A cert-valid requester (EMT + CPR unexpired) so cert gating never masks a result. */
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

/** An imminent instant N hours from the real wall clock — used for the
 *  reminder suites, which care about "hours until shift", not a calendar day. */
function soon(hoursFromNow: number): Date {
  return new Date(Date.now() + hoursFromNow * 3_600_000);
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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

/**
 * Set the per-event `policy` override directly, same raw write
 * evt-waitlist.test.ts's EVT-06/EVT-15 use — there is no dedicated setter on
 * the lib layer.
 */
async function setPolicy(eventId: string, policy: EventPolicyOverride): Promise<void> {
  await updateDoc(doc(db, 'events', eventId), { policy });
}

/** A 2-EMT team (createEmptyTeam clamps below MIN_EMTS=2, so this is the
 *  smallest team that can ever be "full"), matching evt-tiers.test.ts's shape. */
function team1(): EventTeam {
  return { ...createEmptyTeam('Team 1', 2, false), id: 'team-1' };
}

/** Real approved-shift + waitlist/offer stats for `uid`, via the actual
 *  `getMemberShiftStats` aggregator over re-read `shift_requests` docs —
 *  never a hand-built stats object (evt-tiers.test.ts's rule, applies to
 *  the Phase 3 fields exactly as much as the Phase 1 ones). */
async function statsFor(uid: string) {
  const reqs = await readUserRequests(uid);
  return getMemberShiftStats(reqs, new Date(Date.now() - 400 * 86_400_000));
}

/** Wait for real wall-clock time to pass `respondBy` — no clock injection
 *  exists for offer expiry, matching evt-waitlist.test.ts's EVT-06. */
async function waitPast(respondByMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, respondByMs - Date.now()) + 500));
}

function reminderConfig(overrides: Partial<ShiftReminderConfig> = {}): ShiftReminderConfig {
  return {
    enabled: true,
    hoursBefore: [48, 12],
    channels: ['in_app'],
    template: 'Reminder: {event} — {team} ({role}) in {hours}h. {bogus} stays put.',
    ...overrides,
  };
}

async function notificationCount(userId: string, type: string): Promise<number> {
  const snap = await getDocs(
    query(collection(db, 'notifications'), where('userId', '==', userId), where('type', '==', type)),
  );
  return snap.size;
}

// ─────────────────────────────────────────────────────────────────────────────
// EVT-32 — requestShiftStart prefers the team-aware shiftStartAt over eventDate (D2)
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-32', 'requestShiftStart resolves to the TEAM shift start (shiftStartAt), falling back to eventDate only when shiftStartAt is absent', async (t) => {
  await wipeEvents();

  // event-level callTime and team-level startTime deliberately far apart on
  // the same calendar day, so a bug that ignored the team override and used
  // event.callTime instead would be caught immediately.
  const day = at(3, '00:00');
  const callTime = '18:00'; // event-level approximation
  const startTime = '09:00'; // real team start — this is what must win

  const team = { ...team1(), startTime };
  const event = await makeEvent({ name: 'EVT-32 Team Start Override', date: day, callTime, teams: [team] });

  const eventInstant = getShiftStartInstant(event)!; // no team arg -> event.callTime
  const teamInstant = getShiftStartInstant(event, event.teams[0])!; // team.startTime
  t.ok(eventInstant.getTime() !== teamInstant.getTime(), 'precondition: the event-level and team-level instants genuinely differ');

  const approved = await signUp(event, 'team-1', 'EMT', await requester('d2-member', 'D2 Member', 'member'));
  const reread = (await readRequests(event.id!)).find((r) => r.id === approved.id)!;
  t.ok(!!reread.shiftStartAt, 'sanity: the re-read request genuinely persisted a shiftStartAt');

  const resolved = requestShiftStart(reread);
  t.ok(!!resolved, 'requestShiftStart resolves a start instant');
  t.equal(resolved!.getTime(), teamInstant.getTime(), 'resolves to the TEAM startTime instant, not the event callTime');
  t.ok(resolved!.getTime() !== eventInstant.getTime(), 'and is genuinely NOT the event-level approximation');

  // Fallback: a doc with no shiftStartAt at all (legacy shape, or a doc from
  // before this field existed) falls back to eventDate. `eventDate` is lifted
  // straight off the SAME real re-read document rather than a freestanding
  // literal, so it is still the genuine round-tripped Firestore value.
  const legacyShape: Pick<ShiftRequest, 'shiftStartAt' | 'eventDate'> = { eventDate: reread.eventDate };
  const fallback = requestShiftStart(legacyShape);
  t.ok(!!fallback, 'with no shiftStartAt, requestShiftStart still resolves (via eventDate)');
  const rereadEvent = await readEvent(event.id!);
  t.equal(fallback!.getTime(), (rereadEvent.date as Date).getTime(), 'the fallback instant is exactly eventDate');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-33 — computeDueShiftReminders returns ONE offset per request, the most
// specific crossed one, never one per crossed threshold
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-33', 'computeDueShiftReminders returns the SINGLE most specific due offset, not one per crossed threshold', async (t) => {
  await wipeEvents();
  const now = new Date();

  // Shift 3 hours out crosses BOTH the 48h and 12h thresholds — a member who
  // has never opened the app before must get exactly the 12h reminder, once.
  const shiftAt = soon(3);
  const event = await makeEvent({ name: 'EVT-33 Anti-spam', date: shiftAt, callTime: hhmm(shiftAt), teams: [team1()] });
  const approved = await signUp(event, 'team-1', 'EMT', await requester('spam-guard', 'Spam Guard', 'member'));
  const reread = (await readRequests(event.id!)).find((r) => r.id === approved.id)!;

  // Deliberately unsorted input, matching the config's own doc comment that
  // hoursBefore is admin-edited data that may be in any order.
  const config = reminderConfig({ hoursBefore: [48, 12] });
  const due = computeDueShiftReminders([reread], now, config);

  t.equal(due.length, 1, 'exactly ONE due entry for this request — the array LENGTH itself is the anti-spam assertion, not just its contents');
  t.equal(due[0]?.hoursBefore, 12, 'the single entry names the more specific (smaller) crossed offset, 12h, not 48h');
  t.equal(due[0]?.request.id, reread.id, 'the entry carries the real re-read request');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-34 — remindersSent is a real idempotency key, at the field AND the
// notifications-collection level
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-34', 'remindersSent is a genuine idempotency key: the offset sticks, computeDueShiftReminders stops offering it, and the notification is never doubled', async (t) => {
  await wipeEvents();
  const now = new Date();

  const shiftAt = soon(3);
  const event = await makeEvent({ name: 'EVT-34 Idempotent', date: shiftAt, callTime: hhmm(shiftAt), teams: [team1()] });
  const approved = await signUp(event, 'team-1', 'EMT', await requester('idem-member', 'Idem Member', 'member'));
  const reread1 = (await readRequests(event.id!)).find((r) => r.id === approved.id)!;

  const config = reminderConfig({ hoursBefore: [12] });
  const due1 = computeDueShiftReminders([reread1], now, config);
  t.equal(due1.length, 1, 'one reminder is due before anything has been sent');

  const sent1 = await emitDueShiftReminders(due1, MANAGER);
  t.equal(sent1, 1, 'emitDueShiftReminders reports one send');

  const reread2 = (await readRequests(event.id!)).find((r) => r.id === approved.id)!;
  t.ok(!!reread2.remindersSent?.includes(12), 'the offset genuinely landed in remindersSent on the RE-READ document');

  const due2 = computeDueShiftReminders([reread2], now, config);
  t.equal(due2.length, 0, 're-running computeDueShiftReminders against the RE-READ document (with remindersSent stamped) offers nothing more');

  const countAfterFirst = await notificationCount('idem-member', 'shift_reminder');
  t.equal(countAfterFirst, 1, 'exactly one shift_reminder notification doc exists after the first emit');

  // Re-run the WHOLE pipeline a second time (compute against the fresh state,
  // then emit) — the mandatory idempotency proof per plan §6.6, because the
  // Phase 4a poller has no before/after trigger condition to lean on.
  const sent2 = await emitDueShiftReminders(due2, MANAGER);
  t.equal(sent2, 0, 'the second full compute+emit pass sends nothing (nothing was due)');

  const countAfterSecond = await notificationCount('idem-member', 'shift_reminder');
  t.equal(countAfterSecond, 1, 'the notification count is STILL exactly one — it never doubled to two');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-35 — only status === 'approved' produces a reminder
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-35', "only status === 'approved' requests produce reminders — waitlisted, offered, and pending yield nothing even with an imminent start", async (t) => {
  await wipeEvents();
  const now = new Date();

  const shiftAt = soon(3);
  const event = await makeEvent({ name: 'EVT-35 Status Gate', date: shiftAt, callTime: hhmm(shiftAt), teams: [team1()] });

  // Pending: requested while a slot is still open (team not yet full).
  await requestShift(event, 'team-1', 'EMT', await requester('p-pending', 'P Pending', 'member'));

  // Fill the team (2 EMT slots) so the NEXT requests queue.
  const a = await signUp(event, 'team-1', 'EMT', await requester('a-approved', 'A Approved', 'member'));
  const bEvent = await readEvent(event.id!);
  const b = await signUp(bEvent, 'team-1', 'EMT', await requester('b-approved', 'B Approved', 'member'));

  // Waitlisted x2 (team is now full). Named by ARRIVAL order, not final
  // state — 'c-first-queued' is the one that gets promoted below.
  await requestShift(await readEvent(event.id!), 'team-1', 'EMT', await requester('c-first-queued', 'C First Queued', 'member'));
  await requestShift(await readEvent(event.id!), 'team-1', 'EMT', await requester('d-second-queued', 'D Second Queued', 'member'));

  // Free A's seat -> auto-promotes the first queued member (C) to offered;
  // D stays waitlisted. B remains approved throughout.
  await cancelRequest(a, MANAGER);

  const all = await readRequests(event.id!);
  const pending = all.find((r) => r.userId === 'p-pending')!;
  const approvedB = all.find((r) => r.userId === 'b-approved')!;
  const offeredC = all.find((r) => r.userId === 'c-first-queued')!;
  const waitlistedD = all.find((r) => r.userId === 'd-second-queued')!;

  t.equal(pending.status, 'pending', 'sanity: P really is pending');
  t.equal(approvedB.status, 'approved', 'sanity: B really is approved');
  t.equal(offeredC.status, 'offered', 'sanity: C was really promoted to offered');
  t.equal(waitlistedD.status, 'waitlisted', 'sanity: D is really still waitlisted');
  t.ok(!!b, 'B (approved) exists for reference');

  const config = reminderConfig({ hoursBefore: [12] });
  const due = computeDueShiftReminders(all, now, config);

  t.equal(due.length, 1, 'exactly one due reminder across all four states — only the approved one');
  t.equal(due[0]?.request.userId, 'b-approved', 'the single due reminder belongs to the APPROVED member');
  t.ok(!due.some((d) => d.request.userId === 'p-pending'), 'pending yields nothing');
  t.ok(!due.some((d) => d.request.userId === 'c-first-queued'), 'offered yields nothing');
  t.ok(!due.some((d) => d.request.userId === 'd-second-queued'), 'waitlisted yields nothing');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-36 — a past shift, and each disabling config knob, yield nothing
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-36', 'a past shift yields nothing; enabled:false, empty hoursBefore (D3), and channels missing in_app each suppress reminders', async (t) => {
  await wipeEvents();
  const now = new Date();

  // Past shift.
  const pastAt = soon(-1);
  const pastEvent = await makeEvent({ name: 'EVT-36 Past', date: pastAt, callTime: hhmm(pastAt), teams: [team1()] });
  const pastApproved = await signUp(pastEvent, 'team-1', 'EMT', await requester('past-member', 'Past Member', 'member'));
  const pastReread = (await readRequests(pastEvent.id!)).find((r) => r.id === pastApproved.id)!;
  t.equal(computeDueShiftReminders([pastReread], now, reminderConfig()).length, 0, 'a shift already in the past yields nothing, regardless of config');

  // Imminent shift, reused across the config-disabling sub-cases.
  const shiftAt = soon(3);
  const event = await makeEvent({ name: 'EVT-36 Disabled Config', date: shiftAt, callTime: hhmm(shiftAt), teams: [team1()] });
  const approved = await signUp(event, 'team-1', 'EMT', await requester('config-member', 'Config Member', 'member'));
  const reread = (await readRequests(event.id!)).find((r) => r.id === approved.id)!;

  t.equal(computeDueShiftReminders([reread], now, reminderConfig({ enabled: false })).length, 0, 'enabled:false suppresses everything');

  // D3: an admin who deletes every reminder row must actually stop
  // reminders — an empty hoursBefore must NOT silently fall back to the
  // [48, 12] defaults.
  t.equal(computeDueShiftReminders([reread], now, reminderConfig({ hoursBefore: [] })).length, 0, 'D3: an empty hoursBefore suppresses everything — no silent fallback to defaults');

  t.equal(computeDueShiftReminders([reread], now, reminderConfig({ channels: ['email'] })).length, 0, "a channels array without 'in_app' suppresses everything");
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-37 — selectShiftReminderBanner is independent of remindersSent
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-37', 'selectShiftReminderBanner keeps returning the shift after emitDueShiftReminders has stamped remindersSent — a fact displayed while true, not a one-shot send', async (t) => {
  await wipeEvents();
  const now = new Date();

  const shiftAt = soon(3);
  const event = await makeEvent({ name: 'EVT-37 Banner', date: shiftAt, callTime: hhmm(shiftAt), teams: [team1()] });
  const approved = await signUp(event, 'team-1', 'EMT', await requester('banner-member', 'Banner Member', 'member'));
  const reread1 = (await readRequests(event.id!)).find((r) => r.id === approved.id)!;

  const config = reminderConfig({ hoursBefore: [12] });

  const bannerBefore = selectShiftReminderBanner([reread1], now, config);
  t.ok(!!bannerBefore, 'the banner shows before any reminder has been emitted');
  t.equal(bannerBefore?.request.id, reread1.id, 'the banner names the real request');

  const due = computeDueShiftReminders([reread1], now, config);
  await emitDueShiftReminders(due, MANAGER);
  const reread2 = (await readRequests(event.id!)).find((r) => r.id === approved.id)!;
  t.ok(!!reread2.remindersSent?.includes(12), 'sanity: remindersSent is genuinely stamped on the re-read document now');

  const bannerAfter = selectShiftReminderBanner([reread2], now, config);
  t.ok(!!bannerAfter, 'the banner STILL returns the shift after remindersSent has been stamped — it is not gated on that field');
  t.equal(bannerAfter?.request.id, reread2.id, 'still the same request');

  // Contrast: computeDueShiftReminders (the SEND-side function) correctly
  // stops offering it — proves the two functions are genuinely independent,
  // not that the idempotency check silently vanished everywhere.
  const dueAfter = computeDueShiftReminders([reread2], now, config);
  t.equal(dueAfter.length, 0, 'contrast: computeDueShiftReminders (send-side) DOES stop offering the already-sent offset');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-38 — formatShiftReminder interpolates from the real request and leaves
// unrecognized placeholders untouched
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-38', 'formatShiftReminder interpolates {event} {team} {role} {hours} from the real re-read request and leaves an unrecognized placeholder untouched', async (t) => {
  await wipeEvents();
  const now = new Date();

  const shiftAt = soon(3);
  const event = await makeEvent({ name: 'EVT-38 Football Classic', date: shiftAt, callTime: hhmm(shiftAt), teams: [team1()] });
  const approved = await signUp(event, 'team-1', 'EMT', await requester('fmt-member', 'Fmt Member', 'member'));
  const reread = (await readRequests(event.id!)).find((r) => r.id === approved.id)!;

  const config = reminderConfig({ hoursBefore: [12] });
  const due = computeDueShiftReminders([reread], now, config);
  t.equal(due.length, 1, 'sanity: exactly one due reminder to format');
  const item = due[0]!;

  const template = 'Reminder: {event} — {team} ({role}) in {hours}h. Unknown: {bogus}.';
  const result = formatShiftReminder(template, item);

  const expected = `Reminder: ${item.request.eventName} — ${item.request.teamName} (${slotRoleLabel(item.request.role)}) in ${item.hoursUntil}h. Unknown: {bogus}.`;
  t.equal(result, expected, 'byte-for-byte: all four known placeholders interpolate from the real request, and {bogus} is left untouched, not blanked');
  t.ok(result.includes('{bogus}'), 'the unrecognized placeholder is still literally present in the output');
  t.ok(result.includes('EMT'), 'the real role interpolated (EMT)');
  t.ok(result.includes('EVT-38 Football Classic'), 'the real event name interpolated');
  t.ok(result.includes('Team 1'), 'the real team name interpolated');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-39 — the four new MemberShiftStats fields, from real requestShift +
// the real promotion path, never leaking into shiftsAllTime/noShow/lateCount
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-39', 'waitlistPending / offersOutstanding / offersDeclined / offersExpired are driven from REAL shift_requests via the real promotion path, and never move shiftsAllTime, noShow, or lateCount', async (t) => {
  await wipeEvents();
  const uid = 'stats-member';
  const day = at(3, '18:00');

  // --- Event W: stays waitlisted, never promoted. ---
  const eventW = await makeEvent({ name: 'EVT-39 Waitlist', date: day, callTime: '18:00', teams: [team1()] });
  await signUp(eventW, 'team-1', 'EMT', await requester('w-fill-1', 'W Fill 1', 'member'));
  await signUp(await readEvent(eventW.id!), 'team-1', 'EMT', await requester('w-fill-2', 'W Fill 2', 'member'));
  await requestShift(await readEvent(eventW.id!), 'team-1', 'EMT', await requester(uid, 'Stats Member', 'member'));

  // --- Event O: promoted to offered, never responded. ---
  const eventO = await makeEvent({ name: 'EVT-39 Offered', date: day, callTime: '18:00', teams: [team1()] });
  const oFill1 = await signUp(eventO, 'team-1', 'EMT', await requester('o-fill-1', 'O Fill 1', 'member'));
  await signUp(await readEvent(eventO.id!), 'team-1', 'EMT', await requester('o-fill-2', 'O Fill 2', 'member'));
  await requestShift(await readEvent(eventO.id!), 'team-1', 'EMT', await requester(uid, 'Stats Member', 'member'));
  await cancelRequest(oFill1, MANAGER); // promotes stats-member to offered

  // --- Event D: promoted to offered, then declined. ---
  const eventD = await makeEvent({ name: 'EVT-39 Declined', date: day, callTime: '18:00', teams: [team1()] });
  const dFill1 = await signUp(eventD, 'team-1', 'EMT', await requester('d-fill-1', 'D Fill 1', 'member'));
  await signUp(await readEvent(eventD.id!), 'team-1', 'EMT', await requester('d-fill-2', 'D Fill 2', 'member'));
  await requestShift(await readEvent(eventD.id!), 'team-1', 'EMT', await requester(uid, 'Stats Member', 'member'));
  await cancelRequest(dFill1, MANAGER);
  const dOffered = (await readRequests(eventD.id!)).find((r) => r.userId === uid)!;
  await declineOffer(dOffered, { uid, name: 'Stats Member' });

  // --- Event X: promoted to offered, offer expires, sweep materializes it. ---
  const eventX = await makeEvent({ name: 'EVT-39 Expired', date: day, callTime: '18:00', teams: [team1()] });
  // setPolicy only touches the `policy` field, not `teams`, so the `eventX`
  // object from makeEvent is still an accurate read for the first signUp.
  await setPolicy(eventX.id!, { longNoticeResponseWindowHours: 3 / 3600 }); // ~3 seconds
  const xFill1 = await signUp(eventX, 'team-1', 'EMT', await requester('x-fill-1', 'X Fill 1', 'member'));
  await signUp(await readEvent(eventX.id!), 'team-1', 'EMT', await requester('x-fill-2', 'X Fill 2', 'member'));
  await requestShift(await readEvent(eventX.id!), 'team-1', 'EMT', await requester(uid, 'Stats Member', 'member'));
  await cancelRequest(xFill1, MANAGER);
  const xOffered = (await readRequests(eventX.id!)).find((r) => r.userId === uid)!;
  await waitPast(xOffered.offer!.respondBy.toMillis());
  await sweepExpiredOffers(await readEvent(eventX.id!), MANAGER);

  // Sanity: confirm every state actually landed as intended before trusting stats.
  const wReq = (await readRequests(eventW.id!)).find((r) => r.userId === uid)!;
  const oReq = (await readRequests(eventO.id!)).find((r) => r.userId === uid)!;
  const dReq = (await readRequests(eventD.id!)).find((r) => r.userId === uid)!;
  const xReq = (await readRequests(eventX.id!)).find((r) => r.userId === uid)!;
  t.equal(wReq.status, 'waitlisted', 'sanity: W really is waitlisted');
  t.equal(oReq.status, 'offered', 'sanity: O really is offered, outstanding');
  t.equal(dReq.status, 'declined', 'sanity: D really is declined');
  t.equal(xReq.status, 'expired', 'sanity: X really is expired (materialized by the sweep)');

  const stats = await statsFor(uid);
  t.equal(stats.waitlistPending, 1, 'waitlistPending counts the one waitlisted request');
  t.equal(stats.offersOutstanding, 1, 'offersOutstanding counts the one live, unanswered offer');
  t.equal(stats.offersDeclined, 1, 'offersDeclined counts the one declined offer');
  t.equal(stats.offersExpired, 1, 'offersExpired counts the one swept-expired offer');

  // P4's load-bearing guarantee: none of this queue/offer activity is fault,
  // and none of it may leak into the numbers a manager judges attendance by.
  t.equal(stats.shiftsAllTime, 0, 'P4: none of this was ever an approved shift — shiftsAllTime is untouched');
  t.equal(stats.noShow, 0, 'P4: no no-show was recorded anywhere in this suite');
  t.equal(stats.lateCount, 0, 'P4: no lateness was recorded anywhere in this suite');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-40 — a lazily-expired offer (respondBy passed, no sweep) counts as
// offersExpired, not offersOutstanding — stats read through resolveOfferState
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-40', 'an offered request past its respondBy that no sweep has rewritten counts as offersExpired, not offersOutstanding — stats read resolveOfferState, never raw status', async (t) => {
  await wipeEvents();
  const uid = 'lazy-stats-member';
  const day = at(3, '18:00');

  const event = await makeEvent({ name: 'EVT-40 Lazy Expiry', date: day, callTime: '18:00', teams: [team1()] });
  await setPolicy(event.id!, { longNoticeResponseWindowHours: 3 / 3600 }); // ~3 seconds
  const fill1 = await signUp(await readEvent(event.id!), 'team-1', 'EMT', await requester('lazy-fill-1', 'Lazy Fill 1', 'member'));
  await signUp(await readEvent(event.id!), 'team-1', 'EMT', await requester('lazy-fill-2', 'Lazy Fill 2', 'member'));
  await requestShift(await readEvent(event.id!), 'team-1', 'EMT', await requester(uid, 'Lazy Stats Member', 'member'));
  await cancelRequest(fill1, MANAGER); // promotes uid to offered

  const offered = (await readRequests(event.id!)).find((r) => r.userId === uid)!;
  t.equal(offered.status, 'offered', 'sanity: promoted to offered');
  await waitPast(offered.offer!.respondBy.toMillis());

  // Deliberately NO sweepExpiredOffers call — this is the whole point.
  const raw = (await readRequests(event.id!)).find((r) => r.userId === uid)!;
  t.equal(raw.status, 'offered', 'the RAW status is still offered — nothing has rewritten it, confirming no sweep ran');
  t.equal(resolveOfferState(raw, new Date()), 'expired', 'but resolveOfferState reads it as expired, since respondBy has genuinely passed');

  const stats = await statsFor(uid);
  t.equal(stats.offersExpired, 1, 'MemberShiftStats counts the un-swept, past-due offer as offersExpired');
  t.equal(stats.offersOutstanding, 0, 'and NOT as offersOutstanding — the raw status alone would have said otherwise');
});
