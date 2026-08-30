import type { FieldValue, Timestamp } from 'firebase/firestore';
/**
 * Type-only import from org-config: `EventPolicyOverride` is declared there
 * (app/config/org-config.ts §4.3) alongside the org-config groups it mirrors
 * (WaitlistConfig, CancellationPolicyConfig, ...) so the whole policy-shaped
 * surface lives in one file. This is a type-only circular reference with
 * org-config.ts (which type-imports `TierCriteria` from here) — safe under
 * `isolatedModules`, since `import type` is fully erased at compile time and
 * never participates in module evaluation order.
 */
import type { EventPolicyOverride } from '@/app/config/org-config';

// --- PURCHASE TRACKING ---
export interface PurchaseInfo {
  supplierName?: string;
  supplierId?: string;
  pricePerUnit?: number;
  currency?: string; // Default: 'USD'
  quantityReceived?: number;
  unitOfMeasure?: string; // 'box', 'each', 'case', etc.
  purchaseOrderId?: string;
  orderDate?: Timestamp | Date;
  invoiceRef?: string;
  receivedAt?: Timestamp | Date;
  notes?: string;
}

// --- PROCUREMENT: LOG PURCHASE -> RECEIVE (two-phase) ---
/** One line item within a `Purchase` order. */
export interface PurchaseLine {
  lineId: string;
  kind: 'inventory' | 'asset';
  itemName: string;
  /** Existing item, or the placeholder doc created for a new SKU */
  linkedInventoryId?: string;
  /** Set when a placeholder inventory doc was created for this line */
  createdInventoryId?: string;
  /** Vendor catalog/SKU # to verify on arrival */
  itemNumber?: string;
  category?: string;
  /** Number of packages ordered */
  orderedQty: number;
  /** 'box' | 'bag' | 'case' | 'each' */
  unit?: string;
  unitsPerPackage?: number;
  /** Goods subtotal for this line (pre ship/tax) */
  lineCost?: number;
  // --- receipt (filled at Receive) ---
  received: boolean;
  receivedQty?: number;
  lotNumber?: string;
  /** 'YYYY-MM' */
  expirationMonth?: string;
  receivedAt?: Timestamp | Date;
  receivedBy?: string;
}

/** Order-level source of truth for cost (`purchases` collection). */
export interface Purchase {
  id?: string;
  vendor: string;
  vendorId?: string;
  orderDate: Timestamp | Date;
  status: 'ordered' | 'partially_received' | 'received' | 'cancelled';
  currency?: string; // Default: 'USD'
  /** Goods, pre-shipping & pre-tax */
  subtotal?: number;
  shipping?: number;
  tax?: number;
  discount?: number;
  /** Grand total (subtotal - discount + shipping + tax) */
  total?: number;
  poNumber?: string;
  invoiceRef?: string;
  notes?: string;
  lines: PurchaseLine[];
  createdBy: string;
  createdByName?: string;
  createdAt: Timestamp | Date | FieldValue;
  updatedAt?: Timestamp | Date | FieldValue;
}

// --- ASSET MANAGEMENT CONSTANTS ---
// Default dollar threshold for automatic asset classification
// Items over this value should be tracked as individual assets with serial numbers
export const ASSET_VALUE_THRESHOLD = 500; // USD

// High-value equipment categories that should always be treated as assets
export const ASSET_CATEGORIES = ['AED', 'Radio', 'Oxygen Tank', 'Generator', 'Monitor'] as const;
export type AssetCategoryType = typeof ASSET_CATEGORIES[number];

// --- USER & AUTH ---
export interface User {
  id: string;
  fullName: string;
  email: string;
  /**
   * `medops` is a reduced-admin role: it staffs events and switches members
   * between FTO/member, but is NOT `isAdmin` and sees no logistics surfaces.
   *
   * `fto_intern` is the training tier below `FTO`: an intern shadows a real FTO
   * in the field to earn experience. It is a role position like member/FTO —
   * same cert gating, same permissions as `FTO` — but an intern may only fill
   * the supernumerary FTO-intern slot (or a plain EMT slot), never the FTO slot,
   * and never gains the FTO's attendance-recording powers.
   */
  role: 'admin' | 'member' | 'FTO' | 'fto_intern' | 'quartermaster' | 'inventory_helper' | 'medops';
  /** When true, this member can perform inventory audits even if not admin/quartermaster */
  canAudit?: boolean;
  /** When true, this member is on the Logistics Committee (sees the Committee Board) even if not admin/quartermaster */
  isCommitteeMember?: boolean;
  /**
   * Field-readiness certifications gating shift signup. Both EMT and CPR must be
   * present and unexpired for the member to request a shift. Cleared/renewed
   * manually by medops/admin (see app/lib/certifications.ts) — the app tracks
   * expiry dates only, not the underlying documents.
   */
  certifications?: MemberCertifications;
  /** Whether the user has completed the onboarding tutorial */
  tutorialCompleted?: boolean;
  tutorialCompletedAt?: Date;
  /**
   * Self/admin-set experience tier, replacing the old per-request "Experience"
   * picker. Denormalized onto each ShiftRequest at signup time. Missing/unset
   * MUST be treated as 'general' everywhere it's read — never leave it
   * ambiguous between "new" and "not set".
   */
  memberStatus?: 'new' | 'probationary' | 'general';
  /** Freeform term the member joined (e.g. "Fall 2025"). */
  joinedTerm?: string;
  /**
   * [Phase 0] Tenure anchor, DERIVED from `joinedTerm` via a configured term's
   * `startDate` (`deriveJoinedOn`, app/lib/tenure.ts) — never parsed from
   * freeform text. `joinedTerm` stays the display label; `joinedOn` is the
   * only field tenure math (`minTenureDays`/`minSemesters`) may read. Absent =
   * tenure unknown and MUST fail closed (never treated as zero or infinite
   * tenure) — see `TierCriteria` in this file.
   */
  joinedOn?: Timestamp;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthResponse {
  success: boolean;
  message: string;
  user?: User;
  error?: string;
}

// --- MEMBER CERTIFICATIONS (shift-signup gating) ---
/** One tracked certification (expiry-date only; documents live off-app). */
export interface CertificationRecord {
  /** Cert / license number (optional, for reference). */
  number?: string;
  /** Expiration date. Absent = never recorded (treated as `missing`). */
  expiresOn?: Timestamp | Date;
  /** Who last set/renewed this expiry (medops/admin). */
  verifiedBy?: string;
  verifiedAt?: Timestamp | Date;
}

export interface MemberCertifications {
  /** California EMT certification. */
  emt?: CertificationRecord;
  /** CPR certification. */
  cpr?: CertificationRecord;
}

export type CertStatus = 'valid' | 'expired' | 'missing';

// --- EVENTS & SHIFT STAFFING ---
/** Which member roles may fill a given team slot. */
export type SlotRole = 'FTO' | 'FTO_INTERN' | 'EMT';

/** One assignable slot on a team (empty until a request is approved into it). */
export interface TeamSlot {
  userId?: string;
  userName?: string;
  /**
   * shift_requests doc id that filled this slot (for unassign/audit), OR — while
   * `heldUntil` is set and no `userId` has landed yet — the doc id of the
   * `offered` request softly holding this slot (see `heldUntil`).
   */
  requestId?: string;
  /**
   * [Phase 1 / waitlist plan §3.5] A SOFT HOLD from an outstanding
   * `WaitlistOffer`: the slot is reserved for `requestId`'s member until this
   * instant, without yet placing them (`userId`/`userName` stay unset until
   * `acceptOffer` actually fills the slot). The slot is EFFECTIVELY OPEN AGAIN
   * once `heldUntil` is in the past — every read must treat a stale hold as
   * open, never as occupancy, and there is deliberately no write that "releases"
   * an expired hold: it simply stops counting once `now > heldUntil` (see
   * `isSlotHeld` in app/lib/events.ts). Absent = not held.
   */
  heldUntil?: Timestamp;
}

/**
 * A staffing team on an event: exactly one FTO + `emtCount` EMTs (2–4, default
 * 3), plus an optional single FTO-intern who shadows the FTO. An event may have
 * multiple teams. `emtSlots.length` tracks `emtCount`.
 */
export interface EventTeam {
  id: string;
  name: string;
  /** The single FTO slot. */
  ftoSlot: TeamSlot;
  /**
   * Whether this team carries an FTO-intern slot. Defaults to ON for teams
   * created after the intern feature landed; `undefined` on a legacy doc means
   * OFF, so pre-existing events don't retroactively sprout an open slot.
   */
  hasFtoIntern?: boolean;
  /**
   * The single FTO-intern slot (only meaningful when `hasFtoIntern`). The intern
   * is SUPERNUMERARY: they are an addition to the team, never a substitute, and
   * must NOT be counted toward staffing totals (a team is staffed at 1 FTO +
   * `emtCount` EMTs regardless of whether the intern slot is filled).
   */
  ftoInternSlot?: TeamSlot;
  /** Desired EMT headcount, clamped 2–4. */
  emtCount: number;
  emtSlots: TeamSlot[];
  /** Optional per-team time overrides (fall back to the event's call/end time). */
  startTime?: string;
  endTime?: string;
}

export type EventStatus = 'draft' | 'open' | 'closed' | 'cancelled';

/**
 * [Phase 0 / waitlist plan §3.7] Eligibility criteria for one staged-release
 * tier window. Every SPECIFIED (non-undefined) criterion must hold when
 * `combine` is `'all'` (default); with `combine: 'any'`, one satisfied
 * criterion is enough. `{}` (no criteria specified) means "anyone, once this
 * window opens" under either mode — a pure timing tier with no eligibility
 * filter.
 *
 * `roles` is typed `User['role'][]` rather than a standalone `UserRole` alias
 * — the codebase has no such alias today (the role union is inlined on
 * `User.role`); introducing one is a real but out-of-scope cleanup (plan §2.2).
 */
export interface TierCriteria {
  /** Role allowlist — omitted means "no role restriction" for this criterion. */
  roles?: User['role'][];
  /** Member experience tier — omitted means no restriction. */
  memberStatus?: NonNullable<User['memberStatus']>[];
  minCompletedShifts?: number;
  /** Per-event-type minimums, e.g. `{ football: 2 }`. Keyed by eventType id. */
  minShiftsByType?: Record<string, number>;
  /** Fails closed (does not qualify) when `User.joinedOn` is absent. */
  minTenureDays?: number;
  /** Tenure in configured terms (app/config/org-config.ts `terms`) — the unit
   *  MedOps actually thinks in. Also fails closed when `joinedOn` is absent. */
  minSemesters?: number;
  requireCommitteeMember?: boolean;
  /** How the specified criteria combine. Default `'all'`. */
  combine?: 'all' | 'any';
}

/**
 * [Phase 0 / waitlist plan §2.2] One staged-release window on `EventAccessTier.tiers`,
 * earliest-`opensAt`-first. A member's access opens at the earliest window
 * whose criteria they satisfy (see `getTierAccess`, app/lib/events.ts), falling
 * back to `EventAccessTier.generalOpensAt`.
 */
export interface TierWindow {
  id: string;
  /** Member-facing label for this window, e.g. "FTOs & 5+ shift members". */
  label: string;
  opensAt: Timestamp;
  criteria: TierCriteria;
}

/**
 * [Phase 0 / waitlist plan §2.2, P5] Tiered/staged-release signup for an event.
 * A STAGED RELEASE WINDOW, not an eligibility gate: after `generalOpensAt`,
 * everyone can sign up with no manual override, and an event may define any
 * number of `tiers` (zero = a plain "opens on this date" event).
 *
 * Absent, or `enabled: false`, = untiered event, open to everyone immediately
 * — the same behavior as every event that predates this field.
 */
export interface EventAccessTier {
  enabled: boolean;
  /** Ordered staged-release windows, earliest first. */
  tiers: TierWindow[];
  /** After this instant, signup is open to everyone — no override needed or possible. */
  generalOpensAt: Timestamp;
  /** Author-written explanation, rendered to a blocked member BEFORE they hit the restriction. */
  rationale: string;
}

export interface Event {
  id?: string;
  name: string;
  eventType?: string;
  venue?: string;
  location?: string;
  /** Event day. */
  date: Timestamp | Date;
  /**
   * Call time as "HH:mm" (note: not necessarily Berkeley time).
   *
   * [Phase 0 / waitlist plan §2.2, P12] REQUIRED on every event going forward
   * — notice class, reminders, lateness, and the external worker's bounded
   * queries all derive from the shift's start instant. Enforcement is
   * client-side only (event-editor-modal.tsx blocks save on empty; no server
   * to reject it). Legacy events written before this phase may still lack it
   * in Firestore — read paths must keep a null branch for that case, but it
   * is now "legacy data" handling, not a supported state: such an event is
   * excluded from auto-promotion and surfaced to managers as "needs a call
   * time" rather than silently defaulted.
   */
  callTime: string;
  endTime?: string;
  description?: string;
  status: EventStatus;
  teams: EventTeam[];
  /** Whether a signup-open notification has been broadcast for this event. */
  notified?: boolean;
  /**
   * [Phase 1 / waitlist plan §3.3, §3.5, P12] Set `true` by
   * `flagEventNeedsCallTime` when `promoteNextFromWaitlist` is attempted
   * against this event and `computeNoticeClass` returns `null` — i.e. a
   * legacy event with no `callTime`, which can't be auto-promoted because
   * notice class is undecidable. `updateEvent` clears it (`needsCallTime:
   * false`) whenever a non-empty `callTime` is saved, so fixing the one field
   * un-flags the event with no separate "resolve" step. Absent = never
   * flagged (the common case for every event created after `callTime` became
   * required).
   */
  needsCallTime?: boolean;
  /**
   * [Phase 0 / waitlist plan §2.2, P5] Staged-release tier config, prefilled
   * from `org_settings.priorityTiers` at event creation and then owned by the
   * event (non-retroactive — a later org-config retune does not move an
   * already-published event's dates). Absent/`enabled: false` = untiered.
   */
  accessTier?: EventAccessTier;
  /**
   * [Phase 0 / waitlist plan §2.2] Per-event kill switch for whether a full
   * team offers a waitlist at all, or just shows "Full." Kept as its own
   * field (rather than folded into `policy`) because it's the one flag the
   * event editor surfaces as a prominent switch and the UI reads it before
   * any policy resolution happens.
   *
   * Absent = ON (waitlisting available) — deliberately the opposite polarity
   * of the `hasFtoIntern`-style "undefined = off" precedent: waitlisting only
   * activates on an already-full team and has no effect on an event with open
   * slots, so there is no "don't retroactively sprout surface area" risk to
   * guard against, whereas defaulting off would silently opt every
   * pre-existing event out of the feature this whole plan is for.
   */
  waitlistEnabled?: boolean;
  /**
   * [Phase 5 / waitlist plan §5.9, §2.2, R5] Opaque tag shared by every event
   * created in one bulk run, so a manager looking at these next week can still
   * tell they came from one batch. Optional, non-load-bearing, and **read by
   * nothing** — in particular the bulk UNDO deletes by id, never by querying
   * this field, so undo needs no index and cannot reach an earlier run's events.
   * A `seriesId` is NOT a live series entity: these are ordinary, independent
   * events (see §5.9 "Deliberately out of scope").
   */
  seriesId?: string;
  /**
   * [Phase 0 / waitlist plan §2.2, §4.3, P11] Per-event escape hatch overriding
   * `org_settings.waitlist` / `cancellationPolicy` / reminder hours for THIS
   * event only. Every key optional; `undefined` (on the whole field or any key
   * inside it) means "inherit org config." Nothing should read this field
   * directly — always go through `resolveEventPolicy(event)`
   * (app/lib/events.ts), which is the one place override-vs-default
   * resolution happens.
   */
  policy?: EventPolicyOverride;
  createdBy: string;
  createdByName?: string;
  createdAt: Timestamp | Date | FieldValue;
  updatedAt?: Timestamp | Date | FieldValue;
}

/** BMRC self-reported experience ranking carried on a request (informational). */
export type MemberRanking = 'FTO' | 'returning' | 'new';

/**
 * [Phase 0 / waitlist plan §2.1, P1] Widened from the original 4 values to
 * support the waitlist, which reuses `shift_requests` rather than a new
 * collection. `waitlisted`/`offered` are the two "live" new states;
 * `declined`/`expired` are terminal siblings of `rejected`/`cancelled` under
 * the default policy (`waitlist.declinedOfferBehavior === 'terminal'`).
 *
 * CONSUMER AUDIT WARNING (plan §2.1): every existing `switch`/equality/filter
 * site over this union was audited against the new values as part of this
 * plan (see the plan's consumer table) — that audit is a SEPARATE workstream
 * from this schema change and must not be re-litigated ad hoc. A `switch`
 * over this type should use an `assertNever` default so the compiler
 * enumerates any site that still needs a decision.
 */
export type ShiftRequestStatus =
  | 'pending' | 'approved' | 'rejected' | 'cancelled'   // existing
  | 'waitlisted' | 'offered' | 'declined' | 'expired';  // new (waitlist plan)

/**
 * Attendance exceptions only — a normal attendance is represented by
 * `checkedInAt` being set (see `AttendanceRecord`). 'present'/'late' are no
 * longer stored statuses: lateness is derived from `checkedInAt` vs the
 * event's call time (see `computeMinutesLate` in event-utils.ts).
 */
export type AttendanceStatus = 'no_show' | 'excused';

/**
 * Attendance record stamped onto an approved ShiftRequest. A member
 * "attended" iff `checkedInAt` is set and `exception` is unset.
 *
 * Times are STAMPED BY BUTTON PRESS, never typed: "Check in" sets `checkedInAt`
 * to now, "Check out" sets `shiftEndAt` to now. There is deliberately no
 * arrival-time entry field in the live flow — whenever the FTO taps check in IS
 * when the member arrived. Only a manager (admin/quartermaster/medops) editing a
 * past event may override these times after the fact.
 *
 * `minutesLate` / `minutesEarly` / `leftEarly` are stored SNAPSHOTS derived at
 * stamp time from the event's call and end times; they are recomputed when a
 * manager overrides a time retroactively.
 */
export interface AttendanceRecord {
  /** Stamped when the member checks in (or a manager backfills the arrival time). */
  checkedInAt?: Timestamp | Date | FieldValue;
  /** Stamped on "Check out", by manual "End shift", or when the pack tied to this shift is checked back in. */
  shiftEndAt?: Timestamp | Date | FieldValue;
  /** Snapshot: arrival − event call time, in minutes (>= 0). Recomputed on override. */
  minutesLate?: number;
  /** No-show / excused absence. Mutually exclusive with `checkedInAt`. */
  exception?: AttendanceStatus;
  /**
   * Snapshot marker that the member checked out before the event's scheduled end
   * time — DERIVED at check-out, never a toggle. No grace window: any departure
   * strictly before the end time counts. Left unset when the event has no
   * `endTime` (undeterminable). Only meaningful when `checkedInAt` is set.
   */
  leftEarly?: boolean;
  /** Snapshot: event end time − departure, in minutes (> 0). Set only when `leftEarly`. */
  minutesEarly?: number;
  notes?: string;
  recordedBy: string;
  recordedByName?: string;
  recordedAt: Timestamp | Date | FieldValue;
}

/**
 * [Phase 0 / waitlist plan §2.1, P3] One offer of a freed slot to a waitlisted
 * member, embedded on `ShiftRequest.offer` (live) and appended to
 * `ShiftRequest.offerHistory` (log) whenever it is superseded. `noticeClass`,
 * `binding`, and the resolved `policy` snapshot are computed ONCE at offer
 * time (from `resolveEventPolicy`) and FROZEN here — a later org-config or
 * per-event policy retune must never retroactively change what a past offer
 * meant to the person who accepted (or is still considering) it.
 */
export interface WaitlistOffer {
  offeredAt: Timestamp;
  /** Deadline for the member to accept/decline. */
  respondBy: Timestamp;
  /** Which notice-window bucket produced this offer (see org-config `waitlist.longNoticeThresholdHours`). */
  noticeClass: 'long' | 'short';
  /**
   * Whether ACCEPTING this offer creates no-show liability. Computed ONCE at
   * offer time from the resolved policy and FROZEN. See
   * `ShiftRequest.commitmentBinding` for the current/actual liability state,
   * which is a separate, mutable field set only at acceptance.
   */
  binding: boolean;
  /**
   * The resolved policy this offer was made under, frozen alongside it, so a
   * reader can explain the offer months later without re-deriving it from
   * today's config. See `resolveEventPolicy` (app/lib/events.ts).
   */
  policy: {
    longNoticeThresholdHours: number;
    responseWindowHours: number;
    cancellationNoticeHours: number;
    cancellationMode: 'ignore' | 'flag' | 'confirm' | 'block';
  };
  /** Which team's slot this offer is for — the queue itself is team-agnostic (P13). */
  teamId: string;
  teamName: string;
  /**
   * [Phase 0] The shift start instant `noticeClass` above was actually
   * computed from, resolved for the offered team as
   * `team.startTime ?? event.callTime` and frozen here with the rest of the
   * offer (P3).
   *
   * This is NOT the same value as `ShiftRequest.shiftStartAt`, and the
   * difference is load-bearing. `EventTeam` carries per-team `startTime`
   * overrides, but under P13 a queued member has no team yet (`teamId: ''`),
   * so the request-level `shiftStartAt` can only ever be the event-level
   * approximation. A team is resolved at promotion time — and only then is the
   * member's real shift start knowable.
   *
   * Computing `noticeClass` from the event-level value would break P4: if the
   * offered team starts EARLIER than the event call time, an offer can be
   * classed `'long'` — and therefore stamped `binding: true`, with real
   * no-show liability — on a shift that is actually inside the short-notice
   * window, which P4 promises can never happen. (The reverse error, a team
   * starting later, only over-credits the member and is harmless.)
   *
   * So: `promoteNextFromWaitlist` MUST recompute this from the resolved team
   * and derive `noticeClass`/`binding` from it, never from the queue-time
   * approximation.
   */
  shiftStartAt: Timestamp;
  offeredBy: string;
  respondedAt?: Timestamp;
  response?: 'accepted' | 'declined' | 'expired';
}

/** A member's request to fill a specific role on a specific team of an event. */
export interface ShiftRequest {
  id?: string;
  eventId: string;
  eventName: string;
  /** Denormalized for list display / sorting. */
  eventDate?: Timestamp | Date;
  /**
   * [Phase 0 / waitlist plan §2.1, P13] For a waitlist entry (`status ===
   * 'waitlisted'`), the queue is keyed on `(eventId, role)` — NOT team — so
   * this field is written `''` (documented sentinel = "not yet assigned")
   * until an offer is made, at which point the real team is filled in inside
   * the same transaction that holds the slot. Stays required (rather than
   * widened to `string | undefined`) so existing consumers keep compiling
   * against the sentinel; check `isUnassignedQueueEntry(request)` rather than
   * `!request.teamId` at call sites that care. RULE: filter by `status`
   * before grouping by `teamId` — an unfiltered `groupBy(teamId)` over queue
   * entries grows a phantom `''` group.
   */
  teamId: string;
  teamName: string;
  /** Which slot type the member is applying for. */
  role: SlotRole;
  userId: string;
  userName: string;
  /** @deprecated Legacy manual FTO/Returning/New picker. No longer written by any UI — kept for back-compat with existing docs. Use `memberStatus`/`joinedTerm` instead. */
  ranking?: MemberRanking;
  /** Denormalized from the requester's `User.memberStatus` at signup time (default 'general' when unset on the user doc). */
  memberStatus?: 'new' | 'probationary' | 'general';
  /** Denormalized from the requester's `User.joinedTerm` at signup time. */
  joinedTerm?: string;
  status: ShiftRequestStatus;
  /** For an approved request: which slot they were placed in ('fto' | emt index). */
  assignedSlot?: string;
  note?: string;
  requestedAt: Timestamp | Date | FieldValue;
  decidedBy?: string;
  decidedByName?: string;
  decidedAt?: Timestamp | Date | FieldValue;
  /** Set by the FTO/manager after the event (only on approved requests). */
  attendance?: AttendanceRecord;

  // --- Waitlist / offer fields (Phase 0, waitlist plan §2.1) ---

  /**
   * Set ONCE, at the moment this request is written as `waitlisted` (either
   * because no slot was open at request time, or because it fell back onto
   * the queue). The SOLE ordering key: `getWaitlistPosition` sorts a queue's
   * `waitlisted` requests ascending on this field. Never renumbered, never
   * rewritten on a queue change — position is a read-time computation over N
   * docs, not a stored rank. Absent on `pending`/`approved` requests (direct
   * signups don't queue). A doc with `status === 'waitlisted'` and this field
   * absent is a data-integrity bug (sort it last), not a silent default.
   */
  waitlistedAt?: Timestamp;
  /**
   * Set by the manager **Skip** action to deprioritize a queued member
   * without removing them. `getWaitlistPosition` sorts by `(skippedAt == null
   * ? 0 : 1)` FIRST, then ascending `waitlistedAt` — a skipped entry falls
   * behind every non-skipped entry while keeping its original arrival time as
   * the tie-break among other skipped entries. Clearing this field restores
   * the member's original position (the "undo"). Absent = not skipped.
   */
  skippedAt?: Timestamp;
  /**
   * The member's optional soft team preference, captured at join time. Never
   * removes them from the queue and never changes their position; how
   * promotion treats it is governed by `waitlist.honorTeamPreference`
   * (`'ignore' | 'soft' | 'strict'`, org-config). Absent = no preference =
   * "any team", the permissive case under every mode.
   */
  preferredTeamId?: string;
  /**
   * Denormalized start instant of the shift this request is for (team
   * `startTime` if set, else `event.callTime`, resolved against `event.date`).
   * Written at request time and re-stamped whenever the event's date/call
   * time changes (`updateEvent` must re-stamp it on every non-terminal
   * request for that event, in the same batch — the same propagation
   * obligation the location model carries for zone renames). Exists so the
   * external sweep worker, the cancellation policy, and shift reminders can
   * query/compare against the shift start without an event join. Absent =
   * fall back to loading the event (correct but slow); the worker skips such
   * docs rather than fanning out.
   */
  shiftStartAt?: Timestamp;
  /**
   * [Phase 3 / waitlist plan §6.6] Reminder offsets (hours-before-shift, from
   * `shiftReminders.hoursBefore`) already EMITTED as a `shift_reminder`
   * notification for this request. Idempotency key: an offset present here is
   * never re-sent, which is what stops the 48h and 12h reminders from
   * repeating on every dashboard load — and what makes the Phase 4a worker
   * safe, since a poller has no before/after trigger condition to lean on.
   * Absent = nothing sent yet. NOT a record of whether the member SAW it, and
   * deliberately NOT what drives the dashboard banner (the banner is a fact
   * displayed while true, not a one-shot send — see `selectShiftReminderBanner`).
   */
  remindersSent?: number[];
  /**
   * Denormalized `Event.eventType` at request time. Makes
   * `MemberShiftStats.shiftsByType` and the `minShiftsByType` tier criterion
   * derivable from a member's own `shift_requests` query with no event
   * fan-out. Absent = "type unknown": counts toward `shiftsAllTime` but is
   * EXCLUDED from every per-type bucket — never bucketed under a synthesized
   * `'other'`, which would silently satisfy a `minShiftsByType` rule the
   * member never actually met.
   */
  eventType?: string;
  /**
   * Present only while `status === 'offered'`, or as the final snapshot after
   * it resolves to `approved` (accepted), `declined`, or `expired`. Never
   * present on a plain `pending`/`waitlisted` doc.
   */
  offer?: WaitlistOffer;
  /**
   * Append-only log of every offer this request has received (oldest first),
   * pushed to whenever `offer` is overwritten (e.g. offer 1 expires, entry
   * requeues under `declinedOfferBehavior: 'requeue_back'`, offer 2 is made
   * later). Bounded in practice by `waitlist.maxOffersPerMember`. Absent = no
   * offer has ever been made on this request.
   */
  offerHistory?: WaitlistOffer[];
  /**
   * How many offers this member has been made for this event. Used by
   * `waitlist.maxOffersPerMember` to cap the requeue loop when
   * `declinedOfferBehavior === 'requeue_back'`. Absent = 0.
   */
  offerCount?: number;
  /**
   * [P4] Whether a no-show against THIS request is held against the member.
   * Set explicitly at every relevant transition — never left to infer from
   * `status` alone: `true` for a normal direct `approved` signup, or an
   * `offer.noticeClass === 'long'` offer that is explicitly accepted; `false`
   * for a `waitlisted`/unanswered-`offered` entry, any short-notice offer
   * (even if accepted), or any terminal (`declined`/`expired`/`rejected`/
   * `cancelled`) request.
   *
   * LEGACY-UNDEFINED ASYMMETRY (footgun, read this before touching this
   * field): this field did not exist before this phase, so every pre-existing
   * doc has it `undefined`. The read-side default is STATUS-CONDITIONAL, not
   * a single default:
   *   - `undefined` AND `status === 'approved'` -> treat as `true` (legacy
   *     direct approvals predate waitlisting and were always binding in
   *     practice; defaulting them non-binding would silently forgive existing
   *     no-show liability on every historical record).
   *   - `undefined` AND `status !== 'approved'` -> treat as `false` (no shift
   *     to be liable for).
   * Never read this as a flat `?? true` or `?? false` — both are wrong for
   * half the doc population. Centralize the branch as a helper (e.g.
   * `isCommitmentBinding(request)`) rather than inlining it at every call site.
   */
  commitmentBinding?: boolean;
  /**
   * Stamped by `cancelRequest` when the configured cancellation policy
   * (`org_settings.cancellationPolicy`, possibly per-event overridden) is
   * triggered. Absent = not flagged.
   */
  lateCancellation?: boolean;
  /**
   * The resolved `policy.cancellation.noticeHours` THRESHOLD the cancellation
   * was evaluated against — NOT the actual hours-of-notice the member gave.
   * Stored alongside the flag because the threshold is configurable and
   * per-event overridable — a flag alone can't tell a manager six weeks later
   * whether "late" meant 48h or 12h on that particular event. (The actual
   * notice given is cheaply recoverable from `shiftStartAt`/`decidedAt` if
   * ever needed, so it isn't duplicated here.)
   */
  lateCancellationHours?: number;
}

// --- IN-APP NOTIFICATIONS ---
/**
 * [Phase 0 / waitlist plan §2.4] New values are purely additive — no existing
 * doc holds them. No structural change to `AppNotification` itself: all four
 * reuse the existing `link` field to deep-link to the event (e.g.
 * `'/events?event=' + eventId`), same convention `requestShift`'s broadcast
 * already uses.
 *
 * | Value | Fires when |
 * |---|---|
 * | `waitlist_offer` | A `waitlisted` entry transitions to `offered` — recipient is the offered member. |
 * | `waitlist_promoted` | An accepted offer resolves into a filled slot (`offered` -> `approved`) — kept distinct from `waitlist_offer` so the feed reads as two events, matching the existing `request_approved` pattern for direct signups. |
 * | `shift_reminder` | Config-driven pre-shift reminder per `org_settings.shiftReminders` — evaluated client-side on read, no scheduler. |
 * | `tier_open` | A tiered event crosses `generalOpensAt` (or a member starts qualifying under a tier's `criteria`) and becomes signable for a previously-blocked member. |
 */
export type NotificationType =
  | 'event_open'
  | 'request_approved'
  | 'request_rejected'
  | 'broadcast'
  | 'cert_expiring'
  | 'waitlist_offer'
  | 'waitlist_promoted'
  | 'shift_reminder'
  | 'tier_open';

export interface AppNotification {
  id?: string;
  /** Recipient user id. */
  userId: string;
  type: NotificationType;
  title: string;
  body?: string;
  /** In-app route to open when tapped (e.g. "/events"). */
  link?: string;
  read: boolean;
  createdAt: Timestamp | Date | FieldValue;
  createdBy?: string;
}

// --- MASTER INVENTORY ---
export type ItemCategory =
  | 'Airway'
  | 'Trauma'
  | 'Vitals'
  | 'Meds'
  | 'PPE'
  | 'Splinting'
  | 'Hygiene'
  | 'First Aid'
  | 'Other';

export type LocationType = 'HQ' | 'CPR Closet' | 'Shed' | 'Other';
// Clarify HQ rooms: Back Room is the authoritative inventory (audit target).
export type HQRoom = 'Front' | 'Forward Staging' | 'Back Room' | 'Office';

export interface InventoryVariant {
  id: string;
  name: string;
  quantityPerUnit: number;
  stock: number;
  lotNumber?: string;
  expirationDate?: Date;
  reorderThreshold?: number;
  // Optional per-variant batch tracking for expirations/lot-specific stock
  batches?: InventoryBatch[];
  // When true, this specific variant must always have its expiration checked before use
  requiresExpirationCheck?: boolean;
}

// --- BATCH STATUS ---
export type BatchStatus = 'sealed' | 'open' | 'depleted' | 'expired' | 'quarantined';

// --- STORAGE LOCATION REFERENCE ---
/** Structured reference to a storage zone/shelf/level/container from Storage Management */
export interface StorageLocationRef {
  zoneId?: string;
  zoneName?: string;       // denormalized for display
  shelfId?: string;
  shelfName?: string;      // denormalized
  level?: number;          // which level on the shelf
  containerId?: string;
  containerName?: string;  // denormalized
}

export interface InventoryBatch {
  id: string;
  lotNumber?: string;
  expirationDate?: Date;
  openDate?: Date; // For items like glucose strips that expire X days after opening
  // When an item has variants, a batch must belong to a specific variant
  variantId?: string;
  stock: number;

  // --- BAG / SUBDIVISION TRACKING ---
  /** How many items are in each bag/box for THIS specific batch (supplier may vary between orders) */
  itemsPerBag?: number;
  /** Number of sealed bags in this batch (source-of-truth count) */
  bagCount?: number;
  /** Loose individual items not in a complete bag (e.g., partially used bag) */
  looseItems?: number;
  /** Lifecycle status of this batch */
  status?: BatchStatus;
  /** When the first bag in this batch was opened */
  openedAt?: Date;
  /** User ID of person who opened this batch */
  openedBy?: string;

  // optional metadata for a batch (receivedAt, supplier, notes)
  receivedAt?: Date;
  supplier?: string;
  notes?: string;
  requiresFIFO?: boolean; // Flag to enforce oldest-first picking
  // Purchase/vendor tracking for this batch
  purchase?: PurchaseInfo;
  // Optional per-location splits for the same batch (e.g., storage, statpacks)
  locations?: {
    id: string;
    name: string; // freeform location label (e.g., "Back storage", "Statpack 3", "Front desk")
    quantity: number;
    // Optional parsed UI fields (not required in stored documents)
    area?: LocationType;
    room?: HQRoom;
    shelf?: string;
  }[];
  // Optional: when true, this batch is tracked at unit-level and `serialNumbers` holds each unit's ID
  serialized?: boolean;
  // For serialized batches, explicit serial/asset IDs for each unit in the batch
  serialNumbers?: string[];
  // Optional richer per-unit asset instances (for devices like AEDs)
  assetInstances?: AssetInstance[];
}

export interface InventoryItem {
  id: string;
  /**
   * DERIVED, never typed by hand: `${family}, ${variantLabel}` (family alone if
   * there is no variant). Persisted so the ~78 existing read sites and
   * Firestore `orderBy('name')` keep working — sorting by name naturally
   * groups parent-first, variant-last. Regenerate via `deriveItemName`.
   */
  name: string;
  /** Controlled parent list from `orgConfig.itemFamilies` (e.g. "Nitrile Gloves"). */
  family?: string;
  /**
   * Free-text descriptor (e.g. "Small", "M", "28 Fr"). Named `variantLabel`, not
   * `variant`, because the legacy `InventoryVariant[]`/`hasVariants` fields below
   * are an unrelated (dead, write-stripped) stock-bearing concept.
   */
  variantLabel?: string;
  /** Set by the naming backfill when `name` could not be split confidently; drives the admin review queue. */
  namingReviewNeeded?: boolean;
  category: ItemCategory;
  description?: string;

  // Stock Levels - Box-Based Tracking
  unopenedBoxes: number; // Number of unopened boxes
  itemsPerBox?: number;  // Optional: how many items in one box
  /** Loose individual units not in a complete box (e.g., partial box after subdivision) */
  looseUnits?: number;
  reorderThreshold: number;
  /** Maximum desired stock level. Progress bar shows current/maxUnits. Overstocking is allowed. */
  maxUnits?: number;
  /** Units currently staged on the FRONT restock shelf (the deployed pool). The item-level box/loose/batch counts are the back-room RESERVE. Refilling the shelf pulls from reserve and increments this. */
  shelfQuantity?: number;
  /**
   * When the front shelf was last physically counted. Front-shelf consumption is
   * deliberately NOT event-tracked (members won't log it reliably); instead a
   * weekly check re-anchors `shelfQuantity` to what is actually there.
   */
  lastShelfCheckAt?: Date;
  /** Display name of whoever performed the last front-shelf check. */
  lastShelfCheckBy?: string;
  // Par levels per location (optional): { locationId: minimumQuantity }
  parByLocation?: Record<string, number>;
  
  // DEPRECATED: Legacy fields kept for migration compatibility
  totalStockQuantity?: number;
  
  // Locations
  location: LocationType;
  room?: HQRoom;
  shelf?: string;
  bin?: string;
  /** Back-room shelf identifier (e.g., "Shelf A") */
  backShelf?: string;
  /** Back-room shelf level/row number (e.g., 1 = top, 2 = second, etc.) */
  backLevel?: number;

  /** Structured storage location from Storage Management (zone → shelf → level → container) */
  storageLocation?: StorageLocationRef;

  // UI / metadata
  unit?: string; // e.g., 'box' or 'count'
  // Asset flag: when true this item is an individual asset (e.g., Blue Stat Pack 1)
  // Assets are tracked by status, not by quantity.
  isAsset?: boolean;
  // For tangible assets, optional serial number to uniquely identify this asset instance
  assetSerial?: string;
  // Barcode and QR code for scanning asset checkout/checkin (either or both)
  barcode?: string; // UPC, code128, or other barcode format
  qr?: string; // QR code content (often same as serial or barcode)
  // External barcode assigned from purchased asset tags (can replace or supplement generated codes)
  assignedBarcode?: string | null;
  // History of all barcode assignments/reassignments for audit trail (append-only)
  barcodeHistory?: Array<{
    value: string;
    assignedAt: Date | FieldValue;
    assignedBy?: { id?: string; name?: string };
  }>;
  // If this asset is a child of another asset (e.g., battery/pad assigned to AED parent), store parent asset id
  parentAssetId?: string;
  // When set, this inventory doc is an AED child component (battery or pads), linked to its parent AED via parentAssetId
  componentType?: 'battery' | 'pads';
  // If assigned to a statpack or other container, reference that entity
  assignedToId?: string;
  // Distinguish asset categories; 'AED' is a special asset type with additional checks
  assetCategory?: 'AED' | 'Generic' | string;
  // Model name or identifier for assets that have multiple models (e.g., 'Philips FRx')
  assetModel?: string;
  manufacturer?: string; // Asset manufacturer (e.g. "Philips", "ZOLL")
  // If isAsset=true, use assetStatus/lastChecked/nextExpiration instead of quantities.
  assetStatus?: 'Ready' | 'Not Ready' | 'In Use' | 'Checked Out';
  assetLastChecked?: Date;
  assetNextExpiration?: Date;
  // Checkout tracking fields (when asset is checked out by a member)
  checkedOutAt?: Date | FieldValue; // When the asset was checked out
  checkedOutBy?: string; // User ID of member who checked it out
  lastCheckedInAt?: Date | FieldValue; // When asset was last checked in
  lastCheckedInBy?: string; // User ID of member who checked it in
  lastKnownReturnLocation?: string; // Where the member reported returning it
  // Asset-specific quick-check fields (useful for AEDs)
  assetChecks?: {
    batteryStatus?: 'Good' | 'Low' | 'Unknown';
    padsSealed?: boolean;
    lastCheckNotes?: string;
  };
  // Per-item expiry fields for consumable components (convenience for single-instance assets)
  batteryExpiration?: Date;
  padExpiration?: Date;
  /**
   * Control-test currency for reagent-based diagnostic assets (e.g. a glucometer):
   * a fresh passing control test must be on file within `intervalDays`, otherwise
   * the asset (and any pack holding it) is treated as not service-ready.
   */
  controlTest?: {
    lastPassedAt?: Date;
    intervalDays?: number;
    lastResult?: 'pass' | 'fail' | string;
  };
  // Optional top-level list of asset instances when the item represents multiple unique devices
  assets?: AssetInstance[];
  // Optional per-asset verification policy (admin-configurable)
  // Controls which checks are performed at checkout/checkin for this inventory item
  verificationPolicy?: AssetVerificationRules;
  hasVariants?: boolean;
  variants?: InventoryVariant[];

  // Batch/lots tracking for different expirations (separate from sizing `variants`)
  batches?: InventoryBatch[];
  // When true, this item must always have its expiration date checked before use (UI/enforcement can honor this)
  requiresExpirationCheck?: boolean;
  // Tracking
  tracksExpiration: boolean; 
  expirationDate?: Date;
  expirationPrecision?: 'day' | 'month'; // Precision for expiration date tracking (day = full date, month = month/year only)
  // Audit flag: whether this item must be included in semesterly audit counts
  
  
  // Oxygen Specifics
  isOxygen?: boolean;
  oxygenPsi?: number;
  maxOxygenPsi?: number;
  // Optional model/name for oxygen tanks
  oxygenModel?: string;

  // Box/Unit Logic - DEPRECATED (replaced by unopenedBoxes/itemsPerBox)
  tracksOpenStock?: boolean;
  quantityPerUnit?: number;
  unopenedQuantity?: number;
  openedQuantity?: number;
  hasSecondaryExpiration?: boolean; 
  secondaryExpirationDays?: number;
  openedAt?: Date;

  // Reagent-specific handling (Glucose, Control Solution, Eye Wash)
  isReagent?: boolean; // Items that degrade after opening
  daysValidAfterOpening?: number; // e.g., 90 for glucose strips

  // Medication-specific tracking (for EMS medical cabinet compliance)
  isMedication?: boolean;
  medicationInfo?: MedicationInfo;

  // Audit tracking
  auditVerified?: boolean; // Semester audit verification flag
  // QC/Condition recorded during audit: Good (default), Damaged, or Expired
  auditCondition?: 'Good' | 'Damaged' | 'Expired';
  auditNotes?: string;
  lastAuditDate?: Date;
  isLegacyItem?: boolean; // Quick-added legacy/found items
  /** Training / non-deployable gear (trainer AEDs, manikins) — still tracked as an asset but must not be dispatched */
  isTrainer?: boolean;

  createdAt: Date;
  updatedAt: Date;

  // --- PROCUREMENT: ON-ORDER TRACKING ---
  /** Present on a placeholder row for a brand-new SKU with 0 real stock, logged via Log Purchase */
  orderStatus?: 'on_order';
  /** Pending purchase-order lines for this item; on-order is NOT on-hand (never feeds stock math) */
  incomingOrders?: {
    purchaseId: string;
    lineId: string;
    qty: number;
    unitsPerPackage?: number;
    unit?: string;
    orderDate: Timestamp | Date;
    vendor?: string;
  }[];

  // --- STATPACK ASSIGNMENT (bidirectional link) ---
  /** Structured assignment linking this asset to a specific statpack and pocket */
  statpackAssignment?: {
    statpackId: string;
    statpackName: string;
    pocket: StatpackPocket;
    compartmentLabel?: string;
    positionIndex?: number;
    assignedAt: Date | FieldValue;
    assignedBy: string;
  };

  // --- VERIFICATION TRACKING ---
  /** Results from the last verification/checkout scan */
  lastVerification?: {
    verifiedAt: Date;
    verifiedBy: string;
    verifiedByName: string;
    barcodeMatched?: boolean;
    fieldValues?: Record<string, unknown>;
    warnings?: Array<{ fieldId: string; message: string; severity: string }>;
    passed: boolean;
  };

  // Asset-specific fields (for non-disposable high-value items: O2 tanks, AEDs, bikes, radios, etc.)
  assetValue?: number; // Monetary value in dollars
  currentLocation?: string; // Where the asset is currently (GPS or room location)
  /** Per-unit dollar value for consumables (mirrors `assetValue` for assets). Stamped from purchase unit cost. */
  itemValue?: number;
  maintenance_logs?: Array<{
    id?: string;
    timestamp?: Date;
    serviceType: string; // 'routine', 'repair', 'inspection', 'replacement'
    reason: string; // Why is it being serviced
    technician?: string; // Who did the work
    notes?: string;
    status: 'pending' | 'in-progress' | 'completed'; // Current status
    completedAt?: Date;
  }>;
}

// --- STATPACKS ---
export type StatpackPocket = 'main' | 'front_aux' | 'side_left' | 'side_right';

export interface StatpackCompartment {
  id: string;
  name: string;
  parentPocket: StatpackPocket; 
  isSealed: boolean;
  sealNumber?: string;
  expirationDate?: Date;
}

// Asset verification rules for statpack items (admin-configurable, optional)
export interface AssetVerificationRules {
  // Require scanning/entering serial number during checkin/checkout
  requireSerial?: boolean;
  // Require confirming expiration date matches during verification (month/year format)
  requireExpirationConfirmation?: boolean;
  // Minimum O2 PSI required for oxygen tanks
  requireO2PsiMin?: number;
  // If true, violations are advisory warnings only (not blocking)
  advisoryOnly?: boolean;
}

// Custom admin-configurable warning for statpack items (shown during checkout)
export interface StatpackWarning {
  id: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
  /** When true, the person checking out must acknowledge this warning before proceeding */
  requiresAcknowledgment?: boolean;
}

export interface StatpackItem {
  itemId: string;
  itemDetails?: InventoryItem;
  variantId?: string;
  variantName?: string;
  requiredQuantity: number; 
  currentQuantity: number; 
  pocket?: StatpackPocket; 
  compartmentId?: string;
  // CRITICAL: StatpackItem must reference a specific batch (not just item)
  batchId: string; // REQUIRED - cannot add generic item, must specify batch
  // If this statpack contains a serialized asset/unit, record the specific serial
  // For serialized items (AEDs, oxygen tanks, etc.), this is the unique identifier
  // that links to InventoryItem.assetSerial or InventoryItem.assets[].serial
  serialNumber?: string;
  // Optional: link to a specific asset instance ID for direct asset assignment at the statpack item level
  assetInstanceId?: string;
  expirationDate?: Date; // Derived from batch for UI convenience
  lotNumber?: string; // Derived from batch for UI convenience
  effectiveExpiration?: Date; // Computed from batch.expirationDate or batch.openDate + daysValid
  // Convenience flag copied from linked `InventoryItem`/variant to indicate expirations must be confirmed
  requiresExpirationCheck?: boolean;
  // Per-item value for computing total statpack asset value
  itemValue?: number;
  // Optional verification rules for this specific statpack item (admin-configurable)
  verificationRules?: AssetVerificationRules;
  // Admin-configurable custom warnings shown during checkout (e.g., "Verify glucose strips match glucometer brand")
  customWarnings?: StatpackWarning[];
}

export interface Statpack {
  id: string;
  name: string;
  type: 'Primary' | 'Secondary' | 'Event Bag';
  status: 'Ready' | 'Restock Needed' | 'Expired Items' | 'CRITICAL - EXPIRED ITEMS' | 'In Use' | 'Pending Initial Check';
  compartments: StatpackCompartment[];
  contents: StatpackItem[];
  isCheckedOut: boolean;
  assignedToUserId?: string;
  assignedToUserName?: string;
  checkedOutAt?: Date;
  lastCheckedBy?: string;
  lastCheckedAt?: Date;
  /** Last full audit (biweekly cadence) — set only by mode=audit check-offs */
  lastAuditAt?: Date;
  lastAuditBy?: string;
  /** Last admin edit of expected contents; drives the "contents changed since last audit" indicator */
  contentsUpdatedAt?: Date;
  /** Human-readable event name this pack is currently deployed for (checkout → In Use). */
  currentEvent?: string;
  /** `events` doc id backing `currentEvent`; cleared on check-in. */
  currentEventId?: string;
  /**
   * @deprecated Legacy flat list of linked exchange bag ids. Superseded by
   * `exchangeBagAssignments` (pocket-aware). Never read this directly — use
   * `resolveBagAssignments(pack)` (app/lib/exchange-bags.ts), which shims a
   * legacy array into `{ bagId, pocket: 'main', qtyPerPack: 1 }` entries.
   * Kept declared (not removed) so old docs still type-check; no migration
   * script writes this away.
   */
  exchangeBagIds?: string[];
  /** Pocket-aware exchange bag assignments. Source of truth going forward. */
  exchangeBagAssignments?: ExchangeBagAssignment[];
  /** Pack-level sharps container safety check, stamped on each check-off */
  sharpsContainer?: {
    status: 'ok' | 'full' | 'na';
    lastCheckedAt?: Date;
    lastCheckedBy?: string;
  };
  
  createdAt: Date;
  updatedAt: Date;
  
  // Statpacks are ALWAYS treated as high-value assets in EMS logistics
  // This field represents the total value of the statpack container + all contents
  // Should be computed/updated whenever contents change
  assetValue?: number; // Computed: sum of contents' itemValue * quantity
  currentLocation?: string; // Physical location (e.g., "Vehicle 1", "Storage Room A")
  assetSerial?: string; // Unique serial/tag for the statpack container itself
  
  maintenance_logs?: Array<{
    id?: string;
    timestamp?: Date;
    serviceType: string;
    reason?: string;
    technician?: string;
    notes?: string;
    status: 'pending' | 'in-progress' | 'completed';
    completedAt?: Date;
  }>;
}

// --- EXCHANGE BAGS (two-bin / kanban swap system) ---
/** One SKU line within a multi-SKU Exchange Bag. */
export interface ExchangeBagLine {
  itemId: string;
  itemName: string;
  qtyPerBag: number;
}

/**
 * Pre-stocked multi-SKU bag staged for grab-and-go exchange (e.g. a bandaid
 * bag, glove kit, paper-PCR stack). Crews take a FULL bag and drop the EMPTY;
 * empties are refilled from back-room reserve (`consumeReserveUnits`) and
 * re-staged. See `app/lib/exchange-bags.ts`.
 */
export interface ExchangeBag {
  id: string;
  name: string;
  /** `restock_categories` doc it belongs to, if any. */
  categoryId?: string;
  /**
   * Structured zone → shelf → level → container ref — the SOURCE OF TRUTH for
   * where this bag design is staged. See the location-model invariant in
   * CLAUDE.md: `shelfId` below is a denormalized mirror written FROM
   * `storageLocation.shelfId`, never the reverse.
   */
  storageLocation?: StorageLocationRef;
  /** Denormalized mirror of `storageLocation?.shelfId` — never write directly. */
  shelfId?: string;
  /** Multi-SKU contents of one bag. */
  lines: ExchangeBagLine[];
  /** Full bags staged on the shelf. */
  fullCount: number;
  /** Empties awaiting refill. */
  emptyCount: number;
  /** Desired full-bag count. */
  parBags?: number;
  /**
   * When true, this bag design ships with a tamper-evident seal and the
   * statpack check-off flow uses the binary seal reflex (intact → done,
   * broken → replace) instead of counting contents.
   */
  sealRequired?: boolean;
  /** Optional seal number prefix printed on the label / used for reference (e.g. "BB-"). */
  sealPrefix?: string;
  createdAt?: Date | FieldValue;
  updatedAt?: Date | FieldValue;
  updatedBy?: string;
}

/** Pocket-level assignment linking an Exchange Bag design to a statpack. */
export interface ExchangeBagAssignment {
  bagId: string;
  pocket: StatpackPocket;
  qtyPerPack: number;
}

// --- LOGGING & ISSUES ---

/** Issue recorded for a specific item during statpack checkout/checkin (NOT the global IssueReport) */
export interface StatpackItemIssue {
  itemId: string;
  itemName: string;
  issueType: 'missing' | 'expired' | 'damaged' | 'other';
  isReplaced: boolean;
  replacedQuantity: number;
  newExpirationDate?: string;
  notes: string;
}

export interface StatpackLog {
  id?: string;
  statpackId: string;
  statpackName: string;
  action: 'checkout' | 'checkin' | 'restock' | 'created' | 'maintenance' | 'audit' | 'content_edit';
  pairId?: string; // Explicit pairing between checkout + checkin
  quickCheckin?: boolean; // True when member used quick check-in (no items used)
  /** Event this checkout was for (set on checkout, carried onto the paired checkin). */
  eventId?: string;
  eventName?: string;
  userId: string;
  userName: string;
  timestamp: Date | FieldValue;
  clientTimestamp?: Date; // Client-side time for immediate display
  notes?: string;
  mismatchResolutions?: MismatchResolution[];
  validationWarnings?: ValidationWarning[];
  
  // Summary statistics for admin audit review
  summary?: {
    totalItems: number;
    verifiedCount: number;
    mismatchCount: number;
    expiredCount: number;
    restockedCount?: number; // Items that were restocked during check-in
    shelfEmptyCount?: number; // Items where restock shelf was empty
    reportedCount?: number; // Items the member filed an issue report on
  };

  // Pack-level sharps container safety check submitted with this check-off
  sharpsCheck?: { status: 'ok' | 'full' | 'na'; notes?: string };
  
  // Digital Check-Off: structured per-item check entries
  checkEntries?: {
    itemId: string;
    itemName?: string;
    batchId?: string;
    compartmentId?: string;
    pocket?: StatpackPocket;
    requiredQuantity: number;
    countedQuantity: number; // Actual count during check
    ok: boolean; // true if countedQuantity >= requiredQuantity
    serialNumber?: string; // For asset items
    notes?: string;
    expirationDate?: Date | FieldValue;
    /** Freshly entered/confirmed expiration persisted onto the pack content */
    newExpirationDate?: Date | FieldValue;
    /** Oxygen tank PSI reading recorded during the check */
    oxygenPsi?: number;
    /** Regulator visual check passed */
    regulatorOk?: boolean;
    /** Member acknowledged a short/expired item and chose to proceed */
    acknowledged?: boolean;
    acknowledgeReason?: string;
    /** Member reported a problem with this item (spawns an issue_report) */
    issue?: { type: 'missing' | 'broken' | 'expired'; quantity?: number; notes?: string };
    checkedAt?: Date | FieldValue;
    checkedBy?: string;
    // Per-asset condition tracking (only for serialized/asset items)
    assetCondition?: 'Good' | 'Minor Issue' | 'Major Issue' | 'Needs Maintenance';
    assetCheckResult?: {
      batteryStatus?: 'Good' | 'Low' | 'Unknown';
      batteryPct?: number;
      padsSealed?: boolean;
      oxygenPsi?: number;
      notes?: string;
    };
    // Restock tracking during check-in: what the member did when an item was short
    restockStatus?: 'restocked' | 'shelf_empty' | 'not_needed';
    restockNotes?: string; // Free-text note about restock attempt
  }[];
  
  // Detailed Issue Tracking
  issues?: {
      sealChecks?: Record<string, { sealed: boolean; sealNumber?: string; expiration?: Date }>;
      oxygenReadings?: Record<string, string>;
      issueReports?: Record<string, StatpackItemIssue>;
      verifiedCount?: number;
      /** Exchange bag seal reflex results captured on this check-off, keyed by bagId. */
      bagChecks?: Record<string, { sealIntact: boolean; resolution?: 'swapped' | 'replaced'; notes?: string }>;
  };
  
  // Legacy/Simple tracking
  itemsUsed?: Record<string, number>; 
}

export interface MismatchResolution {
  key: string; // item id or AED field key
  entered?: string;
  system?: string;
  acknowledged: boolean;
  resolvedBy?: string;
  resolvedAt?: Date | FieldValue;
  note?: string;
}

export interface ValidationWarning {
  warningType:
    | 'missing_asset'
    | 'unassigned_asset'
    | 'assigned_mismatch'
    | 'asset_status'
    | 'asset_expired'
    | 'other';
  severity?: 'critical' | 'warning' | 'info'; // critical = blocks submission, warning/info = informational only
  itemId?: string;
  itemName?: string;
  serialNumber?: string;
  currentAssignedTo?: string | null;
  message: string;
}

export interface AssetCheckResult {
  itemId: string;
  itemName: string;
  serialNumber?: string;
  measuredBatteryPct?: number; // 0-100
  measuredO2Psi?: number;
  condition: 'Good' | 'Minor Issue' | 'Major Issue' | 'Needs Maintenance';
  expirationWarnings: ValidationWarning[];
  checkedAt: Date;
  checkedBy: string;
  checkedByName: string;
  notes?: string;
  dueNextDate?: Date;
  actionRequired: boolean;
}

export interface StatpackAuditResult {
  statpackId: string;
  statpackName: string;
  contentChecks: Array<{
    itemId: string;
    itemName: string;
    serialNumber?: string;
    requiredQuantity: number;
    foundQuantity: number;
    inCorrectPocket: boolean;
    conditionOk: boolean;
    expirationOk: boolean;
    notes?: string;
  }>;
  validationWarnings: ValidationWarning[];
  condition: 'Ready' | 'Issues Found';
  checkedAt: Date;
  checkedBy: string;
  checkedByName: string;
  overallNotes?: string;
  actionRequired: boolean;
}

// Per-asset instance metadata for serialized items (e.g., AEDs)
export interface AssetInstance {
  serial: string;
  // Unique asset identifier (asset tag or barcode). May differ from manufacturer `serial`.
  id?: string;
  assetTag?: string;
  // Barcode and QR code for scanning asset checkout/checkin (either or both)
  barcode?: string;
  qr?: string;
  // External barcode assigned from purchased asset tags (can replace or supplement generated codes)
  assignedBarcode?: string | null;
  // History of all barcode assignments/reassignments for audit trail (append-only)
  barcodeHistory?: Array<{
    value: string;
    assignedAt: Date | FieldValue;
    assignedBy?: { id?: string; name?: string };
  }>;
  status?: 'Ready' | 'Not Ready' | 'Maintenance' | 'In Use' | 'Checked Out' | 'Unknown';
  // Consumable components attached to the device
  padExpiration?: Date;
  batteryExpiration?: Date;
  lastServiceDate?: Date;
  lastChecked?: Date;
  // Convenience flattened check fields (preferred for UI):
  batteryStatus?: 'Good' | 'Low' | 'Unknown';
  padsSealed?: boolean;
  lastCheckNotes?: string;
  // For oxygen tanks: measured PSI at last check
  oxygenPsi?: number;
  // Optional fields for derived next expiration (pads/battery replacement window)
  nextExpiration?: Date;
  // Per-instance expiration date (useful for disposables stored as instances, e.g., EpiPens)
  expirationDate?: Date;
  // Checkout tracking
  checkedOutAt?: Date | FieldValue;
  checkedOutBy?: string; // User ID of member who checked out this asset
  lastCheckedInAt?: Date | FieldValue;
  lastCheckedInBy?: string; // User ID of member who checked in this asset
  checks?: {
    batteryStatus?: 'Good' | 'Low' | 'Unknown';
    padsSealed?: boolean;
    notes?: string;
  };
  // Container or statpack this asset instance is assigned to.
  // Tracks the "home" location for accountability (e.g., 'statpack-primary-1' or 'vehicle-3').
  // When checking in/out, verify this matches the expected statpack/container.
  assignedToId?: string;
  // Current human-friendly location or container id (e.g., 'Statpack-1' or 'Back Room')
  currentLocation?: string;
  /** Training / non-deployable gear (trainer AEDs, manikins) — still tracked as an asset but must not be dispatched */
  isTrainer?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

// --- STORAGE / CONTAINERS ---
export interface StorageZone {
  id: string;
  name: string;
  locationType: LocationType;
  room?: HQRoom;
  description?: string;
  /** Building floor this zone is on: upper = entrance level, lower = main HQ */
  level?: 'upper' | 'lower';
  createdAt?: Date;
  updatedAt?: Date;
}

export interface Shelf {
  id: string;
  name: string;
  zoneId?: string | null;
  capacity?: number | null;
  barcode?: string | null;
  /** Number of levels/rows on this shelf (e.g., 4 for a 4-tier shelf) */
  numberOfLevels?: number;
  /** Optional label per level (e.g., ["Top", "Middle", "Bottom"]) */
  levelLabels?: string[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface Container {
  id: string;
  name: string;
  shelfId?: string | null;
  barcode?: string | null;
  // Sealed Box / Container Logic (for student workflow accountability)
  isBox?: boolean; // When true, treat as a sealed box with fixed contents
  isSealed?: boolean;
  sealNumber?: string; // Tamper-evident seal id or sticker number
  sealedAt?: Date;
  sealedBy?: string; // userId of person who sealed
  sealedByName?: string;
  // Contents of the sealed box: itemId + batchId + quantity (assumes unchanged until unopened)
  boxContents?: {
    itemId: string;
    batchId: string;
    quantity: number;
    serialNumber?: string; // For serialized/asset items
  }[];
  // Purchase tracking for sealed boxes (when received)
  purchase?: PurchaseInfo;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface BoxLog {
  id?: string;
  boxId: string;
  action: 'sealed' | 'unsealed' | 'inventory_check' | 'break_seal';
  userId: string;
  userName?: string;
  timestamp: Date | FieldValue;
  sealIntact?: boolean; // true if seal was verified intact, false if broken
  notes?: string;
  itemsCounted?: Record<string, number>; // If seal was broken, what was counted
}

// Inventory log events (e.g., asset checkout/checkin, box consumption, restocking)
export interface InventoryLog {
  id?: string;
  itemId?: string; // The inventory item this log refers to
  itemName?: string;
  action: string; // 'asset_checkout', 'asset_checkin', 'consume_box', 'create_open_batch', etc.
  serialNumber?: string; // For single-serial events
  serials?: string[]; // For multi-serial events
  batchId?: string;
  quantity?: number;
  boxCount?: number;
  unitsAdded?: number;
  beforeUnopenedBoxes?: number;
  afterUnopenedBoxes?: number;
  userId?: string;
  userName?: string;
  timestamp: Date | FieldValue; // Server timestamp of the event
  location?: string; // Where the action took place or asset was located
  notes?: string; // Additional context/reason
  newStatus?: string; // For status change events
  details?: Record<string, any>; // Catch-all for additional event data
}

// --- BUY LIST (Admin Shopping List) ---
export interface BuyListItem {
  id?: string;
  itemName: string;
  quantity?: number;
  unit?: string; // 'boxes', 'each', 'cases', etc.
  category?: ItemCategory | string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  notes?: string;
  /** Optional link to existing inventory item */
  linkedInventoryId?: string;
  status: 'pending' | 'ordered' | 'received';
  addedBy: string; // userId
  addedByName?: string;
  addedAt: Date | FieldValue;
  orderedAt?: Date | FieldValue;
  receivedAt?: Date | FieldValue;
  completedBy?: string;
  completedByName?: string;
}

// --- BUG REPORTS & ISSUE TRACKING ---

// --- LOGISTICS TASK LIST ---
export type TaskCategory = 'buy' | 'fix' | 'restock' | 'admin' | 'other';
export interface TaskItem {
  id?: string;
  title: string;
  description?: string;
  /** Acceptance criteria — what must be true for this task to count as done */
  definitionOfDone?: string;
  category: TaskCategory;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  /** Legacy docs may contain 'todo'; readers normalize it to 'backlog' (see app/tasks/page.tsx) */
  status: 'backlog' | 'this_cycle' | 'in_progress' | 'blocked' | 'done';
  /** For buy-type tasks: quantity and unit */
  quantity?: number;
  unit?: string;
  /** Optional link to inventory item */
  linkedInventoryId?: string;
  /** Optional link to buy list item */
  linkedBuyListId?: string;
  /** Who created it */
  createdBy: string;
  createdByName?: string;
  assignedTo?: string;
  assignedToName?: string;
  dueDate?: Date | null;
  completedAt?: Date | FieldValue | null;
  completedBy?: string;
  completedByName?: string;
  createdAt: Date | FieldValue;
  updatedAt?: Date | FieldValue;
  notes?: string;
}

// --- TEAM TASK BOARD (Logistics Committee) ---
export type TeamTaskStatus =
  | 'backlog' | 'this_cycle' | 'in_progress' | 'blocked' | 'done';

/** One owner of a team task (owners are admins/quartermasters). */
export interface TeamTaskOwner {
  id: string;                     // users/{uid}
  name: string;                   // denormalized fullName
}

/** A progress note appended to a task's timeline. */
export interface TeamTaskUpdate {
  id: string;
  text: string;
  authorId: string;
  authorName: string;
  // Timestamp.now() on write — serverTimestamp() is rejected inside array elements.
  createdAt: Date | Timestamp;
}

/** A checklist item within a task. */
export interface TeamSubtask {
  id: string;
  text: string;
  done: boolean;
}

export interface TeamTask {
  id?: string;
  title: string;
  owners: TeamTaskOwner[];        // one or more admins/quartermasters
  /** @deprecated legacy single-owner fields — read-only, kept for back-compat */
  ownerId?: string;
  ownerName?: string;
  status: TeamTaskStatus;
  definitionOfDone: string;
  dueDate?: Date | null;
  /** Progress notes, oldest→newest */
  updates?: TeamTaskUpdate[];
  /** Checklist / todo items within the task */
  subtasks?: TeamSubtask[];
  createdBy: string;
  createdByName: string;
  createdAt: Date | FieldValue;   // serverTimestamp() on write
  /** Stamped when the card enters 'done'; cleared if it leaves */
  completedAt?: Date | FieldValue | null;
  completedBy?: string;
  completedByName?: string;
  /** optional, carried from migrated plain tasks */
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  /** optional, carried from migrated plain tasks */
  category?: string;
  /** optional, carried from migrated plain tasks */
  quantity?: number;
  /** optional, carried from migrated plain tasks */
  unit?: string;
  /** optional, carried from migrated plain tasks */
  notes?: string;
}

export interface IssueReport {
  id?: string;
  reporter: {
    userId: string | null;
    userName?: string | null;
    userEmail?: string | null;
    isAnonymous?: boolean;
  };
  target?: {
    collection?: string; // 'inventory', 'statpack', etc.
    docId?: string;
  };
  type: 'bug' | 'feedback' | 'improvement' | 'question';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'open' | 'triaged' | 'in_progress' | 'resolved' | 'closed';
  title: string;
  description: string;
  reproductionSteps?: string[];
  pagePath?: string; // Route or UI area where issue was reported
  component?: string; // Component name or ID
  assignedTo?: {
    userId?: string;
    userName?: string;
  } | null;
  comments?: Array<{
    commentId?: string;
    by: {
      userId: string;
      userName?: string;
    };
    message: string;
    timestamp: Date | FieldValue;
  }>;
  attachments?: Array<{
    name: string;
    url: string;
  }>;
  linkedAuditId?: string; // Reference to an auditEvents doc
  createdAt: Date | FieldValue;
  updatedAt: Date | FieldValue;
}

// --- MEDICATION CABINET TRACKING ---
// Mirrors a 911 EMS agency medical cabinet with strict chain-of-custody

export interface MedicationLog {
  id?: string;
  medicationId: string; // Reference to InventoryItem.id
  medicationName: string;
  action: 'check_out' | 'check_in' | 'administered' | 'wasted' | 'expired_disposal' | 'inventory_count' | 'received';
  /** Lot number of the specific unit transacted */
  lotNumber: string;
  /** Expiration date of the specific unit */
  expirationDate: Date;
  /** Quantity transacted (e.g., 1 vial, 2 ampules) */
  quantity: number;
  /** Running count after this transaction (like a paper narcotic log) */
  runningCount: number;
  /** Who performed the action */
  performedBy: {
    userId: string;
    userName: string;
  };
  /** Witness/cosigner for controlled substances */
  witness?: {
    userId: string;
    userName: string;
  };
  /** Where the medication was taken from or returned to */
  location?: string;
  /** Reason for wasting / administering */
  reason?: string;
  /** Patient care report number (if administered) */
  pcrNumber?: string;
  /** General notes */
  notes?: string;
  /** Concentration / dosage info confirmed during transaction */
  concentration?: string;
  /** Route confirmed (IM, IV, SQ, etc.) */
  route?: string;
  timestamp: Date | FieldValue;
}

// --- VEHICLES ---
// Individual fleet vehicles (roster docs in `vehicles`). Vehicle TYPES stay in
// org config (`VehicleDef` in app/config/org-config.ts); `Vehicle.typeId`
// references a VehicleDef.id.

export type VehicleStatus = 'active' | 'retired';

export interface Vehicle {
  id?: string;
  /** "Ambulance 2", "UTV-1" */
  name: string;
  /** VehicleDef.id from org config ('ambulance' | 'utv' | 'ebike' | …) */
  typeId: string;
  status: VehicleStatus;
  notes?: string;
  /** Live checkout state — AUTHORITATIVE; the open vehicle_logs doc mirrors it
   *  (both written in one transaction, statpack pattern). */
  isCheckedOut: boolean;
  /** Open vehicle_logs doc id while checked out; O(1) check-in lookup */
  activeLogId?: string | null;
  assignedToUserId?: string | null;
  assignedToUserName?: string | null;
  checkedOutAt?: Date | FieldValue | null;
  /** Last known readings, denormalized FROM the latest closed log */
  lastMileage?: number | null;
  /** 0 | 25 | 50 | 75 | 100 (E / ¼ / ½ / ¾ / F) */
  lastFuelLevel?: number | null;
  /** 0–100 % */
  lastBatteryLevel?: number | null;
  createdAt?: Date | FieldValue;
  createdBy?: string;
  updatedAt?: Date | FieldValue;
  retiredAt?: Date | FieldValue | null;
  retiredBy?: string | null;
}

/** Pre- or post-shift readings; which fields apply comes from the vehicle
 *  type's reading fields (getReadingFieldsForVehicleType in org-config). */
export interface VehicleShiftReadings {
  mileage?: number;
  /** 0 | 25 | 50 | 75 | 100 (E / ¼ / ½ / ¾ / F) */
  fuelLevel?: number;
  /** 0–100 % */
  batteryLevel?: number;
}

export type VehicleLogStatus = 'open' | 'closed' | 'force_closed';

/** One document per shift in `vehicle_logs`: created 'open' at checkout with
 *  pre-readings, completed at check-in with post-readings. Abandoned shifts
 *  stay visibly 'open' until an admin force-closes them. */
export interface VehicleLog {
  id?: string;
  vehicleId: string;
  /** Snapshot at checkout — history stays readable after rename/retire */
  vehicleName: string;
  /** Snapshot at checkout */
  vehicleTypeId: string;
  status: VehicleLogStatus;
  driverUserId: string;
  driverName: string;
  /** Free-text team member names */
  crewNames?: string[];
  checkoutAt: Date | FieldValue;
  /** Client-side time for immediate display (StatpackLog.clientTimestamp pattern) */
  checkoutClientAt?: Date;
  checkinAt?: Date | FieldValue | null;
  checkinClientAt?: Date | null;
  /** Who closed the log (driver or admin) */
  checkinUserId?: string | null;
  checkinUserName?: string | null;
  preReadings?: VehicleShiftReadings;
  postReadings?: VehicleShiftReadings;
  /** NEW damage noted at checkout (free text; also files an issue report) */
  preDamage?: string | null;
  /** NEW damage noted at check-in (free text; also files an issue report) */
  postDamage?: string | null;
  /** Required note when checkout mileage ≠ vehicle.lastMileage */
  mileageMismatchAck?: string | null;
  notes?: string;
  /** Set with status 'force_closed' by an admin */
  forceCloseReason?: string | null;
}

/** Medication-specific fields added to InventoryItem when isMedication is true */
export interface MedicationInfo {
  /** Whether this is a controlled substance */
  isControlled?: boolean;
  /** DEA schedule (II, III, IV, V) if controlled */
  deaSchedule?: 'II' | 'III' | 'IV' | 'V';
  /** Drug concentration (e.g., "1mg/1mL", "0.3mg auto-injector") */
  concentration?: string;
  /** Administration route (IM, IV, SQ, PO, IN, etc.) */
  route?: string;
  /** Storage requirements (e.g., "Room temp", "Refrigerate 2-8°C", "Protect from light") */
  storageRequirements?: string;
  /** Whether a witness/cosigner is required for all transactions */
  requiresWitness?: boolean;
  /** Minimum stock level for this medication (triggers alert) */
  parLevel?: number;
  /** National Drug Code */
  ndcNumber?: string;
}