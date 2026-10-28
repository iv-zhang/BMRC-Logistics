import { Timestamp } from 'firebase/firestore';

/** Normalize Firestore dates, including timestamp maps left by old JSON-cloned writes. */
export function coerceTimestamp(value: unknown): Timestamp | undefined {
  if (value instanceof Timestamp) return value;

  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const map = value as Record<string, unknown>;
    const seconds = typeof map.seconds === 'number' ? map.seconds : map._seconds;
    const nanoseconds = typeof map.nanoseconds === 'number' ? map.nanoseconds : map._nanoseconds ?? 0;
    if (typeof seconds === 'number') {
      if (!Number.isInteger(seconds) || typeof nanoseconds !== 'number' ||
          !Number.isInteger(nanoseconds) || nanoseconds < 0 || nanoseconds >= 1_000_000_000) return undefined;
      try {
        return new Timestamp(seconds, nanoseconds);
      } catch {
        return undefined;
      }
    }

    // Keep accepting Timestamp-like values from other Firebase SDK instances.
    if (typeof map.toDate === 'function') {
      try {
        const date = (map.toDate as () => unknown).call(value);
        if (date instanceof Date && Number.isFinite(date.getTime())) return Timestamp.fromDate(date);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  const date = value instanceof Date ? value
    : typeof value === 'string' || typeof value === 'number' ? new Date(value) : undefined;
  if (!date || !Number.isFinite(date.getTime())) return undefined;
  try {
    return Timestamp.fromDate(date);
  } catch {
    return undefined;
  }
}

/** Return a valid Date, or undefined for missing, invalid, or sentinel values. */
export function coerceDate(value: unknown): Date | undefined {
  const date = coerceTimestamp(value)?.toDate();
  return date && Number.isFinite(date.getTime()) ? date : undefined;
}
