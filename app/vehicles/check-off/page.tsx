'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Chip, Input, Spinner, Textarea } from '@heroui/react';
import { ArrowLeft, ArrowRight, Battery, Check, Fuel, Gauge, Plus, Users, X } from 'lucide-react';
import { doc, getDoc, onSnapshot, Timestamp } from 'firebase/firestore';
import { db } from '@/firebase';
import { useUserRole } from '@/app/hooks/useUserRole';
import { useOrgConfig } from '@/app/hooks/useOrgConfig';
import { checkoutVehicle, checkinVehicle } from '@/app/lib/vehicles';
import { fuelLabel } from '@/app/lib/vehicle-format';
import { getReadingFieldsForVehicleType, FUEL_LEVEL_STEPS } from '@/app/config/org-config';
import type { Vehicle, VehicleLog, VehicleShiftReadings } from '@/app/types';

type Mode = 'checkout' | 'checkin';

function toDate(value: unknown): Date | null {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  return null;
}

export default function VehicleCheckOffPage() {
  const router = useRouter();
  const { user, role, fullName, loading: authLoading } = useUserRole();
  const isAdmin = role === 'admin' || role === 'quartermaster';
  // Subscribing to org config keeps reading-field lookups reactive to admin edits.
  const { loading: configLoading } = useOrgConfig();

  const [params, setParams] = useState<{ id?: string; mode?: Mode }>({});
  const [paramsReady, setParamsReady] = useState(false);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [vehicleLoading, setVehicleLoading] = useState(true);
  const [openLog, setOpenLog] = useState<VehicleLog | null>(null);

  // Form state
  const [mileage, setMileage] = useState('');
  const [fuelLevel, setFuelLevel] = useState<number | null>(null);
  const [batteryLevel, setBatteryLevel] = useState('');
  const [crewNames, setCrewNames] = useState<string[]>([]);
  const [crewInput, setCrewInput] = useState('');
  const [damageNone, setDamageNone] = useState(false);
  const [damage, setDamage] = useState('');
  const [mileageAck, setMileageAck] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  // Read id + mode from the query string (window.location, not useSearchParams —
  // the hook forces a Suspense boundary that breaks under output: 'export').
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const id = sp.get('id') ?? undefined;
    const rawMode = sp.get('mode');
    const mode: Mode | undefined = rawMode === 'checkout' || rawMode === 'checkin' ? rawMode : undefined;
    setParams({ id, mode });
    setParamsReady(true);
  }, []);

  useEffect(() => {
    if (!authLoading && !user) router.push('/login');
  }, [authLoading, user, router]);

  // Live vehicle doc
  useEffect(() => {
    if (!params.id) { setVehicleLoading(!paramsReady); return; }
    const unsub = onSnapshot(
      doc(db, 'vehicles', params.id),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          setVehicle({ ...data, id: snap.id, checkedOutAt: toDate(data.checkedOutAt) } as Vehicle);
        } else {
          setVehicle(null);
        }
        setVehicleLoading(false);
      },
      (e) => { console.error('[vehicle check-off] listener error', e); setVehicleLoading(false); },
    );
    return () => unsub();
  }, [params.id, paramsReady]);

  // Check-in: load the open shift log for pre-readings + validation.
  useEffect(() => {
    if (params.mode !== 'checkin' || !vehicle?.activeLogId) { setOpenLog(null); return; }
    let cancelled = false;
    getDoc(doc(db, 'vehicle_logs', vehicle.activeLogId)).then((snap) => {
      if (cancelled) return;
      setOpenLog(snap.exists() ? ({ ...snap.data(), id: snap.id } as VehicleLog) : null);
    }).catch((e) => console.error('[vehicle check-off] failed to load open log', e));
    return () => { cancelled = true; };
  }, [params.mode, vehicle?.activeLogId]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const readingFields = useMemo(
    () => (vehicle ? getReadingFieldsForVehicleType(vehicle.typeId) : []),
    // configLoading in deps re-derives once runtime overrides land.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vehicle?.typeId, configLoading],
  );
  const wantsMileage = readingFields.some((f) => f.id === 'mileage');
  const wantsFuel = readingFields.some((f) => f.id === 'fuel_level');
  const batteryField = readingFields.find((f) => f.id === 'battery_level');

  const mode = params.mode;
  const mileageNum = mileage.trim() === '' ? undefined : Number(mileage);
  const batteryNum = batteryLevel.trim() === '' ? undefined : Number(batteryLevel);
  const preMileage = openLog?.preReadings?.mileage;

  const mileageMismatch =
    mode === 'checkout' &&
    wantsMileage &&
    typeof mileageNum === 'number' &&
    Number.isFinite(mileageNum) &&
    typeof vehicle?.lastMileage === 'number' &&
    mileageNum !== vehicle.lastMileage;

  const mileageBelowPre =
    mode === 'checkin' &&
    wantsMileage &&
    typeof mileageNum === 'number' &&
    typeof preMileage === 'number' &&
    mileageNum < preMileage;

  const batteryLow =
    typeof batteryNum === 'number' &&
    batteryField?.warningThreshold !== undefined &&
    batteryNum <= batteryField.warningThreshold;
  const batteryCritical =
    typeof batteryNum === 'number' &&
    batteryField?.criticalThreshold !== undefined &&
    batteryNum <= batteryField.criticalThreshold;

  const readingsComplete =
    (!wantsMileage || (typeof mileageNum === 'number' && Number.isFinite(mileageNum) && mileageNum >= 0)) &&
    (!wantsFuel || fuelLevel !== null) &&
    (!batteryField || (typeof batteryNum === 'number' && Number.isFinite(batteryNum) && batteryNum >= 0 && batteryNum <= 100));

  const damageResolved = damageNone || damage.trim().length > 0;
  const ackSatisfied = !mileageMismatch || mileageAck.trim().length > 0;
  const canSubmit = readingsComplete && damageResolved && ackSatisfied && !mileageBelowPre && !submitting;

  const addCrewName = () => {
    const name = crewInput.trim();
    if (!name) return;
    setCrewNames((prev) => (prev.includes(name) ? prev : [...prev, name]));
    setCrewInput('');
  };

  const handleSubmit = async () => {
    if (!vehicle?.id || !user || !mode) return;
    setSubmitting(true);
    setError(null);
    const readings: VehicleShiftReadings = {
      ...(wantsMileage && typeof mileageNum === 'number' ? { mileage: mileageNum } : {}),
      ...(wantsFuel && fuelLevel !== null ? { fuelLevel } : {}),
      ...(batteryField && typeof batteryNum === 'number' ? { batteryLevel: batteryNum } : {}),
    };
    try {
      if (mode === 'checkout') {
        await checkoutVehicle({
          vehicleId: vehicle.id,
          userId: user.uid,
          userName: fullName || user.email || 'Unknown',
          crewNames,
          preReadings: readings,
          preDamage: damageNone ? undefined : damage,
          mileageMismatchAck: mileageMismatch ? mileageAck : undefined,
          notes: notes || undefined,
        });
        setToast({ ok: true, msg: `${vehicle.name} checked out` });
      } else {
        await checkinVehicle({
          vehicleId: vehicle.id,
          userId: user.uid,
          userName: fullName || user.email || 'Unknown',
          userRole: role ?? undefined,
          postReadings: readings,
          postDamage: damageNone ? undefined : damage,
          notes: notes || undefined,
        });
        setToast({ ok: true, msg: `${vehicle.name} checked in` });
      }
      setTimeout(() => router.push('/dashboard'), 900);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong — try again');
      setSubmitting(false);
    }
  };

  // ── Guard states ─────────────────────────────────────────────────────────
  if (authLoading || configLoading || vehicleLoading || !paramsReady) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  const guardMessage = !params.id || !mode
    ? 'Missing vehicle or mode — open this page from the vehicle checkout or check-in list.'
    : !vehicle
      ? 'Vehicle not found.'
      : mode === 'checkout' && vehicle.status !== 'active'
        ? 'This vehicle is retired.'
        : mode === 'checkout' && vehicle.isCheckedOut
          ? `This vehicle is already checked out${vehicle.assignedToUserName ? ` by ${vehicle.assignedToUserName}` : ''}.`
          : mode === 'checkin' && !vehicle.isCheckedOut
            ? 'This vehicle is not checked out.'
            : mode === 'checkin' && !isAdmin && vehicle.assignedToUserId && vehicle.assignedToUserId !== user?.uid
              ? `This vehicle was checked out by ${vehicle.assignedToUserName ?? 'another member'} — only they (or an admin) can check it in.`
              : null;

  if (guardMessage) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center p-4">
        <div className="bg-content1 border border-divider rounded-large p-6 max-w-md w-full text-center">
          <p className="text-sm text-foreground-500 mb-4">{guardMessage}</p>
          <Button variant="bordered" onPress={() => router.back()} startContent={<ArrowLeft size={15} />}>
            Go back
          </Button>
        </div>
      </div>
    );
  }

  const v = vehicle as Vehicle;
  const isCheckout = mode === 'checkout';

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
      <div className="max-w-lg mx-auto min-h-screen flex flex-col">
        {/* Sticky header */}
        <header className="sticky top-0 z-30 bg-background/80 backdrop-blur-md border-b border-divider">
          <div className="h-14 flex items-center gap-2 px-3">
            <button
              onClick={() => router.back()}
              className="w-9 h-9 rounded-xl flex items-center justify-center text-foreground-500 hover:bg-content2 transition-colors duration-150"
              aria-label="Back"
            >
              <ArrowLeft size={20} />
            </button>
            <div className="flex-1 text-center flex flex-col leading-tight">
              <span className="text-sm font-semibold text-foreground">
                {isCheckout ? 'Check Out' : 'Check In'} — {v.name}
              </span>
              <span className="text-[11px] text-foreground-400 font-medium">
                {isCheckout ? 'Pre-shift readings' : 'Post-shift readings'}
              </span>
            </div>
            <div className="w-9 h-9" />
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 px-3 py-4 flex flex-col gap-3 pb-28">
          {/* Shift crew */}
          <div className="bg-content1 border border-divider rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <Users size={14} className="text-primary" />
              <span className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">Shift crew</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-foreground-500">Driver</span>
              <span className="text-sm font-semibold text-foreground">
                {isCheckout ? (fullName || user?.email || '—') : (openLog?.driverName ?? v.assignedToUserName ?? '—')}
              </span>
            </div>
            {isCheckout && (
              <div className="mt-3">
                <div className="flex gap-2">
                  <Input
                    size="sm"
                    placeholder="Add team member name"
                    value={crewInput}
                    onValueChange={setCrewInput}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCrewName(); } }}
                  />
                  <Button size="sm" variant="flat" color="primary" isIconOnly onPress={addCrewName} aria-label="Add crew member">
                    <Plus size={15} />
                  </Button>
                </div>
                {crewNames.length > 0 && (
                  <div className="flex gap-1.5 flex-wrap mt-2">
                    {crewNames.map((name) => (
                      <Chip
                        key={name}
                        size="sm"
                        variant="flat"
                        onClose={() => setCrewNames((prev) => prev.filter((n) => n !== name))}
                      >
                        {name}
                      </Chip>
                    ))}
                  </div>
                )}
              </div>
            )}
            {!isCheckout && openLog?.crewNames && openLog.crewNames.length > 0 && (
              <div className="flex items-center justify-between gap-2 mt-2">
                <span className="text-sm text-foreground-500">Crew</span>
                <span className="text-sm text-foreground">{openLog.crewNames.join(', ')}</span>
              </div>
            )}
          </div>

          {/* Readings */}
          <div className="bg-content1 border border-divider rounded-2xl p-4 flex flex-col gap-4">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">
              {isCheckout ? 'Pre-shift readings' : 'Post-shift readings'}
            </span>

            {wantsFuel && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Fuel size={14} className="text-foreground-400" />
                  <span className="text-sm font-semibold text-foreground">Fuel level</span>
                  {!isCheckout && typeof openLog?.preReadings?.fuelLevel === 'number' && (
                    <span className="text-xs text-foreground-400 ml-auto">out at {fuelLabel(openLog.preReadings.fuelLevel)}</span>
                  )}
                </div>
                <div className="flex gap-1.5">
                  {FUEL_LEVEL_STEPS.map((step) => (
                    <button
                      key={step.value}
                      onClick={() => setFuelLevel(step.value)}
                      className={`flex-1 h-10 rounded-lg text-sm font-semibold transition-colors duration-150 ${
                        fuelLevel === step.value
                          ? 'bg-primary text-white'
                          : 'bg-content2 text-foreground-500 hover:bg-content3'
                      }`}
                    >
                      {step.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {wantsMileage && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Gauge size={14} className="text-foreground-400" />
                  <span className="text-sm font-semibold text-foreground">Mileage</span>
                  {isCheckout && typeof v.lastMileage === 'number' && (
                    <span className="text-xs text-foreground-400 ml-auto">last recorded {v.lastMileage} mi</span>
                  )}
                  {!isCheckout && typeof preMileage === 'number' && (
                    <span className="text-xs text-foreground-400 ml-auto">out at {preMileage} mi</span>
                  )}
                </div>
                <Input
                  type="text"
                  inputMode="numeric"
                  placeholder="Odometer reading"
                  value={mileage}
                  onValueChange={(val) => setMileage(val.replace(/[^\d]/g, ''))}
                  endContent={<span className="text-xs text-foreground-400">mi</span>}
                  classNames={{ input: 'font-mono tabular-nums' }}
                  isInvalid={mileageBelowPre}
                  errorMessage={mileageBelowPre ? `Cannot be below the checkout reading (${preMileage} mi)` : undefined}
                />
                {mileageMismatch && (
                  <div className="bg-warning-50/60 dark:bg-warning-950/20 border border-warning/20 rounded-xl p-3 mt-2">
                    <p className="text-xs font-semibold text-warning mb-2">
                      Differs from the last recorded reading ({v.lastMileage} mi) — add a note explaining why.
                    </p>
                    <Input
                      size="sm"
                      placeholder="e.g. maintenance run, odometer corrected…"
                      value={mileageAck}
                      onValueChange={setMileageAck}
                    />
                  </div>
                )}
              </div>
            )}

            {batteryField && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Battery size={14} className="text-foreground-400" />
                  <span className="text-sm font-semibold text-foreground">Battery level</span>
                  {!isCheckout && typeof openLog?.preReadings?.batteryLevel === 'number' && (
                    <span className="text-xs text-foreground-400 ml-auto">out at {openLog.preReadings.batteryLevel}%</span>
                  )}
                </div>
                <Input
                  type="text"
                  inputMode="numeric"
                  placeholder="0–100"
                  value={batteryLevel}
                  onValueChange={(val) => setBatteryLevel(val.replace(/[^\d]/g, '').slice(0, 3))}
                  endContent={<span className="text-xs text-foreground-400">%</span>}
                  classNames={{ input: 'font-mono tabular-nums' }}
                  isInvalid={typeof batteryNum === 'number' && batteryNum > 100}
                  errorMessage={typeof batteryNum === 'number' && batteryNum > 100 ? 'Battery cannot exceed 100%' : undefined}
                />
                {typeof batteryNum === 'number' && batteryNum <= 100 && (batteryCritical || batteryLow) && (
                  <Chip size="sm" variant="flat" color={batteryCritical ? 'danger' : 'warning'} className="mt-2">
                    {batteryCritical ? 'Battery critical' : 'Battery low'}
                  </Chip>
                )}
              </div>
            )}
          </div>

          {/* New damage */}
          <div className="bg-content1 border border-divider rounded-2xl p-4">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">New damage</span>
            <p className="text-xs text-foreground-400 mt-1 mb-3">
              Only damage that wasn&apos;t there before. Reported damage opens a tracked issue for the quartermaster.
            </p>
            <button onClick={() => setDamageNone((d) => !d)} className="flex items-center gap-2 text-left mb-3">
              <div className={`w-5 h-5 rounded-md flex-none flex items-center justify-center border-2 transition-all ${
                damageNone ? 'bg-primary border-primary' : 'bg-transparent border-foreground-400'
              }`}>
                <Check size={11} strokeWidth={3.5} className={damageNone ? 'text-white' : 'text-transparent'} />
              </div>
              <span className="text-sm font-semibold text-foreground-600">No new damage</span>
            </button>
            {!damageNone && (
              <Textarea
                placeholder="Describe the new damage…"
                value={damage}
                onValueChange={setDamage}
                minRows={2}
              />
            )}
          </div>

          {/* Notes */}
          <div className="bg-content1 border border-divider rounded-2xl p-4">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">Notes</span>
            <Textarea
              placeholder="Optional shift notes…"
              value={notes}
              onValueChange={setNotes}
              minRows={2}
              className="mt-2"
            />
          </div>

          {error && (
            <div className="bg-danger-50/60 dark:bg-danger-950/20 rounded-large p-3">
              <p className="text-sm text-danger">{error}</p>
            </div>
          )}
        </main>

        {/* Sticky footer */}
        <footer className="sticky bottom-0 z-30 bg-background/80 backdrop-blur-md border-t border-divider px-3 py-3 flex items-center gap-3">
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold text-foreground">
              {readingsComplete ? (damageResolved ? 'Ready to submit' : 'Confirm damage') : 'Enter readings'}
            </span>
            <span className="text-xs text-foreground-400 font-medium">
              {isCheckout ? 'Checkout opens the shift log' : 'Check-in closes the shift log'}
            </span>
          </div>
          <Button
            color="primary"
            className="ml-auto font-semibold"
            endContent={<ArrowRight size={16} />}
            isDisabled={!canSubmit}
            isLoading={submitting}
            onPress={handleSubmit}
          >
            {isCheckout ? 'Check out' : 'Check in'}
          </Button>
        </footer>
      </div>

      {toast && (
        <div className={`fixed z-[60] bottom-20 left-1/2 -translate-x-1/2 flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-lg text-sm font-semibold text-white max-w-[92vw] ${toast.ok ? 'bg-success' : 'bg-danger'}`}>
          <div className="w-5 h-5 rounded-full bg-white/25 flex items-center justify-center flex-none">
            {toast.ok ? <Check size={12} strokeWidth={3.5} /> : <X size={12} strokeWidth={3.5} />}
          </div>
          <span>{toast.msg}</span>
        </div>
      )}
    </div>
  );
}
