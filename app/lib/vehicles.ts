'use client';

/**
 * Vehicle roster + shift-log operations.
 *
 * Individual vehicles live in the `vehicles` collection; each shift is ONE
 * `vehicle_logs` doc created 'open' at checkout (pre-readings) and completed
 * at check-in (post-readings, status 'closed'). `Vehicle.isCheckedOut` is the
 * AUTHORITATIVE checked-out state (statpack pattern); the open log and
 * `activeLogId` mirror it and are always written in the same transaction —
 * a mismatch between them is a bug.
 */

import {
  collection,
  doc,
  addDoc,
  updateDoc,
  getDocs,
  query,
  where,
  limit,
  runTransaction,
  deleteDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '@/firebase';
import type { Vehicle, VehicleLog, VehicleShiftReadings } from '@/app/types';
import { getReadingFieldsForVehicleType } from '@/app/config/org-config';
import { deepRemoveUndefined } from '@/app/lib/audit';
import { createReport } from '@/app/lib/reports';

export interface VehicleActor {
  uid: string;
  name: string;
  role?: string;
}

const isAdminRole = (role?: string) => role === 'admin' || role === 'quartermaster';

/** Map reading-field ids (org-config) to VehicleShiftReadings keys. */
const READING_KEY_BY_FIELD_ID: Record<string, keyof VehicleShiftReadings> = {
  fuel_level: 'fuelLevel',
  mileage: 'mileage',
  battery_level: 'batteryLevel',
};

/** Throw if a required reading for this vehicle type is missing/invalid. */
function assertReadingsComplete(typeId: string, readings: VehicleShiftReadings | undefined, phase: 'checkout' | 'check-in') {
  for (const field of getReadingFieldsForVehicleType(typeId)) {
    if (!field.required) continue;
    const key = READING_KEY_BY_FIELD_ID[field.id];
    if (!key) continue;
    const value = readings?.[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${field.label} is required at ${phase}`);
    }
    if (field.min !== undefined && value < field.min) {
      throw new Error(`${field.label} cannot be below ${field.min}`);
    }
    if (field.max !== undefined && value > field.max) {
      throw new Error(`${field.label} cannot exceed ${field.max}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Roster CRUD
// ---------------------------------------------------------------------------

export async function addVehicle(
  input: { name: string; typeId: string; notes?: string },
  actor: VehicleActor,
) {
  const name = input.name.trim();
  if (!name) throw new Error('Vehicle name is required');
  if (!input.typeId) throw new Error('Vehicle type is required');
  const payload = deepRemoveUndefined({
    name,
    typeId: input.typeId,
    status: 'active',
    notes: input.notes?.trim() || undefined,
    isCheckedOut: false,
    activeLogId: null,
    createdAt: serverTimestamp(),
    createdBy: actor.name,
    updatedAt: serverTimestamp(),
  });
  return addDoc(collection(db, 'vehicles'), payload);
}

export async function updateVehicle(
  vehicleId: string,
  patch: { name?: string; typeId?: string; notes?: string },
) {
  const update: Record<string, unknown> = { updatedAt: serverTimestamp() };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error('Vehicle name is required');
    update.name = name;
  }
  if (patch.typeId !== undefined) update.typeId = patch.typeId;
  if (patch.notes !== undefined) update.notes = patch.notes.trim();
  await updateDoc(doc(db, 'vehicles', vehicleId), update);
}

export async function retireVehicle(vehicleId: string, actor: VehicleActor) {
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(doc(db, 'vehicles', vehicleId));
    if (!snap.exists()) throw new Error('Vehicle not found');
    const vehicle = snap.data() as Vehicle;
    if (vehicle.isCheckedOut) throw new Error('Check the vehicle in before retiring it');
    tx.update(doc(db, 'vehicles', vehicleId), {
      status: 'retired',
      retiredAt: serverTimestamp(),
      retiredBy: actor.name,
      updatedAt: serverTimestamp(),
    });
  });
}

export async function reactivateVehicle(vehicleId: string) {
  await updateDoc(doc(db, 'vehicles', vehicleId), {
    status: 'active',
    retiredAt: null,
    retiredBy: null,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Hard delete — allowed ONLY for a vehicle no shift log references (typo
 * cleanup). Anything with history must be retired instead so logs stay
 * readable.
 */
export async function deleteVehicleIfUnused(vehicleId: string) {
  const logs = await getDocs(query(
    collection(db, 'vehicle_logs'),
    where('vehicleId', '==', vehicleId),
    limit(1),
  ));
  if (!logs.empty) {
    throw new Error('This vehicle has shift logs — retire it instead of deleting');
  }
  await deleteDoc(doc(db, 'vehicles', vehicleId));
}

// ---------------------------------------------------------------------------
// Checkout / check-in (one transaction each: log doc + vehicle doc)
// ---------------------------------------------------------------------------

async function fileDamageReport(params: {
  vehicleId: string;
  vehicleName: string;
  phase: 'checkout' | 'checkin';
  damage: string;
  userId: string;
  userName: string;
}) {
  // AFTER the transaction commits, like statpack check-off issue reports —
  // a report failure must never roll back the shift log.
  try {
    await createReport({
      reporter: { userId: params.userId, userName: params.userName },
      type: 'bug',
      priority: 'high',
      title: `Vehicle damage: ${params.vehicleName}`,
      description:
        `New damage reported during vehicle ${params.phase} of "${params.vehicleName}".\n\n${params.damage}`,
      pagePath: '/vehicles/check-off',
      component: 'vehicle_checkoff',
      target: { collection: 'vehicles', docId: params.vehicleId },
    });
  } catch (err) {
    console.warn('vehicles: failed to create damage report for', params.vehicleId, err);
  }
}

export async function checkoutVehicle(params: {
  vehicleId: string;
  userId: string;
  userName: string;
  crewNames?: string[];
  preReadings: VehicleShiftReadings;
  preDamage?: string;
  /** Required when preReadings.mileage differs from the vehicle's lastMileage */
  mileageMismatchAck?: string;
  notes?: string;
}) {
  const { vehicleId, userId, userName, crewNames, preReadings, preDamage, mileageMismatchAck, notes } = params;

  const vehicleRef = doc(db, 'vehicles', vehicleId);
  const newLogRef = doc(collection(db, 'vehicle_logs'));
  const now = new Date();
  let vehicleName = '';

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(vehicleRef);
    if (!snap.exists()) throw new Error('Vehicle not found');
    const vehicle = snap.data() as Vehicle;

    if (vehicle.status !== 'active') throw new Error('This vehicle is retired');
    if (vehicle.isCheckedOut) throw new Error('Vehicle is already checked out');

    assertReadingsComplete(vehicle.typeId, preReadings, 'checkout');

    // Odometer soft check: a mismatch against the previous shift's post
    // reading is legitimate (maintenance runs) but must be acknowledged.
    if (
      typeof preReadings.mileage === 'number' &&
      typeof vehicle.lastMileage === 'number' &&
      preReadings.mileage !== vehicle.lastMileage &&
      !mileageMismatchAck?.trim()
    ) {
      throw new Error(
        `Mileage differs from the last recorded reading (${vehicle.lastMileage}) — add a note acknowledging why`,
      );
    }

    vehicleName = vehicle.name;

    const log = deepRemoveUndefined({
      vehicleId,
      vehicleName: vehicle.name,
      vehicleTypeId: vehicle.typeId,
      status: 'open',
      driverUserId: userId,
      driverName: userName,
      crewNames: (crewNames ?? []).map(n => n.trim()).filter(Boolean),
      preReadings,
      preDamage: preDamage?.trim() || null,
      mileageMismatchAck: mileageMismatchAck?.trim() || null,
      notes: notes?.trim() || undefined,
    }) as Record<string, unknown>;
    log.checkoutAt = serverTimestamp();
    log.checkoutClientAt = now;

    tx.set(newLogRef, log);
    tx.update(vehicleRef, {
      isCheckedOut: true,
      activeLogId: newLogRef.id,
      assignedToUserId: userId,
      assignedToUserName: userName,
      checkedOutAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });

  if (preDamage?.trim()) {
    await fileDamageReport({ vehicleId, vehicleName, phase: 'checkout', damage: preDamage.trim(), userId, userName });
  }

  return { logId: newLogRef.id };
}

export async function checkinVehicle(params: {
  vehicleId: string;
  userId: string;
  userName: string;
  userRole?: string;
  postReadings: VehicleShiftReadings;
  postDamage?: string;
  notes?: string;
}) {
  const { vehicleId, userId, userName, userRole, postReadings, postDamage, notes } = params;

  const vehicleRef = doc(db, 'vehicles', vehicleId);
  const now = new Date();
  let vehicleName = '';

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(vehicleRef);
    if (!snap.exists()) throw new Error('Vehicle not found');
    const vehicle = snap.data() as Vehicle;

    if (!vehicle.isCheckedOut || !vehicle.activeLogId) {
      throw new Error('Vehicle is not checked out');
    }
    if (!isAdminRole(userRole) && vehicle.assignedToUserId && vehicle.assignedToUserId !== userId) {
      throw new Error('Only the driver who checked out this vehicle can check it in');
    }

    const logRef = doc(db, 'vehicle_logs', vehicle.activeLogId);
    const logSnap = await tx.get(logRef);
    if (!logSnap.exists()) throw new Error('Open shift log not found');
    const log = logSnap.data() as VehicleLog;
    if (log.status !== 'open') throw new Error('This shift log is already closed');

    assertReadingsComplete(vehicle.typeId, postReadings, 'check-in');

    // Hard block: the odometer only moves forward within a shift.
    const preMileage = log.preReadings?.mileage;
    if (
      typeof postReadings.mileage === 'number' &&
      typeof preMileage === 'number' &&
      postReadings.mileage < preMileage
    ) {
      throw new Error(`Post-shift mileage (${postReadings.mileage}) cannot be below checkout mileage (${preMileage})`);
    }

    vehicleName = vehicle.name;

    const logUpdate = deepRemoveUndefined({
      status: 'closed',
      checkinUserId: userId,
      checkinUserName: userName,
      postReadings,
      postDamage: postDamage?.trim() || null,
      notes: notes?.trim() || undefined,
    }) as Record<string, unknown>;
    logUpdate.checkinAt = serverTimestamp();
    logUpdate.checkinClientAt = now;

    tx.update(logRef, logUpdate);
    tx.update(vehicleRef, {
      isCheckedOut: false,
      activeLogId: null,
      assignedToUserId: null,
      assignedToUserName: null,
      checkedOutAt: null,
      // Last-known readings denormalize FROM this closed log.
      lastMileage: typeof postReadings.mileage === 'number' ? postReadings.mileage : vehicle.lastMileage ?? null,
      lastFuelLevel: typeof postReadings.fuelLevel === 'number' ? postReadings.fuelLevel : vehicle.lastFuelLevel ?? null,
      lastBatteryLevel: typeof postReadings.batteryLevel === 'number' ? postReadings.batteryLevel : vehicle.lastBatteryLevel ?? null,
      updatedAt: serverTimestamp(),
    });
  });

  if (postDamage?.trim()) {
    await fileDamageReport({ vehicleId, vehicleName, phase: 'checkin', damage: postDamage.trim(), userId, userName });
  }
}

/**
 * Admin force-close for a shift that was never checked in. Closes the log as
 * 'force_closed' (no post-readings, so last-known readings are untouched) and
 * frees the vehicle.
 */
export async function forceCloseVehicleLog(params: {
  vehicleId: string;
  reason: string;
  actor: VehicleActor;
}) {
  const { vehicleId, reason, actor } = params;
  if (!isAdminRole(actor.role)) throw new Error('Only an admin or quartermaster can force-close a shift log');
  if (!reason.trim()) throw new Error('A reason is required to force-close a shift log');

  const vehicleRef = doc(db, 'vehicles', vehicleId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(vehicleRef);
    if (!snap.exists()) throw new Error('Vehicle not found');
    const vehicle = snap.data() as Vehicle;
    if (!vehicle.isCheckedOut || !vehicle.activeLogId) throw new Error('Vehicle has no open shift log');

    const logRef = doc(db, 'vehicle_logs', vehicle.activeLogId);
    const logSnap = await tx.get(logRef);
    if (logSnap.exists() && (logSnap.data() as VehicleLog).status === 'open') {
      tx.update(logRef, {
        status: 'force_closed',
        forceCloseReason: reason.trim(),
        checkinUserId: actor.uid,
        checkinUserName: actor.name,
        checkinAt: serverTimestamp(),
        checkinClientAt: new Date(),
      });
    }
    tx.update(vehicleRef, {
      isCheckedOut: false,
      activeLogId: null,
      assignedToUserId: null,
      assignedToUserName: null,
      checkedOutAt: null,
      updatedAt: serverTimestamp(),
    });
  });
}
