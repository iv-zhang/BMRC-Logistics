/**
 * Internal call-record contract for the ESO/NEMSIS ingest boundary.
 *
 * BMRC is adopting ESO for EHR/QM. ESO emits NEMSIS 3.5 (the federal EMS
 * reporting standard) on export. `app/lib/calls/nemsis-map.ts` is the ONLY
 * file in this codebase permitted to know about NEMSIS elements or ESO
 * column names — everything downstream (call tiles, stats aggregation, etc.)
 * reads the stable `CallRecord` shape defined here.
 *
 * This file is written ahead of having a real ESO export in hand, so the
 * shape is deliberately conservative: only fields that are safe to keep after
 * de-identification, and every timestamp/interval is nullable because we
 * cannot assume any particular element is always populated.
 *
 * De-identification is structural, not a runtime scrub: `CallRecord` simply
 * has no field capable of holding a patient name, DOB, street address, or
 * narrative text. See `PHI_FIELDS` in `nemsis-map.ts` for the NEMSIS elements
 * that are dropped at parse time to keep it that way.
 */

/** Coarse age bucket. Prefer this over a raw age for anything rendered or aggregated. */
export type AgeBand = '<18' | '18-34' | '35-54' | '55-74' | '75+' | 'unknown';

/**
 * Timestamps along the call timeline, in the order NEMSIS models them.
 * All nullable — a missing or NOT-value-coded element becomes `null`, never
 * an invented time.
 */
export interface CallTimes {
  /** eTimes.01 — PSAP call date/time received. */
  psapCall: Date | null;
  /** eTimes.03 — dispatch notified (CAD) date/time. */
  dispatchNotified: Date | null;
  /** eTimes.05 — unit notified by dispatch date/time. */
  unitNotified: Date | null;
  /** eTimes.06 — unit en route date/time. */
  enRoute: Date | null;
  /** eTimes.07 — unit arrived on scene date/time. */
  arrivedScene: Date | null;
  /** eTimes.08 — arrived at patient date/time. */
  arrivedPatient: Date | null;
  /** eTimes.11 — transfer of patient care date/time. */
  transferOfCare: Date | null;
  /** eTimes.13 — unit back in service date/time. */
  backInService: Date | null;
}

/**
 * Derived durations (seconds) between timeline points. Computed by
 * `computeIntervals` — never trust a NEMSIS-provided interval directly, since
 * agencies compute these inconsistently. Any interval whose endpoints are
 * missing or would be negative is `null`, never `0`.
 */
export interface CallIntervals {
  /** unitNotified → enRoute. */
  chuteSeconds: number | null;
  /** psapCall → arrivedScene. */
  responseSeconds: number | null;
  /** arrivedScene → transferOfCare. */
  onSceneSeconds: number | null;
  /** transferOfCare → backInService. */
  transportSeconds: number | null;
  /** psapCall → backInService. */
  totalSeconds: number | null;
}

/**
 * Stable, de-identified internal call record. Built exclusively by
 * `nemsis-map.ts` from a NEMSIS 3.5 XML export or an ESO Analytics CSV
 * export. Contains NO patient name, DOB, street address, or narrative text —
 * that is a structural property of this type, not a filter applied later.
 */
export interface CallRecord {
  /** Internal id — pcrNumber when available, else a synthesized fallback (see nemsis-map.ts). */
  id: string;
  /** eRecord.01 — PCR/ePCR record number. */
  pcrNumber: string | null;
  /** Best available incident time (falls back through the CallTimes chain — see computeIncidentAt). */
  incidentAt: Date;
  /** dAgency/eResponse unit identifier for the responding unit. */
  unitId: string | null;
  /** Agency-assigned incident number (CAD incident #, distinct from the PCR number). */
  agencyIncidentNumber: string | null;

  times: CallTimes;
  intervals: CallIntervals;

  /** eResponse.13 — type of response mode to the scene (e.g. emergent/non-emergent), category code/label. */
  responseMode: string | null;
  /** eResponse.05 — type of service requested. */
  serviceRequested: string | null;

  /** eDisposition.12 — incident/patient disposition category. */
  disposition: string | null;
  /** eDisposition.16 — level of care provided by the transporting unit. */
  levelOfCare: string | null;
  /** Derived from eDisposition.12: true/false when disposition indicates transport/no-transport, else null if unknown. */
  transported: boolean | null;

  /** eSituation.09 — primary impression, CATEGORY string only (no free text). */
  primaryImpression: string | null;
  /** eSituation.10 — secondary impression, CATEGORY string only (no free text). */
  secondaryImpression: string | null;
  /** Coarse chief-complaint category (derived from eSituation.09/.11 category codes, never the free-text complaint). */
  chiefComplaintCategory: string | null;

  /** eScene.21 — scene zip code ONLY. Never street address, city block, or lat/long. */
  zip: string | null;

  /** Patient age in whole years, when present. Prefer `ageBand` downstream — this exists for computing the band. */
  patientAgeYears: number | null;
  /** Coarse age bucket. Downstream code (call tiles) should read this, not `patientAgeYears`. */
  ageBand: AgeBand;

  /** eCrew.01 — crew member ids assigned to the unit for this call. */
  crewIds: string[];

  /** Medication categories/names administered (eMedications group), no dosage-to-patient narrative. */
  medicationsGiven: string[];
  /** Procedure categories/names performed (eProcedures group). */
  proceduresPerformed: string[];

  /** BMRC standby `events/{id}` this call was resolved against by time+unit overlap, when applicable. */
  linkedEventId?: string;
}

/** One row of the import summary: why records were skipped, and how many. */
export interface SkippedReason {
  reason: string;
  count: number;
}

/** Result of a NEMSIS XML or ESO CSV import pass. */
export interface NemsisImportResult {
  records: CallRecord[];
  skipped: SkippedReason[];
  warnings: string[];
}
