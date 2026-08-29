'use client';

/**
 * The Shifts board (`/events`) — calendar/list of staffed events, with
 * self-service shift requests for members and staffing/approval tools for
 * event managers (admin/quartermaster/medops). See `app/lib/events.ts` for
 * the data operations this page and its child components call into.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Spinner, Button } from '@heroui/react';
import { CalendarDays, LayoutList, Inbox, Plus, Check } from 'lucide-react';
import { useUserRole } from '@/app/hooks/useUserRole';
import {
  subscribeEvents,
  subscribeMyRequests,
  subscribePendingRequests,
  isEventManagerRole,
  deleteEvent,
  approveRequest,
  rejectRequest,
  slotRoleLabel,
  resolveOfferState,
  type EventActor,
} from '@/app/lib/events';
import type { Event, ShiftRequest } from '@/app/types';
import EventCalendar from '@/app/components/events/event-calendar';
import EventList from '@/app/components/events/event-list';
import EventDetailDrawer from '@/app/components/events/event-detail-drawer';
import EventEditorModal from '@/app/components/events/event-editor-modal';
import NotifyModal from '@/app/components/events/notify-modal';
import WaitlistOfferModal from '@/app/components/events/waitlist-offer-modal';

type ViewMode = 'calendar' | 'list' | 'requests';

export default function EventsPage() {
  const router = useRouter();
  const { user, userData, role, fullName, effectiveUid, loading: authLoading } = useUserRole();
  const canManage = isEventManagerRole(role);

  const [events, setEvents] = useState<Event[]>([]);
  const [myRequests, setMyRequests] = useState<ShiftRequest[]>([]);
  const [pendingRequests, setPendingRequests] = useState<ShiftRequest[]>([]);
  const [loading, setLoading] = useState(true);
  // `?event=<id>` deep link (e.g. from a dashboard "Upcoming Shifts" row or a
  // shift-request notification), read lazily from window.location.search so it
  // keeps working under `output: export` (no useSearchParams / Suspense).
  const [deepLinkEventId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('event');
  });
  const [deepLinkHandled, setDeepLinkHandled] = useState(false);
  // `?offer=<requestId>` deep link (from a shift-offer notification or the
  // dashboard "Shift Offers" card) — same lazy window.location.search read as
  // `?event=` above, for the same output:export/no-Suspense reason. Opens
  // WaitlistOfferModal on top of the drawer once the deep-linked event has
  // resolved and the viewer's own requests have loaded.
  const [deepLinkOfferId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('offer');
  });
  const [offerDeepLinkHandled, setOfferDeepLinkHandled] = useState(false);
  const [myRequestsLoaded, setMyRequestsLoaded] = useState(false);
  const [offerRequest, setOfferRequest] = useState<ShiftRequest | null>(null);

  const [viewMode, setViewMode] = useState<ViewMode>('calendar');
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<Event | null>(null);
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !user) router.push('/login');
  }, [authLoading, user, router]);

  useEffect(() => {
    const unsub = subscribeEvents((evs) => {
      setEvents(evs);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  // Once events have loaded, open the drawer for the deep-linked event (if any).
  // Guarded by deepLinkHandled so it only auto-opens once — the user can close
  // the drawer afterward without it snapping back open on the next events tick.
  useEffect(() => {
    if (deepLinkHandled || !deepLinkEventId || loading) return;
    const ev = events.find((e) => e.id === deepLinkEventId);
    if (ev) {
      setSelectedEvent(ev);
      setDeepLinkHandled(true);
    }
  }, [deepLinkEventId, deepLinkHandled, events, loading]);

  useEffect(() => {
    if (!effectiveUid) {
      setMyRequests([]);
      return;
    }
    const unsub = subscribeMyRequests(effectiveUid, (requests) => {
      setMyRequests(requests);
      setMyRequestsLoaded(true);
    });
    return () => unsub();
  }, [effectiveUid]);

  useEffect(() => {
    if (!canManage) {
      setPendingRequests([]);
      return;
    }
    const unsub = subscribePendingRequests(setPendingRequests);
    return () => unsub();
  }, [canManage]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  // Keep the drawer's event in sync with live updates (e.g. an approval elsewhere).
  const liveSelectedEvent = useMemo(
    () => (selectedEvent ? (events.find((e) => e.id === selectedEvent.id) ?? selectedEvent) : null),
    [selectedEvent, events],
  );

  // Once the deep-linked event's drawer has resolved (deepLinkHandled above)
  // and the viewer's own requests have loaded, auto-open the offer modal for
  // the matching `?offer=` request — but only while it's still live per
  // `resolveOfferState` (§5.7: never open a modal onto a resolved offer, e.g.
  // one already accepted/declined/expired via another tab, or swept stale).
  // Guarded by offerDeepLinkHandled exactly like deepLinkHandled so closing
  // the modal doesn't snap it back open on the next requests snapshot.
  useEffect(() => {
    if (offerDeepLinkHandled || !deepLinkOfferId || !liveSelectedEvent || !myRequestsLoaded) return;
    const req = myRequests.find((r) => r.id === deepLinkOfferId);
    if (req && resolveOfferState(req, new Date()) === 'offered') {
      setOfferRequest(req);
    }
    setOfferDeepLinkHandled(true);
  }, [deepLinkOfferId, offerDeepLinkHandled, liveSelectedEvent, myRequestsLoaded, myRequests]);

  const actor: EventActor = {
    uid: effectiveUid ?? 'unknown',
    name: fullName || user?.email || 'Unknown',
    role: role ?? undefined,
  };

  const notify = (ok: boolean, msg: string) => setToast({ ok, msg });

  const handleDelete = async () => {
    if (!liveSelectedEvent?.id) return;
    try {
      await deleteEvent(liveSelectedEvent.id);
      notify(true, `${liveSelectedEvent.name} deleted`);
      setSelectedEvent(null);
    } catch (e) {
      notify(false, e instanceof Error ? e.message : 'Failed to delete event');
    }
  };

  const handleNotifySent = (count: number) => {
    notify(true, `Notified ${count} member${count === 1 ? '' : 's'}`);
  };

  const openCount = events.filter((e) => e.status === 'open').length;
  const myConfirmedCount = myRequests.filter((r) => r.status === 'approved').length;
  const myPendingCount = myRequests.filter((r) => r.status === 'pending').length;
  // [Phase 0 / waitlist plan §2.1] Without this the header undercounts a
  // member's involvement once waitlisted/offered docs exist — today it's
  // always 0 since no code writes those statuses yet. Neutral count only, no
  // queue position breakdown (Phase 1).
  const myQueueCount = myRequests.filter((r) => r.status === 'waitlisted' || r.status === 'offered').length;
  // [Phase 0 / waitlist plan §2.1, orchestrator addition] `subscribePendingRequests`
  // now also returns waitlisted/offered docs (for Phase 1's manager queue
  // panel); the approve/reject inbox below only understands 'pending', so it
  // must filter explicitly rather than trust the feed's old name.
  const actionablePendingRequests = pendingRequests.filter((r) => r.status === 'pending');

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  const viewTabs: { mode: ViewMode; icon: React.ReactNode; label: string }[] = [
    { mode: 'calendar', icon: <CalendarDays size={14} />, label: 'Calendar' },
    { mode: 'list', icon: <LayoutList size={14} />, label: 'List' },
    ...(canManage ? [{ mode: 'requests' as ViewMode, icon: <Inbox size={14} />, label: 'Requests' }] : []),
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
      <main className="max-w-7xl mx-auto px-4 sm:px-6 pt-6 sm:pt-8 pb-28 md:pb-8">
        {/* Header */}
        <div className="flex items-end justify-between gap-4 mb-6 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-foreground mb-1.5">Shifts</h1>
            <div className="flex items-center gap-2 flex-wrap mt-1">
              <div className="flex items-center gap-2 bg-content1 border border-divider rounded-large px-3 py-1.5">
                <span className="font-mono font-semibold tabular-nums text-foreground">{events.length}</span>
                <span className="text-xs text-foreground-400">events</span>
              </div>
              <div className="flex items-center gap-2 bg-primary-50 dark:bg-primary-900/20 border border-primary/30 rounded-large px-3 py-1.5">
                <span className="w-2 h-2 rounded-sm bg-primary flex-none" />
                <span className="font-mono font-semibold tabular-nums text-primary">{openCount}</span>
                <span className="text-xs text-primary/80 font-medium">open</span>
              </div>
              <div className="flex items-center gap-2 bg-success-50 dark:bg-success-900/20 border border-success/30 rounded-large px-3 py-1.5">
                <span className="w-2 h-2 rounded-sm bg-success flex-none" />
                <span className="font-mono font-semibold tabular-nums text-success">{myConfirmedCount}</span>
                <span className="text-xs text-success/80 font-medium">confirmed</span>
              </div>
              {myPendingCount > 0 && (
                <div className="flex items-center gap-2 bg-warning-50 dark:bg-warning-900/20 border border-warning/30 rounded-large px-3 py-1.5">
                  <span className="w-2 h-2 rounded-sm bg-warning flex-none" />
                  <span className="font-mono font-semibold tabular-nums text-warning">{myPendingCount}</span>
                  <span className="text-xs text-warning/80 font-medium">requested</span>
                </div>
              )}
              {myQueueCount > 0 && (
                <div className="flex items-center gap-2 bg-content2 border border-divider rounded-large px-3 py-1.5">
                  <span className="w-2 h-2 rounded-sm bg-foreground-400 flex-none" />
                  <span className="font-mono font-semibold tabular-nums text-foreground-500">{myQueueCount}</span>
                  <span className="text-xs text-foreground-500 font-medium">waitlisted</span>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex bg-content1 border border-divider rounded-large p-1 gap-1">
              {viewTabs.map(({ mode, icon, label }) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-medium text-sm font-semibold transition-colors duration-150 ${
                    viewMode === mode ? 'bg-primary text-white' : 'text-foreground-500 hover:bg-content2'
                  }`}
                >
                  {icon} {label}
                  {/* [Phase 0 / waitlist plan §2.1, orchestrator addition] Must
                      use the filtered count, not `pendingRequests.length` —
                      that feed now also carries waitlisted/offered docs. */}
                  {mode === 'requests' && actionablePendingRequests.length > 0 && (
                    <span
                      className={`font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                        viewMode === mode ? 'bg-white/20 text-white' : 'bg-danger-50 dark:bg-danger-900/20 text-danger'
                      }`}
                    >
                      {actionablePendingRequests.length}
                    </span>
                  )}
                </button>
              ))}
            </div>
            {canManage && (
              <Button
                color="primary"
                startContent={<Plus size={15} />}
                onPress={() => {
                  setEditingEvent(null);
                  setEditorOpen(true);
                }}
              >
                New event
              </Button>
            )}
          </div>
        </div>

        {viewMode === 'calendar' && (
          <EventCalendar
            month={month}
            onMonthChange={setMonth}
            events={events}
            myRequests={myRequests}
            pendingRequests={pendingRequests}
            canManage={canManage}
            onSelectEvent={setSelectedEvent}
          />
        )}

        {viewMode === 'list' && (
          <EventList
            events={events}
            myRequests={myRequests}
            pendingRequests={pendingRequests}
            canManage={canManage}
            onSelectEvent={setSelectedEvent}
          />
        )}

        {viewMode === 'requests' && canManage && (
          // [Phase 0 / waitlist plan §2.1, orchestrator addition] This inbox
          // only renders Approve/Reject actions, which are meaningless (and
          // wrong) for a waitlisted/offered entry — feed it the filtered list,
          // not the raw (now-widened) `pendingRequests`. Phase 1's queue panel
          // is where waitlisted/offered entries belong (§5.4).
          <PendingRequestsInbox
            requests={actionablePendingRequests}
            actor={actor}
            decidingId={decidingId}
            setDecidingId={setDecidingId}
            onToast={notify}
            onOpenEvent={(eventId) => {
              const ev = events.find((e) => e.id === eventId);
              if (ev) setSelectedEvent(ev);
            }}
          />
        )}
      </main>

      {liveSelectedEvent && (
        <EventDetailDrawer
          event={liveSelectedEvent}
          canManage={canManage}
          actor={actor}
          userData={userData}
          onClose={() => setSelectedEvent(null)}
          onEdit={() => {
            setEditingEvent(liveSelectedEvent);
            setEditorOpen(true);
          }}
          onDelete={handleDelete}
          onNotify={() => setNotifyOpen(true)}
          onToast={notify}
        />
      )}

      <EventEditorModal
        isOpen={editorOpen}
        onClose={() => setEditorOpen(false)}
        event={editingEvent}
        actor={actor}
        onSaved={(msg) => notify(true, msg)}
        onError={(msg) => notify(false, msg)}
      />

      <NotifyModal
        isOpen={notifyOpen}
        onClose={() => setNotifyOpen(false)}
        event={liveSelectedEvent}
        actor={actor}
        onSent={handleNotifySent}
        onError={(msg) => notify(false, msg)}
      />

      {offerRequest && liveSelectedEvent && (
        <WaitlistOfferModal
          isOpen={!!offerRequest}
          onClose={() => setOfferRequest(null)}
          request={offerRequest}
          event={liveSelectedEvent}
          actor={actor}
          onDecided={(ok, msg) => {
            notify(ok, msg);
            setOfferRequest(null);
          }}
        />
      )}

      {toast && (
        <div
          className={`fixed z-[60] bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-lg text-sm font-semibold text-white max-w-[92vw] ${toast.ok ? 'bg-success' : 'bg-danger'}`}
        >
          <div className="w-5 h-5 rounded-full bg-white/25 flex items-center justify-center flex-none">
            {toast.ok ? <Check size={12} strokeWidth={3.5} /> : <span className="text-xs leading-none">✕</span>}
          </div>
          <span>{toast.msg}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Derived experience label for a shift request, from denormalized
 * `memberStatus`/`joinedTerm` (replaces the old free-text `ranking` field).
 * e.g. "General · Fall 2025", or just "New" if no term is recorded.
 */
function formatExperience(req: ShiftRequest): string {
  const status = req.memberStatus || 'general';
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return req.joinedTerm ? `${label} · ${req.joinedTerm}` : label;
}

function PendingRequestsInbox({
  requests,
  actor,
  decidingId,
  setDecidingId,
  onToast,
  onOpenEvent,
}: {
  requests: ShiftRequest[];
  actor: EventActor;
  decidingId: string | null;
  setDecidingId: (id: string | null) => void;
  onToast: (ok: boolean, msg: string) => void;
  onOpenEvent: (eventId: string) => void;
}) {
  const handleApprove = async (req: ShiftRequest) => {
    if (!req.id) return;
    setDecidingId(req.id);
    try {
      await approveRequest(req, actor);
      onToast(true, `Approved ${req.userName}`);
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to approve');
    } finally {
      setDecidingId(null);
    }
  };

  const handleReject = async (req: ShiftRequest) => {
    if (!req.id) return;
    setDecidingId(req.id);
    try {
      await rejectRequest(req, actor);
      onToast(true, `Rejected ${req.userName}`);
    } catch (e) {
      onToast(false, e instanceof Error ? e.message : 'Failed to reject');
    } finally {
      setDecidingId(null);
    }
  };

  if (requests.length === 0) {
    return (
      <div className="bg-content1 border border-divider rounded-large px-6 py-12 text-center">
        <Inbox size={40} className="mx-auto mb-3 text-foreground-400" />
        <p className="text-sm text-foreground-500">No pending requests.</p>
      </div>
    );
  }

  const sorted = [...requests].sort((a, b) => (a.eventName || '').localeCompare(b.eventName || ''));

  return (
    <div className="flex flex-col gap-3">
      {sorted.map((req) => (
        <div
          key={req.id}
          className="bg-content1 border border-divider rounded-large px-4 py-4 flex items-center justify-between gap-3 flex-wrap"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-foreground">{req.userName}</span>
              <span className="text-xs text-foreground-400">→</span>
              <button
                onClick={() => req.eventId && onOpenEvent(req.eventId)}
                className="text-sm font-semibold text-primary hover:underline"
              >
                {req.eventName}
              </button>
            </div>
            <div className="text-xs text-foreground-500 mt-0.5">
              {req.teamName} · {slotRoleLabel(req.role)}
              {` · ${formatExperience(req)}`}
              {req.note ? ` — "${req.note}"` : ''}
            </div>
          </div>
          <div className="flex gap-2 flex-none">
            <Button size="sm" variant="bordered" color="danger" onPress={() => handleReject(req)} isLoading={decidingId === req.id}>
              Reject
            </Button>
            <Button size="sm" color="primary" onPress={() => handleApprove(req)} isLoading={decidingId === req.id}>
              Approve
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
