'use client';

import { AlertTriangle } from 'lucide-react';

/** Plain-language reason for a failed Firestore read. */
export function describeLoadError(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  if (code === 'permission-denied') return "You don't have permission to view this.";
  // A failed Firestore client can't recover in place; only a reload restarts it.
  const message = String((err as { message?: string } | null)?.message ?? '');
  if (/INTERNAL ASSERTION FAILED|AsyncQueue is already failed/.test(message)) {
    return 'The data connection stopped. Reload the page to reconnect.';
  }
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 'You may be offline.';
  return 'Check your connection, then try again.';
}

interface Props {
  title: string;
  message?: string;
  onRetry?: () => void;
  compact?: boolean;
  testId?: string;
}

/** Shared "this failed to load" notice so a failed read never looks like an empty list. */
export default function LoadFailureNotice({ title, message, onRetry, compact, testId }: Props) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className={`flex items-start gap-3 rounded-large border border-danger/30 bg-danger-50 dark:bg-danger-900/20 ${
        compact ? 'px-3 py-2' : 'px-4 py-4'
      }`}
    >
      <AlertTriangle size={compact ? 16 : 20} className="mt-0.5 flex-none text-danger" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className={`font-semibold text-foreground ${compact ? 'text-sm' : 'text-base'}`}>{title}</p>
        {message && <p className="text-xs text-foreground-500 mt-0.5">{message}</p>}
      </div>
      {onRetry && (
        <button
          type="button"
          aria-label={`Retry: ${title}`}
          className="flex-none rounded-lg bg-primary px-3 py-1.5 text-sm text-white"
          onClick={onRetry}
        >
          Retry
        </button>
      )}
    </div>
  );
}
