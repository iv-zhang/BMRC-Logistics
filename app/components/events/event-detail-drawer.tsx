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
  endEventShifts,
  formatMemberExperience,
  type EventActor,
} from '@/app/lib/events';
import type { Event, EventStatus, ShiftRequest, User } from '@/app/types';
import TeamCard from './team-card';
import { formatEventDate, formatTimeRange, toJsDate, eventCallDateTime, computeMinutesLate } from './event-utils';

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
  const isAssignedFto = useMemo(
    () => (event.teams || []).some((t) => t.ftoSlot?.userId === actor.uid),
    [event.teams, actor.uid],
  );
  const showAttendance = isAssignedFto || userData?.role === 'admin' || userData?.role === 'quartermaster';

  const [arrivalDrafts, setArrivalDrafts] = useState<Record<string, string>>({});
  const [attendanceSavingId, setAttendanceSavingId] = useState<string | null>(null);
  const [endingShifts, setEndingShifts] = useState(false);

  type MobilePage = 'details' | 'teams' | 'attendance' | 'requests';
  const [mobilePage, setMobilePage] = useState<MobilePage>('details');

  const eventDay = useMemo(() => toJsDate(event.date), [event.date]);
  const callDateTime = useMemo(() => eventCallDateTime(event), [event]);

  /** The "Arrived at" time input value: the in-progress edit, else the existing check-in, else now. */
  const getArrivalDraft = (req: ShiftRequest): string => {
    if (req.id && arrivalDrafts[req.id] !== undefined) return arrivalDrafts[req.id];
    const existing = toJsDate(req.attendance?.checkedInAt);
    return toHHmm(existing ?? new Date());
  };

  const handleCheckInNow = async (req: ShiftRequest) => {
    if (!req.id) return;
    setAttendanceSavingId(req.id);
    try {
      const now = new Date();
      const minutesLate = computeMinutesLate(now, callDateTime);
      await recordAttendance(req, { checkedInAt: now, minutesLate }, actor);
      onToast(true, `${req.userName} checked in${minutesLate > 0 ? ` — late by ${minutesLate}m` : ''}`);
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to check in');
    } finally {
      setAttendanceSavingId(null);
    }
  };

  const handleSaveArrival = async (req: ShiftRequest) => {
    if (!req.id || !eventDay) return;
    const arrival = combineDayAndTime(eventDay, getArrivalDraft(req));
    if (!arrival) {
      onToast(false, 'Enter a valid time');
      return;
    }
    setAttendanceSavingId(req.id);
    try {
      const minutesLate = computeMinutesLate(arrival, callDateTime);
      await recordAttendance(req, { checkedInAt: arrival, minutesLate }, actor);
      onToast(true, `${req.userName}: arrived ${toHHmm(arrival)}`);
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to save arrival time');
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
      const count = await endEventShifts(event.id, actor);
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
    const sections: { key: MobilePage; label: string }[] = [];
    if (event.description || myActiveRequest) sections.push({ key: 'details', label: 'Details' });
    sections.push({ key: 'teams', label: 'Teams' });
    if (showAttendance) sections.push({ key: 'attendance', label: 'Attendance' });
    if (canManage) sections.push({ key: 'requests', label: 'Requests' });
    return sections;
  }, [event.description, myActiveRequest, showAttendance, canManage]);

  useEffect(() => {
    if (mobileSections.length > 0 && !mobileSections.some((s) => s.key === mobilePage)) {
      setMobilePage(mobileSections[0].key);
    }
  }, [mobileSections, mobilePage]);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed top-0 right-0 bottom-0 z-50 w-full md:w-[480px] md:max-w-[94vw] bg-content1 shadow-2xl flex flex-col">
        {/* Header */}
        <div className="px-6 py-5 border-b border-divider">
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

        {/* Mobile page switcher */}
        {mobileSections.length > 1 && (
          <div className="md:hidden flex gap-1.5 overflow-x-auto px-6 py-2 border-b border-divider">
            {mobileSections.map((s) => {
              const active = mobilePage === s.key;
              return (
                <button
                  key={s.key}
                  onClick={() => setMobilePage(s.key)}
                  className={`flex-none text-xs font-semibold px-2.5 py-1.5 rounded-medium border transition-colors duration-150 ${
                    active ? 'bg-content3 border-content3 text-foreground' : 'bg-content2 border-divider text-foreground-500 hover:bg-content3'
                  }`}
                >
                  {s.label}
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
                        {myActiveRequest.teamName} · {myActiveRequest.role}
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

          {showAttendance && (
            <div className={mobilePage === 'attendance' ? 'block' : 'hidden md:block'}>
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 inline-flex items-center gap-1.5">
                  <ClipboardCheck size={11} /> Attendance
                </div>
                <Button
                  size="sm"
                  variant="light"
                  startContent={<LogOut size={13} />}
                  onPress={handleEndShifts}
                  isLoading={endingShifts}
                  isDisabled={approved.length === 0}
                >
                  End shift
                </Button>
              </div>
              {loadingRequests ? (
                <div className="flex justify-center py-4">
                  <Spinner size="sm" color="primary" />
                </div>
              ) : approved.length === 0 ? (
                <p className="text-sm text-foreground-400">No confirmed members yet.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {approved.map((req) => {
                    const attendance = req.attendance;
                    const checkedIn = !!attendance?.checkedInAt && !attendance?.exception;
                    const arrivalDate = attendance?.checkedInAt ? toJsDate(attendance.checkedInAt) : null;
                    const lateMinutes = attendance?.minutesLate ?? 0;
                    const saving = attendanceSavingId === req.id;
                    return (
                      <div key={req.id} className="border border-divider rounded-large p-3 flex flex-col gap-2.5">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-foreground truncate">{req.userName}</div>
                            <div className="text-xs text-foreground-500">
                              {req.teamName} · {req.role}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 flex-none flex-wrap justify-end">
                            {attendance?.exception ? (
                              <Chip size="sm" variant="flat" color={attendance.exception === 'no_show' ? 'danger' : 'default'}>
                                {attendance.exception === 'no_show' ? 'No-show' : 'Excused'}
                              </Chip>
                            ) : checkedIn ? (
                              <>
                                <Chip size="sm" variant="flat" color="success">
                                  Arrived {arrivalDate ? toHHmm(arrivalDate) : ''}
                                </Chip>
                                {lateMinutes > 0 && (
                                  <Chip size="sm" variant="flat" color="warning">
                                    Late by {lateMinutes}m
                                  </Chip>
                                )}
                              </>
                            ) : (
                              <Chip size="sm" variant="flat" color="default">Unrecorded</Chip>
                            )}
                          </div>
                        </div>

                        <div className="flex items-end gap-2 flex-wrap">
                          {!checkedIn && !attendance?.exception && (
                            <Button size="sm" color="primary" variant="flat" onPress={() => handleCheckInNow(req)} isLoading={saving}>
                              Check in
                            </Button>
                          )}
                          <Input
                            size="sm"
                            type="time"
                            label="Arrived at"
                            className="w-32"
                            value={getArrivalDraft(req)}
                            onValueChange={(v) => req.id && setArrivalDrafts((prev) => ({ ...prev, [req.id!]: v }))}
                            isDisabled={saving}
                          />
                          <Button size="sm" variant="bordered" onPress={() => handleSaveArrival(req)} isLoading={saving}>
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
                          {(checkedIn || attendance?.exception) && (
                            <Button size="sm" variant="light" onPress={() => handleClearAttendance(req)} isDisabled={saving}>
                              Clear
                            </Button>
                          )}
                        </div>
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
                          {req.teamName} · {req.role} · {formatMemberExperience(req.memberStatus, req.joinedTerm)}
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
      </div>
    </>
  );
}
