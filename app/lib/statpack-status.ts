export interface StatpackStatusInfo {
  label: string;
  color: string;
  bg: string;
}

const STATUS_INFO: Record<string, StatpackStatusInfo> = {
  Ready: { label: 'Ready', color: 'text-success', bg: 'bg-success-50 dark:bg-success-900/20' },
  'Restock Needed': { label: 'Restock Needed', color: 'text-warning', bg: 'bg-warning-50 dark:bg-warning-900/20' },
  'Expired Items': { label: 'Expired Items', color: 'text-danger', bg: 'bg-danger-50 dark:bg-danger-900/20' },
  'CRITICAL - EXPIRED ITEMS': { label: 'CRITICAL - EXPIRED ITEMS', color: 'text-danger', bg: 'bg-danger-50 dark:bg-danger-900/20' },
  'In Use': { label: 'In Use', color: 'text-primary', bg: 'bg-primary-50 dark:bg-primary-900/20' },
  'Pending Initial Check': { label: 'Pending Initial Check', color: 'text-warning', bg: 'bg-warning-50 dark:bg-warning-900/20' },
  'In Maintenance': { label: 'In Maintenance', color: 'text-warning', bg: 'bg-warning-50 dark:bg-warning-900/20' },
};

const UNKNOWN_STATUS: StatpackStatusInfo = {
  label: 'Unknown',
  color: 'text-default-500',
  bg: 'bg-default-100 dark:bg-default-50/10',
};

export function getStatpackStatusInfo(status: unknown): StatpackStatusInfo {
  if (typeof status !== 'string') return UNKNOWN_STATUS;
  return Object.hasOwn(STATUS_INFO, status) ? STATUS_INFO[status] : UNKNOWN_STATUS;
}
