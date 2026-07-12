'use client';

import { useState, useEffect } from 'react';
import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  Timestamp,
} from 'firebase/firestore';
import { db } from '@/firebase';
import type { Vehicle, VehicleLog } from '@/app/types';

/** Firestore returns Timestamp objects; normalize to Date once so pages never see raw Timestamps. */
function toDate(value: unknown): Date | null {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  return null;
}

function hydrateVehicle(id: string, raw: Record<string, unknown>): Vehicle {
  return {
    ...raw,
    id,
    checkedOutAt: toDate(raw.checkedOutAt),
    createdAt: toDate(raw.createdAt) ?? undefined,
    updatedAt: toDate(raw.updatedAt) ?? undefined,
    retiredAt: toDate(raw.retiredAt),
  } as Vehicle;
}

function hydrateVehicleLog(id: string, raw: Record<string, unknown>): VehicleLog {
  return {
    ...raw,
    id,
    // Prefer the resolved server timestamp; fall back to the client stamp so a
    // just-written log renders immediately (StatpackLog clientTimestamp pattern).
    checkoutAt: toDate(raw.checkoutAt) ?? toDate(raw.checkoutClientAt) ?? new Date(),
    checkoutClientAt: toDate(raw.checkoutClientAt) ?? undefined,
    checkinAt: toDate(raw.checkinAt) ?? toDate(raw.checkinClientAt),
    checkinClientAt: toDate(raw.checkinClientAt),
  } as VehicleLog;
}

/** Real-time subscription to the whole vehicle roster (active + retired). */
export function useVehicles(): { vehicles: Vehicle[]; loading: boolean } {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, 'vehicles'), orderBy('name'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setVehicles(snap.docs.map((d) => hydrateVehicle(d.id, d.data())));
        setLoading(false);
      },
      (e) => {
        console.error('[useVehicles] listener error', e);
        setLoading(false);
      },
    );
    return () => unsub();
  }, []);

  return { vehicles, loading };
}

/**
 * Real-time subscription to shift logs, newest checkout first.
 * Pass a vehicleId to scope to one vehicle's history.
 */
export function useVehicleLogs(vehicleId?: string): { logs: VehicleLog[]; loading: boolean } {
  // Keyed by the vehicleId the snapshot answered for, so switching vehicles
  // reads as loading again without a synchronous setState inside the effect.
  const [result, setResult] = useState<{ key: string; logs: VehicleLog[] } | null>(null);
  const key = vehicleId ?? '__all__';

  useEffect(() => {
    const base = collection(db, 'vehicle_logs');
    const q = vehicleId
      ? query(base, where('vehicleId', '==', vehicleId), orderBy('checkoutAt', 'desc'))
      : query(base, orderBy('checkoutAt', 'desc'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setResult({ key: vehicleId ?? '__all__', logs: snap.docs.map((d) => hydrateVehicleLog(d.id, d.data())) });
      },
      (e) => {
        console.error('[useVehicleLogs] listener error', e);
        setResult({ key: vehicleId ?? '__all__', logs: [] });
      },
    );
    return () => unsub();
  }, [vehicleId]);

  const fresh = result !== null && result.key === key;
  return { logs: fresh ? result.logs : [], loading: !fresh };
}
