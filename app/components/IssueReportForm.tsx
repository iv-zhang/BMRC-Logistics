'use client';

import React, { useState } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Input,
  Select,
  SelectItem,
  Textarea,
  Switch,
  Divider,
  Chip,
} from '@heroui/react';
import { AlertCircle } from 'lucide-react';
import { useUserRole } from '@/app/hooks/useUserRole';
import { createReport } from '@/app/lib/reports';
import type { IssueReport } from '@/app/types';

interface IssueReportFormProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  pagePath?: string;
  component?: string;
  targetCollection?: string;
  targetDocId?: string;
  onSuccess?: () => void;
}

export default function IssueReportForm({
  isOpen,
  onOpenChange,
  pagePath,
  component,
  targetCollection,
  targetDocId,
  onSuccess,
}: IssueReportFormProps) {
  const { user } = useUserRole();
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    type: 'bug' as IssueReport['type'],
    priority: 'medium' as IssueReport['priority'],
    title: '',
    description: '',
    reproductionSteps: '',
  });

  const handleSubmit = async () => {
    setError(null);

    // Validation
    if (!formData.title.trim()) {
      setError('Please enter a title');
      return;
    }
    if (!formData.description.trim()) {
      setError('Please enter a description');
      return;
    }

    setSubmitting(true);

    try {
      const reporterId = isAnonymous ? null : user?.uid || null;

      await createReport({
        reporter: {
          userId: reporterId,
          userName: !isAnonymous ? user?.displayName : undefined,
          userEmail: !isAnonymous ? user?.email : undefined,
          isAnonymous,
        },
        type: formData.type,
        priority: formData.priority,
        title: formData.title,
        description: formData.description,
        reproductionSteps: formData.reproductionSteps
          .split('\n')
          .filter((s) => s.trim()),
        pagePath,
        component,
        target: targetCollection
          ? { collection: targetCollection, docId: targetDocId }
          : undefined,
      });

      // Reset form
      setFormData({
        type: 'bug',
        priority: 'medium',
        title: '',
        description: '',
        reproductionSteps: '',
      });
      setIsAnonymous(false);
      onOpenChange(false);
      onSuccess?.();
    } catch (err: any) {
      setError(err?.message || 'Failed to submit report');
      console.error('Error submitting report:', err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      size="lg"
      scrollBehavior="inside"
      backdrop="blur"
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader className="flex flex-col gap-1">
              Report an Issue
              <p className="text-sm text-gray-500 font-normal">
                Help us improve the platform by reporting bugs and feedback
              </p>
            </ModalHeader>
            <ModalBody className="gap-4">
              {error && (
                <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg flex items-start gap-2">
                  <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                  <span className="text-sm text-red-600 dark:text-red-400">
                    {error}
                  </span>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <Select
                  label="Issue Type"
                  placeholder="Select type"
                  size="sm"
                  selectedKeys={[formData.type]}
                  onSelectionChange={(keys) =>
                    setFormData((prev) => ({
                      ...prev,
                      type: Array.from(keys)[0] as IssueReport['type'],
                    }))
                  }
                >
                  <SelectItem key="bug">
                    Bug Report
                  </SelectItem>
                  <SelectItem key="feedback">
                    Feedback
                  </SelectItem>
                  <SelectItem key="improvement">
                    Improvement
                  </SelectItem>
                  <SelectItem key="question">
                    Question
                  </SelectItem>
                </Select>

                <Select
                  label="Priority"
                  placeholder="Select priority"
                  size="sm"
                  selectedKeys={[formData.priority]}
                  onSelectionChange={(keys) =>
                    setFormData((prev) => ({
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

              <Input
                label="Title"
                placeholder="Brief summary of the issue"
                size="sm"
                variant="bordered"
                value={formData.title}
                onValueChange={(v) =>
                  setFormData((prev) => ({ ...prev, title: v }))
                }
                isRequired
              />

              <Textarea
                label="Description"
                placeholder="Describe the issue in detail..."
                minRows={4}
                variant="bordered"
                value={formData.description}
                onValueChange={(v) =>
                  setFormData((prev) => ({ ...prev, description: v }))
                }
                isRequired
              />

              <Textarea
                label="Reproduction Steps (optional)"
                placeholder="1. First step&#10;2. Second step&#10;3. Expected result"
                minRows={3}
                variant="bordered"
                value={formData.reproductionSteps}
                onValueChange={(v) =>
                  setFormData((prev) => ({ ...prev, reproductionSteps: v }))
                }
                description="Separate each step with a new line"
              />

              {pagePath && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Location</p>
                  <Chip variant="flat" size="sm" className="bg-blue-50 dark:bg-blue-900/20">
                    {pagePath}
                  </Chip>
                </div>
              )}

              <Divider className="my-2" />

              <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-slate-800/50 rounded-lg border border-gray-200 dark:border-slate-700">
                <div className="flex flex-col">
                  <span className="font-medium text-sm">Report Anonymously</span>
                  <span className="text-xs text-gray-500">
                    Don't attach your name
                  </span>
                </div>
                <Switch
                  isSelected={isAnonymous}
                  onValueChange={setIsAnonymous}
                />
              </div>
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
                Submit Report
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
