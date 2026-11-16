/**
 * Best-effort flagging of a statpack's shortages to the logistics team.
 *
 * Context: the check-in fast path (docs/statpack-checkin-fast-path.md,
 * "Flagging the logistics team") assumes the crew did NOT restock — so the
 * pack's shortage must reach logistics on its own, without anyone remembering
 * to look. This fires two independent channels after the check-in
 * transaction has already committed: a `team_tasks` card (every short
 * check-in) and an in-app admin/QM notification (ONLY when a shortage is a
 * critical item — AED, oxygen, epinephrine; see statpack-critical.ts).
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
import { createReport } from '@/app/lib/reports';
import { isCriticalStatpackItem } from '@/app/lib/statpack-critical';

export interface RestockFlagActor {
  uid: string;
  name: string;
}

// TeamTaskStatus is 'backlog' | 'this_cycle' | 'in_progress' | 'blocked' | 'done'.
// "Open" = everything but 'done'. Firestore `!=` doesn't compose cleanly with
// the other equality filter here, so enumerate the open set for a `where(...,
// 'in', ...)` query instead — same shape as the de-dupe query in
// `addToBuyList` (app/lib/buy-list.ts:49).
export const OPEN_TEAM_TASK_STATUSES = ['backlog', 'this_cycle', 'in_progress', 'blocked'];

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

  // Channel 1: team_tasks card (see upsertRestockTask).
  await upsertRestockTask(
    pack,
    allShortages.map((x) => ({ id: x.itemId, text: formatShortage(x) })),
    actor,
    'flagStatpackRestock',
  );

  // Channel 2: in-app notification, admin/quartermaster ONLY. This
  // deliberately differs from the similar manager broadcast in
  // app/lib/events.ts (~line 300), which also includes 'medops' — medops is
  // event/roster staffing, not logistics. Per decisions.md D-13, medops is a
  // reduced-admin role that must never see logistics surfaces, so it is
  // excluded here on purpose; this is not an oversight.
  const criticalIds = new Set(
    (pack.contents ?? []).filter(isCriticalStatpackItem).map((c) => c.itemId),
  );
  const criticalShortages = allShortages.filter((x) => criticalIds.has(x.itemId));
  if (criticalShortages.length === 0) return;
  try {
    const recipientIds = await getAdminRecipientIds();

    const shownNames = criticalShortages.slice(0, 3).map(formatShortage).join(', ');
    const remaining = criticalShortages.length - 3;
    const body = `${pack.name} checked in short: ${shownNames}${remaining > 0 ? `, +${remaining} more` : ''}.`;

    await broadcastNotification(
      recipientIds,
      {
        type: 'broadcast',
        title: `Critical item short: ${pack.name}`,
        body,
        link: `/statpacks/check-off?id=${pack.id}&mode=audit`,
      },
      actor,
    );
  } catch (e) {
    console.error('flagStatpackRestock: notification failed:', e);
  }
}

export async function getAdminRecipientIds(): Promise<string[]> {
  const recipientsSnap = await getDocs(
    query(collection(db, 'users'), where('role', 'in', ['admin', 'quartermaster'])),
  );
  return recipientsSnap.docs.map((d) => d.id);
}

/**
 * De-duplicated restock card: reuses any already-open `team_tasks` card linked
 * to the pack (refreshing its subtasks) or creates a new one. Never throws.
 */
async function upsertRestockTask(
  pack: Pick<Statpack, 'id' | 'name'>,
  items: { id: string; text: string }[],
  actor: RestockFlagActor,
  caller: string,
): Promise<void> {
  // team_tasks card — the live logistics queue. (The `tasks`
  // collection is dead; `/tasks` is a redirect stub to `/committee-board`,
  // which reads/writes `team_tasks`.) De-duplicated against any already-open
  // card linked to this pack so a chronically short pack doesn't spawn a new
  // card on every check-in — instead its subtasks get refreshed in place.
  try {
    const teamTasksRef = collection(db, 'team_tasks');
    const subtasks = items.map((s) => ({
      // Deterministic, stable per item so re-running this update doesn't churn ids.
      id: s.id,
      text: s.text,
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
    console.error(`${caller}: team_tasks write failed:`, e);
  }
}

export interface UnfillableItem {
  itemId: string;
  itemName: string;
  problem: 'short' | 'expired' | 'low_psi' | 'check_failed';
  /** Plain-language detail, e.g. "1 of 2 on hand", "expired Mar 2026", "reads 900 psi". */
  detail: string;
  critical: boolean;
}

/**
 * Best-effort: a member could not fill a pack at checkout (blocked). Files one
 * issue report per item, refreshes the restock card, and notifies admin/QM only
 * if any item is critical. NEVER throws and never changes the pack's status.
 */
export async function flagUnfillablePack(
  pack: Pick<Statpack, 'id' | 'name'>,
  items: UnfillableItem[],
  actor: RestockFlagActor,
): Promise<{ reportFailures: number }> {
  let reportFailures = 0;
  try {
    if (items.length === 0) return { reportFailures };

    await Promise.all(items.map(async (it) => {
      try {
        await createReport({
          reporter: { userId: actor.uid, userName: actor.name },
          type: 'bug',
          priority: it.critical ? 'high' : 'medium',
          title: `Can't fill at checkout: ${it.itemName} (in ${pack.name})`,
          description:
            `${actor.name} could not check out "${pack.name}" because ${it.itemName} is not ready: ${it.detail} (${it.problem.replace('_', ' ')}).`,
          pagePath: '/statpacks/check-off',
          component: 'statpack_checkoff',
          target: { collection: 'statpacks', docId: pack.id },
        });
      } catch (e) {
        reportFailures++;
        console.warn('flagUnfillablePack: failed to create issue report for', it.itemId, e);
      }
    }));

    await upsertRestockTask(
      pack,
      items.map((it) => ({ id: `${it.itemId}:${it.problem}`, text: `${it.itemName}: ${it.detail}` })),
      actor,
      'flagUnfillablePack',
    );

    const critical = items.filter((it) => it.critical);
    if (critical.length > 0) {
      try {
        const recipientIds = await getAdminRecipientIds();
        const shown = critical.slice(0, 3).map((it) => `${it.itemName} (${it.detail})`).join(', ');
        const more = critical.length - 3;
        await broadcastNotification(
          recipientIds,
          {
            type: 'broadcast',
            title: `Critical item blocked checkout: ${pack.name}`,
            body: `${pack.name} could not go out: ${shown}${more > 0 ? `, +${more} more` : ''}.`,
            link: '/reports',
          },
          actor,
        );
      } catch (e) {
        console.error('flagUnfillablePack: notification failed:', e);
      }
    }
  } catch (e) {
    console.error('flagUnfillablePack failed:', e);
  }
  return { reportFailures };
}
