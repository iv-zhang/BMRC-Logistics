import type { StatpackItem } from '../types';

/** Identity of a physical content entry, independent of mutable counts/checks.
 * Keep SKU, pocket and compartment on submitted entries; this key is UI state only.
 * Identical duplicates at the same physical location should be merged by pack setup.
 */
export function statpackEntryKey(item: Pick<StatpackItem, 'itemId' | 'pocket' | 'compartmentId' | 'batchId' | 'variantId' | 'assetInstanceId' | 'serialNumber'>): string {
  return encodeURIComponent(JSON.stringify([
    item.itemId, item.pocket ?? '', item.compartmentId ?? '', item.batchId ?? '',
    item.variantId ?? '', item.assetInstanceId ?? '', item.serialNumber ?? '',
  ]));
}
