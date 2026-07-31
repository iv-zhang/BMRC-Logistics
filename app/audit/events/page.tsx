'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  collection,
  query,
  orderBy,
  limit,
  getDocs,
  startAfter,
  type QueryDocumentSnapshot,
  type DocumentData,
  Timestamp,
} from 'firebase/firestore';
import { db } from '@/firebase';
import { useUserRole } from '@/app/hooks/useUserRole';
import {
  Button,
  Chip,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Spinner,
} from '@heroui/react';
import {
  ClipboardCheck,
  AlertTriangle,
  Activity,
  User,
  Package,
  ClipboardList,
  Search,
  ArrowLeft,
  ScrollText,
  X,
} from 'lucide-react';

type AuditEventView = {
  id: string;
  eventType: string;
  actor?: {
    userId?: string | null;
    userName?: string | null;
    userEmail?: string | null;
    role?: string | null;
  } | null;
  timestamp?: unknown;
  targets?: Array<{ collection: string; docId: string; fieldPath?: string }>;
  details?: Record<string, unknown> | null;
  delta?: unknown;
  before?: unknown;
  after?: unknown;
  source?: string;
  sourceId?: string;
};

const PAGE_SIZE = 50;

const getEventIcon = (eventType: string) => {
  const normalized = (eventType || '').toLowerCase();
  if (normalized.includes('issue') || normalized.includes('error')) return <AlertTriangle size={16} />;
  if (normalized.includes('restock') || normalized.includes('inventory')) return <Package size={16} />;
  if (normalized.includes('audit')) return <ClipboardCheck size={16} />;
  if (normalized.includes('check')) return <ClipboardList size={16} />;
  return <Activity size={16} />;
};

const eventIconTone = (eventType: string) => {
  const normalized = (eventType || '').toLowerCase();
  if (normalized.includes('issue') || normalized.includes('error'))
    return 'bg-danger-50 dark:bg-danger-900/20 text-danger';
  if (normalized.includes('audit'))
    return 'bg-success-50 dark:bg-success-900/20 text-success';
  return 'bg-primary-50 dark:bg-primary-900/20 text-primary';
};

const formatEventType = (raw?: string) => {
  if (!raw) return 'Event';
  const withSpaces = raw
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return withSpaces
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
};

const formatTimestamp = (ts?: unknown) => {
  if (!ts) return 'Unknown time';
  if (ts instanceof Timestamp) return ts.toDate().toLocaleString();
  if (ts instanceof Date) return ts.toLocaleString();
  if (typeof ts === 'string' || typeof ts === 'number') return new Date(ts).toLocaleString();
  if (typeof (ts as { toDate?: () => Date })?.toDate === 'function') return (ts as { toDate: () => Date }).toDate().toLocaleString();
  return String(ts);
};

const getActorLabel = (actor?: AuditEventView['actor']) =>
  actor?.userName || actor?.userEmail || actor?.userId || 'system';

const extractString = (value: unknown) => (typeof value === 'string' ? value : undefined);

const findFirst = (details: Record<string, unknown> | null | undefined, keys: string[]) => {
  if (!details) return undefined;
  for (const key of keys) {
    if (details[key] !== undefined && details[key] !== null) return details[key];
  }
  return undefined;
};

const extractUsedItems = (details?: Record<string, unknown> | null) => {
  if (!details) return [] as Array<{ name: string; quantity: number }>;
  const itemsUsed = details.itemsUsed as Record<string, number> | undefined;
  if (!itemsUsed) return [];
  return Object.entries(itemsUsed).map(([name, quantity]) => ({ name, quantity }));
};

const extractIssueReports = (details?: Record<string, unknown> | null) => {
  const issueReports = (details?.issues as { issueReports?: Record<string, { issueType?: string; notes?: string }> })
    ?.issueReports;
  if (!issueReports) return [] as Array<{ name: string; issueType?: string; notes?: string }>;
  return Object.entries(issueReports).map(([name, value]) => ({ name, issueType: value?.issueType, notes: value?.notes }));
};

export default function AuditEventsPage() {
  const router = useRouter();
  const { loading: roleLoading, role } = useUserRole();
  const isAdmin = role === 'admin' || role === 'quartermaster';

  const [events, setEvents] = useState<AuditEventView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastDoc, setLastDoc] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [selected, setSelected] = useState<AuditEventView | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [filter, setFilter] = useState('');

  const normalizeDoc = useCallback((docSnap: QueryDocumentSnapshot<DocumentData>): AuditEventView => {
    const data = docSnap.data();
    return {
      id: docSnap.id,
      eventType: data.eventType || data.action || 'auditEvent',
      actor: data.actor || {
        userId: data.userId ?? null,
        userName: data.userName ?? data.userEmail ?? null,
        userEmail: data.userEmail ?? null,
        role: data.role ?? null,
      },
      timestamp: data.timestamp || data.createdAt || null,
      targets: data.targets || (data.itemId ? [{ collection: 'inventory', docId: data.itemId }] : data.statpackId ? [{ collection: 'statpacks', docId: data.statpackId }] : []),
      details: (data.details as Record<string, unknown>) ?? data,
      delta: data.delta || null,
      before: data.before || null,
      after: data.after || null,
      source: data.source || undefined,
      sourceId: data.sourceId || undefined,
    };
  }, []);

  const fetchPage = useCallback(
    async (startAfterDoc?: QueryDocumentSnapshot<DocumentData> | null) => {
      try {
        const baseQuery = query(
          collection(db, 'auditEvents'),
          orderBy('timestamp', 'desc'),
          limit(PAGE_SIZE),
          ...(startAfterDoc ? [startAfter(startAfterDoc)] : [])
        );
        const snap = await getDocs(baseQuery);
        const normalized = snap.docs.map((doc) => normalizeDoc(doc));
        setLastDoc(snap.docs[snap.docs.length - 1] ?? null);
        setHasMore(snap.docs.length === PAGE_SIZE);
        return normalized;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to load audit events';
        setError(msg);
        return [] as AuditEventView[];
      }
    },
    [normalizeDoc]
  );

  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      const initial = await fetchPage(null);
      if (mounted) {
        setEvents(initial);
        setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [fetchPage]);

  const handleLoadMore = async () => {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    const nextPage = await fetchPage(lastDoc);
    setEvents((prev) => [...prev, ...nextPage]);
    setLoadingMore(false);
  };

  const filteredEvents = useMemo(() => {
    // Supply ledger view: exclude asset lifecycle events
    const disposablesOnly = events.filter((ev) => {
      const eventType = (ev.eventType || '').toLowerCase();
      const source = (ev.source || '').toLowerCase();
      if (eventType.includes('asset_checkout') ||
          eventType.includes('asset_checkin') ||
          eventType.includes('asset_assign') ||
          eventType.includes('asset_maintenance') ||
          eventType.includes('asset_manual_check') ||
          source === 'inventory_logs') {
        return false;
      }
      return true;
    });

    if (!filter.trim()) return disposablesOnly;
    const needle = filter.toLowerCase();
    return disposablesOnly.filter((ev) => {
      const actor = getActorLabel(ev.actor).toLowerCase();
      const targetText = (ev.targets || [])
        .map((t) => `${t.collection}/${t.docId}`)
        .join(' ')
        .toLowerCase();
      const detailsText = JSON.stringify(ev.details || {}).toLowerCase();
      return (
        (ev.eventType || '').toLowerCase().includes(needle) ||
        actor.includes(needle) ||
        targetText.includes(needle) ||
        detailsText.includes(needle)
      );
    });
  }, [events, filter]);

  const openModal = (event: AuditEventView) => {
    setSelected(event);
    setShowRaw(false);
    setIsModalOpen(true);
  };

  // Derived values for selected event modal
  const selectedDetails = (selected?.details || {}) as Record<string, unknown>;
  const selectedActorLabel = getActorLabel(selected?.actor);
  const selectedCheckoutAt = findFirst(selectedDetails, ['checkedOutAt', 'checkoutAt', 'checked_out_at']);
  const selectedCheckinAt = findFirst(selectedDetails, ['checkedInAt', 'checkinAt', 'lastCheckedInAt', 'returnedAt']);
  const selectedReason = findFirst(selectedDetails, ['reason', 'notes', 'message', 'issueType']);
  const selectedItemsUsed = extractUsedItems(selectedDetails);
  const selectedIssueReports = extractIssueReports(selectedDetails);

  if (roleLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center p-4">
        <div className="bg-content1 border border-divider rounded-large max-w-md w-full text-center py-10 px-6">
          <ScrollText size={40} className="mx-auto text-foreground-300 mb-4" />
          <h2 className="text-base font-semibold text-foreground mb-2">Admin Access Required</h2>
          <p className="text-sm text-foreground-500">Only admins can view the supply ledger.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">

        {/* ── Page header ────────────────────────────────────────────────── */}
        <div className="flex items-end justify-between gap-4 mb-6 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-foreground mb-1.5">Supply Ledger</h1>
            <div className="flex items-center gap-3 text-sm text-foreground-500 flex-wrap">
              <span>
                <span className="font-semibold text-foreground tabular-nums">{filteredEvents.length}</span> events loaded
              </span>
              <span className="w-1 h-1 rounded-full bg-divider" />
              <span>Boxes added, opened, counted, and restocked</span>
            </div>
          </div>
          <Button
            size="sm"
            variant="flat"
            startContent={<ArrowLeft size={14} />}
            onPress={() => router.push('/audit')}
          >
            Back to audit
          </Button>
        </div>

        {/* ── Filter ─────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 bg-content1 border border-divider rounded-large px-4 py-1 mb-4">
          <Search size={16} className="text-foreground-400 flex-none" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by actor, event, item, or keyword…"
            className="flex-1 text-sm bg-transparent outline-none py-2.5 text-foreground placeholder:text-foreground-400"
          />
          {filter && (
            <button onClick={() => setFilter('')} className="text-foreground-400 hover:text-foreground-600 transition-colors">
              <X size={15} />
            </button>
          )}
        </div>

        {error && (
          <div className="bg-danger-50/60 dark:bg-danger-950/20 border border-danger/30 rounded-large p-4 mb-4">
            <div className="text-sm text-danger font-semibold">{error}</div>
          </div>
        )}

        {/* ── Event list ─────────────────────────────────────────────────── */}
        {loading ? (
          <div className="bg-content1 border border-divider rounded-large flex items-center justify-center py-16">
            <Spinner size="md" color="primary" />
          </div>
        ) : filteredEvents.length === 0 ? (
          <div className="bg-content1 border border-dashed border-divider rounded-large text-center py-16">
            <ScrollText size={32} className="mx-auto text-foreground-300 mb-2" />
            <p className="text-sm font-semibold text-foreground-500">No events found</p>
            <p className="text-xs text-foreground-400 mt-1">Try clearing the filter.</p>
          </div>
        ) : (
          <div className="bg-content1 border border-divider rounded-large divide-y divide-divider overflow-hidden">
            {filteredEvents.map((ev) => {
              const actor = getActorLabel(ev.actor);
              const timestampLabel = formatTimestamp(ev.timestamp);
              const details = ev.details || {};
              const itemName = extractString((details as Record<string, unknown>).itemName) ||
                extractString((details as Record<string, unknown>).statpackName) ||
                extractString((details as Record<string, unknown>).name);
              const friendlyEvent = formatEventType(ev.eventType || ev.source || 'Event');
              return (
                <button
                  key={ev.id}
                  onClick={() => openModal(ev)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-content2 transition-colors duration-150"
                >
                  <div className={`w-9 h-9 rounded-[9px] flex items-center justify-center flex-none ${eventIconTone(ev.eventType)}`}>
                    {getEventIcon(ev.eventType)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm text-foreground">{friendlyEvent}</span>
                      {itemName && <span className="text-xs text-foreground-500 truncate">{itemName}</span>}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-foreground-400 mt-0.5 flex-wrap">
                      <span className="flex items-center gap-1"><User size={11} /> {actor}</span>
                      <span className="w-1 h-1 rounded-full bg-divider" />
                      <span>{timestampLabel}</span>
                    </div>
                  </div>
                  {ev.targets && ev.targets.length > 0 && (
                    <span className="font-mono text-xs text-foreground-400 flex-none hidden sm:block truncate max-w-[180px]">
                      {ev.targets[0].collection}/{ev.targets[0].docId}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex justify-center mt-4">
          <Button
            size="sm"
            variant="bordered"
            onPress={handleLoadMore}
            isDisabled={!hasMore || loadingMore}
            isLoading={loadingMore}
          >
            {hasMore ? 'Load older' : 'No more events'}
          </Button>
        </div>
      </div>

      {/* ── Detail modal ─────────────────────────────────────────────────── */}
      <Modal isOpen={isModalOpen} onOpenChange={setIsModalOpen} size="3xl" scrollBehavior="inside">
        <ModalContent>
          <>
            <ModalHeader className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <div className={`w-8 h-8 rounded-[8px] flex items-center justify-center flex-none ${eventIconTone(selected?.eventType || '')}`}>
                  {getEventIcon(selected?.eventType || '')}
                </div>
                <span className="text-base font-semibold text-foreground">
                  {formatEventType(selected?.eventType || selected?.source || 'Event Details')}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs text-foreground-400">
                <User size={13} /> {selectedActorLabel}
                <span className="w-1 h-1 rounded-full bg-divider" />
                {formatTimestamp(selected?.timestamp)}
              </div>
            </ModalHeader>
            <ModalBody className="gap-4">
              {selected?.targets && selected.targets.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {selected.targets.map((t) => (
                    <Chip key={`${selected.id}-${t.collection}-${t.docId}`} size="sm" variant="flat">
                      <span className="font-mono">{t.collection}/{t.docId}</span>
                    </Chip>
                  ))}
                </div>
              )}

              <div className="bg-content2 rounded-large p-4">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-2">Timeline</div>
                <div className="space-y-1 text-xs text-foreground-500">
                  <div>Checked out: {selectedCheckoutAt ? formatTimestamp(selectedCheckoutAt) : '—'}</div>
                  <div>Checked in: {selectedCheckinAt ? formatTimestamp(selectedCheckinAt) : '—'}</div>
                  <div>Reason / Notes: {selectedReason ? String(selectedReason) : '—'}</div>
                </div>
              </div>

              {(selectedItemsUsed.length > 0 || selectedIssueReports.length > 0) && (
                <div className="bg-content2 rounded-large p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-2">
                    Statpack Usage / Issues
                  </div>
                  {selectedItemsUsed.length > 0 && (
                    <div className="text-xs text-foreground-500">
                      <div className="font-semibold text-foreground-600 mb-1">Items used</div>
                      <ul className="space-y-0.5">
                        {selectedItemsUsed.map((item) => (
                          <li key={`${item.name}-${item.quantity}`}>
                            {item.name}: <span className="font-mono tabular-nums">{item.quantity}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {selectedIssueReports.length > 0 && (
                    <div className="text-xs text-foreground-500 mt-2">
                      <div className="font-semibold text-foreground-600 mb-1">Reported issues</div>
                      <ul className="space-y-0.5">
                        {selectedIssueReports.map((item) => (
                          <li key={`${item.name}-${item.issueType || 'issue'}`}>
                            {item.name} — {item.issueType || 'issue'} {item.notes ? `(${item.notes})` : ''}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              <div>
                <div className="flex justify-between items-center">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400">Raw details</div>
                  <Button size="sm" variant="bordered" onPress={() => setShowRaw((s) => !s)}>
                    {showRaw ? 'Hide raw' : 'Show raw'}
                  </Button>
                </div>
                {showRaw && selected && (
                  <pre className="text-xs overflow-auto whitespace-pre-wrap bg-content2 text-foreground-600 p-3 rounded-large mt-2 font-mono">
                    {JSON.stringify(selected.details || selected.delta || { before: selected.before, after: selected.after }, null, 2)}
                  </pre>
                )}
              </div>
            </ModalBody>
            <ModalFooter>
              <Button variant="bordered" onPress={() => { setIsModalOpen(false); setSelected(null); }}>Close</Button>
            </ModalFooter>
          </>
        </ModalContent>
      </Modal>
    </div>
  );
}
