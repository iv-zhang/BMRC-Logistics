import { InventoryBatch, InventoryItem } from '@/app/types';

/**
 * Calculate effective expiration for a batch considering openDate
 * effectiveExpiration = MIN(printedExpiration, openDate + daysValidAfterOpening)
 */
export function getEffectiveBatchExpiration(
  batch: InventoryBatch,
  item?: InventoryItem
): Date | undefined {
  const printed = batch.expirationDate;
  const opened = batch.openDate;
  const daysValid = item?.daysValidAfterOpening || 90; // Default 90 days for reagents

  if (!printed && !opened) return undefined;
  if (!opened) return printed;
  if (!printed) {
    // Only openDate available
    const eff = new Date(opened);
    eff.setDate(eff.getDate() + daysValid);
    return eff;
  }

  // Both available: return MIN
  const openExpiry = new Date(opened);
  openExpiry.setDate(openExpiry.getDate() + daysValid);
  return openExpiry < printed ? openExpiry : printed;
}

/**
 * Check if a batch is expired considering openDate logic
 */
export function isBatchExpired(batch: InventoryBatch, item?: InventoryItem): boolean {
  const effective = getEffectiveBatchExpiration(batch, item);
  if (!effective) return false;
  return effective < new Date();
}

/**
 * Sort batches by FIFO (oldest expiration first)
 * Used for smart picking during restock
 */
export function sortBatchesFIFO(
  batches: InventoryBatch[],
  item?: InventoryItem
): InventoryBatch[] {
  return [...batches].sort((a, b) => {
    const aExp = getEffectiveBatchExpiration(a, item);
    const bExp = getEffectiveBatchExpiration(b, item);
    
    if (!aExp && !bExp) return 0;
    if (!aExp) return 1; // batches without expiry go last
    if (!bExp) return -1;
    
    return aExp.getTime() - bExp.getTime();
  });
}

/**
 * Get the oldest valid (non-expired) batch for FIFO picking
 */
export function getOldestValidBatch(
  batches: InventoryBatch[],
  item?: InventoryItem
): InventoryBatch | null {
  const validBatches = batches.filter(b => !isBatchExpired(b, item) && (b.stock ?? 0) > 0);
  if (validBatches.length === 0) return null;
  
  const sorted = sortBatchesFIFO(validBatches, item);
  return sorted[0];
}

/**
 * Get smart pick instructions for FIFO restocking
 */
export function getSmartPickInstructions(
  batch: InventoryBatch,
  item?: InventoryItem
): string {
  const location = batch.locations?.[0];
  const expDate = getEffectiveBatchExpiration(batch, item);
  const expStr = expDate ? expDate.toLocaleDateString() : 'Unknown';
  const lotStr = batch.lotNumber ? `Lot #${batch.lotNumber}` : 'No lot #';
  
  const where = location?.name || 'Unknown location';
  
  return `📍 Go to ${where}. Take from ${lotStr} (Exp: ${expStr}). Use oldest stock first.`;
}
