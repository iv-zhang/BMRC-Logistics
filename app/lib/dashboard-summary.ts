import type { InventoryItem, Statpack } from '@/app/types';
import { batchHasStock, computeBagStock, displayLocation, expiringCutoff } from '@/app/lib/item-status';

type Raw = Record<string, unknown>;

function asDate(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  if (value && typeof value === 'object' && typeof (value as { toDate?: unknown }).toDate === 'function') {
    try {
      const parsed = (value as { toDate: () => unknown }).toDate();
      return parsed instanceof Date && !Number.isNaN(parsed.getTime()) ? parsed : undefined;
    } catch { return undefined; }
  }
  return undefined;
}

function withDateFields(value: Raw, fields: string[]): Raw {
  const result: Raw = { ...value };
  for (const field of fields) {
    const parsed = asDate(value[field]);
    if (parsed) result[field] = parsed;
    else if (value[field] != null) delete result[field];
  }
  return result;
}

export function hydrateDashboardInventory(id: string, raw: Raw): InventoryItem {
  const batches = (Array.isArray(raw.batches) ? raw.batches : []).map(batch =>
    batch && typeof batch === 'object'
      ? withDateFields(batch as Raw, ['expirationDate', 'openDate', 'openedAt', 'receivedAt'])
      : batch,
  );
  return { ...withDateFields(raw, [
    'expirationDate', 'assetNextExpiration', 'batteryExpiration', 'padExpiration',
    'lastShelfCheckAt', 'lastAuditDate',
  ]), id, batches } as unknown as InventoryItem;
}

export function hydrateDashboardPack(id: string, raw: Raw): Statpack {
  const contents = (Array.isArray(raw.contents) ? raw.contents : []).map(entry =>
    entry && typeof entry === 'object'
      ? withDateFields(entry as Raw, ['expirationDate', 'effectiveExpiration'])
      : entry,
  );
  return { ...withDateFields(raw, ['lastCheckedAt']), id, contents } as unknown as Statpack;
}

export function getLowReserveItems(inventory: InventoryItem[]): InventoryItem[] {
  return inventory.filter(item => {
    if (item.isOxygen) return false;
    const available = computeBagStock(item).availableItems;
    return available === 0 || (item.reorderThreshold > 0 && available <= item.reorderThreshold);
  });
}

export interface DashboardExpiryAlert {
  name: string;
  src: 'Pack' | 'Reserve';
  loc: string;
  expDate: Date;
  daysLeft: number;
}

export function getDashboardExpiryAlerts(
  packs: Statpack[], inventory: InventoryItem[], now = new Date(),
): DashboardExpiryAlert[] {
  const cutoff = expiringCutoff(now).getTime();
  const day = 24 * 60 * 60 * 1000;
  const alerts: DashboardExpiryAlert[] = [];
  const add = (name: string, src: DashboardExpiryAlert['src'], loc: string, value: unknown) => {
    const date = asDate(value);
    if (!date || date.getTime() > cutoff) return;
    alerts.push({ name, src, loc, expDate: date, daysLeft: date < now ? Math.floor((date.getTime() - now.getTime()) / day) : Math.ceil((date.getTime() - now.getTime()) / day) });
  };

  for (const item of inventory) {
    for (const batch of item.batches ?? []) {
      if (!batchHasStock(batch) || !batch.expirationDate) continue;
      add(item.name, 'Reserve', displayLocation(item) || 'Unknown location', batch.expirationDate);
    }
  }
  for (const pack of packs) {
    for (const content of pack.contents ?? []) {
      if ((content.currentQuantity ?? content.requiredQuantity ?? 0) <= 0) continue;
      add(content.itemDetails?.name || 'Unknown Item', 'Pack', pack.name, content.effectiveExpiration ?? content.expirationDate);
    }
  }
  return alerts.sort((a, b) => a.daysLeft - b.daysLeft);
}
