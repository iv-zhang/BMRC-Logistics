'use client';

import React from 'react';
import { AlertTriangle, AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

export type CalloutTone = 'info' | 'success' | 'warning' | 'danger';

const TONE_CLS: Record<CalloutTone, { box: string; icon: string; text: string }> = {
  info: {
    box: 'bg-primary-50 dark:bg-primary-900/20 border-primary/30',
    icon: 'text-primary',
    text: 'text-primary',
  },
  success: {
    box: 'bg-success-50 dark:bg-success-900/20 border-success/30',
    icon: 'text-success',
    text: 'text-success',
  },
  warning: {
    box: 'bg-warning-50 dark:bg-warning-900/20 border-warning/30',
    icon: 'text-warning',
    text: 'text-warning',
  },
  danger: {
    box: 'bg-danger-50 dark:bg-danger-900/20 border-danger/30',
    icon: 'text-danger',
    text: 'text-danger',
  },
};

const TONE_ICON: Record<CalloutTone, React.ComponentType<{ size?: number; className?: string }>> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: AlertCircle,
};

export interface CalloutProps {
  tone?: CalloutTone;
  /** Short message. For longer text, pass a node instead of a string. */
  children: React.ReactNode;
  /** Right-aligned action cluster (e.g. a "Review" button). */
  actions?: React.ReactNode;
  /** Shows a dismiss (X) button; called on click. Omit to make the callout persistent. */
  onDismiss?: () => void;
  icon?: React.ReactNode;
  className?: string;
}

/**
 * Inline status banner — the duplicate-items warning, the "on the way"
 * notice, the selection bar. `bg-{tone}-50 border-{tone}/30 rounded-large`,
 * one per meaning. Never stack a second bordered surface inside it.
 */
export default function Callout({
  tone = 'info',
  children,
  actions,
  onDismiss,
  icon,
  className = '',
}: CalloutProps) {
  const cls = TONE_CLS[tone];
  const Icon = TONE_ICON[tone];

  return (
    <div
      className={`flex items-center gap-3 border rounded-large px-4 py-2.5 flex-wrap ${cls.box} ${className}`}
    >
      {icon ?? <Icon size={16} className={`flex-none ${cls.icon}`} />}
      <span className={`text-sm font-semibold ${cls.text}`}>{children}</span>
      {(actions || onDismiss) && (
        <div className="flex items-center gap-2 ml-auto">
          {actions}
          {onDismiss && (
            <button
              onClick={onDismiss}
              aria-label="Dismiss"
              className={`w-7 h-7 rounded-medium flex items-center justify-center hover:bg-content1/60 dark:hover:bg-black/20 transition-colors ${cls.icon}`}
            >
              <X size={15} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
