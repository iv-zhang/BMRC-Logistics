import { Timestamp } from 'firebase/firestore';
import type { StatpackLog } from '@/app/types';

const normalizeAction = (raw: unknown): string | undefined => {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).toLowerCase().trim();
  if (!s) return undefined;
  if (['checkin', 'check-in', 'check in'].includes(s)) return 'checkin';
  if (['checkout', 'check-out', 'check out'].includes(s)) return 'checkout';
  if (['maintenance', 'maint'].includes(s)) return 'maintenance';
  if (['restock'].includes(s)) return 'restock';
  return s;
};

export type StatpackLogWithId = StatpackLog & { id: string; timestamp: Date | null };

export type StatpackLogDisplayItem =
  | {
      kind: 'pair';
      pairId: string;
      checkout?: StatpackLogWithId;
      checkin?: StatpackLogWithId;
      logs: StatpackLogWithId[];
      sortTime: Date;
    }
  | {
      kind: 'single';
      log: StatpackLogWithId;
      sortTime: Date;
    };

export const normalizeTimestamp = (value: unknown, fallback?: unknown): Date | null => {
  if (!value) {
    // Try fallback (e.g., clientTimestamp) when primary value is null/undefined
    if (fallback) return normalizeTimestamp(fallback);
    return null;
  }
  if (value instanceof Date) return value;
  if (value instanceof Timestamp) return value.toDate();
  
  const obj = value as { toDate?: () => Date; _methodName?: string; seconds?: number; nanoseconds?: number };
  // Handle Firestore serverTimestamp() sentinel that wasn't resolved on write
  if (obj._methodName === 'serverTimestamp') {
    console.warn('[normalizeTimestamp] Detected unresolved serverTimestamp sentinel in Firestore document; returning null. This indicates a data integrity issue.');
    // Fall back to clientTimestamp if available
    if (fallback) return normalizeTimestamp(fallback);
    return null;
  }
  
  if (typeof obj.toDate === 'function') return obj.toDate();

  // Handle raw Firestore timestamp-like objects { seconds, nanoseconds }
  if (typeof obj.seconds === 'number') {
    return new Date(obj.seconds * 1000 + (obj.nanoseconds || 0) / 1e6);
  }

  // Handle ISO string dates
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!isNaN(parsed.getTime())) return parsed;
  }

  // Handle numeric timestamps (milliseconds)
  if (typeof value === 'number') {
    return new Date(value);
  }

  return null;
};

export const formatTimestamp = (date: Date | null) => {
  if (!date) return '—';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
};

export const pairStatpackLogs = (logs: StatpackLogWithId[]): StatpackLogDisplayItem[] => {
  if (!logs || logs.length === 0) return [];

  const normalized: StatpackLogWithId[] = logs.map((log) => ({
    ...log,
    action: normalizeAction((log as unknown as Record<string, unknown>).action) || (log as unknown as Record<string, unknown>).action,
    timestamp: normalizeTimestamp(log.timestamp, (log as unknown as Record<string, unknown>).clientTimestamp) ?? null,
  } as StatpackLogWithId));

  const byPairId = new Map<string, StatpackLogWithId[]>();
  const noPair: StatpackLogWithId[] = [];

  normalized.forEach((log) => {
    if (log.pairId) {
      const list = byPairId.get(log.pairId) || [];
      list.push(log);
      byPairId.set(log.pairId, list);
    } else {
      noPair.push(log);
    }
  });

  const items: StatpackLogDisplayItem[] = [];

  for (const [pairId, group] of byPairId.entries()) {
    const sorted = [...group].sort((a, b) => (a.timestamp?.getTime() || 0) - (b.timestamp?.getTime() || 0));
    const checkout = sorted.find((log) => log.action === 'checkout');
    const checkin = [...sorted].reverse().find((log) => log.action === 'checkin');
    const sortTime = (checkin?.timestamp ?? checkout?.timestamp ?? sorted[sorted.length - 1]?.timestamp) ?? new Date(0);
    items.push({ kind: 'pair', pairId, checkout, checkin, logs: sorted, sortTime });
  }

  const withoutPair = [...noPair].sort((a, b) => (a.timestamp?.getTime() || 0) - (b.timestamp?.getTime() || 0));
  const pendingCheckouts: StatpackLogWithId[] = [];

  for (const log of withoutPair) {
    if (log.action === 'checkout') {
      pendingCheckouts.push(log);
      continue;
    }

    if (log.action === 'checkin') {
      const checkout = pendingCheckouts.pop();
      if (checkout) {
        const pairId = `legacy-${checkout.id}-${log.id}`;
        const sortTime = log.timestamp ?? checkout.timestamp ?? null;
        items.push({ kind: 'pair', pairId, checkout, checkin: log, logs: [checkout, log], sortTime: sortTime ?? new Date(0) });
      } else {
        items.push({ kind: 'single', log, sortTime: log.timestamp ?? new Date(0) });
      }
      continue;
    }

    items.push({ kind: 'single', log, sortTime: log.timestamp });
  }

  for (const remaining of pendingCheckouts) {
    items.push({ kind: 'single', log: remaining, sortTime: remaining.timestamp ?? new Date(0) });
  }

  return items.sort((a, b) => (b.sortTime?.getTime() || 0) - (a.sortTime?.getTime() || 0));
};

export const getLatestCheckStatus = (logs: StatpackLogWithId[]) => {
  const normalized: StatpackLogWithId[] = logs.map((log) => ({
    ...log,
    action: normalizeAction((log as unknown as Record<string, unknown>).action) || (log as unknown as Record<string, unknown>).action,
    timestamp: normalizeTimestamp(log.timestamp, (log as unknown as Record<string, unknown>).clientTimestamp) ?? null,
  } as StatpackLogWithId));

  const lastCheckout = normalized
    .filter((log) => log.action === 'checkout' && log.timestamp)
    .sort((a, b) => (b.timestamp!.getTime() || 0) - (a.timestamp!.getTime() || 0))[0];

  const lastCheckin = normalized
    .filter((log) => log.action === 'checkin' && log.timestamp)
    .sort((a, b) => (b.timestamp!.getTime() || 0) - (a.timestamp!.getTime() || 0))[0];

  const checkoutTs = lastCheckout?.timestamp ?? null;
  const checkinTs = lastCheckin?.timestamp ?? null;
  const isOut = !!checkoutTs && (!checkinTs || checkoutTs.getTime() > checkinTs.getTime());

  return { lastCheckout: checkoutTs, lastCheckin: checkinTs, isOut };
};

export const formatDuration = (ms: number) => {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 1) return 'just now';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
};

/**
 * Calculate the duration of a checkout/checkin event from paired logs.
 * Returns duration in milliseconds, or null if cannot be calculated.
 */
export const calculateEventDuration = (checkout?: StatpackLogWithId, checkin?: StatpackLogWithId): number | null => {
  if (!checkout?.timestamp || !checkin?.timestamp) return null;
  const diff = checkin.timestamp.getTime() - checkout.timestamp.getTime();
  return diff > 0 ? diff : null;
};

/**
 * Calculate usage rate: items used / items available.
 * Returns a value between 0 and 1, or null if no data.
 */
export const calculateUsageRate = (checkout?: StatpackLogWithId, checkin?: StatpackLogWithId): number | null => {
  if (!checkout?.checkEntries || !checkin?.checkEntries) return null;
  
  const checkoutItems = checkout.checkEntries.length;
  const checkinItems = checkin.checkEntries.length;
  if (checkoutItems === 0) return null;
  
  // Count items where countedQuantity at checkin is less than at checkout (items used)
  let itemsUsed = 0;
  for (const checkoutEntry of checkout.checkEntries) {
    const checkinEntry = checkin.checkEntries.find(e => e.itemId === checkoutEntry.itemId);
    if (!checkinEntry) {
      itemsUsed++; // item missing at checkin = fully used
      continue;
    }
    const checkoutQty = checkoutEntry.countedQuantity ?? checkoutEntry.requiredQuantity ?? 0;
    const checkinQty = checkinEntry.countedQuantity ?? checkinEntry.requiredQuantity ?? 0;
    if (checkinQty < checkoutQty) {
      itemsUsed++;
    }
  }
  
  return itemsUsed / checkoutItems;
};
