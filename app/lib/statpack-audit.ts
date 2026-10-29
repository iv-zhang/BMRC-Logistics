import type { Statpack } from '@/app/types';

/** Audit findings describe contents; custody remains the live transaction's state. */
export function buildStatpackAuditUpdate<T>(
  live: { isCheckedOut?: unknown },
  derivedStatus: Statpack['status'],
  auditedAt: T,
  auditedBy: string,
) {
  return {
    ...(live.isCheckedOut === true ? {} : { status: derivedStatus }),
    lastAuditAt: auditedAt,
    lastAuditBy: auditedBy,
  };
}
