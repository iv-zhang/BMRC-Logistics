/**
 * Shared emulator test harness.
 *
 * IMPORTANT: import this module FIRST in every test file. Importing it:
 *   1. runs ./guard (aborts loudly on any production-shaped config), then
 *   2. loads the app's real Firestore client from @/firebase, which the guard
 *      has already pointed at the emulator.
 * Because ESM evaluates a module's imports in source order, `./guard` executes
 * and normalises env BEFORE `@/firebase` initialises — so tests always exercise
 * the SAME db the real app code (app/lib/*) writes through.
 */
import './guard';
import { db } from '@/firebase';
import { doc, getDoc, getDocs, collection } from 'firebase/firestore';
import type { DocumentData } from 'firebase/firestore';
import { seedAll, clearAll, IDS } from './seed';

export { db, IDS };

// ── Timestamp → Date hydration ───────────────────────────────────────────────
// Firestore returns Dates as Timestamps. The app's pure helpers (getItemStatus,
// computeBagStock, …) expect Dates, so we deep-convert on read exactly like the
// app's hydration layer would.
function isTimestamp(v: unknown): v is { toDate: () => Date } {
  return !!v && typeof (v as { toDate?: unknown }).toDate === 'function';
}
export function hydrate<T = unknown>(v: T): T {
  if (isTimestamp(v)) return (v.toDate() as unknown) as T;
  if (Array.isArray(v)) return v.map(hydrate) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = hydrate(val);
    return out as T;
  }
  return v;
}

export async function getInventory(id: string): Promise<any | null> {
  const snap = await getDoc(doc(db, 'inventory', id));
  return snap.exists() ? hydrate({ id: snap.id, ...snap.data() }) : null;
}
export async function getPack(id: string): Promise<any | null> {
  const snap = await getDoc(doc(db, 'statpacks', id));
  return snap.exists() ? hydrate({ id: snap.id, ...snap.data() }) : null;
}
export async function getAll(colName: string): Promise<any[]> {
  const snap = await getDocs(collection(db, colName));
  return snap.docs.map((d: DocumentData) => hydrate({ id: d.id, ...d.data() }));
}

/** Reset the emulator to the canonical seed. Call in beforeEach of each suite. */
export async function reseed(t0 = new Date()): Promise<void> {
  await seedAll(db, t0);
}
export { clearAll };

// ── Minimal test framework (matches the repo's console+exit-code style) ───────
type Check = { ok: boolean; msg: string; detail?: string };
type Suite = { id: string; title: string; fn: (t: T) => Promise<void>; checks: Check[]; error?: string };

export class T {
  constructor(private suite: Suite) {}
  private push(ok: boolean, msg: string, detail?: string) {
    this.suite.checks.push({ ok, msg, detail });
    const tag = ok ? '\x1b[32m  ✅' : '\x1b[31m  ❌ FAIL:';
    // eslint-disable-next-line no-console
    console.log(`${tag} ${msg}\x1b[0m${!ok && detail ? `\n       ↳ ${detail}` : ''}`);
  }
  ok(cond: boolean, msg: string, detail?: string) { this.push(!!cond, msg, cond ? undefined : detail); }
  equal(actual: unknown, expected: unknown, msg: string) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    this.push(ok, msg, ok ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  /** Passes iff `p` REJECTS — i.e. the system refused the illegal operation. */
  async rejects(p: Promise<unknown>, msg: string) {
    try { await p; this.push(false, msg, 'expected the operation to be REFUSED, but it succeeded'); }
    catch (e) { this.push(true, msg, (e as Error)?.message); }
  }
  /** Passes iff `p` RESOLVES (no throw). */
  async resolves(p: Promise<unknown>, msg: string) {
    try { await p; this.push(true, msg); }
    catch (e) { this.push(false, msg, (e as Error)?.message); }
  }
  note(msg: string) { /* eslint-disable-next-line no-console */ console.log(`\x1b[90m       · ${msg}\x1b[0m`); }
}

const registry: Suite[] = [];
export function defineInvariant(id: string, title: string, fn: (t: T) => Promise<void>) {
  registry.push({ id, title, fn, checks: [] });
}

/** Run every registered suite with a FRESH seed each, print a summary, exit. */
export async function runRegistered(): Promise<void> {
  const t0 = new Date();
  for (const suite of registry) {
    // eslint-disable-next-line no-console
    console.log(`\n\x1b[1m━━━ ${suite.id} — ${suite.title} ━━━\x1b[0m`);
    try {
      await reseed(t0);
      await suite.fn(new T(suite));
    } catch (e) {
      suite.error = (e as Error)?.stack || String(e);
      // eslint-disable-next-line no-console
      console.log(`\x1b[31m  ✖ suite threw: ${(e as Error)?.message}\x1b[0m`);
    }
  }

  // Summary
  let passed = 0, failed = 0;
  // eslint-disable-next-line no-console
  console.log(`\n\x1b[1m━━━ SUMMARY ━━━\x1b[0m`);
  for (const s of registry) {
    const p = s.checks.filter(c => c.ok).length;
    const f = s.checks.filter(c => !c.ok).length;
    passed += p; failed += f;
    const verdict = s.error ? '\x1b[31mERROR' : f === 0 ? '\x1b[32mPASS ' : '\x1b[31mFAIL ';
    // eslint-disable-next-line no-console
    console.log(`  ${verdict}\x1b[0m ${s.id.padEnd(7)} ${p}/${p + f} checks — ${s.title}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\n  ${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m\n`);
  process.exit(failed === 0 ? 0 : 1);
}
