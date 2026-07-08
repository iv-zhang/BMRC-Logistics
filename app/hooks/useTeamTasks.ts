'use client';

import { useState, useEffect } from 'react';
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  Timestamp,
} from 'firebase/firestore';
import { db } from '@/firebase';
import type { TeamTask, TeamTaskOwner, TeamTaskUpdate, TeamSubtask } from '@/app/types';

export interface UseTeamTasksReturn {
  /** All committee tasks, newest first */
  tasks: TeamTask[];
  /** Whether data is still loading from Firestore */
  loading: boolean;
}

/** Firestore returns Timestamp objects; normalize to Date once so pages never see raw Timestamps. */
function toDate(value: unknown): Date | null {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  return null;
}

/**
 * Owners are stored as `owners: TeamTaskOwner[]`, but legacy docs only have the
 * single `ownerId`/`ownerName` pair. Normalize both shapes so the board always
 * renders a non-empty owners array.
 */
function normalizeOwners(raw: Record<string, unknown>): TeamTaskOwner[] {
  const owners = raw.owners;
  if (Array.isArray(owners) && owners.length > 0) {
    return owners
      .filter((o): o is TeamTaskOwner => !!o && typeof (o as TeamTaskOwner).id === 'string')
      .map((o) => ({ id: o.id, name: o.name ?? '' }));
  }
  if (typeof raw.ownerId === 'string' && raw.ownerId) {
    return [{ id: raw.ownerId, name: (raw.ownerName as string) ?? '' }];
  }
  return [];
}

/** Normalize embedded update timestamps (client-written via Timestamp.now()) to Date. */
function normalizeUpdates(raw: unknown): TeamTaskUpdate[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((u): u is TeamTaskUpdate => !!u && typeof (u as TeamTaskUpdate).id === 'string')
    .map((u) => ({ ...u, createdAt: toDate(u.createdAt) ?? new Date() }));
}

function normalizeSubtasks(raw: unknown): TeamSubtask[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is TeamSubtask => !!s && typeof (s as TeamSubtask).id === 'string');
}

/**
 * Shared hook that provides real-time access to the Logistics Committee
 * task board (`team_tasks`) from Firestore.
 *
 * Uses an onSnapshot listener so the board stays up-to-date when another
 * committee member edits it in a different tab/session.
 */
export function useTeamTasks(): UseTeamTasksReturn {
  const [tasks, setTasks] = useState<TeamTask[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, 'team_tasks'), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setTasks(
          snap.docs.map((d) => {
            const raw = d.data();
            return {
              ...raw,
              id: d.id,
              owners: normalizeOwners(raw),
              updates: normalizeUpdates(raw.updates),
              subtasks: normalizeSubtasks(raw.subtasks),
              dueDate: toDate(raw.dueDate),
              createdAt: toDate(raw.createdAt) ?? new Date(),
              completedAt: toDate(raw.completedAt),
            } as TeamTask;
          })
        );
        setLoading(false);
      },
      (e) => {
        console.error('[useTeamTasks] listener error', e);
        setLoading(false); // still resolve so the page doesn't spin forever
      }
    );
    return () => unsub();
  }, []);

  return { tasks, loading };
}
