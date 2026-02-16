import type { StorageLocationRef } from '@/app/types';

/**
 * Format a StorageLocationRef into a human-readable string.
 * Examples:
 *   "HQ / Back" → zone only
 *   "HQ / Back › Shelf A" → zone + shelf
 *   "HQ / Back › Shelf A › L2" → zone + shelf + level
 *   "HQ / Back › Shelf A › L2 › Bin 3" → full path
 */
export function formatStorageLocation(loc?: StorageLocationRef): string {
  if (!loc) return '';
  const parts: string[] = [];
  if (loc.zoneName) parts.push(loc.zoneName);
  if (loc.shelfName) parts.push(loc.shelfName);
  if (loc.level != null) parts.push(`L${loc.level}`);
  if (loc.containerName) parts.push(loc.containerName);
  return parts.join(' › ');
}

/**
 * Return a short version of the location for compact card displays.
 * Shows the most specific part (container > shelf > zone).
 */
export function shortStorageLocation(loc?: StorageLocationRef): string {
  if (!loc) return '';
  if (loc.containerName) return loc.containerName;
  if (loc.shelfName) {
    const suffix = loc.level != null ? ` L${loc.level}` : '';
    return `${loc.shelfName}${suffix}`;
  }
  return loc.zoneName ?? '';
}
