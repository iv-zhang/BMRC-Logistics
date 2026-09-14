/**
 * Best-effort flagging of a statpack's shortages to the logistics team.
 *
 * Context: the check-in fast path (docs/statpack-checkin-fast-path.md,
 * "Flagging the logistics team") assumes the crew did NOT restock — so the
 * pack's shortage must reach logistics on its own, without anyone remembering
 * to look. This fires two independent channels (a `team_tasks` card + an
 * in-app notification) after the check-in transaction has already committed.
 * Neither channel may ever cause a check-in to fail, so every step here is
 * individually try/caught and this function itself never throws — mirroring
 * the `issue_reports` / `endEventShifts` post-commit pattern already used in
 * `logStatpackCheckOff` (app/lib/inventory.ts).
 */
import {
  collection,
  query,
  where,
  getDocs,
  addDoc,
  doc,
  updateDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '@/firebase';
import type { Statpack } from '@/app/types';
import { getPackShortages, formatShortage } from '@/app/lib/statpack-shortages';
import { broadcastNotification } from '@/app/lib/notifications';

export interface RestockFlagActor {
  uid: string;
  name: string;
}

// TeamTaskStatus is 'backlog' | 'this_cycle' | 'in_progress' | 'blocked' | 'done'.
// "Open" = everything but 'done'. Firestore `!=` doesn't compose cleanly with
// the other equality filter here, so enumerate the open set for a `where(...,
// 'in', ...)` query instead — same shape as the de-dupe query in
// `addToBuyList` (app/lib/buy-list.ts:49).
const OPEN_TEAM_TASK_STATUSES = ['backlog', 'this_cycle', 'in_progress', 'blocked'];

/**
 * Best-effort: flag a statpack's shortages to the logistics team.
 * NEVER throws — every channel is independently try/caught. Callers invoke this
 * AFTER their transaction commits, so a flag failure can never roll back a check-in.
 */
export async function flagStatpackRestock(
  pack: Pick<Statpack, 'id' | 'name' | 'contents'>,
  actor: RestockFlagActor,
): Promise<void> {
  const shortages = getPackShortages(pack);
  if (shortages.total === 0) return;

  const allShortages = [...shortages.out, ...shortages.low];

  // Channel 1: team_tasks card — the live logistics queue. (The `tasks`
  // collection is dead; `/tasks` is a redirect stub to `/committee-board`,
  // which reads/writes `team_tasks`.) De-duplicated against any already-open
  // card linked to this pack so a chronically short pack doesn't spawn a new
  // card on every check-in — instead its subtasks get refreshed in place.
  try {
    const teamTasksRef = collection(db, 'team_tasks');
    const subtasks = allShortages.map((s) => ({
      // Deterministic, stable per item so re-running this update doesn't churn ids.
      id: s.itemId,
      text: formatShortage(s),
      done: false,
    }));

    const existingSnap = await getDocs(
      query(
        teamTasksRef,
        where('linkedStatpackId', '==', pack.id),
        where('status', 'in', OPEN_TEAM_TASK_STATUSES),
      ),
    );

    if (!existingSnap.empty) {
      await updateDoc(doc(db, 'team_tasks', existingSnap.docs[0].id), { subtasks });
    } else {
      await addDoc(teamTasksRef, {
        title: `Restock ${pack.name}`,
        definitionOfDone: 'All pack contents back to par quantity.',
        // Deliberately unassigned. The Committee Board's own creation form
        // requires an owner, but that's form validation on that screen, not a
        // data invariant on the collection — confirmed with the user. Leaving
        // this empty is intentional so the card reads as unclaimed until a
        // person picks it up; do not "fix" this to auto-assign someone.
        owners: [],
        status: 'backlog',
        subtasks,
        updates: [],
        dueDate: null,
        linkedStatpackId: pack.id,
        createdBy: actor.uid,
        createdByName: actor.name,
        createdAt: serverTimestamp(),
      });
    }
  } catch (e) {
    console.error('flagStatpackRestock: team_tasks write failed:', e);
  }

  // Channel 2: in-app notification, admin/quartermaster ONLY. This
  // deliberately differs from the similar manager broadcast in
  // app/lib/events.ts (~line 300), which also includes 'medops' — medops is
  // event/roster staffing, not logistics. Per decisions.md D-13, medops is a
  // reduced-admin role that must never see logistics surfaces, so it is
  // excluded here on purpose; this is not an oversight.
  try {
    const recipientsSnap = await getDocs(
      query(collection(db, 'users'), where('role', 'in', ['admin', 'quartermaster'])),
    );
    const recipientIds = recipientsSnap.docs.map((d) => d.id);

    const shownNames = allShortages.slice(0, 3).map(formatShortage).join(', ');
    const remaining = allShortages.length - 3;
    const body = `${pack.name} checked in short: ${shownNames}${remaining > 0 ? `, +${remaining} more` : ''}.`;

    await broadcastNotification(
      recipientIds,
      {
        type: 'broadcast',
        title: `Restock needed: ${pack.name}`,
        body,
        link: '/statpacks/' + pack.id,
      },
      actor,
    );
  } catch (e) {
    console.error('flagStatpackRestock: notification failed:', e);
  }
}
