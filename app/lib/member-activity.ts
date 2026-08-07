import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '@/firebase';

export interface MemberActivityEntry {
  at: Date;
  kind: 'statpack' | 'audit' | 'inventory' | 'shift' | 'report';
  title: string;   // e.g. "Checked out Trauma Pack A"
  detail?: string; // e.g. event name, item name, status
}

/**
 * Best-effort coercion of a Firestore value into a JS Date. Handles
 * Firestore `Timestamp` instances, legacy `{seconds,nanoseconds}` maps, and
 * plain `Date`s. Returns null when the value can't be parsed (caller should
 * skip the doc rather than show a garbage date).
 */
function toDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'object' && v !== null && 'toDate' in v && typeof (v as { toDate: unknown }).toDate === 'function') {
    const d = (v as { toDate(): Date }).toDate();
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'object' && v !== null && 'seconds' in v) {
    const seconds = (v as { seconds: number }).seconds;
    const nanoseconds = (v as { nanoseconds?: number }).nanoseconds ?? 0;
    if (typeof seconds === 'number') {
      const d = new Date(seconds * 1000 + nanoseconds / 1e6);
      return isNaN(d.getTime()) ? null : d;
    }
  }
  const d = new Date(v as string | number);
  return isNaN(d.getTime()) ? null : d;
}

const STATPACK_ACTION_LABELS: Record<string, string> = {
  checkout: 'Checked out',
  checkin: 'Checked in',
  audit: 'Audited',
  restock: 'Restocked',
  created: 'Created',
  maintenance: 'Serviced',
  content_edit: 'Edited contents of',
};

function humanize(raw: string): string {
  return raw.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

const AUDIT_EVENT_LABELS: Record<string, string> = {
  item_issue_reported: 'Reported an issue',
  item_counted: 'Counted an item',
  item_moved: 'Moved an item',
  item_shipment_received: 'Logged a shipment',
  item_fixed: 'Fixed an item',
};

async function fetchStatpackActivity(userId: string): Promise<MemberActivityEntry[]> {
  const entries: MemberActivityEntry[] = [];
  try {
    const snap = await getDocs(query(collection(db, 'statpack_logs'), where('userId', '==', userId)));
    for (const d of snap.docs) {
      const data = d.data() as Record<string, unknown>;
      const at = toDate(data.timestamp);
      if (!at) continue;
      const action = String(data.action ?? '');
      const packName = typeof data.statpackName === 'string' ? data.statpackName : 'a pack';
      const verb = STATPACK_ACTION_LABELS[action] ?? humanize(action || 'Logged');
      entries.push({
        at,
        kind: 'statpack',
        title: `${verb} ${packName}`,
        detail: typeof data.eventName === 'string' ? data.eventName : undefined,
      });
    }
  } catch (error) {
    console.error('getMemberActivity: failed to load statpack_logs', error);
  }
  return entries;
}

async function fetchAuditActivity(userId: string): Promise<MemberActivityEntry[]> {
  const entries: MemberActivityEntry[] = [];
  try {
    const snap = await getDocs(query(collection(db, 'auditEvents'), where('actor.userId', '==', userId)));
    for (const d of snap.docs) {
      const data = d.data() as Record<string, unknown>;
      const at = toDate(data.timestamp);
      if (!at) continue;
      const eventType = String(data.eventType ?? '');
      entries.push({
        at,
        kind: 'audit',
        title: AUDIT_EVENT_LABELS[eventType] ?? humanize(eventType || 'Audit event'),
      });
    }
  } catch (error) {
    console.error('getMemberActivity: failed to load auditEvents', error);
  }
  return entries;
}

async function fetchInventoryActivity(userId: string): Promise<MemberActivityEntry[]> {
  const entries: MemberActivityEntry[] = [];
  try {
    const snap = await getDocs(query(collection(db, 'inventory_logs'), where('userId', '==', userId)));
    for (const d of snap.docs) {
      const data = d.data() as Record<string, unknown>;
      const at = toDate(data.timestamp);
      if (!at) continue;
      const action = String(data.action ?? '');
      const itemName = typeof data.itemName === 'string' ? data.itemName : undefined;
      entries.push({
        at,
        kind: 'inventory',
        title: itemName ? `${humanize(action || 'Logged')} ${itemName}` : humanize(action || 'Inventory activity'),
        detail: typeof data.notes === 'string' ? data.notes : undefined,
      });
    }
  } catch (error) {
    console.error('getMemberActivity: failed to load inventory_logs', error);
  }
  return entries;
}

async function fetchShiftActivity(userId: string): Promise<MemberActivityEntry[]> {
  const entries: MemberActivityEntry[] = [];
  try {
    const snap = await getDocs(query(collection(db, 'shift_requests'), where('userId', '==', userId)));
    for (const d of snap.docs) {
      const data = d.data() as Record<string, unknown>;
      const at = toDate(data.requestedAt);
      if (!at) continue;
      const eventName = typeof data.eventName === 'string' ? data.eventName : undefined;
      entries.push({
        at,
        kind: 'shift',
        title: eventName ? `Signed up for ${eventName}` : 'Signed up for a shift',
        detail: typeof data.status === 'string' ? data.status : undefined,
      });
    }
  } catch (error) {
    console.error('getMemberActivity: failed to load shift_requests', error);
  }
  return entries;
}

async function fetchReportActivity(userId: string): Promise<MemberActivityEntry[]> {
  const entries: MemberActivityEntry[] = [];
  try {
    const snap = await getDocs(query(collection(db, 'issue_reports'), where('reporter.userId', '==', userId)));
    for (const d of snap.docs) {
      const data = d.data() as Record<string, unknown>;
      const at = toDate(data.createdAt);
      if (!at) continue;
      entries.push({
        at,
        kind: 'report',
        title: typeof data.title === 'string' ? data.title : 'Filed an issue report',
        detail: typeof data.status === 'string' ? data.status : undefined,
      });
    }
  } catch (error) {
    console.error('getMemberActivity: failed to load issue_reports', error);
  }
  return entries;
}

/**
 * Aggregates one member's recent activity across statpack logs, audit
 * events, inventory logs, shift requests, and issue reports into a single
 * time-sorted feed (newest first). Each source is fetched independently so a
 * failing/permission-denied source doesn't blank the whole feed.
 */
export async function getMemberActivity(userId: string, max = 60): Promise<MemberActivityEntry[]> {
  const results = await Promise.all([
    fetchStatpackActivity(userId),
    fetchAuditActivity(userId),
    fetchInventoryActivity(userId),
    fetchShiftActivity(userId),
    fetchReportActivity(userId),
  ]);

  return results
    .flat()
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, max);
}
