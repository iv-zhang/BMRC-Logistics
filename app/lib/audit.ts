import { addDoc, collection, serverTimestamp, doc, WriteBatch } from 'firebase/firestore';
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
  timestamp?: any;
  targets?: Array<{ collection: string; docId: string; fieldPath?: string }>;
  before?: any;
  after?: any;
  delta?: any;
  details?: any;
  relatedLogs?: any[];
};

/**
 * Record an audit event to `auditEvents` collection.
 * Adds a serverTimestamp if none provided.
 */
export async function recordAuditEvent(event: Partial<AuditEvent>) {
  const payload: any = { ...event };
  if (!payload.timestamp) payload.timestamp = serverTimestamp();
  return await addDoc(collection(db, 'auditEvents'), payload);
}

/**
 * Add an audit event to an existing WriteBatch.
 * Returns the DocumentReference created so callers can reference it elsewhere in the batch.
 */
export function addAuditEventToBatch(batch: WriteBatch, event: Partial<AuditEvent>) {
  const ref = doc(collection(db, 'auditEvents'));
  const payload: any = { ...event };
  if (!payload.timestamp) payload.timestamp = serverTimestamp();
  batch.set(ref, payload);
  return ref;
}

export default { recordAuditEvent, addAuditEventToBatch };
