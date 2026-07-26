import { addDoc, collection, serverTimestamp, doc, WriteBatch, DocumentData, Timestamp } from 'firebase/firestore';
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

export function deepRemoveUndefined<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) {
    // Clean array elements and remove undefined entries
    const arr = (obj as unknown as any[])
      .map((v) => deepRemoveUndefined(v))
      .filter((v) => v !== undefined);
    return arr as unknown as T;
  }
  if (typeof obj === 'object') {
    // Preserve Date instances as-is
    if (obj instanceof Date) return obj;
    // Preserve Firestore Timestamp instances — recursing rebuilds them into a
    // plain {seconds,nanoseconds} map that Firestore stores as data, not a
    // timestamp (silently breaks date reads; see events createEvent).
    if (obj instanceof Timestamp) return obj;
    // Preserve Firestore FieldValue sentinels (serverTimestamp, increment, etc.)
    // They have an internal _methodName property – never destructure them.
    if ('_methodName' in (obj as any)) return obj;
    const out: any = {};
    for (const [k, v] of Object.entries(obj as any)) {
      if (v === undefined) continue;
      if (v === null) {
        out[k] = null;
        continue;
      }
      if (typeof v === 'object') out[k] = deepRemoveUndefined(v);
      else out[k] = v;
    }
    return out as T;
  }
  return obj;
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

const audit = { recordAuditEvent, addAuditEventToBatch, removeUndefined, deepRemoveUndefined };
export default audit;
