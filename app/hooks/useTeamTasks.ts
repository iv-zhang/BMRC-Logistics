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
import type { TeamTask } from '@/app/types';

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
