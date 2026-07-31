'use client';

import React, { useState, useEffect } from 'react';
import { Button, Chip, Checkbox, Spinner } from '@heroui/react';
import { Search, AlertCircle, Clock, User, X } from 'lucide-react';
import { collection, onSnapshot, orderBy, query, Timestamp, updateDoc, doc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '@/firebase';
import { useUserRole } from '@/app/hooks/useUserRole';
import { subscribeToAllReports } from '@/app/lib/reports';
import IssueTriageModal from '@/app/components/IssueTriageModal';
import type { IssueReport } from '@/app/types';

interface RestockReport {
  id: string;
  type?: string;
  severity?: 'critical' | 'warning' | string;
  createdAt?: Timestamp | Date;
  reporter?: string;
  reporterId?: string;
  statpackName?: string;
  location?: string;
  locationDetail?: string;
  frontRoom?: string;
  frontShelf?: string;
  frontLevel?: string | number;
  notes?: string;
  itemName?: string;
  items?: Array<{ name?: string }>;
  resolved?: boolean;
  resolvedBy?: string;
  resolvedByName?: string;
  resolvedAt?: Timestamp | Date;
}

const humanizeType = (t?: string) => {
  if (!t) return 'Report';
  switch (t) {
    case 'open_box_low': return 'Open Box - Running Low';
    case 'low_stock': return 'Low Stock';
    case 'expiration': return 'Expiration';
    case 'oxygen': return 'Oxygen Level';
    case 'damaged': return 'Damaged / Defective';
    case 'open_box': return 'Untracked / Open Box';
    default:
      return t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
};

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'open', label: 'Open' },
  { value: 'triaged', label: 'Triaged' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
];

const PRIORITY_OPTIONS = [
  { value: 'all', label: 'All priorities' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

export default function IssueReportsPage() {
  const { user, role, loading: roleLoading } = useUserRole();
  const [reports, setReports] = useState<Array<IssueReport & { id: string }>>([]);
  const [filteredReports, setFilteredReports] = useState<
    Array<IssueReport & { id: string }>
  >([]);
  const [loading, setLoading] = useState(true);

  const [restockReports, setRestockReports] = useState<RestockReport[]>([]);
  const [filteredRestockReports, setFilteredRestockReports] = useState<RestockReport[]>([]);
  const [restockLoading, setRestockLoading] = useState(true);
  const [restockUnresolvedOnly, setRestockUnresolvedOnly] = useState(true);

  const [selectedReport, setSelectedReport] = useState<
    (IssueReport & { id: string }) | null
  >(null);
  const [isTriageOpen, setIsTriageOpen] = useState(false);

  const [filters, setFilters] = useState({
    status: 'all',
    priority: 'all',
    search: '',
  });

  const isAdmin = role === 'admin' || role === 'quartermaster';

  // Subscribe to reports
  useEffect(() => {
    setLoading(true);
    const unsubscribe = subscribeToAllReports(
      (data) => {
        setReports(data);
        setLoading(false);
      },
      {
        status: filters.status === 'all' ? 'all' : (filters.status as IssueReport['status']),
      }
    );

    return () => unsubscribe();
  }, [filters.status]);

  useEffect(() => {
    setRestockLoading(true);
    const q = query(collection(db, 'restock_reports'), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const out: RestockReport[] = [];
        snap.forEach((s) => out.push({ id: s.id, ...(s.data() as Omit<RestockReport, 'id'>) }));
        setRestockReports(out);
        setRestockLoading(false);
      },
      (err) => {
        console.error('restock reports snapshot error', err);
        setRestockLoading(false);
      }
    );
    return () => unsub();
  }, []);

  // Apply filters
  useEffect(() => {
    let result = [...reports];

    if (filters.priority !== 'all') {
      result = result.filter((r) => r.priority === filters.priority);
    }

    if (filters.search.trim()) {
      const q = filters.search.toLowerCase();
      result = result.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q) ||
          r.reporter?.userName?.toLowerCase().includes(q)
      );
    }

    setFilteredReports(result);
  }, [reports, filters.priority, filters.search]);

  useEffect(() => {
    let result = [...restockReports];

    if (restockUnresolvedOnly) {
      result = result.filter((r) => !r.resolved);
    }

    if (filters.search.trim()) {
      const q = filters.search.toLowerCase();
      result = result.filter((r) =>
        (r.itemName || '').toLowerCase().includes(q) ||
        (r.statpackName || '').toLowerCase().includes(q) ||
        (r.location || '').toLowerCase().includes(q) ||
        (r.reporter || r.reporterId || '').toLowerCase().includes(q)
      );
    }

    setFilteredRestockReports(result);
  }, [restockReports, restockUnresolvedOnly, filters.search]);

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
          <AlertCircle size={40} className="mx-auto text-foreground-300 mb-4" />
          <h2 className="text-base font-semibold text-foreground mb-2">Admin Access Required</h2>
          <p className="text-sm text-foreground-500">Only admins can view issue reports.</p>
        </div>
      </div>
    );
  }

  const openReportCount = reports.filter((r) => r.status === 'open').length
    + restockReports.filter((r) => !r.resolved).length;
  const inProgressCount = reports.filter((r) => r.status === 'in_progress').length;
  const resolvedCount = reports.filter((r) => r.status === 'resolved').length
    + restockReports.filter((r) => r.resolved).length;

  const priorityColor = {
    low: 'default',
    medium: 'warning',
    high: 'danger',
    urgent: 'danger',
  } as const;

  const statusColor = {
    open: 'danger',
    triaged: 'warning',
    in_progress: 'primary',
    resolved: 'success',
    closed: 'default',
  } as const;

  const handleResolveRestock = async (r: RestockReport) => {
    const current = auth.currentUser;
    if (!current) {
      alert('Sign in to resolve reports.');
      return;
    }
    if (!confirm(`Mark report for ${r.statpackName || r.location || 'inventory'} as resolved?`)) return;
    try {
      await updateDoc(doc(db, 'restock_reports', r.id), {
        resolved: true,
        resolvedBy: current.uid,
        resolvedByName: current.displayName || current.email || null,
        resolvedAt: serverTimestamp(),
      });
    } catch (e) {
      console.error(e);
      alert('Failed to mark resolved');
    }
  };

  const handleDeleteRestock = async (r: RestockReport) => {
    if (!confirm('Delete this report? This cannot be undone.')) return;
    try {
      await deleteDoc(doc(db, 'restock_reports', r.id));
    } catch (e) {
      console.error(e);
      alert('Failed to delete');
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">

        {/* ── Page header ────────────────────────────────────────────────── */}
        <div className="flex items-end justify-between gap-4 mb-6 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-foreground mb-1.5">Reports</h1>
            <div className="flex items-center gap-2 flex-wrap mt-1">
              <div className="flex items-center gap-2 bg-content1 border border-divider rounded-large px-3 py-1.5">
                <span className="font-mono font-semibold tabular-nums text-foreground">
                  {reports.length + restockReports.length}
                </span>
                <span className="text-xs text-foreground-400">total</span>
              </div>
              <div className="flex items-center gap-2 bg-danger-50 dark:bg-danger-900/20 border border-danger/30 rounded-large px-3 py-1.5">
                <span className="w-2 h-2 rounded-sm bg-danger flex-none" />
                <span className="font-mono font-semibold tabular-nums text-danger">{openReportCount}</span>
                <span className="text-xs text-danger/80 font-medium">open</span>
              </div>
              <div className="flex items-center gap-2 bg-warning-50 dark:bg-warning-900/20 border border-warning/30 rounded-large px-3 py-1.5">
                <span className="w-2 h-2 rounded-sm bg-warning flex-none" />
                <span className="font-mono font-semibold tabular-nums text-warning">{inProgressCount}</span>
                <span className="text-xs text-warning/80 font-medium">in progress</span>
              </div>
              <div className="flex items-center gap-2 bg-success-50 dark:bg-success-900/20 border border-success/30 rounded-large px-3 py-1.5">
                <span className="w-2 h-2 rounded-sm bg-success flex-none" />
                <span className="font-mono font-semibold tabular-nums text-success">{resolvedCount}</span>
                <span className="text-xs text-success/80 font-medium">resolved</span>
              </div>
            </div>
          </div>
        </div>

        {/* ── Filter bar ─────────────────────────────────────────────────── */}
        <div className="bg-content1 border border-divider rounded-large p-3 mb-4 flex items-center gap-3 flex-wrap">
          <div className="flex-1 min-w-[220px] flex items-center gap-2 bg-content2 border border-divider rounded-medium px-3 py-0.5">
            <Search size={15} className="text-foreground-400 flex-none" />
            <input
              value={filters.search}
              onChange={(e) => setFilters((prev) => ({ ...prev, search: e.target.value }))}
              placeholder="Search by title, item, location, or reporter…"
              className="flex-1 text-sm bg-transparent outline-none py-2 text-foreground placeholder:text-foreground-400"
            />
            {filters.search && (
              <button
                onClick={() => setFilters((prev) => ({ ...prev, search: '' }))}
                className="text-foreground-400 hover:text-foreground-600 transition-colors"
              >
                <X size={15} />
              </button>
            )}
          </div>

          <select
            value={filters.status}
            onChange={(e) => setFilters((prev) => ({ ...prev, status: e.target.value }))}
            className="text-sm font-medium text-foreground-600 dark:text-foreground-300 bg-content1 border border-divider rounded-medium px-3 py-2 cursor-pointer outline-none"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>

          <select
            value={filters.priority}
            onChange={(e) => setFilters((prev) => ({ ...prev, priority: e.target.value }))}
            className="text-sm font-medium text-foreground-600 dark:text-foreground-300 bg-content1 border border-divider rounded-medium px-3 py-2 cursor-pointer outline-none"
          >
            {PRIORITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>

          <Checkbox size="sm" isSelected={restockUnresolvedOnly} onValueChange={setRestockUnresolvedOnly}>
            <span className="text-sm text-foreground-600">Unresolved stock alerts only</span>
          </Checkbox>
        </div>

        {/* ── Combined reports list (issues + inventory) ─────────────────── */}
        <div className="space-y-3">
          {loading || restockLoading ? (
            <div className="bg-content1 border border-divider rounded-large flex items-center justify-center py-16">
              <Spinner size="md" color="primary" />
            </div>
          ) : (
            (() => {
              const mappedRestock = filteredRestockReports.map((r) => ({
                id: r.id,
                title: `${humanizeType(r.type)}${(r.items && r.items.length > 0 && r.items[0].name) ? ` — ${r.items[0].name}` : (r.itemName ? ` — ${r.itemName}` : '')}`,
                description: r.notes || 'No notes provided',
                priority: (r.severity === 'critical' ? 'urgent' : r.severity === 'warning' ? 'high' : 'medium') as IssueReport['priority'],
                status: (r.resolved ? 'resolved' : 'open') as IssueReport['status'],
                reporter: { isAnonymous: false, userName: r.reporter || r.reporterId || 'Unknown' },
                createdAt: r.createdAt,
                _source: 'restock' as const,
                raw: r,
              }));

              const mappedIssues = filteredReports.map((rep) => ({ ...rep, _source: 'issue' as const, raw: undefined as unknown as RestockReport }));

              const toMillis = (v: unknown): number => {
                if (!v) return 0;
                if (v instanceof Date) return v.getTime();
                if (typeof (v as { toDate?: () => Date }).toDate === 'function') return (v as { toDate: () => Date }).toDate().getTime();
                const d = new Date(v as string);
                return isNaN(d.getTime()) ? 0 : d.getTime();
              };

              const combined = [...mappedIssues, ...mappedRestock].sort(
                (a, b) => toMillis(b.createdAt) - toMillis(a.createdAt)
              );

              if (combined.length === 0) {
                return (
                  <div className="bg-content1 border border-dashed border-divider rounded-large text-center py-16">
                    <AlertCircle size={32} className="mx-auto text-foreground-300 mb-2" />
                    <p className="text-sm font-semibold text-foreground-500">No reports found</p>
                    <p className="text-xs text-foreground-400 mt-1">Try adjusting your filters.</p>
                  </div>
                );
              }

              return combined.map((item) => {
                const isIssue = item._source === 'issue';
                const createdLabel = (() => {
                  const ms = toMillis(item.createdAt);
                  return ms ? new Date(ms).toLocaleDateString() : '—';
                })();
                return (
                  <div
                    key={`${item._source}-${item.id}`}
                    onClick={() => {
                      if (isIssue) {
                        setSelectedReport(item as IssueReport & { id: string });
                        setIsTriageOpen(true);
                      }
                    }}
                    className={`bg-content1 border border-divider rounded-large px-4 py-4 transition-all duration-150 ${
                      isIssue ? 'cursor-pointer hover:border-primary/30 hover:shadow-sm' : ''
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-sm text-foreground line-clamp-2">
                          {item.title}
                        </h3>
                        <p className="text-xs text-foreground-500 line-clamp-1 mt-1">
                          {item.description}
                        </p>
                      </div>
                      <div className="flex gap-1.5 flex-none">
                        <Chip
                          variant="flat"
                          color={priorityColor[(item.priority || 'medium') as keyof typeof priorityColor]}
                          size="sm"
                        >
                          {item.priority}
                        </Chip>
                        <Chip
                          variant="flat"
                          color={statusColor[item.status as keyof typeof statusColor] || 'default'}
                          size="sm"
                        >
                          {String(item.status).replace(/_/g, ' ')}
                        </Chip>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-3 text-xs text-foreground-400 mt-3 flex-wrap">
                      <div className="flex items-center gap-3 flex-wrap">
                        <span className="flex items-center gap-1">
                          <User size={11} />
                          {item.reporter?.isAnonymous ? 'Anonymous' : (item.reporter?.userName || 'Unknown')}
                        </span>

                        {isIssue && 'assignedTo' in item && (item as IssueReport).assignedTo && (
                          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-primary-50 dark:bg-primary-900/20 text-primary">
                            Assigned to {(item as IssueReport).assignedTo?.userName}
                          </span>
                        )}

                        {!isIssue && item.raw && (item.raw.statpackName || item.raw.location) && (
                          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-primary-50 dark:bg-primary-900/20 text-primary">
                            {item.raw.statpackName ?? item.raw.location}
                            {item.raw.locationDetail ? ` · ${item.raw.locationDetail}` : ''}
                            {(item.raw.frontRoom || item.raw.frontShelf || item.raw.frontLevel) &&
                              ` — ${[item.raw.frontRoom, item.raw.frontShelf, item.raw.frontLevel ? `Level ${item.raw.frontLevel}` : ''].filter(Boolean).join(', ')}`}
                          </span>
                        )}
                      </div>

                      <span className="flex items-center gap-1">
                        <Clock size={11} /> {createdLabel}
                      </span>
                    </div>

                    {!isIssue && item.raw && (
                      <div className="flex items-center gap-2 mt-3">
                        {!item.raw.resolved && (
                          <Button
                            size="sm"
                            color="primary"
                            variant="flat"
                            onPress={() => handleResolveRestock(item.raw)}
                          >
                            Mark resolved
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="light"
                          color="danger"
                          onPress={() => handleDeleteRestock(item.raw)}
                        >
                          Delete
                        </Button>
                      </div>
                    )}
                  </div>
                );
              });
            })()
          )}
        </div>
      </div>

      {/* Triage Modal */}
      <IssueTriageModal
        isOpen={isTriageOpen}
        onOpenChange={setIsTriageOpen}
        report={selectedReport}
        admins={[
          { id: user?.uid || '', name: user?.displayName || 'Unknown' },
        ]}
        onSuccess={() => {
          setSelectedReport(null);
        }}
      />
    </div>
  );
}
