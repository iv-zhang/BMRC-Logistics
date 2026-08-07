'use client';

/** Right-side detail drawer for one event: identity/status header, team
 *  slots (member: request buttons; manager: also a pending-requests inbox
 *  scoped to this event), and manager actions (edit/notify/delete). */

import { useEffect, useMemo, useState } from 'react';
import { Button, Chip, Spinner, Textarea, Input } from '@heroui/react';
import { X, MapPin, Clock, CalendarDays, Pencil, Trash2, BellRing, Info, ClipboardCheck, LogOut } from 'lucide-react';
import {
  subscribeEventRequests,
  approveRequest,
  rejectRequest,
  cancelRequest,
  recordAttendance,
  checkInMember,
  checkOutMember,
  endEventShifts,
  formatMemberExperience,
  slotRoleLabel,
  type EventActor,
} from '@/app/lib/events';
import type { Event, EventStatus, ShiftRequest, AttendanceRecord, User } from '@/app/types';
import TeamCard from './team-card';
import {
  formatEventDate,
  formatTimeRange,
  toJsDate,
  eventCallDateTime,
  eventEndDateTime,
  computeMinutesLate,
  computeMinutesEarly,
  getAttendanceAccess,
  shiftHours,
} from './event-utils';
import PanelShell from '@/app/components/panel-shell';

const STATUS_CHIP: Record<EventStatus, { label: string; color: 'primary' | 'default' | 'danger' }> = {
  draft: { label: 'Draft', color: 'default' },
  open: { label: 'Open', color: 'primary' },
  closed: { label: 'Closed', color: 'default' },
  cancelled: { label: 'Cancelled', color: 'danger' },
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** "HH:mm" for a time <input type="time"> from a Date. */
function toHHmm(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Combine an event's day with an arbitrary "HH:mm" string into a Date (not the event's call time). */
function combineDayAndTime(day: Date, hhmm: string): Date | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  const d = new Date(day);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

/** The status chips for one row's attendance state — same rendering in every mode. */
function AttendanceChips({ attendance }: { attendance?: AttendanceRecord }) {
  if (attendance?.exception) {
    return (
      <Chip size="sm" variant="flat" color={attendance.exception === 'no_show' ? 'danger' : 'default'}>
        {attendance.exception === 'no_show' ? 'No-show' : 'Excused'}
      </Chip>
    );
  }
  if (!attendance?.checkedInAt) {
    return (
      <Chip size="sm" variant="flat" color="default">
        Unrecorded
      </Chip>
    );
  }
  const arrivalDate = toJsDate(attendance.checkedInAt);
  const departureDate = toJsDate(attendance.shiftEndAt);
  const lateMinutes = attendance.minutesLate ?? 0;
  const hours = shiftHours(attendance.checkedInAt, attendance.shiftEndAt);
  return (
    <>
      <Chip size="sm" variant="flat" color="success">
        Arrived {arrivalDate ? toHHmm(arrivalDate) : ''}
      </Chip>
      {lateMinutes > 0 && (
        <Chip size="sm" variant="flat" color="warning">
          Late by {lateMinutes}m
        </Chip>
      )}
      {departureDate && (
        <Chip size="sm" variant="flat" color="default">
          Left {toHHmm(departureDate)}
        </Chip>
      )}
      {attendance.leftEarly && (
        <Chip size="sm" variant="flat" color="warning">
          {attendance.minutesEarly ? `Left early by ${attendance.minutesEarly}m` : 'Left early'}
        </Chip>
      )}
      {hours != null && (
        <Chip size="sm" variant="flat" color="default">
          {hours}h
        </Chip>
      )}
    </>
  );
}

interface EventDetailDrawerProps {
  event: Event;
  canManage: boolean;
  actor: EventActor;
  userData: User | null;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onNotify: () => void;
  onToast: (ok: boolean, msg: string) => void;
}

export default function EventDetailDrawer({
  event,
  canManage,
  actor,
  userData,
  onClose,
  onEdit,
  onDelete,
  onNotify,
  onToast,
}: EventDetailDrawerProps) {
  const [requests, setRequests] = useState<ShiftRequest[]>([]);
  const [loadingRequests, setLoadingRequests] = useState(true);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  useEffect(() => {
    if (!event.id) return;
    setLoadingRequests(true);
    const unsub = subscribeEventRequests(event.id, (r) => {
      setRequests(r);
      setLoadingRequests(false);
    });
    return () => unsub();
  }, [event.id]);

  const myActiveRequest = useMemo(
    () => requests.find((r) => r.userId === actor.uid && (r.status === 'pending' || r.status === 'approved')),
    [requests, actor.uid],
  );
  const pending = useMemo(() => requests.filter((r) => r.status === 'pending'), [requests]);
  const approved = useMemo(() => requests.filter((r) => r.status === 'approved'), [requests]);

  /** Whether the viewer's OWN approved request already has a check-in stamp. */
  const viewerCheckedIn = !!(myActiveRequest?.status === 'approved' && myActiveRequest.attendance?.checkedInAt);

  const access = useMemo(
    () =>
      getAttendanceAccess({
        event,
        viewerRole: userData?.role,
        viewerUid: actor.uid,
        viewerCheckedIn,
      }),
    [event, userData?.role, actor.uid, viewerCheckedIn],
  );

  /** Approved requests scoped to what this viewer may see, with the viewer's own
   *  row sorted to the top when they're gated on checking themselves in first. */
  const scopedApproved = useMemo(() => {
    const list =
      access.scopeTeamIds == null ? approved : approved.filter((r) => access.scopeTeamIds!.includes(r.teamId));
    if (!access.gatedOnSelfCheckIn) return list;
    return [...list].sort((a, b) => {
      const aSelf = a.userId === actor.uid ? 0 : 1;
      const bSelf = b.userId === actor.uid ? 0 : 1;
      return aSelf - bSelf;
    });
  }, [access, approved, actor.uid]);

  const [arrivalDrafts, setArrivalDrafts] = useState<Record<string, string>>({});
  const [departureDrafts, setDepartureDrafts] = useState<Record<string, string>>({});
  const [attendanceSavingId, setAttendanceSavingId] = useState<string | null>(null);
  const [endingShifts, setEndingShifts] = useState(false);

  type MobilePage = 'details' | 'teams' | 'attendance' | 'requests';
  const [mobilePage, setMobilePage] = useState<MobilePage>('details');

  const eventDay = useMemo(() => toJsDate(event.date), [event.date]);
  const callDateTime = useMemo(() => eventCallDateTime(event), [event]);
  const endDateTime = useMemo(() => eventEndDateTime(event), [event]);

  /** The "Arrived at" time input value: the in-progress edit, else the existing check-in, else now. */
  const getArrivalDraft = (req: ShiftRequest): string => {
    if (req.id && arrivalDrafts[req.id] !== undefined) return arrivalDrafts[req.id];
    const existing = toJsDate(req.attendance?.checkedInAt);
    return toHHmm(existing ?? new Date());
  };

  /** The "Left at" time input value: the in-progress edit, else the existing departure, else now. */
  const getDepartureDraft = (req: ShiftRequest): string => {
    if (req.id && departureDrafts[req.id] !== undefined) return departureDrafts[req.id];
    const existing = toJsDate(req.attendance?.shiftEndAt);
    return toHHmm(existing ?? new Date());
  };

  const handleCheckIn = async (req: ShiftRequest) => {
    if (!req.id) return;
    setAttendanceSavingId(req.id);
    try {
      const { minutesLate } = await checkInMember(event, req, actor);
      onToast(true, `${req.userName} checked in${minutesLate > 0 ? ` — late by ${minutesLate}m` : ''}`);
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to check in');
    } finally {
      setAttendanceSavingId(null);
    }
  };

  const handleCheckOut = async (req: ShiftRequest) => {
    if (!req.id) return;
    setAttendanceSavingId(req.id);
    try {
      const { leftEarly, minutesEarly } = await checkOutMember(event, req, actor);
      onToast(true, `${req.userName} checked out${leftEarly ? ` — left ${minutesEarly}m early` : ''}`);
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to check out');
    } finally {
      setAttendanceSavingId(null);
    }
  };

  /** Manager-only retro-edit: save both time inputs at once, recomputing the derived snapshots. */
  const handleSaveRetro = async (req: ShiftRequest) => {
    if (!req.id || !eventDay) return;
    const arrival = combineDayAndTime(eventDay, getArrivalDraft(req));
    if (!arrival) {
      onToast(false, 'Enter a valid arrival time');
      return;
    }
    const departure = combineDayAndTime(eventDay, getDepartureDraft(req));
    setAttendanceSavingId(req.id);
    try {
      const minutesLate = computeMinutesLate(arrival, callDateTime);
      const patch: Parameters<typeof recordAttendance>[1] = { checkedInAt: arrival, minutesLate };
      if (departure) {
        const minutesEarly = computeMinutesEarly(departure, endDateTime);
        const leftEarly = minutesEarly > 0;
        patch.shiftEndAt = departure;
        patch.leftEarly = leftEarly;
        patch.minutesEarly = leftEarly ? minutesEarly : undefined;
      }
      await recordAttendance(req, patch, actor);
      onToast(true, `${req.userName}: attendance updated`);
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to save attendance');
    } finally {
      setAttendanceSavingId(null);
    }
  };

  const handleSetException = async (req: ShiftRequest, exception: 'no_show' | 'excused') => {
    if (!req.id) return;
    setAttendanceSavingId(req.id);
    try {
      await recordAttendance(req, { exception }, actor);
      onToast(true, `${req.userName}: ${exception === 'no_show' ? 'No-show' : 'Excused'}`);
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to record attendance');
    } finally {
      setAttendanceSavingId(null);
    }
  };

  const handleClearAttendance = async (req: ShiftRequest) => {
    if (!req.id) return;
    setAttendanceSavingId(req.id);
    try {
      await recordAttendance(req, { checkedInAt: null, exception: null }, actor);
      onToast(true, `${req.userName}: cleared`);
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to clear attendance');
    } finally {
      setAttendanceSavingId(null);
    }
  };

  const handleEndShifts = async () => {
    if (!event.id) return;
    setEndingShifts(true);
    try {
      // An assigned FTO ends only their own team's shifts; managers (null scope) sweep the event.
      const count = await endEventShifts(event.id, actor, access.scopeTeamIds);
      onToast(true, count > 0 ? `Ended ${count} shift${count === 1 ? '' : 's'}` : 'No checked-in shifts to end');
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to end shifts');
    } finally {
      setEndingShifts(false);
    }
  };

  const handleApprove = async (req: ShiftRequest) => {
    if (!req.id) return;
    setDecidingId(req.id);
    try {
      await approveRequest(req, actor);
      onToast(true, `Approved ${req.userName} for ${req.teamName} · ${req.role}`);
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to approve request');
    } finally {
      setDecidingId(null);
    }
  };

  const handleReject = async (req: ShiftRequest) => {
    if (!req.id) return;
    setDecidingId(req.id);
    try {
      await rejectRequest(req, actor, rejectReason || undefined);
      onToast(true, `Rejected ${req.userName}'s request`);
      setRejectingId(null);
      setRejectReason('');
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to reject request');
    } finally {
      setDecidingId(null);
    }
  };

  const handleWithdraw = async () => {
    if (!myActiveRequest) return;
    try {
      await cancelRequest(myActiveRequest);
      onToast(true, 'Request withdrawn');
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to withdraw request');
    }
  };

  const handleDelete = () => {
    if (!confirm(`Delete "${event.name}"? This cannot be undone.`)) return;
    onDelete();
  };

  const statusChip = STATUS_CHIP[event.status];

  const mobileSections = useMemo(() => {
    const sections: { key: MobilePage; label: string; badge?: number }[] = [];
    if (event.description || myActiveRequest) sections.push({ key: 'details', label: 'Details' });
    sections.push({ key: 'teams', label: 'Teams' });
    if (access.visible) sections.push({ key: 'attendance', label: 'Attendance' });
    if (canManage) sections.push({ key: 'requests', label: 'Requests', badge: pending.length || undefined });
    return sections;
  }, [event.description, myActiveRequest, access.visible, canManage, pending.length]);

  useEffect(() => {
    if (mobileSections.length > 0 && !mobileSections.some((s) => s.key === mobilePage)) {
      setMobilePage(mobileSections[0].key);
    }
  }, [mobileSections, mobilePage]);

  return (
    <PanelShell isOpen onClose={onClose} ariaLabel="Event detail" widthClass="w-full md:w-[560px] md:max-w-[94vw]" forceMode="modal">
        {/* Header */}
        <div className="px-6 py-5 border-b border-divider flex-none">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-semibold text-lg text-foreground leading-tight">{event.name}</div>
              {event.eventType && <div className="text-xs text-foreground-500 mt-0.5">{event.eventType}</div>}
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-medium bg-content2 hover:bg-content3 text-foreground-400 flex items-center justify-center transition-colors flex-none"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>

          <div className="flex gap-1.5 flex-wrap mt-3">
            <Chip size="sm" variant="flat" color={statusChip.color}>
              {statusChip.label}
            </Chip>
            {canManage && pending.length > 0 && (
              <Chip size="sm" variant="flat" color="danger">
                {pending.length} pending
              </Chip>
            )}
          </div>

          <div className="flex flex-col gap-1.5 text-sm text-foreground-500 mt-3">
            <span className="inline-flex items-center gap-1.5">
              <CalendarDays size={13} /> {formatEventDate(event.date)}
            </span>
            {formatTimeRange(event.callTime, event.endTime) && (
              <span className="inline-flex items-center gap-1.5">
                <Clock size={13} /> {formatTimeRange(event.callTime, event.endTime)}
              </span>
            )}
            {(event.venue || event.location) && (
              <span className="inline-flex items-center gap-1.5">
                <MapPin size={13} /> {[event.venue, event.location].filter(Boolean).join(' · ')}
              </span>
            )}
          </div>

          {canManage && (
            <div className="flex gap-2 flex-wrap mt-4">
              <Button size="sm" variant="bordered" startContent={<Pencil size={14} />} onPress={onEdit}>
                Edit
              </Button>
              {event.status === 'open' && (
                <Button size="sm" variant="bordered" startContent={<BellRing size={14} />} onPress={onNotify}>
                  {event.notified ? 'Notify again' : 'Notify members'}
                </Button>
              )}
              <Button size="sm" variant="bordered" color="danger" startContent={<Trash2 size={14} />} onPress={handleDelete}>
                Delete
              </Button>
            </div>
          )}
        </div>

        {/* Mobile page switcher — real tabs, not faint pills: equal-width targets,
            a primary label and a solid underline on the active one so it's obvious
            at a glance which section you're looking at. */}
        {mobileSections.length > 1 && (
          <div className="md:hidden flex border-b border-divider bg-content1 flex-none" role="tablist">
            {mobileSections.map((s) => {
              const active = mobilePage === s.key;
              return (
                <button
                  key={s.key}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setMobilePage(s.key)}
                  className={`relative flex-1 min-w-0 px-1 pt-3 pb-2.5 text-[12.5px] font-semibold transition-colors duration-150 ${
                    active ? 'text-primary' : 'text-foreground-400 active:text-foreground-600'
                  }`}
                >
                  <span className="flex items-center justify-center gap-1 truncate">
                    <span className="truncate">{s.label}</span>
                    {s.badge ? (
                      <span className="flex-none min-w-[16px] h-4 px-1 rounded-full bg-danger text-white text-[10px] font-bold leading-4">
                        {s.badge}
                      </span>
                    ) : null}
                  </span>
                  <span
                    className={`absolute left-2.5 right-2.5 bottom-0 h-[3px] rounded-t-full transition-opacity duration-150 ${
                      active ? 'bg-primary opacity-100' : 'opacity-0'
                    }`}
                  />
                </button>
              );
            })}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-5">
          {(event.description || myActiveRequest) && (
            <div className={mobilePage === 'details' ? 'block' : 'hidden md:block'}>
              <div className="flex flex-col gap-5">
                {event.description && <p className="text-sm text-foreground-600 whitespace-pre-wrap">{event.description}</p>}

                {myActiveRequest && (
                  <div className="bg-content2 rounded-large p-4 flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1">
                        Your request
                      </div>
                      <div className="text-sm font-medium text-foreground">
                        {myActiveRequest.teamName} · {slotRoleLabel(myActiveRequest.role)}
                      </div>
                      <Chip
                        size="sm"
                        variant="flat"
                        color={myActiveRequest.status === 'approved' ? 'success' : 'warning'}
                        className="mt-1.5"
                      >
                        {myActiveRequest.status === 'approved' ? 'Confirmed' : 'Requested'}
                      </Chip>
                    </div>
                    <Button size="sm" variant="bordered" color="danger" onPress={handleWithdraw}>
                      Withdraw
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className={mobilePage === 'teams' ? 'block' : 'hidden md:block'}>
            <div className="flex flex-col gap-3">
              <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">Teams</div>
              {(event.teams || []).map((team) => (
                <TeamCard
                  key={team.id}
                  event={event}
                  team={team}
                  userRole={userData?.role ?? null}
                  userData={userData}
                  actorUid={actor.uid}
                  actorName={actor.name}
                  myActiveRequest={myActiveRequest}
                  onRequested={() => onToast(true, 'Request sent')}
                  onError={(msg) => onToast(false, msg)}
                />
              ))}
            </div>
          </div>

          {access.visible && (
            <div className={mobilePage === 'attendance' ? 'block' : 'hidden md:block'}>
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 inline-flex items-center gap-1.5">
                  <ClipboardCheck size={11} /> Attendance
                </div>
                {access.canRecordLive && (
                  <Button
                    size="sm"
                    variant="light"
                    startContent={<LogOut size={13} />}
                    onPress={handleEndShifts}
                    isLoading={endingShifts}
                    isDisabled={scopedApproved.length === 0}
                  >
                    End shift
                  </Button>
                )}
              </div>

              {access.mode === 'read-only' && access.reason && (
                <p className="text-xs text-foreground-400">{access.reason}</p>
              )}
              {access.gatedOnSelfCheckIn && access.reason && (
                <div className="text-xs text-warning-600 bg-warning-50 dark:bg-warning-900/20 rounded-medium px-2.5 py-1.5 inline-flex items-start gap-1.5">
                  <Info size={12} className="mt-0.5 flex-none" /> {access.reason}
                </div>
              )}

              {loadingRequests ? (
                <div className="flex justify-center py-4">
                  <Spinner size="sm" color="primary" />
                </div>
              ) : scopedApproved.length === 0 ? (
                <p className="text-sm text-foreground-400">No confirmed members yet.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {scopedApproved.map((req) => {
                    const attendance = req.attendance;
                    const checkedIn = !!attendance?.checkedInAt && !attendance?.exception;
                    const hasEnded = checkedIn && !!attendance?.shiftEndAt;
                    const saving = attendanceSavingId === req.id;
                    const isSelf = req.userId === actor.uid;
                    const gatedOut = access.gatedOnSelfCheckIn && !isSelf;
                    const disabled = saving || gatedOut;

                    return (
                      <div
                        key={req.id}
                        data-testid={`attendance-row-${req.userId}`}
                        className={`border rounded-large p-3 flex flex-col gap-2.5 ${
                          access.gatedOnSelfCheckIn && isSelf
                            ? 'border-primary bg-primary-50/50 dark:bg-primary-900/10'
                            : 'border-divider'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-foreground truncate inline-flex items-center gap-1.5">
                              {req.userName}
                              {access.gatedOnSelfCheckIn && isSelf && (
                                <Chip size="sm" variant="flat" color="primary" className="h-4 text-[10px] px-1.5">
                                  You
                                </Chip>
                              )}
                            </div>
                            <div className="text-xs text-foreground-500">
                              {req.teamName} · {slotRoleLabel(req.role)}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 flex-none flex-wrap justify-end">
                            <AttendanceChips attendance={attendance} />
                          </div>
                        </div>

                        {access.mode === 'live' && (
                          <div className="flex items-end gap-2 flex-wrap">
                            {!checkedIn && !attendance?.exception && (
                              <>
                                <Button
                                  size="sm"
                                  color="primary"
                                  variant="flat"
                                  onPress={() => handleCheckIn(req)}
                                  isLoading={saving}
                                  isDisabled={gatedOut}
                                >
                                  Check in
                                </Button>
                                <Button
                                  size="sm"
                                  variant="bordered"
                                  color="danger"
                                  onPress={() => handleSetException(req, 'no_show')}
                                  isDisabled={disabled}
                                >
                                  No-show
                                </Button>
                                <Button
                                  size="sm"
                                  variant="bordered"
                                  onPress={() => handleSetException(req, 'excused')}
                                  isDisabled={disabled}
                                >
                                  Excused
                                </Button>
                              </>
                            )}
                            {checkedIn && !hasEnded && (
                              <Button
                                size="sm"
                                variant="bordered"
                                onPress={() => handleCheckOut(req)}
                                isLoading={saving}
                                isDisabled={gatedOut}
                              >
                                Check out
                              </Button>
                            )}
                            {access.canClear && (checkedIn || attendance?.exception) && (
                              <Button size="sm" variant="light" onPress={() => handleClearAttendance(req)} isDisabled={disabled}>
                                Clear
                              </Button>
                            )}
                          </div>
                        )}

                        {access.mode === 'retro-edit' && (
                          <div className="flex items-end gap-2 flex-wrap">
                            <Input
                              size="sm"
                              type="time"
                              label="Arrived at"
                              className="w-32"
                              value={getArrivalDraft(req)}
                              onValueChange={(v) => req.id && setArrivalDrafts((prev) => ({ ...prev, [req.id!]: v }))}
                              isDisabled={saving}
                            />
                            <Input
                              size="sm"
                              type="time"
                              label="Left at"
                              className="w-32"
                              value={getDepartureDraft(req)}
                              onValueChange={(v) => req.id && setDepartureDrafts((prev) => ({ ...prev, [req.id!]: v }))}
                              isDisabled={saving}
                            />
                            <Button size="sm" variant="bordered" onPress={() => handleSaveRetro(req)} isLoading={saving}>
                              Save
                            </Button>
                            <Button
                              size="sm"
                              variant={attendance?.exception === 'no_show' ? 'solid' : 'bordered'}
                              color="danger"
                              onPress={() => handleSetException(req, 'no_show')}
                              isDisabled={saving}
                            >
                              No-show
                            </Button>
                            <Button
                              size="sm"
                              variant={attendance?.exception === 'excused' ? 'solid' : 'bordered'}
                              onPress={() => handleSetException(req, 'excused')}
                              isDisabled={saving}
                            >
                              Excused
                            </Button>
                            {access.canClear && (
                              <Button size="sm" variant="light" onPress={() => handleClearAttendance(req)} isDisabled={saving}>
                                Clear
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            </div>
          )}

          {canManage && (
            <div className={mobilePage === 'requests' ? 'block' : 'hidden md:block'}>
            <div className="flex flex-col gap-3">
              <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">Pending requests</div>
              {loadingRequests ? (
                <div className="flex justify-center py-4">
                  <Spinner size="sm" color="primary" />
                </div>
              ) : pending.length === 0 ? (
                <p className="text-sm text-foreground-400">No pending requests for this event.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {pending.map((req) => (
                    <div key={req.id} className="border border-divider rounded-large p-3 flex flex-col gap-2">
                      <div>
                        <div className="text-sm font-semibold text-foreground">{req.userName}</div>
                        <div className="text-xs text-foreground-500">
                          {req.teamName} · {slotRoleLabel(req.role)} · {formatMemberExperience(req.memberStatus, req.joinedTerm)}
                        </div>
                      </div>
                      {req.note && (
                        <div className="text-xs text-foreground-500 bg-content2 rounded-medium px-2 py-1.5 inline-flex items-start gap-1.5">
                          <Info size={12} className="mt-0.5 flex-none" /> {req.note}
                        </div>
                      )}
                      {rejectingId === req.id ? (
                        <div className="flex flex-col gap-2">
                          <Textarea
                            size="sm"
                            placeholder="Reason (optional)"
                            value={rejectReason}
                            onValueChange={setRejectReason}
                            minRows={1}
                          />
                          <div className="flex gap-2 justify-end">
                            <Button size="sm" variant="light" onPress={() => setRejectingId(null)} isDisabled={decidingId === req.id}>
                              Cancel
                            </Button>
                            <Button size="sm" color="danger" onPress={() => handleReject(req)} isLoading={decidingId === req.id}>
                              Confirm reject
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex gap-2 justify-end">
                          <Button
                            size="sm"
                            variant="bordered"
                            color="danger"
                            onPress={() => setRejectingId(req.id ?? null)}
                            isDisabled={decidingId === req.id}
                          >
                            Reject
                          </Button>
                          <Button size="sm" color="primary" onPress={() => handleApprove(req)} isLoading={decidingId === req.id}>
                            Approve
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            </div>
          )}
        </div>
    </PanelShell>
  );
}
