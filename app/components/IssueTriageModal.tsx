'use client';

import React, { useState } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Select,
  SelectItem,
  Textarea,
  Divider,
  Chip,
  Avatar,
  Badge,
  Card,
  CardBody,
  ScrollShadow,
} from '@heroui/react';
import { Clock, AlertCircle, CheckCircle2, User } from 'lucide-react';
import { updateReport, addComment } from '@/app/lib/reports';
import { useUserRole } from '@/app/hooks/useUserRole';
import type { IssueReport } from '@/app/types';

interface IssueTriageModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  report: (IssueReport & { id: string }) | null;
  admins?: Array<{ id: string; name: string }>;
  onSuccess?: () => void;
}

export default function IssueTriageModal({
  isOpen,
  onOpenChange,
  report,
  admins = [],
  onSuccess,
}: IssueTriageModalProps) {
  const { user } = useUserRole();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [triageData, setTriageData] = useState({
    status: report?.status || 'open',
    priority: report?.priority || 'medium',
    assignedTo: report?.assignedTo?.userId || '',
    comment: '',
  });

  // Update triageData when report changes
  React.useEffect(() => {
    if (report) {
      setTriageData({
        status: report.status,
        priority: report.priority,
        assignedTo: report.assignedTo?.userId || '',
        comment: '',
      });
      setError(null);
    }
  }, [report?.id, isOpen]);

  const handleSubmit = async () => {
    if (!report) return;
    setError(null);
    setSubmitting(true);

    try {
      const updates: Partial<IssueReport> = {
        status: triageData.status as IssueReport['status'],
        priority: triageData.priority as IssueReport['priority'],
      };

      // Only update assignedTo if changed
      if (triageData.assignedTo) {
        const assignedAdmin = admins.find((a) => a.id === triageData.assignedTo);
        updates.assignedTo = {
          userId: triageData.assignedTo,
          userName: assignedAdmin?.name,
        };
      } else {
        updates.assignedTo = null;
      }

      await updateReport(report.id, updates);

      // Add comment if provided
      if (triageData.comment.trim() && user?.uid) {
        await addComment(report.id, {
          userId: user.uid,
          userName: user.displayName || 'Unknown',
          message: triageData.comment,
        });
      }

      onOpenChange(false);
      onSuccess?.();
    } catch (err: any) {
      setError(err?.message || 'Failed to update report');
      console.error('Error updating report:', err);
    } finally {
      setSubmitting(false);
    }
  };

  if (!report) return null;

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
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="2xl"
      scrollBehavior="inside"
      backdrop="blur"
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader className="flex flex-col gap-1">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <h2 className="text-lg font-bold">{report.title}</h2>
                  <p className="text-xs text-gray-500 mt-1">
                    ID: {report.id.slice(0, 8)}...
                  </p>
                </div>
                <div className="flex gap-2">
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
            </ModalHeader>
            <ModalBody className="gap-4">
              {/* Reporter Info */}
              <Card className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
                <CardBody className="gap-2">
                  <div className="flex items-center gap-2">
                    <User className="w-4 h-4 text-blue-600" />
                    <span className="font-medium text-sm">
                      {report.reporter?.isAnonymous ? (
                        <span className="text-gray-600 dark:text-gray-400">
                          Anonymous Report
                        </span>
                      ) : (
                        <>
                          {report.reporter?.userName || 'Unknown'} (
                          {report.reporter?.userEmail || 'no email'})
                        </>
                      )}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                    <Clock className="w-3 h-3" />
                    {report.createdAt instanceof Date
                      ? report.createdAt.toLocaleDateString()
                      : new Date().toLocaleDateString()}
                  </div>
                </CardBody>
              </Card>

              {/* Description */}
              <div>
                <p className="font-semibold text-sm mb-2">Description</p>
                <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
                  {report.description}
                </p>
              </div>

              {/* Reproduction Steps */}
              {report.reproductionSteps && report.reproductionSteps.length > 0 && (
                <div>
                  <p className="font-semibold text-sm mb-2">Reproduction Steps</p>
                  <ol className="text-sm text-gray-700 dark:text-gray-300 space-y-1 ml-4 list-decimal">
                    {report.reproductionSteps.map((step, idx) => (
                      <li key={idx}>{step}</li>
                    ))}
                  </ol>
                </div>
              )}

              {/* Location Info */}
              {(report.pagePath || report.component) && (
                <div>
                  <p className="font-semibold text-sm mb-2">Location</p>
                  <div className="flex flex-wrap gap-2">
                    {report.pagePath && (
                      <Chip variant="flat" size="sm" className="bg-gray-100 dark:bg-slate-700">
                        Page: {report.pagePath}
                      </Chip>
                    )}
                    {report.component && (
                      <Chip variant="flat" size="sm" className="bg-gray-100 dark:bg-slate-700">
                        Component: {report.component}
                      </Chip>
                    )}
                  </div>
                </div>
              )}

              <Divider className="my-2" />

              {/* Comments */}
              {report.comments && report.comments.length > 0 && (
                <div>
                  <p className="font-semibold text-sm mb-2">Comments</p>
                  <ScrollShadow className="h-max max-h-[150px]">
                    <div className="space-y-2">
                      {report.comments.map((comment) => (
                        <Card key={comment.commentId} className="bg-gray-50 dark:bg-slate-800">
                          <CardBody className="gap-1 py-2">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-xs">
                                {comment.by.userName || 'Unknown'}
                              </span>
                              <span className="text-[10px] text-gray-500">
                                {comment.timestamp instanceof Date
                                  ? comment.timestamp.toLocaleString()
                                  : new Date().toLocaleString()}
                              </span>
                            </div>
                            <p className="text-sm text-gray-700 dark:text-gray-300">
                              {comment.message}
                            </p>
                          </CardBody>
                        </Card>
                      ))}
                    </div>
                  </ScrollShadow>
                </div>
              )}

              {error && (
                <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg flex items-start gap-2">
                  <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                  <span className="text-sm text-red-600 dark:text-red-400">
                    {error}
                  </span>
                </div>
              )}

              <Divider className="my-2" />

              {/* Triage Controls */}
              <div className="grid grid-cols-2 gap-3">
                <Select
                  label="Status"
                  placeholder="Select status"
                  size="sm"
                  selectedKeys={[triageData.status]}
                  onSelectionChange={(keys) =>
                    setTriageData((prev) => ({
                      ...prev,
                      status: Array.from(keys)[0] as IssueReport['status'],
                    }))
                  }
                >
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
                  placeholder="Select priority"
                  size="sm"
                  selectedKeys={[triageData.priority]}
                  onSelectionChange={(keys) =>
                    setTriageData((prev) => ({
                      ...prev,
                      priority: Array.from(keys)[0] as IssueReport['priority'],
                    }))
                  }
                >
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

              <Select
                label="Assign To"
                placeholder="Assign to admin"
                size="sm"
                selectedKeys={triageData.assignedTo ? [triageData.assignedTo] : []}
                onSelectionChange={(keys) =>
                  setTriageData((prev) => ({
                    ...prev,
                    assignedTo: Array.from(keys)[0] as string,
                  }))
                }
              >
                {admins.map((admin) => (
                  <SelectItem key={admin.id}>
                    {admin.name}
                  </SelectItem>
                ))}
              </Select>

              <Textarea
                label="Add Comment"
                placeholder="Type your response or notes..."
                minRows={3}
                size="sm"
                variant="bordered"
                value={triageData.comment}
                onValueChange={(v) =>
                  setTriageData((prev) => ({ ...prev, comment: v }))
                }
              />
            </ModalBody>
            <ModalFooter>
              <Button
                color="default"
                variant="light"
                onPress={onClose}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                color="primary"
                onPress={handleSubmit}
                isLoading={submitting}
                className="font-semibold"
              >
                Save Changes
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
