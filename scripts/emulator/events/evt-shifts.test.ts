/**
 * EVT — FTO-intern slots, the FTO self-check-in gate, and stamp-only attendance.
 *
 * These suites drive the REAL app code paths (app/lib/events.ts) against the
 * Firestore emulator: events and shift requests are created, approved, checked
 * in and checked out exactly the way the UI does it, then read back from the
 * database to confirm what actually persisted.
 *
 * Covers decisions.md D-29 (the FTO starts the shift; retro edits are
 * manager-only) and D-30 (FTO Intern is a role + a supernumerary team slot).
 */
import { defineInvariant, db } from '../harness';
import { collection, doc, getDoc, getDocs, query, where, writeBatch } from 'firebase/firestore';
import {
  createEvent,
  createEmptyTeam,
  requestShift,
  approveRequest,
  cancelRequest,
  canRequestRole,
  teamFilledCount,
  teamHasIntern,
  slotRoleLabel,
  checkInMember,
  checkOutMember,
  endEventShifts,
  getMemberShiftStats,
  type EventActor,
  type ShiftRequester,
} from '@/app/lib/events';
import {
  getAttendanceAccess,
  isEventPast,
  eventEndDateTime,
  computeMinutesEarly,
  teamSummaryLines,
} from '@/app/components/events/event-utils';
import type { Event, EventTeam, ShiftRequest } from '@/app/types';

// ── local helpers ────────────────────────────────────────────────────────────

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

/** A cert-valid requester (EMT + CPR unexpired) so cert gating never masks a result. */
function requester(uid: string, name: string, role: string): ShiftRequester {
  const future = new Date(Date.now() + 365 * 86400000);
  return {
    uid,
    name,
    role,
    certifications: { emt: { expiresOn: future }, cpr: { expiresOn: future } },
    memberStatus: 'general',
  };
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
  return snap.docs.map((d) => {
    const r = d.data() as ShiftRequest;
    const att = r.attendance as Record<string, { toDate?: () => Date }> | undefined;
    return {
      ...r,
      id: d.id,
      attendance: att
        ? ({
            ...r.attendance,
            checkedInAt: att.checkedInAt?.toDate?.() ?? r.attendance?.checkedInAt,
            shiftEndAt: att.shiftEndAt?.toDate?.() ?? r.attendance?.shiftEndAt,
          } as ShiftRequest['attendance'])
        : undefined,
    };
  });
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

// ─────────────────────────────────────────────────────────────────────────────
// EVT-01 — the intern slot: eligibility, placement, and supernumerary counting
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-01', 'FTO intern fills its own slot and never counts toward headcount', async (t) => {
  await wipeEvents();

  const team = { ...createEmptyTeam('Team 1', 3, true), id: 'team-1' };
  const legacy = { id: 'team-legacy', name: 'Team Legacy', ftoSlot: {}, emtCount: 2, emtSlots: [{}, {}] } as EventTeam;
  const event = await makeEvent({ name: 'EVT-01 Concert', date: at(1, '18:00'), callTime: '18:00', endTime: '22:00', teams: [team, legacy] });

  t.ok(teamHasIntern(event.teams[0]), 'a newly created team carries an intern slot by default');
  t.ok(!teamHasIntern(event.teams[1]), 'a legacy team with no hasFtoIntern field is treated as having NO intern slot');

  // Eligibility (pure).
  t.ok(canRequestRole('fto_intern', 'FTO_INTERN'), 'an intern may request the intern slot');
  t.ok(canRequestRole('fto_intern', 'EMT'), 'an intern may also take a plain EMT slot');
  t.ok(!canRequestRole('fto_intern', 'FTO'), 'an intern may NOT request the FTO slot — that is the point of the tier');
  t.ok(!canRequestRole('member', 'FTO_INTERN'), 'a plain member may not request the intern slot');
  t.ok(!canRequestRole('FTO', 'FTO_INTERN'), 'a full FTO does not occupy the intern slot');
  t.ok(canRequestRole('medops', 'FTO_INTERN'), 'a manager may still place into the intern slot');
  t.equal(slotRoleLabel('FTO_INTERN'), 'FTO Intern', 'the intern slot renders a human label, not the raw enum');

  // Placement through the real request → approve path.
  const intern = requester('intern-1', 'Indy Intern', 'fto_intern');
  const approved = await signUp(event, 'team-1', 'FTO_INTERN', intern);
  t.equal(approved.assignedSlot, 'intern', 'approval records the intern slot assignment');

  const after = await readEvent(event.id!);
  t.equal(after.teams[0].ftoInternSlot?.userId, 'intern-1', 'the intern landed in ftoInternSlot');
  t.ok(!after.teams[0].ftoSlot?.userId, 'the FTO slot is untouched — an intern never consumes it');

  // Supernumerary: the intern must not move any staffing number.
  const counts = teamFilledCount(after.teams[0]);
  t.equal(counts, { fto: 0, intern: 1, emt: 0 }, 'teamFilledCount reports the intern SEPARATELY from fto/emt');
  const summary = teamSummaryLines(after.teams)[0];
  t.equal(summary.emtFilled, 0, 'the intern does not inflate the EMT fill count');
  t.equal(summary.emtCount, 3, 'the EMT requirement is unchanged by the presence of an intern');
  t.ok(summary.hasIntern && summary.internFilled, 'the summary still surfaces the intern separately');

  // Rejections.
  await t.rejects(
    requestShift(after, 'team-1', 'FTO', requester('intern-2', 'Ivy Intern', 'fto_intern')),
    'an intern is REFUSED the FTO slot at the write path, not just in the UI',
  );
  await t.rejects(
    requestShift(after, 'team-1', 'FTO_INTERN', requester('member-9', 'Marty Member', 'member')),
    'a plain member is REFUSED the intern slot',
  );
  await t.rejects(
    requestShift(after, 'team-legacy', 'FTO_INTERN', requester('intern-3', 'Ike Intern', 'fto_intern')),
    'a team without an intern slot REFUSES an intern request',
  );

  // A second intern cannot double-fill the single slot.
  await requestShift(after, 'team-1', 'FTO_INTERN', requester('intern-4', 'Iris Intern', 'fto_intern'));
  const second = (await readRequests(event.id!)).find((r) => r.userId === 'intern-4' && r.status === 'pending')!;
  await t.rejects(approveRequest(second, MANAGER), 'the single intern slot cannot be double-filled');

  // Cancelling frees it again.
  await cancelRequest(approved, MANAGER);
  const freed = await readEvent(event.id!);
  t.ok(!freed.teams[0].ftoInternSlot?.userId, 'cancelling an approved intern request frees the intern slot');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-02 — attendance is stamped, and left-early is derived with no grace
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-02', 'check-in/check-out stamp real times and derive late/early snapshots', async (t) => {
  await wipeEvents();

  // 4 EMT slots: this suite signs up three members plus an open-ended case.
  const team = { ...createEmptyTeam('Team 1', 4, true), id: 'team-1' };
  const event = await makeEvent({ name: 'EVT-02 Game', date: at(0, '12:00'), callTime: '12:00', endTime: '20:00', teams: [team] });

  const emt = requester('emt-1', 'Erin EMT', 'member');
  const approved = await signUp(event, 'team-1', 'EMT', emt);
  const fto: EventActor = { uid: 'fto-1', name: 'Fran FTO', role: 'FTO' };

  // Check in 25 minutes after the 12:00 call time.
  const arrival = at(0, '12:25');
  const { minutesLate } = await checkInMember(event, approved, fto, arrival);
  t.equal(minutesLate, 25, 'lateness is derived from arrival vs the call time, not entered by a human');

  let persisted = (await readRequests(event.id!)).find((r) => r.id === approved.id)!;
  t.ok(!!persisted.attendance?.checkedInAt, 'the arrival stamp persisted');
  t.equal(persisted.attendance?.minutesLate, 25, 'the lateness snapshot persisted for offline stats');
  t.equal((persisted.attendance?.checkedInAt as Date).getHours(), 12, 'the stored arrival is the moment of the tap');

  // Check out 1 minute before the 20:00 end — no grace window, so this is early.
  await checkOutMember(event, persisted, fto, at(0, '19:59'));
  persisted = (await readRequests(event.id!)).find((r) => r.id === approved.id)!;
  t.equal(persisted.attendance?.leftEarly, true, 'leaving ONE minute early counts — there is deliberately no grace window');
  t.equal(persisted.attendance?.minutesEarly, 1, 'the early-departure snapshot records how early');

  // Stats read the stored snapshot.
  const stats = getMemberShiftStats([persisted], new Date(Date.now() - 30 * 86400000));
  t.equal(stats.leftEarlyCount, 1, 'getMemberShiftStats counts the early departure from the snapshot');
  t.equal(stats.lateCount, 1, 'and still counts the late arrival');

  // Checking out exactly at the end time is NOT early.
  const onTime = await signUp(event, 'team-1', 'EMT', requester('emt-2', 'Ozzy OnTime', 'member'));
  await checkInMember(event, onTime, fto, at(0, '12:00'));
  const onTimeIn = (await readRequests(event.id!)).find((r) => r.id === onTime.id)!;
  await checkOutMember(event, onTimeIn, fto, at(0, '20:00'));
  const onTimeOut = (await readRequests(event.id!)).find((r) => r.id === onTime.id)!;
  t.ok(!onTimeOut.attendance?.leftEarly, 'checking out exactly at the scheduled end is not "early"');
  t.equal(onTimeOut.attendance?.minutesLate, 0, 'arriving exactly at call time is not late');

  // Check-out requires a check-in first.
  const never = await signUp(event, 'team-1', 'EMT', requester('emt-3', 'Nora NoShow', 'member'));
  await t.rejects(checkOutMember(event, never, fto), 'a member who never checked in cannot be checked out');

  // An event with no end time cannot determine "early" — and must not guess.
  const noEnd = await makeEvent({ name: 'EVT-02 No End', date: at(0, '12:00'), callTime: '12:00', teams: [{ ...createEmptyTeam('T', 2, true), id: 'team-1' }] });
  const openEnded = await signUp(noEnd, 'team-1', 'EMT', requester('emt-4', 'Opal Open', 'member'));
  await checkInMember(noEnd, openEnded, fto, at(0, '12:00'));
  const oIn = (await readRequests(noEnd.id!)).find((r) => r.id === openEnded.id)!;
  await checkOutMember(noEnd, oIn, fto, at(0, '13:00'));
  const oOut = (await readRequests(noEnd.id!)).find((r) => r.id === openEnded.id)!;
  t.equal(eventEndDateTime(noEnd), null, 'an event with no endTime has no end datetime');
  t.ok(!oOut.attendance?.leftEarly, 'with no scheduled end, leftEarly is left UNSET rather than guessed');
  t.ok(!!oOut.attendance?.shiftEndAt, 'the shift still ends — only the early-departure judgement is withheld');
  t.equal(computeMinutesEarly(at(0, '19:00'), null), 0, 'computeMinutesEarly is 0 when there is no end time');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-03 — the FTO starts the shift, owns only their team, and loses edits later
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-03', 'FTO must self-check-in first, is scoped to their team, and is read-only once past', async (t) => {
  await wipeEvents();

  const t1: EventTeam = { ...createEmptyTeam('Team 1', 2, true), id: 'team-1', ftoSlot: { userId: 'fto-1', userName: 'Fran FTO' } };
  const t2: EventTeam = { ...createEmptyTeam('Team 2', 2, true), id: 'team-2', ftoSlot: { userId: 'fto-2', userName: 'Fred FTO' } };
  const live = await makeEvent({ name: 'EVT-03 Live', date: at(0, '08:00'), callTime: '08:00', endTime: '23:30', teams: [t1, t2] });

  const gated = getAttendanceAccess({ event: live, viewerRole: 'FTO', viewerUid: 'fto-1', viewerCheckedIn: false });
  t.ok(gated.visible && gated.mode === 'live', 'the assigned FTO sees a live attendance panel');
  t.ok(gated.gatedOnSelfCheckIn, 'and is GATED until they check themselves in — that is what starts the shift');
  t.equal(gated.scopeTeamIds, ['team-1'], 'the FTO is scoped to their own team only');
  t.ok(!gated.canEditRetro && !gated.canClear, 'a live FTO gets no retro-edit and no clear');

  const started = getAttendanceAccess({ event: live, viewerRole: 'FTO', viewerUid: 'fto-1', viewerCheckedIn: true });
  t.ok(!started.gatedOnSelfCheckIn, 'once the FTO is checked in the gate lifts');
  t.ok(started.canRecordLive, 'and they may record the rest of their team');

  // Other roles, same live event.
  const mgr = getAttendanceAccess({ event: live, viewerRole: 'medops', viewerUid: 'medops-1', viewerCheckedIn: false });
  t.ok(mgr.visible && mgr.canRecordLive, 'medops sees and records attendance (D-13 amendment)');
  t.equal(mgr.scopeTeamIds, null, 'a manager is scoped to the whole event, not one team');
  t.ok(!mgr.gatedOnSelfCheckIn, 'a manager is never gated on checking themselves in');

  t.ok(!getAttendanceAccess({ event: live, viewerRole: 'member', viewerUid: 'emt-1', viewerCheckedIn: false }).visible,
    'a plain member sees no attendance panel');
  t.ok(!getAttendanceAccess({ event: live, viewerRole: 'fto_intern', viewerUid: 'intern-1', viewerCheckedIn: true }).visible,
    'an FTO INTERN gets no recording powers — they are an attendee like anyone else');

  // Past event: the FTO goes read-only, managers become the only editors.
  const past = await makeEvent({ name: 'EVT-03 Past', date: at(-3, '08:00'), callTime: '08:00', endTime: '12:00', teams: [t1, t2] });
  t.ok(isEventPast(past), 'an event whose end time has passed is past');
  t.ok(!isEventPast(live), 'an event still running today is not past');

  const ftoPast = getAttendanceAccess({ event: past, viewerRole: 'FTO', viewerUid: 'fto-1', viewerCheckedIn: true });
  t.equal(ftoPast.mode, 'read-only', 'the FTO view of a finished event is READ-ONLY');
  t.ok(!ftoPast.canRecordLive && !ftoPast.canEditRetro && !ftoPast.canClear,
    'an FTO can change nothing retroactively — no times, no statuses');
  t.ok(!!ftoPast.reason, 'and is told who to contact instead');

  for (const role of ['admin', 'quartermaster', 'medops']) {
    const m = getAttendanceAccess({ event: past, viewerRole: role, viewerUid: 'mgr', viewerCheckedIn: false });
    t.ok(m.mode === 'retro-edit' && m.canEditRetro, `${role} keeps retroactive edit rights on a past event`);
  }

  // An event with no endTime stays live until the day is over.
  const dayOnly = await makeEvent({ name: 'EVT-03 Day', date: at(0, '08:00'), teams: [t1] });
  t.ok(!isEventPast(dayOnly), 'with no endTime, an event is live until the end of its day');
  const yesterday = await makeEvent({ name: 'EVT-03 Yday', date: at(-1, '08:00'), teams: [t1] });
  t.ok(isEventPast(yesterday), "and past once that day has gone");
});

// ─────────────────────────────────────────────────────────────────────────────
// EVT-04 — End shift respects the FTO's team scope
// ─────────────────────────────────────────────────────────────────────────────
defineInvariant('EVT-04', "an FTO's End shift ends only their own team's shifts", async (t) => {
  await wipeEvents();

  const t1: EventTeam = { ...createEmptyTeam('Team 1', 2, true), id: 'team-1', ftoSlot: { userId: 'fto-1', userName: 'Fran FTO' } };
  const t2: EventTeam = { ...createEmptyTeam('Team 2', 2, true), id: 'team-2', ftoSlot: { userId: 'fto-2', userName: 'Fred FTO' } };
  const event = await makeEvent({ name: 'EVT-04 Festival', date: at(0, '09:00'), callTime: '09:00', endTime: '23:30', teams: [t1, t2] });

  const a = await signUp(event, 'team-1', 'EMT', requester('emt-a', 'Ada', 'member'));
  const b = await signUp(event, 'team-2', 'EMT', requester('emt-b', 'Bo', 'member'));
  const fto: EventActor = { uid: 'fto-1', name: 'Fran FTO', role: 'FTO' };
  await checkInMember(event, a, fto, at(0, '09:00'));
  await checkInMember(event, b, fto, at(0, '09:00'));

  const ended = await endEventShifts(event.id!, fto, ['team-1']);
  t.equal(ended, 1, "the team-1 FTO's sweep ends exactly one shift — their own team's");

  const after = await readRequests(event.id!);
  t.ok(!!after.find((r) => r.id === a.id)?.attendance?.shiftEndAt, "team 1's member is ended");
  t.ok(!after.find((r) => r.id === b.id)?.attendance?.shiftEndAt, "team 2's member is untouched by another team's FTO");

  // A manager (no scope) sweeps everything that's still open.
  const all = await endEventShifts(event.id!, MANAGER);
  t.equal(all, 1, 'a manager sweep with no scope ends the remaining shift');
  const final = await readRequests(event.id!);
  t.ok(!!final.find((r) => r.id === b.id)?.attendance?.shiftEndAt, 'team 2 is ended by the unscoped manager sweep');
});
