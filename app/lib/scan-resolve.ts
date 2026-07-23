/**
 * Single entry point for "what does this scanned code mean?" — used by
 * every scan-to-X surface (receive, audit shipment, item lookup) so
 * resolution order stays consistent instead of re-implemented per page.
 *
 * Resolution order:
 *   1. Own-label prefix (`BMRC-I-<itemId>`, printed on labels we generate
 *      ourselves — see `ownLabelPayload`/`parseOwnLabel` below).
 *   2. Exchange-bag QR (`parseBagQr`, `app/lib/exchange-bags.ts`).
 *   3. `barcode_index` lookup (see `app/lib/inventory.ts` `assignBarcode`) —
 *      the O(1) index doc keyed by normalized code.
 *   4. Direct field queries on `inventory` for `assignedBarcode` / `barcode`
 *      / `qr` / `assetSerial` — covers items/instances assigned before the
 *      index existed, or never indexed (e.g. manufacturer-printed serials).
 *   5. GS1 GTIN match against `inventory.gtin` (when the SKU has one on
 *      file) — parsed from the same code via `parseGs1Barcode`.
 *
 * Whatever GS1 data was embedded in the code (lot/expiration) is always
 * attached to an `item` match so receiving/shipment flows can prefill it,
 * even when resolution succeeded via a different path (e.g. own-label).
 */

import { collection, doc, getDoc, getDocs, limit, query, where } from 'firebase/firestore';
import { db } from '@/firebase';
import type { InventoryItem } from '@/app/types';
import { parseBagQr } from '@/app/lib/exchange-bags';
import { parseGs1Barcode } from '@/app/lib/gs1';

export type ScanMatch =
  | { kind: 'item'; item: InventoryItem; gs1?: { lot?: string; expiration?: string } }
  | { kind: 'bag'; bagId: string }
  | { kind: 'statpack'; id: string }
  | { kind: 'none'; code: string };

/** Prefix for labels this app prints itself — see `ownLabelPayload`. */
export const OWN_LABEL_PREFIX = 'BMRC-I-';

/** Encode side: the payload printed on a label we generate for an inventory item. */
export function ownLabelPayload(itemId: string): string {
  return `${OWN_LABEL_PREFIX}${itemId}`;
}

/** Decode side: recovers the item id from a scanned own-label code, or null. */
export function parseOwnLabel(code: string): string | null {
  const trimmed = code.trim();
  if (!trimmed.startsWith(OWN_LABEL_PREFIX)) return null;
  const id = trimmed.slice(OWN_LABEL_PREFIX.length).trim();
  return id || null;
}

function hydrateItem(id: string, data: Record<string, unknown>): InventoryItem {
  return { id, ...(data as object) } as InventoryItem;
}

async function fetchItemById(itemId: string): Promise<InventoryItem | null> {
  const snap = await getDoc(doc(db, 'inventory', itemId));
  if (!snap.exists()) return null;
  return hydrateItem(snap.id, snap.data());
}

/** First `inventory` doc matching `field == value`, or null. */
async function fetchItemByField(field: string, value: string): Promise<InventoryItem | null> {
  const snap = await getDocs(
    query(collection(db, 'inventory'), where(field, '==', value), limit(1)),
  );
  if (snap.empty) return null;
  const d = snap.docs[0];
  return hydrateItem(d.id, d.data());
}

/** Attach any GS1 data embedded in the raw scanned code to an item match. */
function withGs1(item: InventoryItem, rawCode: string): ScanMatch {
  const parsed = parseGs1Barcode(rawCode);
  const gs1 =
    parsed.lot || parsed.expiration ? { lot: parsed.lot, expiration: parsed.expiration } : undefined;
  return { kind: 'item', item, gs1 };
}

export async function resolveScan(code: string): Promise<ScanMatch> {
  const raw = String(code ?? '');
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'none', code: raw };
  // Codes are matched case-insensitively (scanners/keyboards vary in case
  // handling) but the original scanned text is what's shown back to the
  // user and stored in ledgers — never the uppercased comparison form.
  const normalized = trimmed.toUpperCase();

  // 1. Own-label prefix.
  const ownItemId = parseOwnLabel(trimmed);
  if (ownItemId) {
    const item = await fetchItemById(ownItemId);
    if (item) return withGs1(item, trimmed);
    return { kind: 'none', code: raw };
  }

  // 2. Exchange-bag QR.
  const bagId = parseBagQr(trimmed);
  if (bagId) return { kind: 'bag', bagId };

  // 3. barcode_index lookup (see assignBarcode in app/lib/inventory.ts).
  try {
    const indexSnap = await getDoc(doc(db, 'barcode_index', normalized));
    if (indexSnap.exists()) {
      const data = indexSnap.data() as { itemId?: string };
      if (data.itemId) {
        const item = await fetchItemById(data.itemId);
        if (item) return withGs1(item, trimmed);
      }
    }
  } catch {
    // Fall through to direct field queries — an index miss/error should
    // never block resolution when the legacy fields still work.
  }

  // 4. Direct field queries — covers barcodes assigned before the index
  // existed, or codes that were never indexed (manufacturer serials).
  for (const field of ['assignedBarcode', 'barcode', 'qr', 'assetSerial']) {
    const item = await fetchItemByField(field, trimmed);
    if (item) return withGs1(item, trimmed);
  }

  // 5. GS1 GTIN match against a SKU's own `gtin` field, when present.
  const { gtin } = parseGs1Barcode(trimmed);
  if (gtin) {
    const item = await fetchItemByField('gtin', gtin);
    if (item) return withGs1(item, trimmed);
  }

  return { kind: 'none', code: raw };
}
