import type { InventoryItem } from '@/app/types';
import { computeBagStock } from '@/app/lib/item-status';

export interface AuditCountInput {
  countedBoxes?: number;
  countedLooseUnits?: number;
  itemsPerBox?: number;
  /** Canonical quantities change only after an explicit correction action. */
  reconcileCount?: boolean;
  expectedStockFingerprint?: string;
}

function integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative integer`);
  return value;
}

/** A deterministic stock snapshot, including lot metadata that a correction must preserve.
 * Excludes audit stamps, notes, shelf stock, and other unrelated item edits.
 */
export function auditStockFingerprint(item: InventoryItem): string {
  function canonical(value: unknown): unknown {
    if (value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
      return (value.toDate() as Date).toISOString();
    }
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, canonical(val)]));
    }
    return value;
  }
  return JSON.stringify(canonical({
    unopenedBoxes: item.unopenedBoxes ?? 0, looseUnits: item.looseUnits ?? 0,
    itemsPerBox: item.itemsPerBox, totalStockQuantity: item.totalStockQuantity,
    batches: item.batches ?? [],
  }));
}

/** Pure write plan, shared by the writer and regression tests. No lot allocation. */
export function buildAuditCountPlan(item: InventoryItem, input: AuditCountInput) {
  const stock = computeBagStock(item);
  const boxes = integer(input.countedBoxes ?? 0, 'Sealed packages');
  // Legacy callers that count packages only must not erase existing loose stock.
  const loose = integer(input.countedLooseUnits ?? stock.totalLoose, 'Loose units');
  if (input.itemsPerBox !== undefined && (!Number.isSafeInteger(input.itemsPerBox) || input.itemsPerBox <= 0)) {
    throw new Error('Units per package must be a positive integer');
  }
  const tracked = (item.batches ?? []).filter(b => b.bagCount !== undefined || b.itemsPerBag !== undefined || b.looseItems !== undefined);
  const sizes = new Set(tracked.map(b => b.itemsPerBag).filter((n): n is number => n !== undefined && n > 0));
  const missingSealedConversion = tracked.some(b => (b.bagCount ?? 0) > 0 && !(b.itemsPerBag && b.itemsPerBag > 0));
  const systemPerPackage = stock.hasBagTracking
    ? (missingSealedConversion ? undefined : tracked.length === 1 ? tracked[0].itemsPerBag : sizes.size === 1 ? [...sizes][0] : undefined)
    : item.itemsPerBox;
  const perPackage = stock.hasBagTracking ? systemPerPackage : input.itemsPerBox ?? systemPerPackage;
  const total = boxes === 0 ? loose : perPackage && perPackage > 0 ? boxes * perPackage + loose : null;
  if (total !== null) integer(total, 'Total units');
  const variance = boxes !== stock.totalBags || loose !== stock.totalLoose ||
    (input.itemsPerBox !== undefined && input.itemsPerBox !== systemPerPackage && boxes > 0);
  const cannotReconcile = total === null || (stock.hasBagTracking && (tracked.length !== 1 || (input.itemsPerBox !== undefined && input.itemsPerBox !== systemPerPackage)) && variance);
  const unresolved = cannotReconcile || (variance && !input.reconcileCount);
  const patch: Record<string, unknown> = {};
  if (input.reconcileCount && variance && !cannotReconcile) {
    if (stock.hasBagTracking && tracked.length === 1) {
      patch.batches = (item.batches ?? []).map(b => b === tracked[0]
        ? { ...b, bagCount: boxes, looseItems: loose, stock: total! }
        : b);
    } else if (!stock.hasBagTracking) {
      patch.unopenedBoxes = boxes;
      patch.looseUnits = loose;
      if (input.itemsPerBox !== undefined) patch.itemsPerBox = input.itemsPerBox;
    }
    patch.totalStockQuantity = total;
  }
  return {
    boxes, loose, perPackage: perPackage ?? null, total, variance, unresolved,
    verified: !unresolved, canReconcile: !cannotReconcile,
    systemBoxes: stock.totalBags, systemLoose: stock.totalLoose,
    systemTotal: stock.totalBags > 0 && (!systemPerPackage || systemPerPackage <= 0) ? null : stock.totalItems,
    patch,
  };
}
