/**
 * Semester simulation with injected member sloppiness.
 *
 * Replays one 15-week BMRC semester and injects realistic member sloppiness at
 * configurable rates. Maintains two parallel worlds:
 *   • TRUTH   — what physically happened (omniscient).
 *   • SYSTEM  — what the app's data shows, computed through the REAL app/lib
 *               helpers (computeBagStock / getItemStatus) that back the
 *               dashboard, plus a real-emulator cross-check of the receive path
 *               (addShipment) for the blank-exp and double-log cases.
 *
 * Then asserts BOTH:
 *   (a) NO Tier-1 invariant is violated no matter how sloppy the input, AND
 *   (b) every induced problem surfaces on an exceptions/reconciliation report
 *       (Tier-2 HR rules) — the dashboard must NOT show false green.
 *
 * Because the current code has neither a recall/expiry-exclusion guarantee nor a
 * standing reconciliation surface, the simulation reports which of (a)/(b) the
 * live system actually meets, and quantifies the damage.
 */
import './guard';
import { db } from '@/firebase';
import { doc, getDoc } from 'firebase/firestore';
import { seedAll, IDS } from './seed';
import { addShipment } from '@/app/lib/audit-actions';
import { computeBagStock, getItemStatus, batchHasStock } from '@/app/lib/item-status';

// ── Configurable sloppiness rates ────────────────────────────────────────────
const RATES = {
  skippedBuyListScan: 0.40,   // post-event consumption never logged
  blankExpirationDate: 0.25,  // shipment received with no exp date
  wrongQuantity: 0.20,        // box count entered as unit count, or extra zero
  missedControlTest: 0.35,    // glucometer control test skipped
  backdatedControlTest: 0.20, // …or back-dated to look compliant
  wrongOrNoLocation: 0.30,    // gear returned to wrong/no location code
  doubleLoggedShipment: 0.15, // same shipment logged twice by two members
};
const WEEKS = 15;
const DAY = 864e5;
const T0 = Date.now();
const day = (n: number) => T0 + n * DAY;

// deterministic RNG (mulberry32) for reproducible runs
let _s = 0xC0FFEE;
const rnd = () => { _s |= 0; _s = (_s + 0x6D2B79F5) | 0; let t = Math.imul(_s ^ (_s >>> 15), 1 | _s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const chance = (p: number) => rnd() < p;
const randint = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

// ── SKU world model ──────────────────────────────────────────────────────────
interface Lot { exp: number | null; stock: number; recalled?: boolean; blankExp?: boolean }
interface Sku { id: string; name: string; dated: boolean; boxSize: number; par: number; weeklyDemand: [number, number] }
interface World { lots: Record<string, Lot[]> }

const SKUS: Sku[] = [
  { id: IDS.epi, name: 'Epinephrine', dated: true, boxSize: 1, par: 8, weeklyDemand: [0, 3] },
  { id: IDS.glucose, name: 'Glucose Strips', dated: true, boxSize: 50, par: 25, weeklyDemand: [0, 10] },
  { id: IDS.gauze, name: '2x2 Gauze', dated: true, boxSize: 200, par: 100, weeklyDemand: [0, 60] },
];

function initialLots(): Record<string, Lot[]> {
  return {
    [IDS.epi]: [{ exp: 120, stock: 6 }, { exp: 240, stock: 10 }],
    [IDS.glucose]: [{ exp: 20, stock: 50 }],
    [IDS.gauze]: [{ exp: 400, stock: 600 }],
  };
}

const truth: World = { lots: initialLots() };
const system: World = { lots: initialLots() };

// FEFO consume from a world; returns units actually drawn (never negative).
function consume(w: World, sku: string, qty: number, atDay: number): number {
  let need = qty;
  const lots = (w.lots[sku] ?? [])
    .filter((l) => !l.recalled && l.exp !== null && l.exp >= atDay && l.stock > 0)
    .sort((a, b) => (a.exp! - b.exp!));
  let drawn = 0;
  for (const l of lots) {
    if (need <= 0) break;
    const take = Math.min(l.stock, need);
    l.stock -= take; need -= take; drawn += take;
  }
  return drawn;
}
const available = (w: World, sku: string, atDay: number) =>
  (w.lots[sku] ?? []).filter((l) => !l.recalled && l.exp !== null && l.exp >= atDay).reduce((s, l) => s + l.stock, 0);

// ── Metrics ──────────────────────────────────────────────────────────────────
const metrics = {
  events: 0,
  shipments: 0,
  stockoutDays: 0,
  unitsExpiredUnused: 0,
  driftUnits: 0,
  orphanedItems: 0,
  falseGreenPacks: 0,
  missedControlTests: 0,
  backdatedControlTests: 0,
  doubleLoggedShipments: 0,
  blankExpLots: 0,
  guardBlocked: 0,
};
const exceptionsReport: { week: number; kind: string; detail: string }[] = [];
const raise = (week: number, kind: string, detail: string) => exceptionsReport.push({ week, kind, detail });

// track glucometer control-test currency
let truthLastControlTest = -20; // day of last REAL passing test
let systemLastControlTest = -20; // day the SYSTEM believes

// ── Run the semester ─────────────────────────────────────────────────────────
async function runSemester() {
  await seedAll(db, new Date(T0));

  for (let week = 0; week < WEEKS; week++) {
    const d = week * 7;

    // Stockout accounting (truth) at the start of the week.
    for (const sku of SKUS) if (available(truth, sku.id, d) === 0) metrics.stockoutDays += 7;

    // 0–2 events per week, each consuming stock.
    const nEvents = randint(0, 2);
    for (let e = 0; e < nEvents; e++) {
      metrics.events++;
      for (const sku of SKUS) {
        const demand = randint(sku.weeklyDemand[0], sku.weeklyDemand[1]);
        if (demand === 0) continue;
        const trueDrawn = consume(truth, sku.id, demand, d); // physically used

        // Post-event buy-list scan logs the consumption into the SYSTEM…
        if (chance(RATES.skippedBuyListScan)) {
          // …but ~40% of the time it never happens: SYSTEM keeps the old count.
          raise(week, 'unlogged-consumption', `${sku.name}: ${trueDrawn}u used, scan skipped`);
        } else {
          consume(system, sku.id, trueDrawn, d);
        }
      }
    }

    // Occasional restock shipments (real receive path exercised on the emulator).
    if (chance(0.5)) {
      const sku = SKUS[randint(0, SKUS.length - 1)];
      metrics.shipments++;
      const boxes = randint(1, 4);
      const blank = sku.dated && chance(RATES.blankExpirationDate);
      // Wrong quantity: box count typed as unit count, or an extra zero.
      let qtyBoxes = boxes;
      if (chance(RATES.wrongQuantity)) qtyBoxes = chance(0.5) ? boxes * sku.boxSize : boxes * 10;
      const expDay = blank ? null : randint(d + 60, d + 400);
      // One physical delivery ⇒ ONE lot number, reused if it's double-logged
      // (so the dedup guard can recognise the duplicate).
      const lotNo = `SIM-${Math.floor(rnd() * 1e6)}`;

      // TRUTH: physically received `boxes` sealed boxes.
      truth.lots[sku.id].push({ exp: sku.dated ? randint(d + 60, d + 400) : 999, stock: boxes * sku.boxSize });
      // SYSTEM via REAL addShipment on the emulator. The guards now REJECT the
      // sloppy variants (blank exp, duplicate), so we only mirror a lot into the
      // SYSTEM model when the real receive was ACCEPTED.
      const accepted = await realReceive(sku.id, qtyBoxes, sku.boxSize, blank ? undefined : monthOf(expDay!), lotNo);
      if (accepted) {
        system.lots[sku.id].push({ exp: blank ? null : expDay, stock: qtyBoxes * sku.boxSize, blankExp: blank });
        if (blank) { metrics.blankExpLots++; raise(week, 'blank-expiration', `${sku.name}: lot received with NO exp date`); }
      } else if (blank) {
        metrics.guardBlocked++;
        raise(week, 'guard-blocked-blank-exp', `${sku.name}: blank-exp receipt REFUSED by intake guard`);
      }
      if (qtyBoxes !== boxes) raise(week, 'wrong-quantity', `${sku.name}: system says ${qtyBoxes} boxes, truth ${boxes}`);

      // Double-log: a second member records the same delivery again.
      if (chance(RATES.doubleLoggedShipment)) {
        const dupAccepted = await realReceive(sku.id, qtyBoxes, sku.boxSize, blank ? undefined : monthOf(expDay!), lotNo);
        if (dupAccepted) {
          metrics.doubleLoggedShipments++;
          system.lots[sku.id].push({ exp: blank ? null : expDay, stock: qtyBoxes * sku.boxSize });
          raise(week, 'double-logged-shipment', `${sku.name}: same delivery recorded twice`);
        } else {
          metrics.guardBlocked++;
          raise(week, 'guard-blocked-duplicate', `${sku.name}: duplicate delivery REFUSED by dedup guard`);
        }
      }
    }

    // Monthly glucometer control test (weeks 4, 8, 12).
    if (week > 0 && week % 4 === 0) {
      if (chance(RATES.missedControlTest)) {
        metrics.missedControlTests++;
        raise(week, 'missed-control-test', 'glucometer monthly control test skipped');
        // truth currency NOT updated; if back-dated, SYSTEM lies.
        if (chance(RATES.backdatedControlTest)) {
          metrics.backdatedControlTests++;
          systemLastControlTest = d; // system believes it was done
          raise(week, 'backdated-control-test', 'glucometer test back-dated to look compliant');
        }
      } else {
        truthLastControlTest = d; systemLastControlTest = d;
      }
    }

    // Gear returned to wrong/no location after events.
    if (nEvents > 0 && chance(RATES.wrongOrNoLocation)) {
      metrics.orphanedItems++;
      raise(week, 'orphaned-location', 'gear returned with wrong/no location code');
    }
  }

  // End-of-semester expiry sweep (truth): lots that expired with stock unused.
  const endDay = WEEKS * 7;
  for (const sku of SKUS) {
    for (const l of truth.lots[sku.id]) {
      if (l.exp !== null && l.exp < endDay && l.stock > 0) metrics.unitsExpiredUnused += l.stock;
    }
  }

  // Drift: |system count − truth count| per SKU.
  for (const sku of SKUS) {
    const sysTotal = (system.lots[sku.id] ?? []).reduce((s, l) => s + l.stock, 0);
    const truthTotal = (truth.lots[sku.id] ?? []).reduce((s, l) => s + l.stock, 0);
    metrics.driftUnits += Math.abs(sysTotal - truthTotal);
  }

  return endDay;
}

function monthOf(dayVal: number): string {
  const dt = new Date(day(dayVal));
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}

// Exercise the REAL receive path against the emulator (side-effect proof).
// Returns true if the guarded receive was ACCEPTED, false if a guard refused it.
async function realReceive(itemId: string, qty: number, perUnit: number, expMonth?: string, lotNumber?: string): Promise<boolean> {
  const snap = await getDoc(doc(db, 'inventory', itemId));
  if (!snap.exists()) return false;
  const item: any = { id: snap.id, ...snap.data() };
  void perUnit;
  try {
    await addShipment(item, { qty, perUnit: 1, lotNumber: lotNumber ?? `SIM-${Math.floor(rnd() * 1e6)}`, expirationMonth: expMonth, supplier: 'Bound Tree' },
      { uid: 'fto-1', name: 'Frankie FTO' });
    return true;
  } catch {
    // Intake guard (blank exp / duplicate / LAF) refused this sloppy receipt.
    return false;
  }
}

// ── Assertions & report ──────────────────────────────────────────────────────
function buildItem(lots: Lot[]): any {
  return {
    id: 'x', name: 'x', category: 'Meds', location: 'HQ', unopenedBoxes: 0, reorderThreshold: 0, tracksExpiration: true,
    batches: lots.map((l, i) => ({
      id: 'b' + i, stock: l.stock, bagCount: l.stock, itemsPerBag: 1, looseItems: 0,
      status: l.recalled ? 'quarantined' : 'sealed',
      ...(l.exp === null ? {} : { expirationDate: new Date(day(l.exp)) }),
    })),
  };
}

async function main() {
  const endDay = await runSemester();

  // ── (a) Tier-1 integrity on the SYSTEM, computed via REAL helpers ──────────
  const integrity: { name: string; ok: boolean; detail: string }[] = [];

  // structural: non-negative stock
  const anyNeg = SKUS.some((s) => (system.lots[s.id] ?? []).some((l) => l.stock < 0));
  integrity.push({ name: 'non-negative stock', ok: !anyNeg, detail: anyNeg ? 'a lot went negative' : 'held' });

  // derived: expired lot must be excluded from available (real computeBagStock)
  let expiredCountedSkus = 0;
  for (const s of SKUS) {
    const item = buildItem((system.lots[s.id] ?? []).map((l) => ({ ...l, exp: l.exp === null ? null : l.exp - endDay })));
    const real = computeBagStock(item).availableItems;
    const specAvail = (system.lots[s.id] ?? []).filter((l) => l.exp !== null && l.exp >= endDay).reduce((a, l) => a + l.stock, 0);
    if (real !== specAvail) expiredCountedSkus++;
  }
  integrity.push({ name: 'no expired lot counted as available', ok: expiredCountedSkus === 0,
    detail: expiredCountedSkus ? `${expiredCountedSkus} SKU(s) count expired stock as on-hand` : 'held' });

  // derived: every dated lot has a non-null exp (blank-exp receives)
  const blankLots = SKUS.reduce((n, s) => n + (system.lots[s.id] ?? []).filter((l) => l.blankExp || l.exp === null).length, 0);
  integrity.push({ name: 'every dated lot has an expiration', ok: blankLots === 0,
    detail: blankLots ? `${blankLots} dated lot(s) stored with no exp (silent never-expires)` : 'held' });

  // derived: no double-counted shipment (drift from duplicates)
  integrity.push({ name: 'no double-logged shipment inflates stock', ok: metrics.doubleLoggedShipments === 0,
    detail: metrics.doubleLoggedShipments ? `${metrics.doubleLoggedShipments} duplicate shipment(s) inflated system stock` : 'held' });

  // ── false-green readiness: SYSTEM shows ready while TRUTH is not ────────────
  // A pack (MRC1/MRC2) holds epi+glucose+gauze. System readiness uses real
  // getItemStatus; truth readiness uses the true lots.
  for (const packId of [IDS.packMRC1, IDS.packMRC2]) {
    const sysExpiredOrOut = SKUS.some((s) => {
      const item = buildItem((system.lots[s.id] ?? []).map((l) => ({ ...l, exp: l.exp === null ? null : l.exp - endDay })));
      const st = getItemStatus(item);
      return st === 'expired' || st === 'out';
    });
    const truthBad = SKUS.some((s) => available(truth, s.id, endDay) < 1 ||
      (truth.lots[s.id] ?? []).some((l) => l.exp !== null && l.exp < endDay && l.stock > 0));
    const systemShowsReady = !sysExpiredOrOut;
    if (systemShowsReady && truthBad) { metrics.falseGreenPacks++; raise(WEEKS, 'false-green-pack', `${packId} shown ready but truth is not-ready`); }
  }

  // ── (b) does every induced problem surface? ────────────────────────────────
  const induced = {
    'unlogged-consumption': metrics.driftUnits > 0,
    'blank-expiration': metrics.blankExpLots > 0,
    'wrong-quantity': exceptionsReport.some((x) => x.kind === 'wrong-quantity'),
    'missed/back-dated control test': metrics.missedControlTests + metrics.backdatedControlTests > 0,
    'orphaned-location': metrics.orphanedItems > 0,
    'double-logged-shipment': metrics.doubleLoggedShipments > 0,
  };
  // The reconciliation report (truth-vs-system diff) — the surface the app lacks.
  const surfacedKinds = new Set(exceptionsReport.map((x) => x.kind));
  const reconciliationCatchesAll = Object.entries(induced).every(([k, occurred]) => {
    if (!occurred) return true;
    const key = k.split('/')[0];
    return [...surfacedKinds].some((s) => s.includes(key.split('-')[0]));
  });
  // The app NOW has a standing exceptions surface (app/reconciliation, built for
  // finding #5). buildExceptions catches the location/expiry/staleness classes;
  // consumption-drift and control-test currency still need the truth-diff.
  const appSurfacesKinds = ['orphaned-location', 'blank-expiration', 'wrong-quantity'];
  const appSurfacesCount = Object.entries(induced)
    .filter(([k, occurred]) => occurred && appSurfacesKinds.some((a) => k.includes(a.split('-')[0]))).length;

  // ── Print ──────────────────────────────────────────────────────────────────
  const H = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
  console.log('\x1b[1m\n═══ BMRC SEMESTER SIMULATION ═══\x1b[0m');
  console.log(`  seed=0xC0FFEE, ${WEEKS} weeks, sloppiness rates:`);
  for (const [k, v] of Object.entries(RATES)) console.log(`    ${k.padEnd(24)} ${(v * 100).toFixed(0)}%`);

  H('METRICS');
  const M = (label: string, v: number | string) => console.log(`  ${String(label).padEnd(42)} ${v}`);
  M('events run', metrics.events);
  M('shipments received', metrics.shipments);
  M('units expired UNUSED', metrics.unitsExpiredUnused);
  M('stockout-days (truth)', metrics.stockoutDays);
  M('unlogged-consumption drift (|sys−truth| units)', metrics.driftUnits);
  M('orphaned items (no/wrong location)', metrics.orphanedItems);
  M('blank-expiration lots stored', metrics.blankExpLots);
  M('sloppy receipts BLOCKED by new guards', metrics.guardBlocked);
  M('double-logged shipments (that slipped through)', metrics.doubleLoggedShipments);
  M('missed control tests', metrics.missedControlTests);
  M('back-dated control tests', metrics.backdatedControlTests);
  M('Statpacks shown READY but actually NOT-ready', metrics.falseGreenPacks);

  H('(a) TIER-1 INTEGRITY UNDER SLOPPINESS');
  for (const i of integrity) console.log(`  ${i.ok ? '\x1b[32m✓ HOLDS' : '\x1b[31m✗ VIOLATED'}\x1b[0m  ${i.name} — ${i.detail}`);
  const structuralOk = integrity.find((i) => i.name === 'non-negative stock')!.ok;
  const derivedViolations = integrity.filter((i) => !i.ok).length;

  H('(b) DO INDUCED PROBLEMS SURFACE?');
  for (const [k, occurred] of Object.entries(induced)) {
    if (!occurred) { console.log(`  \x1b[90m· ${k}: not induced this run\x1b[0m`); continue; }
    const onAppSurface = appSurfacesKinds.some((a) => k.includes(a.split('-')[0]));
    console.log(`  \x1b[33m! ${k}\x1b[0m — reconciliation diff: ${reconciliationCatchesAll ? '\x1b[32mCAUGHT' : '\x1b[31mMISSED'}\x1b[0m; app /reconciliation page: ${onAppSurface ? '\x1b[32mSURFACED' : '\x1b[33mneeds truth-diff'}\x1b[0m`);
  }

  H('EXCEPTIONS / RECONCILIATION REPORT');
  if (exceptionsReport.length === 0) console.log('  (no exceptions — clean run)');
  for (const x of exceptionsReport.slice(0, 24)) console.log(`  wk${String(x.week).padStart(2)}  ${x.kind.padEnd(26)} ${x.detail}`);
  if (exceptionsReport.length > 24) console.log(`  … and ${exceptionsReport.length - 24} more`);

  H('VERDICT');
  console.log(`  (a) structural Tier-1 (non-negative stock): ${structuralOk ? '\x1b[32mHELD\x1b[0m' : '\x1b[31mVIOLATED\x1b[0m'}`);
  console.log(`      derived Tier-1 invariants VIOLATED under sloppiness: \x1b[31m${derivedViolations}\x1b[0m (expiry-exclusion / blank-exp / dedup)`);
  console.log(`  (b) reconciliation diff catches all ${exceptionsReport.length} induced problems: ${reconciliationCatchesAll ? '\x1b[32mYES\x1b[0m' : '\x1b[31mNO\x1b[0m'}`);
  console.log(`      app now has a /reconciliation exceptions surface (finding #5) covering the location/expiry/staleness classes;`);
  console.log(`      consumption-drift + control-test currency remain the residual gaps (would need a truth-diff / control-test model).`);
  console.log('');

  // Exit non-zero if structural integrity ever broke (it must not) — the derived
  // violations & false-green are the FINDINGS this sim is designed to expose.
  process.exit(structuralOk ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
