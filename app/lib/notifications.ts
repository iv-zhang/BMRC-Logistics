'use client';

/**
 * In-app notifications (`notifications` collection). One doc per recipient —
 * a broadcast fans out to N docs so each member's unread state is independent.
 * There is no email/push layer; this is purely the in-app bell + dashboard feed.
 */

import {
  collection,
  addDoc,
  doc,
  updateDoc,
  writeBatch,
  query,
  where,
  orderBy,
  limit as fsLimit,
  onSnapshot,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '@/firebase';
import type { AppNotification, NotificationType } from '@/app/types';

export interface NotifyActor {
  uid: string;
  name: string;
}

interface NotificationInput {
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
}

function cleanDoc(userId: string, input: NotificationInput, actor?: NotifyActor) {
  const base: Record<string, unknown> = {
    userId,
    type: input.type,
    title: input.title,
    read: false,
    createdAt: serverTimestamp(),
  };
  if (input.body) base.body = input.body;
  if (input.link) base.link = input.link;
  if (actor) base.createdBy = actor.name;
  return base;
}

/** Send one notification to one user. */
export async function createNotification(
  userId: string,
  input: NotificationInput,
  actor?: NotifyActor,
): Promise<void> {
  await addDoc(collection(db, 'notifications'), cleanDoc(userId, input, actor));
}

/**
 * Fan a single notification out to many recipients (batched). Firestore caps a
 * batch at 500 writes, so we chunk. Empty recipient lists are a no-op.
 */
export async function broadcastNotification(
  userIds: string[],
  input: NotificationInput,
  actor?: NotifyActor,
): Promise<number> {
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0) return 0;
  for (let i = 0; i < ids.length; i += 400) {
    const batch = writeBatch(db);
    for (const uid of ids.slice(i, i + 400)) {
      batch.set(doc(collection(db, 'notifications')), cleanDoc(uid, input, actor));
    }
    await batch.commit();
  }
  return ids.length;
}

export async function markNotificationRead(id: string): Promise<void> {
  await updateDoc(doc(db, 'notifications', id), { read: true });
}

/** Mark a set of the user's notifications read (e.g. "mark all read"). */
export async function markAllRead(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  for (let i = 0; i < ids.length; i += 400) {
    const batch = writeBatch(db);
    for (const id of ids.slice(i, i + 400)) {
      batch.update(doc(db, 'notifications', id), { read: true });
    }
    await batch.commit();
  }
}

/**
 * Subscribe to a user's most recent notifications (newest first). Returns the
 * unsubscribe fn. Callers derive the unread count from `read === false`.
 */
export function subscribeUserNotifications(
  userId: string,
  cb: (items: AppNotification[]) => void,
  max = 30,
): () => void {
  const q = query(
    collection(db, 'notifications'),
    where('userId', '==', userId),
    orderBy('createdAt', 'desc'),
    fsLimit(max),
  );
  return onSnapshot(
    q,
    (snap) => {
      cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as AppNotification) })));
    },
    (err) => {
      console.error('notifications subscription error:', err);
      cb([]);
    },
  );
}
