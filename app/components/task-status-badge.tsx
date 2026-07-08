'use client';

import { Chip } from '@heroui/react';
import {
  Inbox,
  CalendarClock,
  CirclePlay,
  OctagonAlert,
  CheckCircle2,
  type LucideIcon,
} from 'lucide-react';
import type { TaskItem } from '@/app/types';

type TaskStatus = TaskItem['status'];

/**
 * Task status → icon/color/label mapping — shared by the tasks page and any
 * surface that displays task status. Follows the category-badge.tsx pattern:
 * config record + getter with fallback + presentational component.
 */
export const TASK_STATUS_CFG: Record<
  TaskStatus,
  {
    label: string;
    Icon: LucideIcon;
    color: 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger';
    text: string;
  }
> = {
  backlog:     { label: 'Backlog',     Icon: Inbox,         color: 'default',   text: 'text-foreground-400' },
  this_cycle:  { label: 'This Cycle',  Icon: CalendarClock, color: 'secondary', text: 'text-secondary' },
  in_progress: { label: 'In Progress', Icon: CirclePlay,    color: 'primary',   text: 'text-primary' },
  blocked:     { label: 'Blocked',     Icon: OctagonAlert,  color: 'danger',    text: 'text-danger' },
  done:        { label: 'Done',        Icon: CheckCircle2,  color: 'success',   text: 'text-success' },
};

/** Unknown/legacy values (e.g. 'todo' docs not yet normalized) render as Backlog. */
export function getTaskStatusCfg(status: string) {
  return TASK_STATUS_CFG[status as TaskStatus] ?? TASK_STATUS_CFG.backlog;
}

export function TaskStatusBadge({ status }: { status: string }) {
  const cfg = getTaskStatusCfg(status);
  return (
    <Chip size="sm" variant="flat" color={cfg.color} startContent={<cfg.Icon size={12} />}>
      {cfg.label}
    </Chip>
  );
}
