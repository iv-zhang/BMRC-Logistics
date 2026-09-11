/**
 * Pure helpers for reading "what's short in this pack" straight off persisted
 * `Statpack.contents` — no Firestore reads/writes here. Mirrors the asset test
 * `logStatpackCheckOff` uses (`app/lib/inventory.ts`, `isAssetEntry`) so an
 * asset entry (serial/assetInstanceId-linked, status-tracked not counted) is
 * never mistaken for a consumable shortage.
 */
import type { Statpack, StatpackItem } from '@/app/types';

export interface PackShortage {
  itemId: string;
  name: string;
  pocket?: string;
  currentQuantity: number;
  requiredQuantity: number;
}

export interface PackShortages {
  out: PackShortage[];
  low: PackShortage[];
  total: number;
}

function isAssetContent(c: StatpackItem): boolean {
  return Boolean(c.serialNumber) || Boolean(c.assetInstanceId) || Boolean(c.itemDetails?.isAsset);
}

/**
 * Walk a pack's persisted contents and classify every required consumable
 * that's counted below par. Missing/never-counted `currentQuantity` is NOT a
 * shortage here (it means "never counted", matching how the check-off page
 * initializes counts from `currentQuantity ?? requiredQuantity`) — only a
 * finite numeric count below `requiredQuantity` counts.
 */
export function getPackShortages(pack: Pick<Statpack, 'contents'> | null | undefined): PackShortages {
  const out: PackShortage[] = [];
  const low: PackShortage[] = [];

  for (const c of pack?.contents ?? []) {
    if (!c || isAssetContent(c)) continue;

    const required = c.requiredQuantity;
    if (typeof required !== 'number' || !Number.isFinite(required) || required <= 0) continue;

    const current = c.currentQuantity;
    if (typeof current !== 'number' || !Number.isFinite(current)) continue; // never counted
    if (current >= required) continue;

    const shortage: PackShortage = {
      itemId: c.itemId,
      name: c.itemDetails?.name ?? 'Unknown item',
      pocket: c.pocket,
      currentQuantity: current,
      requiredQuantity: required,
    };

    if (current <= 0) out.push(shortage);
    else low.push(shortage);
  }

  return { out, low, total: out.length + low.length };
}

/** e.g. "Gauze 4x4 1/2" */
export function formatShortage(s: PackShortage): string {
  return `${s.name} ${s.currentQuantity}/${s.requiredQuantity}`;
}
