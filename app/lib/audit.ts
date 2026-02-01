import { addDoc, collection, serverTimestamp, doc, WriteBatch, DocumentData } from 'firebase/firestore';
import { db } from '@/firebase';

export type AuditEvent = {
  eventType: string;
  source?: string;
  sourceId?: string;
  actor?: {
    userId?: string | null;
    userName?: string | null;
    userEmail?: string | null;
    role?: string | null;
  };
  timestamp?: unknown;
  targets?: Array<{ collection: string; docId: string; fieldPath?: string }>;
  before?: unknown;
  after?: unknown;
  delta?: unknown;
  details?: unknown;
  relatedLogs?: unknown[];
};

/**
 * Record an audit event to `auditEvents` collection.
 * Adds a serverTimestamp if none provided.
 */
export async function recordAuditEvent(event: Partial<AuditEvent>) {
  const payload: Partial<AuditEvent> = { ...event };
  if (!payload.timestamp) payload.timestamp = serverTimestamp();
  return await addDoc(collection(db, 'auditEvents'), payload as DocumentData);
}

export function removeUndefined<T extends Record<string, unknown>>(obj: T): T {
  const cleaned = { ...obj } as T;
  (Object.keys(cleaned) as Array<keyof T>).forEach((k) => {
    if (cleaned[k] === undefined) {
      delete (cleaned as Partial<T>)[k];
    }
  });
  return cleaned;
}

/**
 * Add an audit event to an existing WriteBatch.
 * Returns the DocumentReference created so callers can reference it elsewhere in the batch.
 */
export function addAuditEventToBatch(batch: WriteBatch, event: Partial<AuditEvent>) {
  const ref = doc(collection(db, 'auditEvents'));
  const payload: Partial<AuditEvent> = { ...event };
  if (!payload.timestamp) payload.timestamp = serverTimestamp();
  batch.set(ref, payload as DocumentData);
  return ref;
}

const audit = { recordAuditEvent, addAuditEventToBatch, removeUndefined };
export default audit;
