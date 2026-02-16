'use client';

import React, { useState, useEffect } from 'react';
import {
  Card,
  CardBody,
  CardHeader,
  Button,
  Input,
  Select,
  SelectItem,
  Badge,
  Chip,
  Divider,
  Skeleton,
  Checkbox,
} from '@heroui/react';
import {
  Search,
  AlertCircle,
  Clock,
  User,
  Filter,
} from 'lucide-react';
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
  notes?: string;
  itemName?: string;
  items?: Array<{ name?: string }>;
  resolved?: boolean;
  resolvedBy?: string;
  resolvedByName?: string;
  resolvedAt?: Timestamp | Date;
}

const formatDate = (value: Timestamp | Date | undefined) => {
  if (!value) return '—';
  if (value instanceof Date) return value.toLocaleDateString();
  if (value instanceof Timestamp) return value.toDate().toLocaleDateString();
  if ((value as any)?.toDate) return (value as any).toDate().toLocaleDateString();
  return '—';
};

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

export default function IssueReportsPage() {
  const { user, role } = useUserRole();
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

  // Check if user is admin
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
        status: filters.status === 'all' ? 'all' : (filters.status as any),
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
      const query = filters.search.toLowerCase();
      result = result.filter(
        (r) =>
          r.title.toLowerCase().includes(query) ||
          r.description.toLowerCase().includes(query) ||
          r.reporter?.userName?.toLowerCase().includes(query)
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
      const query = filters.search.toLowerCase();
      result = result.filter((r) =>
        (r.itemName || '').toLowerCase().includes(query) ||
        (r.statpackName || '').toLowerCase().includes(query) ||
        (r.location || '').toLowerCase().includes(query) ||
        (r.reporter || r.reporterId || '').toLowerCase().includes(query)
      );
    }

    setFilteredRestockReports(result);
  }, [restockReports, restockUnresolvedOnly, filters.search]);

  if (!isAdmin) {
    return (
      <div className="container mx-auto p-4 md:p-6">
        <div className="flex items-center justify-center h-96">
          <div className="text-center">
            <AlertCircle className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <p className="text-gray-600 dark:text-gray-400 font-medium">
              Access Denied
            </p>
            <p className="text-sm text-gray-500">
              Only admins can view issue reports
            </p>
          </div>
        </div>
      </div>
    );
  }

  const openReportCount = reports.filter((r) => r.status === 'open').length;
  const inProgressCount = reports.filter(
    (r) => r.status === 'in_progress'
  ).length;
  const resolvedCount = reports.filter((r) => r.status === 'resolved').length;

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
    const user = auth.currentUser;
    if (!user) {
      alert('Sign in to resolve reports.');
      return;
    }
    if (!confirm(`Mark report for ${r.statpackName || r.location || 'inventory'} as resolved?`)) return;
    try {
      await updateDoc(doc(db, 'restock_reports', r.id), {
        resolved: true,
        resolvedBy: user.uid,
        resolvedByName: user.displayName || user.email || null,
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
    <div className="container mx-auto p-4 md:p-6 space-y-6">
      {/* Header */}
      <div className="space-y-3">
        <div>
          <h1 className="text-3xl font-bold">Reports</h1>
          <p className="text-gray-600 dark:text-gray-400">
            Triage member issues and inventory/stock alerts in one place
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="solid">
            Issues ({reports.length + restockReports.length})
          </Button>
        </div>
      </div>

          {/* Stats Cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="bg-gradient-to-br from-danger/10 to-danger/5">
            <CardBody className="gap-2">
              <Badge color="danger" content={openReportCount} shape="circle">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Open
                </span>
              </Badge>
            </CardBody>
          </Card>

          <Card className="bg-gradient-to-br from-warning/10 to-warning/5">
            <CardBody className="gap-2">
              <Badge color="warning" content={inProgressCount} shape="circle">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  In Progress
                </span>
              </Badge>
            </CardBody>
          </Card>

          <Card className="bg-gradient-to-br from-success/10 to-success/5">
            <CardBody className="gap-2">
              <Badge color="success" content={resolvedCount} shape="circle">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Resolved
                </span>
              </Badge>
            </CardBody>
          </Card>

          <Card className="bg-gradient-to-br from-primary/10 to-primary/5">
            <CardBody className="gap-2">
              <Badge color="primary" content={reports.length} shape="circle">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Total
                </span>
              </Badge>
            </CardBody>
          </Card>
        </div>

      {/* Filters */}
      <Card>
        <CardBody className="gap-4">
          <div className="flex items-center gap-2">
            <Filter className="w-5 h-5 text-gray-600" />
            <span className="font-semibold">Filters</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Input
              isClearable
              placeholder={'Search by title, description, or reporter...'}
              size="sm"
              variant="bordered"
              startContent={<Search className="w-4 h-4 text-gray-500" />}
              value={filters.search}
              onValueChange={(v) =>
                setFilters((prev) => ({ ...prev, search: v }))
              }
              onClear={() =>
                setFilters((prev) => ({ ...prev, search: '' }))
              }
            />

            <Select
              label="Status"
              placeholder="Filter by status"
              size="sm"
              selectedKeys={[filters.status]}
              onSelectionChange={(keys) =>
                setFilters((prev) => ({
                  ...prev,
                  status: Array.from(keys)[0] as string,
                }))
              }
            >
              <SelectItem key="all">
                All Statuses
              </SelectItem>
              <SelectItem key="open">
                Open
              </SelectItem>
              <SelectItem key="triaged">
                Triaged
              </SelectItem>
              <SelectItem key="in_progress">
                In Progress
              </SelectItem>
              <SelectItem key="resolved">
                Resolved
              </SelectItem>
              <SelectItem key="closed">
                Closed
              </SelectItem>
            </Select>

            <Select
              label="Priority"
              placeholder="Filter by priority"
              size="sm"
              selectedKeys={[filters.priority]}
              onSelectionChange={(keys) =>
                setFilters((prev) => ({
                  ...prev,
                  priority: Array.from(keys)[0] as string,
                }))
              }
            >
              <SelectItem key="all">
                All Priorities
              </SelectItem>
              <SelectItem key="low">
                Low
              </SelectItem>
              <SelectItem key="medium">
                Medium
              </SelectItem>
              <SelectItem key="high">
                High
              </SelectItem>
              <SelectItem key="urgent">
                Urgent
              </SelectItem>
            </Select>

            <div className="flex items-center gap-3">
              <Checkbox isSelected={restockUnresolvedOnly} onValueChange={setRestockUnresolvedOnly}>
                Inventory: Unresolved only
              </Checkbox>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Combined Reports List (issues + inventory) */}
      <div className="space-y-3">
        {loading || restockLoading ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="rounded-lg h-24" />
            ))}
          </div>
        ) : (
          (() => {
            const mappedRestock = filteredRestockReports.map((r) => ({
              id: r.id,
              title: `${humanizeType(r.type)}${(r.items && r.items.length > 0 && r.items[0].name) ? ` — ${r.items[0].name}` : (r.itemName ? ` — ${r.itemName}` : '')}`,
              description: r.notes || 'No notes provided',
              priority: (r.severity === 'critical' ? 'urgent' : r.severity === 'warning' ? 'high' : 'medium') as IssueReport['priority'],
              status: r.resolved ? 'resolved' : 'open',
              reporter: { isAnonymous: false, userName: r.reporter || r.reporterId || 'Unknown' },
              createdAt: r.createdAt as any,
              _source: 'restock' as const,
              raw: r,
            }));

            const mappedIssues = filteredReports.map((rep) => ({ ...rep, _source: 'issue' as const }));

            const combined = [...mappedIssues, ...mappedRestock].sort((a, b) => {
              const ta = a.createdAt ? (a.createdAt as any).toDate ? (a.createdAt as any).toDate().getTime() : new Date(a.createdAt as any).getTime() : 0;
              const tb = b.createdAt ? (b.createdAt as any).toDate ? (b.createdAt as any).toDate().getTime() : new Date(b.createdAt as any).getTime() : 0;
              return tb - ta;
            });

            if (combined.length === 0) {
              return (
                <Card>
                  <CardBody className="py-12">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <AlertCircle className="w-10 h-10 text-gray-400" />
                      <p className="text-gray-600 dark:text-gray-400 font-medium">
                        No reports found
                      </p>
                      <p className="text-sm text-gray-500">
                        Try adjusting your filters
                      </p>
                    </div>
                  </CardBody>
                </Card>
              );
            }

            return combined.map((item: any) => (
              <Card
                key={item.id}
                className={`cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors ${item._source === 'issue' ? 'is-issue' : 'is-restock'}`}
                isPressable={item._source === 'issue'}
                onPress={() => {
                  if (item._source === 'issue') {
                    setSelectedReport(item);
                    setIsTriageOpen(true);
                  }
                }}
              >
                <CardBody className="gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-sm line-clamp-2">
                        {item.title}
                      </h3>
                      <p className="text-xs text-gray-600 dark:text-gray-400 line-clamp-1 mt-1">
                        {item.description}
                      </p>
                    </div>
                    <div className="flex gap-2 flex-shrink-0">
                      <Chip
                        variant="flat"
                        color={priorityColor[(item.priority || 'medium') as keyof typeof priorityColor]}
                        size="sm"
                        className="font-semibold"
                      >
                        {item.priority}
                      </Chip>
                      <Chip
                        variant="flat"
                        color={statusColor[item.status as keyof typeof statusColor] || 'default'}
                        size="sm"
                      >
                        {item.status}
                      </Chip>
                    </div>
                  </div>

                  <Divider className="my-1" />

                  <div className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400">
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-1">
                        <User className="w-3 h-3" />
                        {item.reporter?.isAnonymous ? (
                          <span>Anonymous</span>
                        ) : (
                          <span>{item.reporter?.userName || 'Unknown'}</span>
                        )}
                      </div>

                      {item._source === 'issue' && item.assignedTo && (
                        <div className="flex items-center gap-1 bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 rounded">
                          <span>Assigned to {item.assignedTo.userName}</span>
                        </div>
                      )}

                      {item._source === 'restock' && item.raw && (item.raw.statpackName || item.raw.location) && (
                        <div className="flex items-center gap-1 bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 rounded">
                          <span>
                            {item.raw.statpackName ?? item.raw.location}{item.raw.locationDetail ? ` • ${item.raw.locationDetail}` : ''}
                            {(item.raw.frontRoom || item.raw.frontShelf || item.raw.frontLevel) && (
                              <span className="ml-1 text-indigo-600 dark:text-indigo-400">
                                [{[item.raw.frontRoom, item.raw.frontShelf, item.raw.frontLevel ? `Level ${item.raw.frontLevel}` : ''].filter(Boolean).join(', ')}]
                              </span>
                            )}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {item.createdAt instanceof Date
                        ? item.createdAt.toLocaleDateString()
                        : item.createdAt && (item.createdAt as any).toDate
                        ? (item.createdAt as any).toDate().toLocaleDateString()
                        : new Date().toLocaleDateString()}
                    </div>
                  </div>

                  {item._source === 'restock' && (
                    <div className="flex items-center gap-2 pt-1">
                      {!item.raw.resolved && (
                        <Button size="sm" color="primary" onPress={() => handleResolveRestock(item.raw)}>
                          Resolve
                        </Button>
                      )}
                      <Button size="sm" variant="light" color="danger" onPress={() => handleDeleteRestock(item.raw)}>
                        Delete
                      </Button>
                    </div>
                  )}
                </CardBody>
              </Card>
            ));
          })()
        )}
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
