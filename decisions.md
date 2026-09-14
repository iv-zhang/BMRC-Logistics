# DECISIONS — BMRC Logistics design log

The **why** behind the deliberate design choices in this repo. CLAUDE.md says *how*
the code is shaped; this file records *why* it is shaped that way, so a future change
doesn't quietly undo a decision that was made on purpose. When a decision here conflicts
with an instinct to "fix" something, treat it as a **stop-and-ask** signal, not a bug.

Cross-references: [invariants.md](invariants.md) (the spec), [FINDINGS.md](FINDINGS.md)
(gap analysis + resolution status), [MODEL.md](MODEL.md) (data shapes),
[CLAUDE.md](CLAUDE.md) (architecture / how-to).

Conventions: each entry is **Decision → Why → Consequences / do-not-regress**. Dates are
absolute. "Deferred" means a schema decision is intentionally open, not forgotten.

---

## Guiding principles (the lens for every decision below)

BMRC members are volunteers, not data-entry users. The realistic failure is a **skipped,
late, or approximate** action — never a malicious one. Three principles follow, and every
decision below serves one of them:

1. **Fail safe, not optimistic.** Missing / unknown / stale data resolves to *not
   available* / *not service-ready*, never green.
2. **Derive, don't assert.** Availability, expiry, readiness, and lateness are *computed*
   from underlying state (lots, maintenance, timestamps), never a bare checkbox.
3. **Assume lossy input.** Any step a member can skip needs a reconciliation / exception /
   re-anchor surface that catches the skip later.

---

## Data model & inventory

### D-1 — Configuration is data, not code
**Decision:** Org configuration (locations, rooms, vehicles, asset categories + checks,
statpack types + pockets, item categories, thresholds, events/venues) lives in one
Firestore doc `org_settings/current`, edited through the form-based `/settings` UI. Code
holds only `DEFAULT_ORG_CONFIG` (seed + type source) in `app/config/org-config.ts`.
**Why:** rebranding for another agency, moving HQ, or retuning thresholds must not require
a deploy or a developer. Non-technical admins/quartermasters own this.
**Do not regress:** pure lib reads live values via getters (`getThresholds()`, etc.);
components use `useOrgConfig()`. Never import the frozen constants for live reads, and
never read config at module scope (it won't be reactive). `VERIFICATION_FIELDS` and
`ROLES` are the only code-owned config.

### D-2 — One central `inventory` collection, no separate `assets`
**Decision:** consumables, assets, oxygen, and medications are all `inventory` docs
discriminated by flags; `determineIsAsset` treats an item as an asset on *any* asset
signal (serial, status, category, `assets[]`, `maintenance_logs`, `isOxygen`), not just
`assetValue ≥ threshold`.
**Why:** the same physical thing can be both a consumable and a tracked asset; one
collection avoids cross-collection joins and split-brain writes.

### D-3 — Structured location is the single source of truth; legacy fields are mirrors
**Decision:** `storageLocation: StorageLocationRef` (zone→shelf→level→container) is
canonical. `location` / `room` / asset `currentLocation` are **denormalized mirrors** kept
in sync *from* the structured ref, never the reverse.
**Why:** legacy string filters still work while the structured model drives everything;
one write path prevents the two from disagreeing.
**Do not regress:** moves resolve the destination zone and rewrite the mirrors; renaming a
zone/shelf/container propagates the new name to every referencing item; deleting a
shelf/container clears dangling refs first (never orphans). See CLAUDE.md "Location Model".

### D-4 — Two-pool stock: back reserve drives status, front shelf is a re-anchor
**Decision:** every consumable splits into **back reserve** (batches/boxes — the ONLY pool
that drives `getItemStatus` and reordering) and **front shelf** (`shelfQuantity` — the
deployed pool members grab from). The shelf is **not event-tracked**; roughly weekly a
physical count **re-anchors** `shelfQuantity` to reality (`lastShelfCheckAt`).
**Why:** general members won't reliably log every unit taken off a shelf (Principle 3), so
instrumenting consumption would produce false precision. A full shelf over an empty reserve
must still read `out` — the shelf is never a substitute for reserve (Principle 1).
**Do not regress:** `refillShelf()` is a **transfer** (reserve→shelf via FEFO
`consumeReserveUnits`), never stock creation. This axis is **distinct** from the deferred
class-vs-field pool gap (D-11) — do not conflate them.

### D-5 — Zero-stock (tombstone) batches never mark an item expired
**Decision:** expiry checks in `getItemStatus` / `generateAuditSnapshot` ignore
`stock: 0` batches.
**Why:** a depleted lot's old date would otherwise pin an item as permanently expired.

### D-6 — Monthly audit is derived from `lastAuditDate`, not a sticky boolean
**Decision:** an item is "verified" only if `lastAuditDate` falls in the current calendar
month (`isAuditedThisMonth`); the `auditVerified` flag must not be trusted alone.
**Why:** Principle 2 — a boolean set once stays true forever; a date-in-window recomputes
every month.

---

## Audits & statpacks

### D-7 — The audit workbench is deliberately orderless
**Decision:** `/audit` has no linear wizard. Members act on whatever is physically in front
of them, in any order, via a per-item action drawer (Count / Move / Shipment / Report /
Fixed).
**Why:** a forced sequence doesn't match how a volunteer works a physical shelf; it invites
skipping and fudging (Principle 3). Every action writes the inventory change + an
`inventory_logs` row + an `auditEvents` ledger entry so usage metrics stay derivable.

### D-8 — Statpack check-off persists state; pack status is derived
**Decision:** `logStatpackCheckOff` writes the pack (not just a log row) in one
transaction. `StatpackItem.currentQuantity` is the source of truth for on-hand
consumables; pack `status` is **derived** on check-in/audit (expired/reported → `Expired
Items`; short-not-restocked or sharps full → `Restock Needed`; else `Ready`; checkout →
`In Use`), never hardcoded `Ready`.
**Why:** a depleted pack the last crew didn't restock must show depleted to the next crew
(Principle 1). Restock sets `currentQuantity` back to par — there's no linked shelf count;
back-room→shelf replenishment is a human process caught by the next crew or admin audit.
Checkout enforces **fix-or-acknowledge** on expired/short items.

**Amended 2026-09-11 — partial shortages don't block Ready; admin override.** Only a
required consumable counted at **0** (not restocked) derives `Restock Needed`; an item that
is short but not empty (e.g. 1 of 2) leaves the pack `Ready`. *Why:* the checkout list only
offers `Ready` packs, so one missing roll of tape was pulling a deployable pack out of
service. The shortage isn't lost — it stays visible as a "Needs restock · N" chip derived
from persisted `contents[].currentQuantity` (`getPackShortages`,
`app/lib/statpack-shortages.ts`), never a stored flag that could go stale. Admins/QMs can
also **override** a not-ready pack to `Ready` (`overrideStatpackReady`, stamps
`Statpack.readyOverride` with who/when/note + a snapshot of what was missing). The override
is **one-shot**: any subsequent check-off clears it and re-derives. It is refused for
`Expired Items` (replace, don't override) and for checked-out packs. Checkout still asks
members to fix-or-acknowledge short items.

### D-9 — One shared check-off page for checkout / check-in / audit
**Decision:** all three modes share `app/statpacks/check-off/page.tsx`, driven by `?id` +
`?mode` query params. Audit mode logs `action: 'audit'` and stamps `lastAuditAt`/`By`
without taking ownership.
**Why:** one verification flow, one place for the pocket-by-pocket logic. The retired
`statpack-checkoff-modal.tsx` survives only for the `maintenance` mode the page lacks.

### D-10 — Static export forces static-route + query-param navigation
**Decision:** `output: export`; pack IDs are Firestore runtime IDs unknown at build time,
so dynamic `[id]/checkoff` routes cannot exist. Always navigate to
`/statpacks/check-off?id=<packId>&mode=<mode>`.
**Why:** a static export can only prerender routes known at build time. This constraint
also rules out server-side mail (see D-16).

---

## Deferred schema decisions (do not silently "fix")

Both are tracked in FINDINGS.md / invariants.md. If a task touches either, **flag it and
ask** — changing it blindly changes how on-hand counts are computed.

### D-11 — No stock-pool axis (class-use vs field/event) — DEFERRED
**Status:** open. There is one stock dimension; "class draws must not deplete field stock"
cannot be expressed today.
**Why deferred:** needs a `pool` axis decision tied to how real HQ stock is entered — is a
SKU one pool split by location, or genuinely separate stock? Decide alongside D-12 when
modeling real inventory.

### D-12 — No per-lot quantity for box-tracked SKUs — DEFERRED
**Status:** open. Box-tracked items pool quantity onto the scalar `unopenedBoxes` with a
`stock: 0` metadata batch standing in for the lot; per-lot on-hand doesn't exist for them.
**Why deferred:** giving box-tracked items real per-lot quantities changes on-hand math
right before real values are loaded. Decide together with D-11.

---

## Events / shift-signup system (added 2026-07-25)

Full mechanics live in the `events-shift-signup-feature` memory and the code
(`app/lib/events.ts`, `app/components/events/*`, `/events`, `/roster`). The load-bearing
*decisions*:

### D-13 — `medops` is a reduced-admin role, deliberately NOT covered by `isAdmin`
**Decision:** `isAdmin = admin | quartermaster`. The event-manager gate is a separate
`isEventManagerRole(role)` = `admin | quartermaster | medops`. medops can manage events,
staff shifts, edit certs/roster status, and see the roster — but **never** logistics
surfaces (inventory, assets, storage).
**Why:** medical-operations leads need to run shifts without inheriting warehouse
authority. Folding medops into `isAdmin` would silently expose logistics.
**Do not regress:** never widen `isAdmin` to include medops; gate event/roster surfaces on
`isEventManagerRole`, not `isAdmin`.
**Amendment (2026-07-27):** the original rule said medops *never sees the attendance panel*.
That is reversed — medops now sees attendance and is one of the two roles that may edit it
**retroactively** (see D-29). This does not widen `isAdmin` and grants no logistics access;
attendance is event operations, which is exactly medops' remit.

### D-14 — Cert gating is expiry-date-only, with an org-config kill switch
**Decision:** `canSignUpForShifts` requires unexpired EMT **and** CPR (dates only, no doc
upload). `org_settings.requireCertsForShiftSignup` (default true) short-circuits all gating
when off. When on and no certs are entered, all signup is blocked *by design*, with an
inline amber reason on the disabled button.
**Why:** don't build document storage/verification for a volunteer org; a date is enough
and admins/medops clear it manually. The kill switch exists for rollout before certs are
seeded (Principle 1: default to blocked, not open).

### D-15 — Experience is auto-derived from the member profile, never a self-selected dropdown
**Decision:** removed the FTO/Returning/New `<Select>`. Experience is computed from
`User.memberStatus` (`new | probationary | general`, **defaults to `general`**) +
`User.joinedTerm`, editable in the roster modal by admin/quartermaster **or medops**.
Requests denormalize both fields; `formatMemberExperience` drives display. Eligibility:
FTO-role members can request FTO+EMT slots, everyone else EMT only (`canRequestRole`).
**Why:** a self-picked dropdown let an EMT claim FTO experience (Principle 2 — derive,
don't let the user assert). Bulk import of status/term from the roster spreadsheet is a
**future TODO** (seam left in roster); the manual editor bridges until then.

### D-16 — Attendance is a check-in stamp; lateness is derived, not a toggle
**Decision:** replaced the present/late toggle with a **check-in** model.
`AttendanceRecord = { checkedInAt?, shiftEndAt?, minutesLate?, exception?: 'no_show' |
'excused', ... }`. An FTO/admin taps **Check in** (stamps arrival = now) with an editable
"Arrived at" override for forgotten check-ins; **lateness is derived** by comparing arrival
to the event call time (`computeMinutesLate` vs `eventCallDateTime`) and stored as a
snapshot `minutesLate`. Attendance is gated to the **assigned FTO** or admin/quartermaster
— medops does not see the panel.
**Why:** Principle 2 — "how late" is a fact you compute from two timestamps, not a category
a human eyeballs. The stored snapshot lets profile/roster stats aggregate offline without
re-reading events.
**Addendum (2026-07-26):** once a member is **checked in**, the no-show/excused controls are
hidden (you can't mark an absence for someone who showed). Early departure is a boolean
`leftEarly?` on `AttendanceRecord` that reuses `shiftEndAt` as the departure stamp (no new
timestamp field); `recordAttendance` clears both when an exception is set or check-in is
cleared. `getMemberShiftStats` exposes `leftEarlyCount`.
**Amendment (2026-07-27) — times are stamped, never typed:** the "Arrived at" override input
is **gone from the live flow**. Whenever the FTO taps **Check in** *is* when the member
arrived; likewise **Check out** replaces the old "Left early" toggle — departure is the moment
the button is tapped, and `leftEarly`/`minutesEarly` are **derived** from it against
`eventEndDateTime` with **no grace window** (any departure strictly before the scheduled end
counts; both are left unset when the event has no `endTime`, since it's undeterminable). The
live path is `checkInMember` / `checkOutMember`; `recordAttendance` is now the manager-only
retro-edit path. **Why:** an editable arrival field was redundant with the button that already
knows the time, and a manual "left early" toggle re-introduced exactly the human-eyeballed
category D-16 set out to remove.

### D-17 — Shift hours end via an explicit action OR the statpack check-in
**Decision:** a shift ends when an FTO taps per-event **End shift** (`endEventShifts`) *or*
automatically when the FTO checks the pack back in — `logStatpackCheckOff` captures the
pack's `currentEventId` before clearing it and calls `endEventShifts` best-effort *outside*
the transaction. Hours = `shiftEndAt − checkedInAt`.
**Why:** the statpack check-in is the real end-of-shift moment, so tie hours to it; the
manual button covers shifts without a pack. Best-effort/outside-txn so an events failure
can never roll back the statpack check-in.

### D-18 — Test-role override is a full identity, and everything user-scoped keys on `effectiveUid`
**Decision:** `bmrc_test_identity` holds a seeded `__test_*` uid; `useUserRole` returns
that user's doc as effective `userData`/`role` while the real Firebase Auth session stays
underneath for writes. `useUserRole` exposes `effectiveUid = effectiveUserData?.id ??
user?.uid`; every user-scoped read/write (`events`, `history`, actor attribution) keys on
`effectiveUid`, **not** the raw auth uid.
**Why:** the earlier role-string override shared the real uid, so a test FTO could withdraw
the real user's EMT request — the identities weren't actually separate. Scoping on
`effectiveUid` makes each `__test_*` identity see and act on only its own records. Seeded by
`seedTestUsers()`; history cleared manually per-identity via `clearTestIdentityHistory`.
**Do not regress:** new user-scoped queries must use `effectiveUid`; writes still run under
real auth (so permissive emulator rules aren't required in prod).

### D-19 — Notifications are in-app broadcasts; email is out of scope
**Decision:** `requestShift` and the `/events` notify modal write in-app `notifications`
docs (`broadcast` type) to managers + the team FTO. No email.
**Why:** static export (D-10) has no mail server. An email Cloud Function is a deferred
optional item, not a current requirement.

---

## Process decisions (workflow, not code)

### D-20 — Never commit or push unless explicitly asked
Make and verify changes in the working tree, report what changed, leave git to an explicit
instruction. Overrides any default "commit when done" behavior.

### D-21 — Verification is tiered; the emulator smoke driver is token-expensive
`tsc --noEmit` + lint on touched files after any change; `npm run build` + `npm run test`
before reporting a feature done; the `run-bmrc-logistics` emulator/Playwright smoke driver
**only** immediately before a commit or on explicit request. When the expensive tier hasn't
run, say so — report work as built-and-typechecked, not runtime-verified end-to-end.

### D-22 — Migration scripts run `--dry-run` first
Anything that writes live Firestore (`migrate:*`, `repair-event-dates.cjs`) runs dry first,
then `--force` only after the dry output is reviewed.

### D-23 — Plan-first, then delegate implementation to cheaper models
**Decision:** for any non-trivial change, produce an implementation plan and get it
**manually approved** before writing code, then implement approved changes via **Sonnet
and/or Haiku subagents at low/medium effort** on strictly non-overlapping file sets. Reserve
the top-tier model for planning, cross-file reasoning, and the integration/verification
pass. Skip the approval gate only for trivial one-liners or an explicit "just do it".
**Why:** planning and cross-file seams are where the expensive model earns its cost;
mechanical edits don't need it. Delegating the bulk of edits maximizes token efficiency
without sacrificing the review gate. Escalate only when a subagent reports it can't finish
within scope.
**Caveat (2026-07-26):** subagents can die mid-run (e.g. a shared session/usage limit). When
that happens the orchestrator implements the delegated edits directly rather than stall — the
approval gate and non-overlap discipline still apply.

### D-24 — The local emulator is the safe test environment; no cloud staging (yet)
**Decision:** role/permission/data testing happens on the **Firebase emulator**, not a cloud
project. `npm run dev:sandbox` boots firestore+auth emulators, seeds the dataset plus one
signed-in-able account per role (`admin@ / qm@ / member@ / fto@ / medops@bmrc.test`, password
`test1234`, via `scripts/emulator/seed-auth-user.ts`), then runs `dev:emulator`. Isolation is
guaranteed by `scripts/emulator/guard.ts` (hard-aborts on any prod-shaped config) + the
`demo-bmrc-logistics` project id; prod builds set none of the emulator env vars.
**Why:** the standard three-env model wants a separate cloud *staging* project, but creating
one needs the user's Firebase auth/billing (a user-run `firebase projects:create` step). The
emulator already delivers the load-bearing guarantee — "testing can never touch real
inventory/member data" — with zero cloud setup. Cloud staging is a deferred, optional layer.
**Do not regress:** never point the sandbox scripts at a non-`demo-*` project or a non-loopback
host; that's exactly what the guard exists to refuse. See [SANDBOX.md](SANDBOX.md).

---

## UI / interaction patterns (added 2026-07-26)

### D-25 — Pop-out panels are drawer or center; "dropdown" is an inventory-inline expansion
**Decision:** `PanelShell` (`app/components/panel-shell.tsx`) renders only two positions —
**drawer** (right sheet) or **center** (modal) — selected by `usePanelMode()`. The third user
preference, **dropdown**, is deliberately **not** a floating anchored overlay: an earlier
attempt greyed the page and never read as "part of the page." Instead PanelShell maps
`dropdown → center` for every surface, and **only the inventory list** implements a true inline
expansion — clicking a row expands the shared `renderItemDetail()` content *inline within the
list, pushing rows below it down* (accordion), gated on `mode === 'dropdown' && viewMode ===
'list'`. Table view + dropdown falls back to the centered panel. A `forceMode` prop pins a
surface regardless of preference (the event signup/management drawer uses `forceMode="modal"`,
because its team-card UI only works centered).
**Why:** a shared overlay component structurally can't push page rows (it renders after the
list, positioned `fixed`). A genuine inline dropdown is per-list work, so it's scoped to the
one surface the users actually asked for. Backdrop uses `bg-black/40` with **no**
`backdrop-blur` — a full-viewport backdrop-filter recomposites the page every frame and was the
source of the "laggy" pop-outs.
**Do not regress:** don't reintroduce an anchored floating "dropdown" overlay; don't add
`backdrop-blur` to the panel backdrop. New list surfaces that want inline expansion opt in
themselves — PanelShell stays drawer/center only.

### D-26 — The onboarding tour spotlights real anchors, skips what's absent, and never click-gates
**Decision:** `onboarding-tour.tsx` + `app/lib/tutorial-tours.ts` drive a role-aware tour that
spotlights elements matched by `data-tour="<key>"`. The **only** anchors are nav items
(`app-sidebar.tsx`, `mobile-bottom-nav.tsx`) plus the member dashboard's `checkout`/`checkin`
quick-action cards. A step whose target isn't present for the current role/viewport
**auto-skips** (so it's safe to list a superset). Every step advances via **Next** — the
dashboard step is no longer `click-target` (it stalled when the user was already on
`/dashboard`). While the tour runs it dispatches `bmrc-tour-active`/`-inactive` so the sidebar
rail stays pinned expanded, and the spotlight parent is `pointer-events-none` with clickable
dim strips so the highlighted element stays interactive.
**Why:** the tour can only meaningfully highlight things that are on screen for that
role/viewport; pointing at nav items a role doesn't have (e.g. a member's desktop rail has only
dashboard + profile) just skipped steps and looked broken. Anchoring the member flow to real
dashboard cards fixed the "skips tabs / highlights nothing" report.
**Do not regress:** add a `data-tour` anchor before adding a tour step that targets it; don't
use `click-target` (a no-op click on the current route never advances); keep the rail-pin +
pointer-events layering intact.

### D-27 — /stats is coded tiles on an arrangeable canvas, not a query builder
**Decision:** The stats page is a Tableau-style **dashboard**, not a Tableau-style **authoring
tool**. Each tile is a hand-written React component with one fixed query, registered in
`app/components/stats/tile-registry.tsx` and grouped into four dashboards (`procurement`,
`consumption`, `staffing`, `calls`). Users compose a dashboard by adding/removing/dragging/
resizing tiles from a catalog, and layouts persist per user with an org-published default
(`dashboards` collection, `app/lib/dashboards.ts`). What they **cannot** do is invent a new
tile: there is no field picker, no "Show Me" mark switcher, and no generic aggregation engine.
Selector logic lives in `app/lib/stats/{procurement,consumption,staffing,restock}.ts` — pure
functions of `(StatsData, StatsFilterState, tileId?)`. Charts are Recharts, wrapped once in
`app/components/stats/chart-kit.tsx` so every tile looks like one system.
**Why:** there are only so many meaningful ways to read this org's data, and a generic query
builder would have cost ~3x the code to let users assemble combinations that are mostly
meaningless. Hand-written tiles mean every number on screen has an author who thought about
what it means — and null-vs-zero is decided per metric rather than by a generic aggregator that
would render "no data" and "zero" identically.
**Load-bearing details:** cross-filtering is the one piece of Tableau interactivity kept — a
tile emits a `CrossFilter` and every OTHER tile narrows (the source tile highlights instead, per
`passesCrossFilters(..., own)`). A record lacking the filtered dimension is **not** excluded, so
a vendor filter can't blank an events chart. Per-dashboard role gating: `staffing`/`calls` use
`isEventManagerRole` (medops must reach them), `procurement`/`consumption` stay admin/QM — do
not collapse these back to a single `isAdmin` check (D-13). `useStatsData` tolerates a denied
collection per-dataset so one gated read degrades one tile, never the page.
**Do not regress:** don't add a generic field/measure picker; don't let a tile fetch its own
data; don't ship a tile whose underlying data isn't persisted (shelf drift was cut for exactly
this — `refillShelf` overwrites `shelfQuantity` and keeps the prior count only in a free-text
`note`, so there is no "expected" value to diff; it needs a structured `previousShelfQuantity`
field before that tile can exist).

### D-28 — Call/EHR data enters through a NEMSIS mapper, de-identified at the boundary
**Decision:** BMRC is adopting ESO for EHR/QM. The app does **not** read ESO's format directly:
`app/lib/calls/nemsis-map.ts` is the only file permitted to know ESO or NEMSIS field names, and
it maps an export into a stable internal `CallRecord` (`app/lib/calls/types.ts`) that every
downstream tile reads. Built against **NEMSIS 3.5** (the federal standard ESO must emit) rather
than ESO's own column names, so it survives a vendor or version change.
**Why:** `Event.callTime` in this app is a report-for-duty time, not a 911 call — there is no
incident, response-time, or acuity data anywhere in the system today, and the only patient
contact trace is the free-text `pcrNumber` on `MedicationLog`. Call stats were therefore a
data-capture problem, not a dashboard problem.
**Load-bearing details:** the mapper **de-identifies at parse time** — patient name, DOB, street
address, GPS, narrative, and payer are dropped before a `CallRecord` exists (`PHI_FIELDS`
enumerates them). Storing-then-hiding would change this Firestore project's compliance posture;
dropping at the boundary does not. Join keys were added ahead of the data: `User.esoCrewId`
(NEMSIS `eCrew.01`), `Vehicle.esoUnitId`, and the existing `MedicationLog.pcrNumber`
(`eRecord.01`). NEMSIS nil attributes and the `77xxxxx` "not recorded" code family map to
`null`, never to 0.
**Do not regress:** don't let ESO/NEMSIS field names leak past the mapper; don't add PHI to
`CallRecord`; don't treat a missing interval as 0. This app is `output: export` with no server,
so a scheduled pull has nowhere to run — ingest is manual upload unless Cloud Functions are
added.
### D-29 — The FTO starts the shift; retroactive attendance edits are manager-only
**Decision:** attendance permissions come from one pure function,
`getAttendanceAccess()` (`app/components/events/event-utils.ts`), which returns a mode:
- **live + assigned FTO** — stamp-only controls (Check in / Check out / No-show / Excused),
  scoped to **their own team**, and **gated on checking themselves in first**. Until the FTO
  has a `checkedInAt`, every other row is disabled behind an inline "Check yourself in to
  start the shift" banner; their own row sorts to the top. Their **End shift** sweep is
  likewise team-scoped (`endEventShifts(eventId, actor, teamIds)`).
- **live + manager** (`admin | quartermaster | medops`) — the same stamp controls plus
  `Clear`, across every team, with no self-check-in gate.
- **past + assigned FTO** — **read-only**. Chips only, no buttons, with a note pointing at
  MedOps/admin.
- **past + manager** — the **only** surface in the app with arrival/departure time inputs;
  saving recomputes the `minutesLate` / `leftEarly` / `minutesEarly` snapshots.

"Past" is derived (`isEventPast`): after the event's end datetime, or end of the event day
when no `endTime` is set — there is no manual "close the event" step.
**Why:** the FTO checking themselves in *is* the act of starting the shift, so a shift can
never be run by someone who isn't there. And an FTO editing times after the fact is how
attendance records quietly drift; correcting the record is a supervisory act, so it belongs
to medops/admin. An intern gets **no** recording powers — they are an attendee like anyone
else (see D-30).
**Do not regress:** don't re-derive role checks inline in the drawer — extend
`getAttendanceAccess` instead; don't add a time input to any live path; don't let the FTO's
`End shift` sweep other teams.
**Note:** `firestore.rules` is emulator-only and wide open, so these boundaries are
UI-enforced, like every other role gate in the app. If real rules ever land, mirror them.

### D-30 — FTO Intern is its own role and a supernumerary team slot
**Decision:** `fto_intern` is a `User['role']` (a role position like member/FTO, same EMT+CPR
cert gating, same permissions as FTO) and `SlotRole` gains `'FTO_INTERN'`. A team carries at
most **one** intern via `hasFtoIntern?: boolean` + `ftoInternSlot?: TeamSlot`, defaulting **on**
for newly created teams; `undefined` on a legacy doc means **off**, so pre-existing events
don't retroactively sprout an open slot. Eligibility: an intern may request the intern slot or
a plain EMT slot, **never** the FTO slot; only `fto_intern` (or a manager) may take the intern
slot. The intern line renders directly beneath the FTO line, visually paired with it.
**Why:** an intern needs field experience before running a team, so they shadow a real FTO
rather than replacing one. That makes them an **addition**, not a substitute — hence a single
extra slot and a hard rule that they are **excluded from staffing math**: a team is staffed at
1 FTO + `emtCount` EMTs whether or not the intern slot is filled. `teamFilledCount` reports
`intern` separately for exactly this reason.
**Do not regress:** never fold the intern into a fill fraction or a "team is staffed" check;
never let an intern request or be approved into the FTO slot; keep `hasFtoIntern === undefined`
meaning off.

### D-31 — Statpack check-in fast path and restock auto-flagging

**Decision:** `?mode=checkin` gains an optional initial gate step presented before the existing pocket-by-pocket form. Check-out and audit are unmodified.

1. **Gate step:** "Did you use anything from this pack?" — one button choice.
   - **Used nothing** → immediate submission: `quickCheckin: true`, `checkEntries: []`, no other form steps.
   - **Used something** → Step 1 (picker of touched items only) → Step 2 (existing `showReview` confirm sheet).
2. **Picker component** (`app/components/statpacks/checkin-used-picker.tsx`) collects only consumables that the crew actually touched, with quantity steppers defaulted to 1, clamped to `currentQuantity`. Untouched items produce no entry — their stored counts survive the transaction.
3. **Escape hatch:** "Open full check-off" remains visible throughout, so crew needing to report an expiration, full sharps box, or broken asset can still reach the complete form.

**Why one tap is safe:** `deriveStatus` in `app/lib/inventory.ts` reads signals from two sources:
- The submitted `checkEntries` (per-item counts + expirations entered this pass)
- The **pack's persisted state** (`anyStoredExpired` — past expirations already on `contents[]`, `anyQuarantined` — recalled lots, `hazard.assetCurrencyLapsed` — a lapsed AED/O₂). These fire regardless of `checkEntries` content. A one-tap "used nothing" still fail-closes on an expired item, recalled lot, or stale life-safety asset without asking the crew anything.

**The untouched-contents fix:** `anyOutConsumable` previously accumulated only from `checkEntries`, safe because full submissions touched every item. Under partial submission a different failure becomes possible: a pack left at 0 gauze by the last crew, checked in with "used nothing", would derive `Ready` — silently un-flagging a depleted pack, the exact failure D-8 exists to prevent. Fix: after the entry loop updates `contents[].currentQuantity`, scan the **final `contents` array** for any non-asset item with `requiredQuantity > 0` and `currentQuantity <= 0` that was **not restocked this pass** (not in `restockedItemIds` collected from entries with `restockStatus === 'restocked'`), and fold into `anyOutConsumable`. Behaviour-preserving for full submissions and audits; adds signal only for items not submitted.

**Auto-flagging the logistics team:** Check-in now auto-creates a de-duplicated `team_tasks` card when the pack leaves with `getPackShortages(...).total > 0` (deliberately including *partial* shortages — the pack still derives `Ready` per the D-8 amendment, but logistics is told). After the transaction commits, best-effort, never throwing (matching `issue_reports` convention):
1. **Status + chips** — free, derived from persisted `currentQuantity`.
2. **Committee Board task** — helper `app/lib/statpack-restock-flag.ts` writes a doc with `title: 'Restock ${pack.name}'`, `definitionOfDone: 'All pack contents back to par quantity.'`, `subtasks` keyed to each shortage, and `linkedStatpackId: pack.id` (new optional field, ratified in TASK 2 of this entry). De-duplicated: if an open task for this pack exists, update its subtasks instead of creating a second card; otherwise every check-in of a chronically short pack spawns another.
3. **In-app notification** — broadcasted to `['admin', 'quartermaster']` only (not `medops`, per D-13: medops never sees logistics surfaces). Links to `/statpacks/<id>`.

**This reverses documented non-behaviour:** `MODEL.md` explicitly states "post-event scan → auto-flag below-par item" does **not exist**; D-8 frames restock as human-pull, caught by the next crew or admin audit. Auto-creating a task and notification is a deliberate reversal, scoped to **statpacks only** — inventory below-par remains display-only. Not a silent patch.

**Do not regress:** don't add a time/sharps/expiry input to the fast-path gate (the escape hatch covers those); don't include `medops` in the restock notification; don't let `anyOutConsumable` drift back to entry-only (statpacks short on untouched items must still derive `Restock Needed`); never remove the de-dupe check (a chronically short pack gets one card, not many).
