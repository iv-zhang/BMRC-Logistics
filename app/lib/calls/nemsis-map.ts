/**
 * ESO / NEMSIS 3.5 ingest boundary.
 *
 * This is the ONLY file in the codebase permitted to know about NEMSIS
 * element names or ESO Analytics CSV column names. Everything downstream
 * (call tiles, `/stats` aggregation, etc.) reads the stable, de-identified
 * `CallRecord` shape from `./types`. If you find yourself reaching for an
 * `eXxx.NN` element name or an ESO column header outside this file, stop —
 * add a field to `CallRecord` and map it here instead.
 *
 * IMPORTANT — written ahead of a real export: BMRC has not yet produced a
 * live NEMSIS XML or ESO Analytics CSV export at the time this file was
 * written. Element numbers explicitly called out in the ingest boundary spec
 * (eRecord.01, eResponse.05/.13, eDisposition.12/.16, eSituation.09/.10,
 * eScene.21, eCrew.01, and the eTimes.* family) are used directly. A few
 * fields have no specified element (`unitId`, `agencyIncidentNumber`,
 * `chiefComplaintCategory`, and the transported-boolean derivation from
 * `disposition`) — those are marked GUESS below with the candidate element
 * names tried, and MUST be verified against a real ESO export / BMRC's ESO
 * rep before this mapper is trusted for reporting. See the GUESS markers.
 *
 * De-identification happens HERE, at parse time — never parse-then-hide.
 * `CallRecord` has no field capable of holding a patient name, DOB, street
 * address, or narrative text, so anything not explicitly read into a
 * `CallRecord` field (name, DOB, SSN, home address, GPS, narrative, payer
 * info, etc.) is simply never touched by this file. `PHI_FIELDS` documents
 * that intent for the importer UI.
 */

import type {
  AgeBand,
  CallIntervals,
  CallRecord,
  CallTimes,
  NemsisImportResult,
  SkippedReason,
} from './types';

// ── PHI compliance statement ────────────────────────────────────────────────

/**
 * NEMSIS elements this mapper deliberately never reads into a `CallRecord`.
 * Shown in the importer UI as a compliance statement ("this import drops the
 * following identifiers before anything touches app state").
 *
 * Element numbers here follow the public NEMSIS 3.5 data dictionary
 * structure to the best of this author's knowledge without a live export or
 * XSD in hand — treat the *categories* (name, DOB, SSN, home address, GPS,
 * narrative, payer/insurance) as authoritative, but confirm exact element
 * numbers against BMRC's actual ESO export before relying on this list alone
 * as a compliance sign-off.
 */
export const PHI_FIELDS: string[] = [
  'ePatient.02 — Patient Last Name',
  'ePatient.03 — Patient First Name',
  'ePatient.04 — Patient Middle Name/Initial',
  'ePatient.06 — Patient Home Address (street)',
  'ePatient.07 — Patient Home City',
  'ePatient.09 — Patient Home County',
  'ePatient.10 — Patient Home State',
  'ePatient.08 — Patient Home Zip (residence, distinct from eScene.21 scene zip)',
  'ePatient.13 — Date of Birth',
  'ePatient.16 — Social Security Number',
  'ePatient.17 — Patient Phone Number',
  'eScene.01 / eScene.02 — Scene GPS latitude/longitude (only eScene.21 zip is kept)',
  'eDisposition.19 — Destination facility name / transfer-of-care details beyond level of care',
  'eNarrative.01 — Patient Care Report Narrative (free text)',
  'ePayment.* — Insurance/payer information',
  'eHistorical.* — Patient history free-text fields',
  'Any signature or attachment/image element',
];

// ── NEMSIS "not value" handling ─────────────────────────────────────────────

/**
 * NEMSIS elements express "no data" two ways: an `xsi:nil="true"` attribute
 * (optionally with a reason-code annotation), or the element's own text
 * being one of NEMSIS's universal "Not Value" codes rather than real data.
 * Per the ingest spec, `7701001` (Not Applicable) and `7701003` (Not
 * Recorded) are the two called out explicitly; the wider NEMSIS 3.x
 * convention is that "not value" codes follow a `77XX00X` shape, so the
 * regex below catches siblings (Not Reporting, Not Available, etc.) without
 * having to enumerate every one. Both checks fail safe: unrecognized text is
 * treated as real data, not silently dropped.
 */
const KNOWN_NOT_VALUE_CODES = new Set(['7701001', '7701003']);
const NOT_VALUE_CODE_PATTERN = /^77\d{5}$/;

function isNotValueText(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (KNOWN_NOT_VALUE_CODES.has(t)) return true;
  return NOT_VALUE_CODE_PATTERN.test(t);
}

// ── Defensive XML element lookup ────────────────────────────────────────────

/** True when `el` (or any attribute on it) marks the element as explicitly nil. */
function isNilElement(el: Element): boolean {
  if (el.getAttribute('xsi:nil') === 'true') return true;
  for (let i = 0; i < el.attributes.length; i++) {
    const attr = el.attributes[i];
    if (attr.localName === 'nil' && (attr.value === 'true' || attr.value === '1')) return true;
  }
  return false;
}

/**
 * Find the first descendant of `scope` whose (namespace-stripped) tag name
 * matches `localName`, searched deeply. NEMSIS XML nesting varies by
 * exporter and we have no real sample to anchor a strict path against, so
 * every lookup here is a deep tag-name search rather than a fixed path —
 * this is deliberate defensiveness per requirement #4, not sloppiness.
 */
function findElement(scope: Element, localName: string): Element | null {
  const all = scope.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el.localName === localName || el.tagName === localName) return el;
  }
  return null;
}

/** All descendants matching `localName` (for repeating groups like eCrew, eMedications). */
function findElements(scope: Element, localName: string): Element[] {
  const all = scope.getElementsByTagName('*');
  const out: Element[] = [];
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el.localName === localName || el.tagName === localName) out.push(el);
  }
  return out;
}

/** Text content of the first element named `localName`, or null if nil/not-value/absent. */
function getElementText(scope: Element, localName: string): string | null {
  const el = findElement(scope, localName);
  if (!el || isNilElement(el)) return null;
  const text = (el.textContent ?? '').trim();
  if (!text || isNotValueText(text)) return null;
  return text;
}

/** Like `getElementText`, but tries each candidate element name in order (for GUESSed fields). */
function getElementTextAny(scope: Element, localNames: string[]): string | null {
  for (const name of localNames) {
    const v = getElementText(scope, name);
    if (v !== null) return v;
  }
  return null;
}

/** All non-nil/non-not-value text values across every element named `localName`. */
function getElementTextAll(scope: Element, localName: string): string[] {
  const out: string[] = [];
  for (const el of findElements(scope, localName)) {
    if (isNilElement(el)) continue;
    const text = (el.textContent ?? '').trim();
    if (text && !isNotValueText(text)) out.push(text);
  }
  return [...new Set(out)];
}

function parseNemsisDate(text: string | null): Date | null {
  if (!text) return null;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ── Shared derivations (used by both XML and CSV paths) ────────────────────

/**
 * Interval seconds between two timeline points. Null (never 0) when either
 * endpoint is missing or the computed duration would be negative — a
 * negative interval means the underlying timestamps are bad, not that the
 * interval is zero.
 */
function intervalSeconds(start: Date | null, end: Date | null): number | null {
  if (!start || !end) return null;
  const ms = end.getTime() - start.getTime();
  if (ms < 0) return null;
  return Math.round(ms / 1000);
}

/** Derive the four interval buckets from a record's timeline. Never invents a 0. */
export function computeIntervals(times: CallTimes): CallIntervals {
  return {
    chuteSeconds: intervalSeconds(times.unitNotified, times.enRoute),
    responseSeconds: intervalSeconds(times.psapCall, times.arrivedScene),
    onSceneSeconds: intervalSeconds(times.arrivedScene, times.transferOfCare),
    transportSeconds: intervalSeconds(times.transferOfCare, times.backInService),
    totalSeconds: intervalSeconds(times.psapCall, times.backInService),
  };
}

/** Coarse age bucket. Negative/absurd ages and missing ages both fall back to 'unknown'. */
export function deriveAgeBand(years: number | null): AgeBand {
  if (years === null || Number.isNaN(years) || years < 0) return 'unknown';
  if (years < 18) return '<18';
  if (years < 35) return '18-34';
  if (years < 55) return '35-54';
  if (years < 75) return '55-74';
  return '75+';
}

/**
 * Earliest available point on the call timeline, used as the record's
 * `incidentAt` anchor. Priority order follows the natural call sequence
 * (a later-stage timestamp is a worse anchor than an earlier one that's
 * actually present).
 */
function computeIncidentAt(times: CallTimes): Date | null {
  return (
    times.psapCall ??
    times.dispatchNotified ??
    times.unitNotified ??
    times.enRoute ??
    times.arrivedScene ??
    times.arrivedPatient ??
    null
  );
}

/**
 * Derive transported (true/false/unknown) from the eDisposition.12 raw
 * value. GUESS: the specific NEMSIS 3.5 disposition codes below follow the
 * publicly documented "Incident/Patient Disposition" code list from memory,
 * without a live export to confirm exact codes against — verify with BMRC's
 * ESO rep. To stay useful even if the codes are slightly off, this also
 * falls back to a keyword match against the human-readable label (which
 * ESO's CSV export is likely to provide instead of a raw numeric code).
 */
const TRANSPORTED_DISPOSITION_CODES = new Set(['4212001', '4212003', '4212005', '4212007', '4212011']);
const NOT_TRANSPORTED_DISPOSITION_CODES = new Set([
  '4212009',
  '4212013',
  '4212015',
  '4212017',
  '4212019',
  '4212021',
  '4212023',
  '4212025',
]);

function deriveTransported(dispositionRaw: string | null): boolean | null {
  if (!dispositionRaw) return null;
  const code = dispositionRaw.trim();
  if (TRANSPORTED_DISPOSITION_CODES.has(code)) return true;
  if (NOT_TRANSPORTED_DISPOSITION_CODES.has(code)) return false;

  const lower = dispositionRaw.toLowerCase();
  if (lower.includes('with transport')) return true;
  if (lower.includes('no transport') || lower.includes('not transported') || lower.includes('without transport')) {
    return false;
  }
  if (lower.includes('dead at scene') || lower.includes('no patient found') || lower.includes('non-patient')) {
    return false;
  }
  if (lower.includes('transport')) return true;
  return null;
}

// ── NEMSIS 3.5 XML ──────────────────────────────────────────────────────────

function findParserError(doc: Document): string | null {
  const all = doc.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName === 'parsererror') return all[i].textContent?.trim() || 'unknown parse error';
  }
  return null;
}

/**
 * NEMSIS 3.5 XML exports wrap each call in a `PatientCareReport` element
 * (name per the NEMSIS XSD). If none are found — e.g. a differently-named
 * wrapper from a given exporter — fall back to treating the document root as
 * a single record, but only when it actually looks like PCR data (has an
 * eRecord.01 or any eTimes.* descendant), so an unrelated/garbage XML file
 * doesn't get silently "mapped" into one empty record.
 */
function getRecordElements(doc: Document): Element[] {
  const root = doc.documentElement;
  if (!root) return [];
  const direct = findElements(root, 'PatientCareReport');
  if (direct.length) return direct;
  const looksLikePcr = findElement(root, 'eRecord.01') || findElement(root, 'eTimes.01');
  return looksLikePcr ? [root] : [];
}

function mapNemsisRecord(el: Element, index: number): CallRecord | null {
  const times: CallTimes = {
    psapCall: parseNemsisDate(getElementText(el, 'eTimes.01')),
    dispatchNotified: parseNemsisDate(getElementText(el, 'eTimes.03')),
    unitNotified: parseNemsisDate(getElementText(el, 'eTimes.05')),
    enRoute: parseNemsisDate(getElementText(el, 'eTimes.06')),
    arrivedScene: parseNemsisDate(getElementText(el, 'eTimes.07')),
    arrivedPatient: parseNemsisDate(getElementText(el, 'eTimes.08')),
    transferOfCare: parseNemsisDate(getElementText(el, 'eTimes.11')),
    backInService: parseNemsisDate(getElementText(el, 'eTimes.13')),
  };

  const incidentAt = computeIncidentAt(times);
  if (!incidentAt) return null; // no usable incident time — caller counts this in `skipped`

  const pcrNumber = getElementText(el, 'eRecord.01');
  const disposition = getElementText(el, 'eDisposition.12');
  const primaryImpression = getElementText(el, 'eSituation.09');
  const ageYearsRaw = getElementTextAny(el, ['ePatient.15', 'ePatient.14']); // GUESS — age element number unconfirmed
  const ageYears = ageYearsRaw !== null && /^\d+(\.\d+)?$/.test(ageYearsRaw) ? Number(ageYearsRaw) : null;

  return {
    id: pcrNumber ?? `nemsis-${index}`,
    pcrNumber,
    incidentAt,
    // GUESS — no element number given in the ingest spec for unit id; tries
    // a couple of plausible NEMSIS 3.5 candidates. Verify with the ESO rep.
    unitId: getElementTextAny(el, ['eResponse.19', 'dVehicle.01', 'eResponse.03']),
    // GUESS — same caveat: candidate incident-number elements, unconfirmed.
    agencyIncidentNumber: getElementTextAny(el, ['eResponse.03', 'dAgency.02']),
    times,
    intervals: computeIntervals(times),
    responseMode: getElementText(el, 'eResponse.13'),
    serviceRequested: getElementText(el, 'eResponse.05'),
    disposition,
    levelOfCare: getElementText(el, 'eDisposition.16'),
    transported: deriveTransported(disposition),
    primaryImpression,
    secondaryImpression: getElementText(el, 'eSituation.10'),
    // GUESS — chief complaint has no dedicated element in the spec; NEMSIS's
    // closest analog is the dispatch-reported complaint (eDispatch.01),
    // falling back to the primary impression category. Verify with ESO.
    chiefComplaintCategory: getElementTextAny(el, ['eDispatch.01']) ?? primaryImpression,
    zip: getElementText(el, 'eScene.21'),
    patientAgeYears: ageYears,
    ageBand: deriveAgeBand(ageYears),
    // GUESS — repeating-group sub-element numbers (.01/.03) follow the common
    // NEMSIS pattern of "id/code in the low sub-elements" but are unconfirmed.
    crewIds: getElementTextAll(el, 'eCrew.01'),
    medicationsGiven: getElementTextAll(el, 'eMedications.03'),
    proceduresPerformed: getElementTextAll(el, 'eProcedures.03'),
  };
}

/**
 * Parse a NEMSIS 3.5 XML export into de-identified `CallRecord`s.
 *
 * Client-side only: this is a static-export app with no server, and
 * `DOMParser` is browser-native, so this guards for `typeof window ===
 * 'undefined'` (SSR/build-time evaluation) rather than importing an XML
 * parsing dependency.
 */
export function mapNemsisXml(xml: string): NemsisImportResult {
  const warnings: string[] = [];
  const skipped: SkippedReason[] = [];
  const records: CallRecord[] = [];

  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') {
    warnings.push('mapNemsisXml requires a browser DOMParser and was called outside the browser; no records were parsed.');
    return { records, skipped, warnings };
  }

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml');
  } catch (err) {
    warnings.push(`Failed to parse NEMSIS XML: ${err instanceof Error ? err.message : String(err)}`);
    return { records, skipped, warnings };
  }

  const parseError = findParserError(doc);
  if (parseError) {
    warnings.push(`NEMSIS XML is not well-formed: ${parseError}`);
    return { records, skipped, warnings };
  }

  const recordEls = getRecordElements(doc);
  if (!recordEls.length) {
    warnings.push('No PatientCareReport records found in the NEMSIS XML document.');
    return { records, skipped, warnings };
  }

  let noIncidentTime = 0;
  recordEls.forEach((el, i) => {
    const record = mapNemsisRecord(el, i);
    if (record) records.push(record);
    else noIncidentTime++;
  });
  if (noIncidentTime > 0) skipped.push({ reason: 'no usable incident time', count: noIncidentTime });

  return { records, skipped, warnings };
}

// ── ESO Analytics CSV ────────────────────────────────────────────────────────

/**
 * Candidate ESO Analytics column headers per `CallRecord` field. Column
 * names vary per agency configuration in ESO, so this is a starting point —
 * exported and overridable so a real export's headers can be added without
 * touching the mapping logic. All matching is case/whitespace/punctuation
 * insensitive (see `normalizeHeader`), so minor formatting differences
 * ("PSAP Call Date/Time" vs "psap_call_date_time") don't need separate
 * entries.
 *
 * UNVERIFIED: none of these header strings have been checked against a real
 * ESO Analytics export. Treat as best-guess scaffolding to refine once BMRC
 * has a sample export.
 */
export const ESO_COLUMN_ALIASES: Record<keyof CallRecord | string, string[]> = {
  pcrNumber: ['PCR Number', 'PCR#', 'Incident PCR Number', 'ePCR Number', 'Record Number'],
  unitId: ['Unit', 'Unit ID', 'Responding Unit', 'Unit Number'],
  agencyIncidentNumber: ['Incident Number', 'CAD Incident Number', 'Incident #'],
  psapCall: ['PSAP Call Date Time', 'Call Received Date Time', 'Time PSAP Call'],
  dispatchNotified: ['Dispatch Notified Date Time', 'Time Dispatch Notified'],
  unitNotified: ['Unit Notified Date Time', 'Time Unit Notified', 'Dispatched'],
  enRoute: ['En Route Date Time', 'Time En Route', 'Enroute'],
  arrivedScene: ['Arrived Scene Date Time', 'Time Arrived Scene', 'On Scene'],
  arrivedPatient: ['Arrived Patient Date Time', 'Time Arrived Patient', 'At Patient'],
  transferOfCare: ['Transfer of Care Date Time', 'Time Transfer of Care', 'Patient Transfer of Care'],
  backInService: ['Back in Service Date Time', 'Time Back in Service', 'In Service'],
  responseMode: ['Response Mode to Scene', 'Response Mode'],
  serviceRequested: ['Type of Service Requested', 'Service Requested'],
  disposition: ['Incident Patient Disposition', 'Disposition'],
  levelOfCare: ['Level of Care Provided', 'Level of Care'],
  primaryImpression: ['Primary Impression', "Provider's Primary Impression"],
  secondaryImpression: ['Secondary Impression', "Provider's Secondary Impression"],
  chiefComplaintCategory: ['Complaint Reported by Dispatch', 'Chief Complaint', 'Dispatch Complaint'],
  zip: ['Scene Zip Code', 'Scene Zip', 'Incident Zip Code'],
  patientAgeYears: ['Patient Age', 'Age (Years)', 'Age'],
  crewIds: ['Crew Members', 'Crew IDs', 'Crew'],
  medicationsGiven: ['Medications Given', 'Medications Administered'],
  proceduresPerformed: ['Procedures Performed', 'Procedures'],
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Look up a value in a CSV row by field key + its own name, trying every alias, case/punctuation-insensitive. */
function findCsvValue(row: Record<string, string>, key: string): string | null {
  const normalizedRow = new Map<string, string>();
  for (const [k, v] of Object.entries(row)) normalizedRow.set(normalizeHeader(k), v);

  const aliases = [key, ...(ESO_COLUMN_ALIASES[key] ?? [])];
  for (const alias of aliases) {
    const v = normalizedRow.get(normalizeHeader(alias));
    if (v === undefined) continue;
    const trimmed = v.trim();
    if (trimmed && !isNotValueText(trimmed)) return trimmed;
  }
  return null;
}

function parseCsvDate(text: string | null): Date | null {
  if (!text) return null;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseCsvNumber(text: string | null): number | null {
  if (!text) return null;
  const n = Number(text.replace(/[^0-9.-]/g, ''));
  return Number.isNaN(n) ? null : n;
}

/** Splits a delimited list cell (";", "|", or ",") into trimmed, deduped, non-empty entries. */
function splitCsvList(text: string | null): string[] {
  if (!text) return [];
  const parts = text
    .split(/[;|,]/)
    .map((p) => p.trim())
    .filter(Boolean);
  return [...new Set(parts)];
}

function mapEsoCsvRow(row: Record<string, string>, index: number): CallRecord | null {
  const times: CallTimes = {
    psapCall: parseCsvDate(findCsvValue(row, 'psapCall')),
    dispatchNotified: parseCsvDate(findCsvValue(row, 'dispatchNotified')),
    unitNotified: parseCsvDate(findCsvValue(row, 'unitNotified')),
    enRoute: parseCsvDate(findCsvValue(row, 'enRoute')),
    arrivedScene: parseCsvDate(findCsvValue(row, 'arrivedScene')),
    arrivedPatient: parseCsvDate(findCsvValue(row, 'arrivedPatient')),
    transferOfCare: parseCsvDate(findCsvValue(row, 'transferOfCare')),
    backInService: parseCsvDate(findCsvValue(row, 'backInService')),
  };

  const incidentAt = computeIncidentAt(times);
  if (!incidentAt) return null;

  const pcrNumber = findCsvValue(row, 'pcrNumber');
  const disposition = findCsvValue(row, 'disposition');
  const primaryImpression = findCsvValue(row, 'primaryImpression');
  const ageYears = parseCsvNumber(findCsvValue(row, 'patientAgeYears'));

  return {
    id: pcrNumber ?? `eso-${index}`,
    pcrNumber,
    incidentAt,
    unitId: findCsvValue(row, 'unitId'),
    agencyIncidentNumber: findCsvValue(row, 'agencyIncidentNumber'),
    times,
    intervals: computeIntervals(times),
    responseMode: findCsvValue(row, 'responseMode'),
    serviceRequested: findCsvValue(row, 'serviceRequested'),
    disposition,
    levelOfCare: findCsvValue(row, 'levelOfCare'),
    transported: deriveTransported(disposition),
    primaryImpression,
    secondaryImpression: findCsvValue(row, 'secondaryImpression'),
    chiefComplaintCategory: findCsvValue(row, 'chiefComplaintCategory') ?? primaryImpression,
    zip: findCsvValue(row, 'zip'),
    patientAgeYears: ageYears,
    ageBand: deriveAgeBand(ageYears),
    crewIds: splitCsvList(findCsvValue(row, 'crewIds')),
    medicationsGiven: splitCsvList(findCsvValue(row, 'medicationsGiven')),
    proceduresPerformed: splitCsvList(findCsvValue(row, 'proceduresPerformed')),
  };
}

/**
 * Parse an ESO Analytics CSV export (already split into header-keyed row
 * objects, e.g. by whatever CSV parser the importer UI uses) into
 * de-identified `CallRecord`s. Column names are resolved via
 * `ESO_COLUMN_ALIASES`, which is exported specifically so it can be extended
 * once BMRC has a real export to check header names against.
 */
export function mapEsoCsv(rows: Record<string, string>[]): NemsisImportResult {
  const warnings: string[] = [];
  const skipped: SkippedReason[] = [];
  const records: CallRecord[] = [];

  if (!rows.length) {
    warnings.push('ESO CSV export contained no rows.');
    return { records, skipped, warnings };
  }

  let noIncidentTime = 0;
  rows.forEach((row, i) => {
    const record = mapEsoCsvRow(row, i);
    if (record) records.push(record);
    else noIncidentTime++;
  });
  if (noIncidentTime > 0) skipped.push({ reason: 'no usable incident time', count: noIncidentTime });

  if (!records.length) {
    warnings.push(
      'No records were mapped from any row — check that column headers match ESO_COLUMN_ALIASES; ' +
        'ESO column names are agency-configurable and may need entries added here.'
    );
  }

  return { records, skipped, warnings };
}

// ── Sample fixture (manual exercising only — no test framework is installed) ─

/**
 * Minimal synthetic 2-record NEMSIS 3.5-shaped document, obviously fake data,
 * for manually exercising `mapNemsisXml` (e.g. from a scratch script or the
 * browser console) before a real ESO export exists. Demonstrates: a fully
 * populated record, an `xsi:nil` timestamp, and a NOT-value disposition code
 * — all of which must resolve to `null`, not literal data.
 */
export const SAMPLE_NEMSIS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<NEMSIS xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <PatientCareReport>
    <eRecord.01>TEST-PCR-0001</eRecord.01>
    <eResponse.03>TEST-INC-0001</eResponse.03>
    <eResponse.19>MEDIC-12</eResponse.19>
    <eTimes.01>2026-01-15T08:12:00-08:00</eTimes.01>
    <eTimes.03>2026-01-15T08:13:05-08:00</eTimes.03>
    <eTimes.05>2026-01-15T08:13:30-08:00</eTimes.05>
    <eTimes.06>2026-01-15T08:14:10-08:00</eTimes.06>
    <eTimes.07>2026-01-15T08:21:45-08:00</eTimes.07>
    <eTimes.08>2026-01-15T08:23:00-08:00</eTimes.08>
    <eTimes.11>2026-01-15T08:55:00-08:00</eTimes.11>
    <eTimes.13>2026-01-15T09:20:00-08:00</eTimes.13>
    <eResponse.05>2205003</eResponse.05>
    <eResponse.13>2205009</eResponse.13>
    <eDisposition.12>4212001</eDisposition.12>
    <eDisposition.16>Basic Life Support</eDisposition.16>
    <eSituation.09>Chest Pain</eSituation.09>
    <eSituation.10>Anxiety</eSituation.10>
    <eScene.21>94720</eScene.21>
    <ePatient.15>21</ePatient.15>
    <eCrew.01>test-crew-001</eCrew.01>
    <eCrew.01>test-crew-002</eCrew.01>
    <eMedications.03>Aspirin</eMedications.03>
    <eProcedures.03>12-Lead ECG</eProcedures.03>
  </PatientCareReport>
  <PatientCareReport>
    <eRecord.01>TEST-PCR-0002</eRecord.01>
    <eResponse.03>TEST-INC-0002</eResponse.03>
    <eResponse.19>MEDIC-07</eResponse.19>
    <eTimes.01>2026-01-16T14:02:00-08:00</eTimes.01>
    <eTimes.03>2026-01-16T14:02:40-08:00</eTimes.03>
    <eTimes.05 xsi:nil="true"></eTimes.05>
    <eTimes.06>2026-01-16T14:04:00-08:00</eTimes.06>
    <eTimes.07>2026-01-16T14:11:00-08:00</eTimes.07>
    <eTimes.08>2026-01-16T14:12:30-08:00</eTimes.08>
    <eTimes.11 xsi:nil="true"></eTimes.11>
    <eTimes.13>2026-01-16T14:45:00-08:00</eTimes.13>
    <eResponse.05>2205001</eResponse.05>
    <eResponse.13>2205003</eResponse.13>
    <eDisposition.12>7701003</eDisposition.12>
    <eDisposition.16>7701001</eDisposition.16>
    <eSituation.09>Fall Injury</eSituation.09>
    <eSituation.10 xsi:nil="true"></eSituation.10>
    <eScene.21>94704</eScene.21>
    <ePatient.15>7701001</ePatient.15>
    <eCrew.01>test-crew-003</eCrew.01>
    <eMedications.03>7701001</eMedications.03>
  </PatientCareReport>
</NEMSIS>
`;
