/**
 * [Phase 5 / waitlist plan §5.9, R5] Pure headless core for bulk event
 * creation ("mass add") — repeat-pattern expansion, paste-a-spreadsheet
 * parsing, name-token rendering, per-row conflict diagnosis, and the
 * draft-row → `CreateEventInput` conversion. This module does **no I/O**: no
 * `db`, no `addDoc`/`getDocs`, nothing async. `Timestamp` is imported as a
 * value (needed to build real `EventAccessTier` instants — see
 * `resolveAccessTierForDate`), never as a signal that this module talks to
 * Firestore.
 *
 * **Import direction is one-way.** `app/lib/events.ts` may import from this
 * module; this module must never import a *value* from `app/lib/events.ts`
 * (that would be a real runtime cycle). The one exception is the
 * `CreateEventInput` type on `draftRowToCreateInput`'s signature, which is
 * pulled in via `import type` — under this project's `isolatedModules`
 * config that import is erased entirely at compile time, so it creates no
 * runtime edge back into `events.ts` even though the *type* is defined
 * there.
 */

import { Timestamp } from 'firebase/firestore';
import type { EventAccessTier, EventTeam, TeamSlot, TierWindow } from '@/app/types';
import type {
  EventTemplateDef,
  EventTemplateTeamDef,
  EventTemplateAccessTierPreset,
} from '@/app/config/org-config';
import type { CreateEventInput } from '@/app/lib/events';

// ---------------------------------------------------------------------------
// Types (contract §4)
// ---------------------------------------------------------------------------

export interface SeriesRecurrence {
  /** Inclusive local start day. */
  from: Date;
  /** Inclusive local end day. */
  to: Date;
  /** 0 = Sunday … 6 = Saturday. At least one. */
  weekdays: number[];
  /** Repeat every N weeks, N >= 1. Week 1 is the week containing `from`. */
  everyNWeeks: number;
}

export interface EventSeriesSpec {
  template?: EventTemplateDef;
  /** Hand-picked dates. When present, `recurrence` is ignored. */
  dates?: Date[];
  recurrence?: SeriesRecurrence;
  /** Token pattern; see `formatSeriesName`. */
  namePattern: string;
  /** Applied on top of the template, to every row. */
  overrides?: Partial<Pick<DraftEventRow,
    'eventType' | 'venue' | 'location' | 'callTime' | 'endTime' | 'description' | 'waitlistEnabled'>>;
}

export interface DraftEventRow {
  /** Stable key for React and for matching results back to rows. Never a Firestore id. */
  key: string;
  /** Local midnight of the event day, or null when a pasted date did not parse. */
  date: Date | null;
  name: string;
  eventType?: string;
  venue?: string;
  location?: string;
  callTime: string;
  endTime?: string;
  description?: string;
  teams: EventTemplateTeamDef[];
  waitlistEnabled?: boolean;
  /** Resolved per row from THIS row's date. Never copied between rows. */
  accessTier?: EventAccessTier;
}

export type RowFlag = 'duplicate' | 'sameDay' | 'invalid';

export interface RowDiagnosis {
  flags: RowFlag[];
  /** One human sentence per flag, same order. */
  reasons: string[];
  /** True iff 'invalid' is present — this row must not be created. */
  blocked: boolean;
}

// ---------------------------------------------------------------------------
// Local-time day arithmetic
// ---------------------------------------------------------------------------

/**
 * Local midnight of `d`. NEVER build this by zeroing UTC fields — `Date`'s
 * getters/constructor here are all local-time, which is what keeps this safe
 * across DST.
 */
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Local-time day arithmetic. NEVER `new Date(t + n*864e5)` — that shifts an
 * event by an hour across a DST boundary and by a day at a month end (§5.9).
 * `Date`'s constructor normalizes an out-of-range day-of-month field itself
 * (e.g. `date + 1` past the last day of the month rolls to the 1st of the
 * next), so this stays correct at month/year boundaries with no extra logic.
 */
export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// ---------------------------------------------------------------------------
// Recurrence expansion
// ---------------------------------------------------------------------------

/**
 * Generates the recurrence's dates. Deliberately counts weeks by an
 * iteration counter (`dayIndex`), never by differencing two `Date#getTime()`
 * instants — a ms-difference between two local-midnight instants either side
 * of a DST transition is NOT an exact multiple of 86400000, so dividing it
 * by a day-in-ms to get a week number would silently misclassify the week
 * containing the transition. Iterating day-by-day with `addDays` (local-time
 * safe) and counting steps sidesteps that entirely. `getTime()` is still
 * used for the loop bound and range checks, which is safe: instant ordering
 * (`<=`) is never affected by DST, only ms *differences* are.
 */
function generateRecurrenceDates(r: SeriesRecurrence): Date[] {
  const from = startOfDay(r.from);
  const to = startOfDay(r.to);
  if (to.getTime() < from.getTime()) return [];

  const weekdaySet = new Set(r.weekdays);
  const everyN = Math.max(1, Math.round(r.everyNWeeks) || 1);
  // Week 1 is the week containing `from`; walk from that week's Sunday so the
  // week-index math below (`dayIndex / 7`) lines up on 7-day boundaries.
  const weekStart = addDays(from, -from.getDay());

  const out: Date[] = [];
  let cur = weekStart;
  let dayIndex = 0;
  while (cur.getTime() <= to.getTime()) {
    const weekIndex = Math.floor(dayIndex / 7);
    if (
      cur.getTime() >= from.getTime()
      && weekdaySet.has(cur.getDay())
      && weekIndex % everyN === 0
    ) {
      out.push(cur);
    }
    cur = addDays(cur, 1);
    dayIndex += 1;
  }
  return out;
}

/**
 * Expand a spec into review rows. Deterministic and pure.
 * - `dates` wins over `recurrence` when both are present.
 * - Output is sorted ascending by date, duplicates by day removed.
 * - `opts.keyPrefix` (default 'row') makes keys stable for tests.
 * - Every row's `accessTier` is computed from THAT row's own date — see
 *   `resolveAccessTierForDate`. This is the one place a copy-paste bug would
 *   give a whole series the same signup-opens date (§5.9); each row gets its
 *   own call.
 */
export function expandEventSeries(
  spec: EventSeriesSpec,
  opts?: { keyPrefix?: string },
): DraftEventRow[] {
  const keyPrefix = opts?.keyPrefix ?? 'row';

  const rawDates = spec.dates && spec.dates.length > 0
    ? spec.dates.map(startOfDay)
    : spec.recurrence
      ? generateRecurrenceDates(spec.recurrence)
      : [];

  const seen = new Set<string>();
  const dates: Date[] = [];
  for (const d of [...rawDates].sort((a, b) => a.getTime() - b.getTime())) {
    const k = dayKey(d);
    if (seen.has(k)) continue;
    seen.add(k);
    dates.push(d);
  }

  const overrides = spec.overrides ?? {};
  const templateTeams = spec.template?.teams ?? [];

  return dates.map((date, i) => {
    const eventType = overrides.eventType ?? spec.template?.eventType;
    const venue = overrides.venue ?? spec.template?.venue;
    const location = overrides.location ?? spec.template?.location;
    const callTime = overrides.callTime ?? spec.template?.callTime ?? '';
    const endTime = overrides.endTime ?? spec.template?.endTime;
    const description = overrides.description ?? spec.template?.description;
    const waitlistEnabled = overrides.waitlistEnabled ?? spec.template?.waitlistEnabled;
    const name = formatSeriesName(spec.namePattern, { date, index: i, eventType, venue });

    return {
      key: `${keyPrefix}_${i}`,
      date,
      name,
      eventType,
      venue,
      location,
      callTime,
      endTime,
      description,
      // Shallow-copied per row so a later row-level edit in the review grid
      // can't alias another row's team array through the shared template.
      teams: templateTeams.map((t) => ({ ...t })),
      waitlistEnabled,
      // Resolved from THIS row's own `date` — never a value copied in from
      // another row or computed once outside the map (§5.9, the worst bug).
      accessTier: resolveAccessTierForDate(spec.template?.accessTierPreset, date),
    };
  });
}

// ---------------------------------------------------------------------------
// Name tokens
// ---------------------------------------------------------------------------

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtMonthDay(d: Date): string {
  return `${MONTH_ABBR[d.getMonth()]} ${d.getDate()}`;
}

function fmtMonthDayYear(d: Date): string {
  return `${fmtMonthDay(d)}, ${d.getFullYear()}`;
}

function fmtIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Tokens: {date:MMM d} {date:MMM d, yyyy} {date:yyyy-MM-dd} {date} (=> MMM d),
 *         {n} (1-based ordinal), {type}, {venue}.
 * An unknown token is left verbatim — a manager sees it in the grid and fixes
 * the pattern; silently dropping it produces plausible-looking wrong names.
 *
 * `ctx.index` is the **0-based array position** — the value a caller already has
 * from `.map((row, i) => …)` — and `{n}` renders `index + 1`. The arithmetic
 * lives here, once, on purpose: the alternative (callers pass an already-1-based
 * ordinal) makes every future call site a place to forget the `+ 1`, and an
 * off-by-one in an event NAME is invisible until a manager reads the grid.
 */
export function formatSeriesName(
  pattern: string,
  /** `index` is 0-based; `{n}` renders `index + 1`. */
  ctx: { date: Date; index: number; eventType?: string; venue?: string },
): string {
  return pattern.replace(/\{[^{}]*\}/g, (token) => {
    switch (token) {
      case '{date:MMM d}':
        return fmtMonthDay(ctx.date);
      case '{date:MMM d, yyyy}':
        return fmtMonthDayYear(ctx.date);
      case '{date:yyyy-MM-dd}':
        return fmtIsoDate(ctx.date);
      case '{date}':
        return fmtMonthDay(ctx.date);
      case '{n}':
        return String(ctx.index + 1);
      case '{type}':
        return ctx.eventType ?? '';
      case '{venue}':
        return ctx.venue ?? '';
      default:
        return token; // unknown token left verbatim, on purpose
    }
  });
}

// ---------------------------------------------------------------------------
// Access-tier resolution (per row — see the warning on `expandEventSeries`)
// ---------------------------------------------------------------------------

/**
 * Resolve a template's LEAD DAYS against one event's date.
 * Returns `Timestamp` instances built with `Timestamp.fromDate` — never a
 * `serverTimestamp()` sentinel, which Firestore rejects inside the `tiers`
 * array (that was build bug D12). Returns undefined when `preset` is undefined.
 * Windows are emitted earliest-first (largest `leadDays` — furthest before
 * the event date — sorts first) and given ids `tier_<i>`.
 */
export function resolveAccessTierForDate(
  preset: EventTemplateAccessTierPreset | undefined,
  eventDate: Date,
): EventAccessTier | undefined {
  if (!preset) return undefined;
  const day = startOfDay(eventDate);

  const orderedWindows = [...preset.windows].sort((a, b) => b.leadDays - a.leadDays);
  const tiers: TierWindow[] = orderedWindows.map((w, i) => ({
    id: `tier_${i}`,
    label: w.label,
    opensAt: Timestamp.fromDate(addDays(day, -w.leadDays)),
    criteria: w.criteria,
  }));

  return {
    enabled: true,
    tiers,
    generalOpensAt: Timestamp.fromDate(addDays(day, -preset.generalLeadDays)),
    rationale: preset.rationale,
  };
}

// ---------------------------------------------------------------------------
// Paste parsing
// ---------------------------------------------------------------------------

type PastedField = 'date' | 'name' | 'eventType' | 'venue' | 'location' | 'callTime' | 'endTime' | 'description';

// Recognised headers (case/space/underscore-insensitive, see `normalizeHeader`).
// NOTE: 'notes' maps to description — called out because it is the one
// mapping a reader wouldn't guess from the column name alone.
const HEADER_MAP: Record<string, PastedField> = {
  date: 'date',
  name: 'name',
  type: 'eventType',
  eventtype: 'eventType',
  venue: 'venue',
  location: 'location',
  calltime: 'callTime',
  call: 'callTime',
  start: 'callTime',
  starttime: 'callTime',
  endtime: 'endTime',
  end: 'endTime',
  description: 'description',
  notes: 'description',
  desc: 'description',
};

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s_]+/g, '');
}

const MONTH_NAMES: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function validLocalDate(y: number, moIndex: number, d: number): Date | null {
  if (!Number.isFinite(y) || !Number.isFinite(moIndex) || !Number.isFinite(d)) return null;
  const dt = new Date(y, moIndex, d);
  // Reject overflow (e.g. Feb 30 rolls forward to Mar 2) rather than silently
  // accepting a date that isn't the one the spreadsheet cell said.
  if (dt.getFullYear() !== y || dt.getMonth() !== moIndex || dt.getDate() !== d) return null;
  return dt;
}

/**
 * Accepted date forms, all parsed as LOCAL dates (never `new Date(str)`,
 * which parses bare `yyyy-mm-dd` as UTC and can shift the day):
 * yyyy-mm-dd, m/d/yyyy, m/d/yy, "Mon d yyyy" / "Mon d, yyyy".
 */
function parseLocalDateString(raw: string): Date | null {
  const s = raw.trim();
  if (!s) return null;

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) {
    return validLocalDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) {
    const [, moStr, dStr, yStr] = m;
    let year = Number(yStr);
    if (yStr.length === 2) year += year < 70 ? 2000 : 1900;
    return validLocalDate(year, Number(moStr) - 1, Number(dStr));
  }

  m = /^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const [, monName, dStr, yStr] = m;
    const moIndex = MONTH_NAMES[monName.slice(0, 3).toLowerCase()];
    if (moIndex === undefined) return null;
    return validLocalDate(Number(yStr), moIndex, Number(dStr));
  }

  return null;
}

/**
 * TSV/CSV straight out of a spreadsheet. First non-empty line is the header.
 * Missing fields fall back to `template`; a row with no `name` column value
 * falls back to `opts.namePattern` (rendered via `formatSeriesName`) before
 * falling back to the template's name.
 * Delimiter: tab if the header line contains one, else comma. No quoted-field
 * handling — this targets a plain paste out of a spreadsheet, not arbitrary
 * CSV with embedded delimiters.
 */
export function parsePastedEvents(
  text: string,
  template?: EventTemplateDef,
  opts?: { namePattern?: string; keyPrefix?: string },
): { rows: DraftEventRow[]; ignoredColumns: string[]; warnings: string[] } {
  const keyPrefix = opts?.keyPrefix ?? 'row';
  const warnings: string[] = [];
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);

  if (lines.length === 0) {
    return { rows: [], ignoredColumns: [], warnings: [] };
  }

  const headerLine = lines[0];
  const delimiter = headerLine.includes('\t') ? '\t' : ',';
  const headers = headerLine.split(delimiter).map((h) => h.trim());
  const fieldByCol = headers.map((h) => HEADER_MAP[normalizeHeader(h)]);
  const ignoredColumns = headers.filter((h, i) => !fieldByCol[i] && h.length > 0);

  const templateTeams = template?.teams ?? [];
  const rows: DraftEventRow[] = [];

  for (let li = 1; li < lines.length; li++) {
    const cols = lines[li].split(delimiter);
    const record: Partial<Record<PastedField, string>> = {};
    for (let ci = 0; ci < headers.length; ci++) {
      const field = fieldByCol[ci];
      if (!field) continue;
      record[field] = (cols[ci] ?? '').trim();
    }

    const dateRaw = record.date ?? '';
    const date = dateRaw ? parseLocalDateString(dateRaw) : null;
    if (dateRaw && !date) {
      warnings.push(`Row ${li + 1}: could not parse date "${dateRaw}".`);
    }

    const eventType = record.eventType || template?.eventType;
    const venue = record.venue || template?.venue;
    // 0-based data-row index (li starts at 1 for the first DATA row, the header being line 0).
    // `formatSeriesName` renders {n} as index + 1, so the first pasted row is "1" — see D28.
    const rowIndex = li - 1;
    let name = record.name || '';
    if (!name && opts?.namePattern) {
      name = formatSeriesName(opts.namePattern, {
        date: date ?? new Date(1970, 0, 1),
        index: rowIndex,
        eventType,
        venue,
      });
    }
    if (!name) name = template?.name ?? '';

    rows.push({
      key: `${keyPrefix}_${li}`,
      date,
      name,
      eventType,
      venue,
      location: record.location || template?.location,
      callTime: record.callTime || template?.callTime || '',
      endTime: record.endTime || template?.endTime,
      description: record.description || template?.description,
      teams: templateTeams.map((t) => ({ ...t })),
      waitlistEnabled: template?.waitlistEnabled,
      accessTier: date ? resolveAccessTierForDate(template?.accessTierPreset, date) : undefined,
    });
  }

  return { rows, ignoredColumns, warnings };
}

// ---------------------------------------------------------------------------
// Conflict diagnosis
// ---------------------------------------------------------------------------

/**
 * Client-side conflict flags against the already-loaded events feed — no reads.
 * - 'invalid'   (blocks THAT ROW ONLY): no date, empty name, or empty callTime (P12).
 * - 'duplicate' (warn, never block): an existing event with the same local day
 *                AND the same trimmed case-insensitive name. A doubleheader is real.
 * - 'sameDay'   (informational): another event on that day, existing or in this batch.
 */
export function diagnoseDraftRows(
  rows: DraftEventRow[],
  existing: { name: string; date: Date | null }[],
): Record<string, RowDiagnosis> {
  const existingByDay = new Map<string, string[]>();
  for (const e of existing) {
    if (!e.date) continue;
    const k = dayKey(e.date);
    if (!existingByDay.has(k)) existingByDay.set(k, []);
    existingByDay.get(k)!.push(e.name.trim().toLowerCase());
  }

  const batchByDay = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.date) continue;
    const k = dayKey(r.date);
    if (!batchByDay.has(k)) batchByDay.set(k, []);
    batchByDay.get(k)!.push(r.key);
  }

  const out: Record<string, RowDiagnosis> = {};
  for (const row of rows) {
    const flags: RowFlag[] = [];
    const reasons: string[] = [];

    if (!row.date || !row.name.trim() || !row.callTime.trim()) {
      const missing: string[] = [];
      if (!row.date) missing.push('date');
      if (!row.name.trim()) missing.push('name');
      if (!row.callTime.trim()) missing.push('call time');
      flags.push('invalid');
      reasons.push(`Missing ${missing.join(', ')}.`);
    }

    if (row.date) {
      const k = dayKey(row.date);
      const existingNamesToday = existingByDay.get(k) ?? [];
      if (existingNamesToday.includes(row.name.trim().toLowerCase())) {
        flags.push('duplicate');
        reasons.push('An event with the same name already exists on this day.');
      }

      const otherRowsToday = (batchByDay.get(k) ?? []).filter((key) => key !== row.key).length;
      if (existingNamesToday.length > 0 || otherRowsToday > 0) {
        flags.push('sameDay');
        reasons.push('Another event falls on this day.');
      }
    }

    out[row.key] = { flags, reasons, blocked: flags.includes('invalid') };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Draft row -> CreateEventInput
// ---------------------------------------------------------------------------

function emptySlot(): TeamSlot {
  return {};
}

// Counter-based, not `Date.now()` alone — a bulk run can build many teams
// inside the same millisecond, and `draftRowToCreateInput` must produce ids
// unique both within an event and across the whole batch.
let teamIdSeq = 0;

/**
 * Mirrors `createEmptyTeam`'s shape (`app/lib/events.ts`) — deliberately not
 * imported from there (see this file's header: no value import back into
 * `events.ts`'s module, to keep the dependency one-way). Clamps `emtCount`
 * to `app/lib/events.ts`'s `clampEmtCount` 2–4 bound inline for the same
 * reason `validateEventTemplate` (org-config.ts) inlines it.
 */
function buildTeamFromDef(def: EventTemplateTeamDef): EventTeam {
  teamIdSeq += 1;
  // Byte-for-byte the same rule as `clampEmtCount` (app/lib/events.ts):
  // non-finite -> the 3-EMT default, otherwise round then clamp to 2-4. The
  // earlier `Math.round(x) || 3` was NOT that rule: 0 is falsy, so it took the
  // default branch and yielded 3 where `clampEmtCount(0)` yields 2 (D29).
  const emtCount = Number.isFinite(def.emtCount)
    ? Math.max(2, Math.min(4, Math.round(def.emtCount)))
    : 3;
  return {
    id: `team_${Date.now()}_${teamIdSeq}`,
    name: def.name,
    ftoSlot: emptySlot(),
    hasFtoIntern: def.hasFtoIntern,
    ftoInternSlot: emptySlot(),
    emtCount,
    emtSlots: Array.from({ length: emtCount }, emptySlot),
  };
}

/** DraftEventRow -> CreateEventInput. Throws on a blocked row (call diagnose first).
 *  Builds real `EventTeam`s via `createEmptyTeam`-shaped objects; ids must be unique
 *  WITHIN an event. Import `createEmptyTeam` from `app/lib/events` is NOT allowed here
 *  (circular: events.ts imports this module). Build the team inline and say so. */
export function draftRowToCreateInput(row: DraftEventRow, seriesId?: string): CreateEventInput {
  if (!row.date || !row.name.trim() || !row.callTime.trim()) {
    throw new Error(
      `draftRowToCreateInput: row "${row.key}" is blocked (missing date, name, or call time) — call diagnoseDraftRows first.`,
    );
  }

  const teams = (row.teams.length > 0 ? row.teams : [{ name: 'Team 1', emtCount: 3, hasFtoIntern: true }])
    .map(buildTeamFromDef);

  return {
    name: row.name.trim(),
    date: row.date,
    eventType: row.eventType,
    venue: row.venue,
    location: row.location,
    callTime: row.callTime,
    endTime: row.endTime,
    description: row.description,
    teams,
    accessTier: row.accessTier,
    waitlistEnabled: row.waitlistEnabled,
    seriesId,
  };
}
