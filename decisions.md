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
