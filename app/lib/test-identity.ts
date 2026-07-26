'use client';

/**
 * Test identities: seeded `users/{__test_*}` docs an admin/quartermaster can
 * "become" (via `bmrc_test_identity` in localStorage, see useUserRole.tsx) to
 * experience the app AS a member/FTO/etc. without polluting their own real
 * account. This is distinct from the legacy `bmrc_role_override` string,
 * which only ever swapped the `role` label and left writes attributed to the
 * real user.
 *
 * Every write these identities generate while in use (shift requests,
 * statpack checkouts, vehicle shifts, notifications, issue reports, event
 * slot claims) is real Firestore data keyed off the test uid. `seedTestUsers`
 * makes sure the identity docs exist (idempotent, safe to call repeatedly);
 * `clearTestIdentityHistory` is the MANUAL reset an admin runs from
 * `/profile` to wipe what a given test identity has generated so far — it is
 * NOT run automatically on exit.
 */

import {
  doc,
  setDoc,
  getDocs,
  updateDoc,
  writeBatch,
  collection,
  query,
  where,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import { db } from '@/firebase';
import type { User } from '@/app/types';

/** Deterministic test-identity uids, all prefixed so they can never collide with a real Firebase Auth uid. */
export const TEST_USER_IDS = {
  member: '__test_member',
  fto: '__test_fto',
  medops: '__test_medops',
  quartermaster: '__test_quartermaster',
  admin: '__test_admin',
} as const;

export interface TestIdentityDef {
  id: string;
  fullName: string;
  email: string;
  role: User['role'];
}

export const TEST_IDENTITIES: TestIdentityDef[] = [
  { id: TEST_USER_IDS.member, fullName: 'Test Member', email: 'test-member@bmrc.test', role: 'member' },
  { id: TEST_USER_IDS.fto, fullName: 'Test FTO', email: 'test-fto@bmrc.test', role: 'FTO' },
  { id: TEST_USER_IDS.medops, fullName: 'Test MedOps', email: 'test-medops@bmrc.test', role: 'medops' },
  { id: TEST_USER_IDS.quartermaster, fullName: 'Test Quartermaster', email: 'test-quartermaster@bmrc.test', role: 'quartermaster' },
  { id: TEST_USER_IDS.admin, fullName: 'Test Admin', email: 'test-admin@bmrc.test', role: 'admin' },
];

const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/**
 * Idempotent: creates/merges the `users/{__test_*}` docs for every test
 * identity so switching to one always resolves to a real, cert-current user
 * doc (cert-gating never blocks a test identity). Safe to call on every
 * "switch to test role" — merge-write, no destructive overwrite of anything
 * an admin may have hand-edited on a test doc.
 */
export async function seedTestUsers(): Promise<void> {
  const farFuture = Timestamp.fromDate(new Date(Date.now() + TWO_YEARS_MS));
  await Promise.all(
    TEST_IDENTITIES.map((identity) =>
      setDoc(
        doc(db, 'users', identity.id),
        {
          id: identity.id,
          email: identity.email,
          fullName: identity.fullName,
          role: identity.role,
          isTestUser: true,
          certifications: {
            emt: { expiresOn: farFuture },
            cpr: { expiresOn: farFuture },
          },
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      ),
    ),
  );
}

/** Delete every doc in `docs` in Firestore-batch-sized chunks (max 400/batch). */
async function batchDelete(refs: { id: string; ref: ReturnType<typeof doc> }[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < refs.length; i += 400) {
    const batch = writeBatch(db);
    for (const { ref } of refs.slice(i, i + 400)) {
      batch.delete(ref);
    }
    await batch.commit();
    deleted += Math.min(400, refs.length - i);
  }
  return deleted;
}

/**
 * Manual reset of a seeded TEST identity's generated history — NOT a real
 * user's data. Deletes everything the test uid authored (shift requests,
 * statpack logs, vehicle shift logs, notifications, issue reports) and
 * vacates any live references to it (an assigned statpack, a claimed event
 * team slot) so the identity is clean to reuse, all WITHOUT touching the
 * `users/{testUid}` doc itself. History is never cleared automatically —
 * this is the explicit "Clear history" action on `/profile`.
 */
export async function clearTestIdentityHistory(testUid: string): Promise<{ deleted: number }> {
  let deleted = 0;

  // shift_requests authored by this identity
  try {
    const snap = await getDocs(query(collection(db, 'shift_requests'), where('userId', '==', testUid)));
    deleted += await batchDelete(snap.docs.map((d) => ({ id: d.id, ref: d.ref })));
  } catch (err) {
    console.warn('clearTestIdentityHistory: shift_requests cleanup failed', err);
  }

  // statpack_logs authored by this identity
  try {
    const snap = await getDocs(query(collection(db, 'statpack_logs'), where('userId', '==', testUid)));
    deleted += await batchDelete(snap.docs.map((d) => ({ id: d.id, ref: d.ref })));
  } catch (err) {
    console.warn('clearTestIdentityHistory: statpack_logs cleanup failed', err);
  }

  // vehicle_logs where this identity was the driver or the one who checked in
  try {
    const [driverSnap, checkinSnap] = await Promise.all([
      getDocs(query(collection(db, 'vehicle_logs'), where('driverUserId', '==', testUid))),
      getDocs(query(collection(db, 'vehicle_logs'), where('checkinUserId', '==', testUid))),
    ]);
    const seen = new Map<string, { id: string; ref: ReturnType<typeof doc> }>();
    for (const d of [...driverSnap.docs, ...checkinSnap.docs]) {
      seen.set(d.id, { id: d.id, ref: d.ref });
    }
    deleted += await batchDelete(Array.from(seen.values()));
  } catch (err) {
    console.warn('clearTestIdentityHistory: vehicle_logs cleanup failed', err);
  }

  // notifications sent to this identity
  try {
    const snap = await getDocs(query(collection(db, 'notifications'), where('userId', '==', testUid)));
    deleted += await batchDelete(snap.docs.map((d) => ({ id: d.id, ref: d.ref })));
  } catch (err) {
    console.warn('clearTestIdentityHistory: notifications cleanup failed', err);
  }

  // issue_reports filed by this identity (reporter is a nested object)
  try {
    const snap = await getDocs(query(collection(db, 'issue_reports'), where('reporter.userId', '==', testUid)));
    deleted += await batchDelete(snap.docs.map((d) => ({ id: d.id, ref: d.ref })));
  } catch (err) {
    console.warn('clearTestIdentityHistory: issue_reports cleanup failed', err);
  }

  // Vacate: any statpack currently assigned/checked out to this identity
  try {
    const snap = await getDocs(query(collection(db, 'statpacks'), where('assignedToUserId', '==', testUid)));
    await Promise.all(
      snap.docs.map((d) =>
        updateDoc(d.ref, {
          isCheckedOut: false,
          assignedToUserId: null,
          assignedToUserName: null,
          checkedOutAt: null,
          currentEvent: null,
          currentEventId: null,
          status: 'Ready',
          updatedAt: serverTimestamp(),
        }),
      ),
    );
  } catch (err) {
    console.warn('clearTestIdentityHistory: statpacks vacate failed', err);
  }

  // Vacate: any event team slot (FTO or EMT) this identity is holding
  try {
    const snap = await getDocs(collection(db, 'events'));
    const updates: Promise<void>[] = [];
    for (const d of snap.docs) {
      const data = d.data() as { teams?: Array<{ id: string; ftoSlot?: { userId?: string }; emtSlots?: Array<{ userId?: string }> }> };
      const teams = data.teams;
      if (!Array.isArray(teams)) continue;
      let changed = false;
      const nextTeams = teams.map((team) => {
        let teamChanged = false;
        let nextFto = team.ftoSlot;
        if (team.ftoSlot?.userId === testUid) {
          teamChanged = true;
          nextFto = {};
        }
        const nextEmtSlots = (team.emtSlots || []).map((slot) => {
          if (slot.userId === testUid) {
            teamChanged = true;
            return {};
          }
          return slot;
        });
        if (teamChanged) changed = true;
        return teamChanged ? { ...team, ftoSlot: nextFto, emtSlots: nextEmtSlots } : team;
      });
      if (changed) {
        updates.push(updateDoc(d.ref, { teams: nextTeams, updatedAt: serverTimestamp() }));
      }
    }
    await Promise.all(updates);
  } catch (err) {
    console.warn('clearTestIdentityHistory: events vacate failed', err);
  }

  return { deleted };
}
