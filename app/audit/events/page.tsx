'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Chip,
  Divider,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Spinner,
} from '@heroui/react';
import { ClipboardCheck, AlertTriangle, Activity, Clock, User, Package, ClipboardList } from 'lucide-react';

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
  if (normalized.includes('issue') || normalized.includes('error')) return <AlertTriangle size={18} />;
  if (normalized.includes('restock') || normalized.includes('inventory')) return <Package size={18} />;
  if (normalized.includes('audit')) return <ClipboardCheck size={18} />;
  if (normalized.includes('check')) return <ClipboardList size={18} />;
  return <Activity size={18} />;
};

const formatEventType = (raw?: string) => {
  if (!raw) return 'Event';
  // replace underscores/hyphens, split camelCase, then title-case
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
    // First filter to disposables only (exclude asset-related events)
    const disposablesOnly = events.filter((ev) => {
      const eventType = (ev.eventType || '').toLowerCase();
      const source = (ev.source || '').toLowerCase();
      
      // Exclude asset-specific events (checkout, checkin, maintenance, assignments)
      if (eventType.includes('asset_checkout') || 
          eventType.includes('asset_checkin') ||
          eventType.includes('asset_assign') ||
          eventType.includes('asset_maintenance') ||
          eventType.includes('asset_manual_check') ||
          source === 'inventory_logs') {
        return false;
      }
      
      // Include disposable/supply events (restock, box operations, statpack operations)
      return true;
    });
    
    // Then apply text filter if present
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
      <div className="flex items-center justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="p-6">
        <Card>
          <CardBody>
            <div className="text-sm text-gray-600 dark:text-gray-300">Admin access required to view audit logs.</div>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-xl font-bold">Supply Ledger</h2>
          <p className="text-xs text-default-500">Disposables tracking · Boxes added, opened, and restocked</p>
        </div>
        <div className="w-full md:w-96">
          <Input
            size="sm"
            placeholder="Filter by actor, event, item, or keyword"
            value={filter}
            onValueChange={setFilter}
          />
        </div>
      </div>

      {error && (
        <Card className="mt-4 border border-danger-200 bg-danger-50">
          <CardBody>
            <div className="text-sm text-danger-600">{error}</div>
          </CardBody>
        </Card>
      )}

      <div className="grid gap-3 mt-4">
        {loading && (
          <Card>
            <CardBody className="flex items-center justify-center py-8">
              <Spinner size="md" />
            </CardBody>
          </Card>
        )}
        {!loading && filteredEvents.length === 0 && (
          <div className="text-sm text-muted">No audit events found.</div>
        )}
        {filteredEvents.map((ev) => {
          const actor = getActorLabel(ev.actor);
          const timestampLabel = formatTimestamp(ev.timestamp);
          const details = ev.details || {};
          const itemName = extractString((details as Record<string, unknown>).itemName) ||
            extractString((details as Record<string, unknown>).statpackName) ||
            extractString((details as Record<string, unknown>).name);
          const friendlyEvent = formatEventType(ev.eventType || ev.source || 'Event');
          return (
            <div
              key={ev.id}
              role="button"
              tabIndex={0}
              onClick={() => openModal(ev)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openModal(ev); }}
              className="cursor-pointer"
            >
              <Card className="bg-white dark:bg-slate-800 hover:shadow-lg transition-shadow">
                <CardHeader className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <div className="text-default-500">{getEventIcon(ev.eventType)}</div>
                    <div className="font-medium text-sm">{friendlyEvent}</div>
                    <Badge color="primary">{actor}</Badge>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <Clock size={14} /> {timestampLabel}
                  </div>
                  {itemName && <div className="text-xs text-default-600">Item: {itemName}</div>}
                  {ev.targets && ev.targets.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {ev.targets.map((t) => (
                        <Chip key={`${ev.id}-${t.collection}-${t.docId}`} size="sm" variant="flat">
                          {t.collection}/{t.docId}
                        </Chip>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="bordered">
                    Open
                  </Button>
                </div>
                </CardHeader>
              </Card>
            </div>
          );
        })}
      </div>

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

      <Modal isOpen={isModalOpen} onOpenChange={setIsModalOpen} size="3xl" scrollBehavior="inside">
        <ModalContent>
          <>
            <ModalHeader className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <div className="text-default-500">{getEventIcon(selected?.eventType || '')}</div>
                <span className="text-base font-semibold">{formatEventType(selected?.eventType || selected?.source || 'Event Details')}</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted">
                <User size={14} /> {selectedActorLabel}
              </div>
              <div className="text-xs text-muted">{formatTimestamp(selected?.timestamp)}</div>
            </ModalHeader>
            <ModalBody className="gap-4">
              <div className="grid gap-3">
                {selected?.targets && selected.targets.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {selected.targets.map((t) => (
                      <Chip key={`${selected.id}-${t.collection}-${t.docId}`} size="sm" variant="flat">
                        {t.collection}/{t.docId}
                      </Chip>
                    ))}
                  </div>
                )}

                <Divider />

                <div className="grid gap-2 text-sm">
                  <div className="font-semibold">Timeline</div>
                  <div className="text-xs">Checked out: {selectedCheckoutAt ? formatTimestamp(selectedCheckoutAt) : '—'}</div>
                  <div className="text-xs">Checked in: {selectedCheckinAt ? formatTimestamp(selectedCheckinAt) : '—'}</div>
                  <div className="text-xs">Reason / Notes: {selectedReason ? String(selectedReason) : '—'}</div>
                </div>

                {(selectedItemsUsed.length > 0 || selectedIssueReports.length > 0) && (
                  <>
                    <Divider />
                    <div className="grid gap-2 text-sm">
                      <div className="font-semibold">Statpack Usage / Issues</div>
                      {selectedItemsUsed.length > 0 && (
                        <div className="text-xs">
                          <div className="font-medium">Items used</div>
                          <ul className="list-disc ml-4">
                            {selectedItemsUsed.map((item) => (
                              <li key={`${item.name}-${item.quantity}`}>{item.name}: {item.quantity}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {selectedIssueReports.length > 0 && (
                        <div className="text-xs">
                          <div className="font-medium">Reported issues</div>
                          <ul className="list-disc ml-4">
                            {selectedIssueReports.map((item) => (
                              <li key={`${item.name}-${item.issueType || 'issue'}`}>
                                {item.name} — {item.issueType || 'issue'} {item.notes ? `(${item.notes})` : ''}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </>
                )}

                <Divider />

                <div className="grid gap-2">
                  <div className="flex justify-between items-center">
                    <div className="font-semibold text-sm">Raw details</div>
                    <Button size="sm" variant="bordered" onPress={() => setShowRaw((s) => !s)}>
                      {showRaw ? 'Hide raw' : 'Show raw'}
                    </Button>
                  </div>
                  {showRaw && selected && (
                    <pre className="text-xs overflow-auto whitespace-pre-wrap bg-default-50 dark:bg-slate-900 p-3 rounded-lg">
                      {JSON.stringify(selected.details || selected.delta || { before: selected.before, after: selected.after }, null, 2)}
                    </pre>
                  )}
                </div>
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
