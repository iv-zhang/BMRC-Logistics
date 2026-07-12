'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Chip, Spinner, Switch, Textarea } from '@heroui/react';
import {
  Ambulance,
  Bike,
  Truck,
  Car,
  Plus,
  Pencil,
  Archive,
  ArchiveRestore,
  Trash2,
  X,
  Fuel,
  Gauge,
  Battery,
  History,
  LogOut,
  LogIn,
  Check,
} from 'lucide-react';
import { useUserRole } from '@/app/hooks/useUserRole';
import { useOrgConfig } from '@/app/hooks/useOrgConfig';
import { useVehicles, useVehicleLogs } from '@/app/hooks/useVehicles';
import { retireVehicle, reactivateVehicle, deleteVehicleIfUnused, forceCloseVehicleLog } from '@/app/lib/vehicles';
import { fuelLabel, formatWhen, readingsSummary } from '@/app/lib/vehicle-format';
import VehicleEditorModal from '@/app/components/vehicles/vehicle-editor-modal';
import type { Vehicle, VehicleLog } from '@/app/types';

const TYPE_ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  Ambulance,
  Bike,
  Truck,
  Car,
};

const LOG_STATUS_CHIP: Record<VehicleLog['status'], { label: string; color: 'success' | 'warning' | 'danger' }> = {
  open: { label: 'Open', color: 'warning' },
  closed: { label: 'Closed', color: 'success' },
  force_closed: { label: 'Force-closed', color: 'danger' },
};

export default function VehiclesPage() {
  const router = useRouter();
  const { user, role, fullName, loading: authLoading } = useUserRole();
  const isAdmin = role === 'admin' || role === 'quartermaster';
  const { vehicles: vehicleTypes } = useOrgConfig();
  const { vehicles, loading } = useVehicles();

  const [showRetired, setShowRetired] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Vehicle | null>(null);
  const [historyVehicle, setHistoryVehicle] = useState<Vehicle | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    if (!authLoading && !user) router.push('/login');
  }, [authLoading, user, router]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  // Keep the drawer's vehicle in sync with live roster updates (e.g. force-close).
  const liveHistoryVehicle = useMemo(
    () => (historyVehicle ? vehicles.find((v) => v.id === historyVehicle.id) ?? historyVehicle : null),
    [historyVehicle, vehicles],
  );

  const typeName = (typeId: string) => vehicleTypes.find((t) => t.id === typeId)?.name ?? typeId;
  const typeIcon = (typeId: string) => {
    const iconName = vehicleTypes.find((t) => t.id === typeId)?.icon ?? 'Truck';
    return TYPE_ICONS[iconName] ?? Truck;
  };

  const visible = vehicles.filter((v) => showRetired || v.status === 'active');
  const active = vehicles.filter((v) => v.status === 'active');
  const checkedOutCount = active.filter((v) => v.isCheckedOut).length;

  const notify = (ok: boolean, msg: string) => setToast({ ok, msg });

  const handleRetire = async (v: Vehicle) => {
    if (!v.id) return;
    if (!confirm(`Retire ${v.name}? It disappears from the checkout picker; its logs are kept.`)) return;
    try {
      await retireVehicle(v.id, { uid: user?.uid ?? 'unknown', name: fullName || 'Unknown', role: role ?? undefined });
      notify(true, `${v.name} retired`);
    } catch (e) {
      notify(false, e instanceof Error ? e.message : 'Failed to retire vehicle');
    }
  };

  const handleReactivate = async (v: Vehicle) => {
    if (!v.id) return;
    try {
      await reactivateVehicle(v.id);
      notify(true, `${v.name} reactivated`);
    } catch (e) {
      notify(false, e instanceof Error ? e.message : 'Failed to reactivate vehicle');
    }
  };

  const handleDelete = async (v: Vehicle) => {
    if (!v.id) return;
    if (!confirm(`Delete ${v.name}? Only possible if it has no shift logs.`)) return;
    try {
      await deleteVehicleIfUnused(v.id);
      notify(true, `${v.name} deleted`);
    } catch (e) {
      notify(false, e instanceof Error ? e.message : 'Failed to delete vehicle');
    }
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {/* Header */}
        <div className="flex items-end justify-between gap-4 mb-6 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-foreground mb-1.5">Vehicles</h1>
            <div className="flex items-center gap-2 flex-wrap mt-1">
              <div className="flex items-center gap-2 bg-content1 border border-divider rounded-large px-3 py-1.5">
                <span className="font-mono font-semibold tabular-nums text-foreground">{active.length}</span>
                <span className="text-xs text-foreground-400">active</span>
              </div>
              <div className="flex items-center gap-2 bg-success-50 dark:bg-success-900/20 border border-success/30 rounded-large px-3 py-1.5">
                <span className="w-2 h-2 rounded-sm bg-success flex-none" />
                <span className="font-mono font-semibold tabular-nums text-success">{active.length - checkedOutCount}</span>
                <span className="text-xs text-success/80 font-medium">available</span>
              </div>
              <div className="flex items-center gap-2 bg-warning-50 dark:bg-warning-900/20 border border-warning/30 rounded-large px-3 py-1.5">
                <span className="w-2 h-2 rounded-sm bg-warning flex-none" />
                <span className="font-mono font-semibold tabular-nums text-warning">{checkedOutCount}</span>
                <span className="text-xs text-warning/80 font-medium">checked out</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {isAdmin && (
              <Switch size="sm" isSelected={showRetired} onValueChange={setShowRetired}>
                <span className="text-sm text-foreground-500">Show retired</span>
              </Switch>
            )}
            <Button variant="bordered" startContent={<LogOut size={15} />} onPress={() => router.push('/vehicles/checkout')}>
              Check out
            </Button>
            <Button variant="bordered" startContent={<LogIn size={15} />} onPress={() => router.push('/vehicles/checkin')}>
              Check in
            </Button>
            {isAdmin && (
              <Button color="primary" startContent={<Plus size={15} />} onPress={() => { setEditing(null); setEditorOpen(true); }}>
                Add vehicle
              </Button>
            )}
          </div>
        </div>

        {/* Roster list */}
        {visible.length === 0 ? (
          <div className="bg-content1 border border-divider rounded-large px-6 py-12 text-center">
            <Truck size={40} className="mx-auto mb-3 text-foreground-400" />
            <p className="text-sm text-foreground-500">
              {isAdmin ? 'No vehicles yet — add the first one.' : 'No vehicles in the roster yet.'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {visible.map((v) => {
              const Icon = typeIcon(v.typeId);
              const retired = v.status === 'retired';
              return (
                <div
                  key={v.id}
                  className={`flex flex-wrap sm:flex-nowrap gap-3 sm:gap-4 items-center bg-content1 border border-divider rounded-large px-4 py-4 ${retired ? 'opacity-60' : ''}`}
                >
                  <div className="w-[50px] h-[50px] rounded-[13px] bg-primary-50 dark:bg-primary-900/20 text-primary flex items-center justify-center flex-none">
                    <Icon size={24} />
                  </div>
                  <div className="flex-1 min-w-[55%] sm:min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-base font-semibold text-foreground">{v.name}</span>
                      <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-content2 text-foreground-500">
                        {typeName(v.typeId)}
                      </span>
                      {retired ? (
                        <Chip size="sm" variant="flat">Retired</Chip>
                      ) : v.isCheckedOut ? (
                        <Chip size="sm" variant="flat" color="warning">Checked out</Chip>
                      ) : (
                        <Chip size="sm" variant="flat" color="success">Available</Chip>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-foreground-400 mt-1 flex-wrap">
                      {v.isCheckedOut && v.assignedToUserName && (
                        <span>with {v.assignedToUserName} since {formatWhen(v.checkedOutAt)}</span>
                      )}
                      {typeof v.lastMileage === 'number' && (
                        <span className="inline-flex items-center gap-1">
                          <Gauge size={11} /> <span className="font-mono tabular-nums">{v.lastMileage}</span> mi
                        </span>
                      )}
                      {fuelLabel(v.lastFuelLevel) && (
                        <span className="inline-flex items-center gap-1">
                          <Fuel size={11} /> {fuelLabel(v.lastFuelLevel)}
                        </span>
                      )}
                      {typeof v.lastBatteryLevel === 'number' && (
                        <span className="inline-flex items-center gap-1">
                          <Battery size={11} /> <span className="font-mono tabular-nums">{v.lastBatteryLevel}</span>%
                        </span>
                      )}
                      {v.notes && <span className="truncate max-w-[280px]">{v.notes}</span>}
                    </div>
                  </div>
                  {isAdmin && (
                    <div className="w-full sm:w-auto flex-none flex items-center gap-2 justify-end">
                      <Button size="sm" variant="light" isIconOnly aria-label="Shift history" onPress={() => setHistoryVehicle(v)}>
                        <History size={15} />
                      </Button>
                      <Button size="sm" variant="light" isIconOnly aria-label="Edit vehicle" onPress={() => { setEditing(v); setEditorOpen(true); }}>
                        <Pencil size={15} />
                      </Button>
                      {retired ? (
                        <>
                          <Button size="sm" variant="light" isIconOnly aria-label="Reactivate vehicle" onPress={() => handleReactivate(v)}>
                            <ArchiveRestore size={15} />
                          </Button>
                          <Button size="sm" variant="light" isIconOnly color="danger" aria-label="Delete vehicle" onPress={() => handleDelete(v)}>
                            <Trash2 size={15} />
                          </Button>
                        </>
                      ) : (
                        <Button size="sm" variant="light" isIconOnly aria-label="Retire vehicle" onPress={() => handleRetire(v)}>
                          <Archive size={15} />
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>

      <VehicleEditorModal isOpen={editorOpen} onClose={() => setEditorOpen(false)} vehicle={editing} />

      {isAdmin && liveHistoryVehicle && (
        <VehicleHistoryDrawer
          vehicle={liveHistoryVehicle}
          onClose={() => setHistoryVehicle(null)}
          onResult={notify}
        />
      )}

      {toast && (
        <div className={`fixed z-[60] bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-lg text-sm font-semibold text-white max-w-[92vw] ${toast.ok ? 'bg-success' : 'bg-danger'}`}>
          <div className="w-5 h-5 rounded-full bg-white/25 flex items-center justify-center flex-none">
            {toast.ok ? <Check size={12} strokeWidth={3.5} /> : <span className="text-xs leading-none">✕</span>}
          </div>
          <span>{toast.msg}</span>
        </div>
      )}
    </div>
  );
}

function VehicleHistoryDrawer({
  vehicle,
  onClose,
  onResult,
}: {
  vehicle: Vehicle;
  onClose: () => void;
  onResult: (ok: boolean, msg: string) => void;
}) {
  const { user, role, fullName } = useUserRole();
  const { logs, loading } = useVehicleLogs(vehicle.id);
  const [forceCloseOpen, setForceCloseOpen] = useState(false);
  const [forceCloseReason, setForceCloseReason] = useState('');
  const [closing, setClosing] = useState(false);

  const handleForceClose = async () => {
    if (!vehicle.id) return;
    setClosing(true);
    try {
      await forceCloseVehicleLog({
        vehicleId: vehicle.id,
        reason: forceCloseReason,
        actor: { uid: user?.uid ?? 'unknown', name: fullName || 'Unknown', role: role ?? undefined },
      });
      onResult(true, `Open shift log for ${vehicle.name} force-closed`);
      setForceCloseOpen(false);
      setForceCloseReason('');
    } catch (e) {
      onResult(false, e instanceof Error ? e.message : 'Failed to force-close shift log');
    } finally {
      setClosing(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed top-0 right-0 bottom-0 z-50 w-[480px] max-w-[94vw] bg-content1 shadow-2xl flex flex-col">
        {/* Header */}
        <div className="px-6 py-5 border-b border-divider">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-semibold text-lg text-foreground leading-tight">{vehicle.name}</div>
              <div className="text-xs text-foreground-500 mt-0.5">Shift history</div>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-medium bg-content2 hover:bg-content3 text-foreground-400 flex items-center justify-center transition-colors flex-none"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
          {vehicle.isCheckedOut && (
            <div className="flex items-center gap-2 flex-wrap mt-4">
              <Chip size="sm" variant="flat" color="warning">
                Checked out{vehicle.assignedToUserName ? ` — ${vehicle.assignedToUserName}` : ''}
              </Chip>
              <Button size="sm" variant="bordered" color="danger" onPress={() => setForceCloseOpen((o) => !o)}>
                Force-close open log
              </Button>
            </div>
          )}
          {forceCloseOpen && (
            <div className="bg-danger-50/60 dark:bg-danger-950/20 rounded-large p-3 mt-3 flex flex-col gap-2">
              <Textarea
                label="Reason"
                placeholder="Why is this shift being closed without a check-in?"
                value={forceCloseReason}
                onValueChange={setForceCloseReason}
                minRows={2}
                size="sm"
              />
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="light" onPress={() => setForceCloseOpen(false)} isDisabled={closing}>
                  Cancel
                </Button>
                <Button size="sm" color="danger" onPress={handleForceClose} isLoading={closing} isDisabled={!forceCloseReason.trim()}>
                  Force-close
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-3">
          {loading ? (
            <div className="flex justify-center py-8"><Spinner color="primary" /></div>
          ) : logs.length === 0 ? (
            <p className="text-sm text-foreground-500 text-center py-8">No shifts logged yet.</p>
          ) : (
            logs.map((log) => {
              const chip = LOG_STATUS_CHIP[log.status];
              return (
                <div key={log.id} className="border border-divider rounded-large p-4">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-foreground">{log.driverName}</span>
                    <Chip size="sm" variant="flat" color={chip.color}>{chip.label}</Chip>
                  </div>
                  {log.crewNames && log.crewNames.length > 0 && (
                    <p className="text-xs text-foreground-500 mt-0.5">Crew: {log.crewNames.join(', ')}</p>
                  )}
                  <div className="text-xs text-foreground-400 mt-2 space-y-1">
                    <p>Out {formatWhen(log.checkoutAt)} — {readingsSummary(log.preReadings)}</p>
                    <p>
                      {log.status === 'open'
                        ? 'Not checked in yet'
                        : `In ${formatWhen(log.checkinAt)} — ${readingsSummary(log.postReadings)}`}
                      {log.status !== 'open' && log.checkinUserName && log.checkinUserName !== log.driverName
                        ? ` (by ${log.checkinUserName})`
                        : ''}
                    </p>
                  </div>
                  {(log.preDamage || log.postDamage || log.forceCloseReason || log.notes || log.mileageMismatchAck) && (
                    <div className="bg-content2 rounded-large p-3 mt-2 space-y-1 text-xs">
                      {log.preDamage && <p className="text-danger">Damage at checkout: {log.preDamage}</p>}
                      {log.postDamage && <p className="text-danger">Damage at check-in: {log.postDamage}</p>}
                      {log.mileageMismatchAck && <p className="text-foreground-500">Mileage note: {log.mileageMismatchAck}</p>}
                      {log.notes && <p className="text-foreground-500">{log.notes}</p>}
                      {log.forceCloseReason && <p className="text-danger">Force-closed: {log.forceCloseReason}</p>}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
