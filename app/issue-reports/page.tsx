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
} from '@heroui/react';
import {
  Search,
  AlertCircle,
  Clock,
  User,
  Filter,
  ChevronDown,
} from 'lucide-react';
import { useUserRole } from '@/app/hooks/useUserRole';
import { subscribeToAllReports } from '@/app/lib/reports';
import IssueTriageModal from '@/app/components/IssueTriageModal';
import type { IssueReport } from '@/app/types';

export default function IssueReportsPage() {
  const { user, role } = useUserRole();
  const [reports, setReports] = useState<Array<IssueReport & { id: string }>>([]);
  const [filteredReports, setFilteredReports] = useState<
    Array<IssueReport & { id: string }>
  >([]);
  const [loading, setLoading] = useState(true);

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

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold">Issue Reports</h1>
        <p className="text-gray-600 dark:text-gray-400">
          Review and triage member-submitted bugs and feedback
        </p>
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
              placeholder="Search by title, description, or reporter..."
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
          </div>
        </CardBody>
      </Card>

      {/* Reports List */}
      <div className="space-y-3">
        {loading ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="rounded-lg h-24" />
            ))}
          </div>
        ) : filteredReports.length === 0 ? (
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
        ) : (
          filteredReports.map((report) => (
            <Card
              key={report.id}
              className="cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors"
              isPressable
              onPress={() => {
                setSelectedReport(report);
                setIsTriageOpen(true);
              }}
            >
              <CardBody className="gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-sm line-clamp-2">
                      {report.title}
                    </h3>
                    <p className="text-xs text-gray-600 dark:text-gray-400 line-clamp-1 mt-1">
                      {report.description}
                    </p>
                  </div>
                  <div className="flex gap-2 flex-shrink-0">
                    <Chip
                      variant="flat"
                      color={priorityColor[report.priority]}
                      size="sm"
                      className="font-semibold"
                    >
                      {report.priority}
                    </Chip>
                    <Chip
                      variant="flat"
                      color={statusColor[report.status]}
                      size="sm"
                    >
                      {report.status}
                    </Chip>
                  </div>
                </div>

                <Divider className="my-1" />

                <div className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1">
                      <User className="w-3 h-3" />
                      {report.reporter?.isAnonymous ? (
                        <span>Anonymous</span>
                      ) : (
                        <span>{report.reporter?.userName || 'Unknown'}</span>
                      )}
                    </div>

                    {report.assignedTo && (
                      <div className="flex items-center gap-1 bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 rounded">
                        <span>Assigned to {report.assignedTo.userName}</span>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {report.createdAt instanceof Date
                      ? report.createdAt.toLocaleDateString()
                      : new Date().toLocaleDateString()}
                  </div>
                </div>
              </CardBody>
            </Card>
          ))
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
