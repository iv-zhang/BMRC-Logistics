/**
 * Pure reference ledger for property-based testing.
 *
 * Implements the CORRECT (spec-compliant) semantics of the five operations
 * {receive, consume, expire, recall, audit} over SKUs with multiple lots across
 * multiple locations. This is the oracle: every Tier-1 invariant holds on this
 * model by construction, so fast-check uses it to (a) validate the invariant
 * checkers + generators + shrinking, and (b) provide the spec-correct
 * "available / expired / quarantined" numbers that the REAL app/lib helpers are
 * then checked against (see run-properties.ts).
 *
 * "Now" is modelled as day 0; lot expirations are integer day-offsets from now
 * (negative = already expired).
 */

export const LOCATIONS = ['MRC1', 'MRC2', 'HQ'] as const;
export type Loc = (typeof LOCATIONS)[number];

export interface Lot {
  id: string;
  sku: string;
  /** day-offset from now; null = a dated SKU received with NO date (illegal). */
  exp: number | null;
  recalled: boolean;
  /** per-location on-hand units */
  holdings: Record<Loc, number>;
}

export type Op =
  | { kind: 'receive'; sku: string; qty: number; exp: number | null; loc: Loc }
  | { kind: 'consume'; sku: string; qty: number }
  | { kind: 'expire'; lotIdx: number }
  | { kind: 'recall'; lotIdx: number }
  | { kind: 'audit'; sku: string };

let counter = 0;
export function resetIds() { counter = 0; }

export class Ledger {
  lots: Lot[] = [];

  private emptyHoldings(): Record<Loc, number> {
    return { MRC1: 0, MRC2: 0, HQ: 0 };
  }

  /** Units of a SKU that are actually deployable: not expired, not recalled. */
  available(sku: string): number {
    return this.lots
      .filter((l) => l.sku === sku && !l.recalled && (l.exp === null ? false : l.exp >= 0))
      .reduce((s, l) => s + l.holdings.MRC1 + l.holdings.MRC2 + l.holdings.HQ, 0);
  }

  /** Total on-hand regardless of expiry/recall (what a naive count would show). */
  total(sku: string): number {
    return this.lots
      .filter((l) => l.sku === sku)
      .reduce((s, l) => s + l.holdings.MRC1 + l.holdings.MRC2 + l.holdings.HQ, 0);
  }

  private lotUnits(l: Lot): number {
    return l.holdings.MRC1 + l.holdings.MRC2 + l.holdings.HQ;
  }

  apply(op: Op): void {
    switch (op.kind) {
      case 'receive': {
        // INV-3: always a DISTINCT new lot.
        this.lots.push({
          id: `L${counter++}`,
          sku: op.sku,
          exp: op.exp,
          recalled: false,
          holdings: { ...this.emptyHoldings(), [op.loc]: Math.max(0, op.qty) },
        });
        break;
      }
      case 'consume': {
        // INV-1 + INV-5: refuse over-consume; draw FEFO from deployable lots.
        let need = Math.max(0, op.qty);
        if (need > this.available(op.sku)) return; // refuse; no underflow
        const fefo = this.lots
          .filter((l) => l.sku === op.sku && !l.recalled && l.exp !== null && l.exp >= 0 && this.lotUnits(l) > 0)
          .sort((a, b) => (a.exp! - b.exp!) || a.id.localeCompare(b.id));
        for (const lot of fefo) {
          if (need <= 0) break;
          for (const loc of LOCATIONS) {
            if (need <= 0) break;
            const take = Math.min(lot.holdings[loc], need);
            lot.holdings[loc] -= take;
            need -= take;
          }
        }
        break;
      }
      case 'expire': {
        const lot = this.lots[op.lotIdx % Math.max(1, this.lots.length)];
        if (lot) lot.exp = -1;
        break;
      }
      case 'recall': {
        // INV-7: recall marks the lot recalled in EVERY location at once.
        const lot = this.lots[op.lotIdx % Math.max(1, this.lots.length)];
        if (lot) lot.recalled = true;
        break;
      }
      case 'audit':
        break; // verification only; no stock mutation
    }
  }
}

export function lotUnits(l: Lot): number {
  return l.holdings.MRC1 + l.holdings.MRC2 + l.holdings.HQ;
}

// ── Tier-1 invariant checkers over a ledger state ────────────────────────────
export interface InvariantResult { ok: boolean; name: string; detail?: string }

export function checkInvariants(ledger: Ledger): InvariantResult[] {
  const skus = Array.from(new Set(ledger.lots.map((l) => l.sku)));
  const out: InvariantResult[] = [];

  // 1) non-negative stock everywhere
  const neg = ledger.lots.find((l) => LOCATIONS.some((loc) => l.holdings[loc] < 0));
  out.push({ ok: !neg, name: 'non-negative-stock', detail: neg ? `lot ${neg.id} went negative` : undefined });

  // 2) lot-sum == reported total
  const lotsumBad = skus.find((s) => {
    const sum = ledger.lots.filter((l) => l.sku === s).reduce((a, l) => a + l.holdings.MRC1 + l.holdings.MRC2 + l.holdings.HQ, 0);
    return sum !== ledger.total(s);
  });
  out.push({ ok: !lotsumBad, name: 'lot-sum==total', detail: lotsumBad ? `sku ${lotsumBad}` : undefined });

  // 3) no expired lot counted as available
  const expiredCounted = skus.find((s) =>
    ledger.lots.some((l) => l.sku === s && l.exp !== null && l.exp < 0 && !l.recalled && lotUnits(l) > 0) &&
    ledger.available(s) > ledger.lots.filter((l) => l.sku === s && !l.recalled && l.exp !== null && l.exp >= 0).reduce((a, l) => a + l.holdings.MRC1 + l.holdings.MRC2 + l.holdings.HQ, 0));
  out.push({ ok: !expiredCounted, name: 'no-expired-available', detail: expiredCounted ? `sku ${expiredCounted}` : undefined });

  // 4) recalled lot fully quarantined across all locations (0 available)
  const recallBad = ledger.lots.find((l) => l.recalled && (l.holdings.MRC1 + l.holdings.MRC2 + l.holdings.HQ) > 0 &&
    ledger.available(l.sku) < 0); // available() already excludes recalled, so this can never be >0 from a recalled lot
  // Direct check: a recalled lot must never contribute to available().
  const recalledContributes = skus.some((s) => {
    const avail = ledger.available(s);
    const availExclRecalled = ledger.lots.filter((l) => l.sku === s && !l.recalled && l.exp !== null && l.exp >= 0)
      .reduce((a, l) => a + l.holdings.MRC1 + l.holdings.MRC2 + l.holdings.HQ, 0);
    return avail !== availExclRecalled;
  });
  out.push({ ok: !recalledContributes && !recallBad, name: 'recall-quarantined-everywhere', detail: recalledContributes ? 'recalled lot still available' : undefined });

  return out;
}
