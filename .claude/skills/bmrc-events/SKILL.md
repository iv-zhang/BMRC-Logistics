---
name: bmrc-events
description: >
  The events / shift-signup system for BMRC Logistics — the /events board,
  /roster, attendance, shift hours, cert gating, and the medops role. USE THIS
  SKILL when touching event creation or staffing, shift requests, team slots,
  attendance or lateness, volunteer hours, member experience/status, roster
  editing, notifications, or any role gate involving medops. Keywords: events,
  event, shift, shift signup, shift_requests, teams, EventTeam, FTO, EMT slot,
  medops, isEventManagerRole, roster, attendance, check in, minutesLate,
  no_show, excused, shift hours, certifications, cert gating, venues,
  semester, notifications, broadcast, volunteer record.
---

# BMRC Events & Shift Signup (`/events`, `/roster`, `/profile`, `/history`)

Members request team slots; managers staff them. Design rationale lives in
[decisions.md](../../../decisions.md) **D-13 … D-19** — if a change would undo
something there, treat it as **stop-and-ask**, not a bug to patch.

- **Lib:** `app/lib/events.ts`, `app/lib/notifications.ts`,
  `app/lib/certifications.ts`, `app/components/events/event-utils.ts`
- **UI:** `app/events/page.tsx` + `app/components/events/*`
- **Collections:** `events` (each has `teams: EventTeam[]`; one team = 1 FTO +
  2–4 EMT slots), `shift_requests`, `notifications`

## The load-bearing rules

### medops ≠ isAdmin (D-13)
`medops` is a reduced-admin role that manages events/roster **only** and must
never see logistics surfaces. The gate is `isEventManagerRole(role)` =
`admin | quartermaster | medops` — gate every event/roster surface on that,
**never** on `isAdmin`. The attendance panel is narrower still: assigned FTO or
admin/quartermaster (`showAttendance = isAssignedFto || role === 'admin' ||
role === 'quartermaster'`) — medops does **not** see it.

### Cert gating (D-14)
`canSignUpForShifts` requires unexpired EMT **and** CPR (expiry dates only, no
document upload). `org_settings.requireCertsForShiftSignup` (default `true`) is
the kill switch; when it's on and no certs are entered, **all signup is blocked
by design** — the disabled Request button shows an inline amber reason from
`getShiftBlockReason`, not just a tooltip. Certs are cleared manually by
medops/admin in the roster modal.

### Experience is derived, not a dropdown (D-15)
Computed from `User.memberStatus` (`'new' | 'probationary' | 'general'`,
default `general`) + `User.joinedTerm` (e.g. `"Fall 2025"`), edited in the
roster `MemberDetailModal` by admin/qm **or medops** (`canEditAllRoles ||
isMedOps`). Requests denormalize both; `formatMemberExperience(status, term)`
renders. `canRequestRole`: FTO-role members can request FTO **and** EMT slots,
everyone else EMT only. `ShiftRequest.ranking` is kept for back-compat and is
no longer written. Bulk import from the roster spreadsheet is a future TODO
(the seam is left in the roster page).

### Attendance = a check-in stamp; lateness is derived (D-16)
```ts
AttendanceRecord = { checkedInAt?, shiftEndAt?, minutesLate?,
                     exception?: 'no_show' | 'excused', notes?, recordedBy... }
```
FTO/admin taps **Check in** (arrival = now) with an editable "Arrived at"
HH:mm override for forgotten check-ins. `minutesLate` is **computed** against
the event call time (`computeMinutesLate` / `eventCallDateTime` in
`event-utils.ts`) and stored as a snapshot — never entered by hand.
`recordAttendance(request, patch, actor)` clears `exception` when
`checkedInAt` is set and vice versa, and preserves `shiftEndAt`.

### Shift hours (D-17)
A shift ends either via the per-event **End shift** button (`endEventShifts`)
or **automatically on statpack check-in**: `logStatpackCheckOff` captures the
pack's `currentEventId` *before* clearing it and calls `endEventShifts`
best-effort **outside** the transaction. Hours = `shiftEndAt − checkedInAt`
(`shiftHours`). `getMemberShiftStats` returns shifts / checkedIn / lateCount /
totalMinutesLate / noShow / excused / hours, all-time **and** semester —
surfaced in the `/profile` "Volunteer Record" card and the roster
`ShiftStatsSection`.

### Notifications are in-app broadcasts (D-19)
`requestShift` and the `/events` notify modal write `notifications` docs
(type `'broadcast'`) to managers + the team FTO. Audience options: everyone /
signed-up (`getSignedUpUserIds`) / both. **No email** — the app is a static
export with no mail server. Don't add an email path without a decision.

## Statpack ↔ event correlation
Checkout picks an event; it threads through `logStatpackCheckOff` →
`StatpackLog.eventId` / `eventName` + `Statpack.currentEvent` / `currentEventId`,
and is cleared on check-in (see the **bmrc-statpack-flows** skill).

## Org config
`/settings` → "Events & Venues" tab: `venues` (picking a venue on an event
auto-fills its location), `eventTypes`, `semesterStartDate` (drives every
"this semester" stat). Getters: `getVenues` / `getVenueByName` /
`getEventTypes` / `getSemesterStart`. See the **bmrc-org-config** skill.

## Gotchas

- **`deepRemoveUndefined` must preserve Firestore `Timestamp`s.** It previously
  rebuilt them into plain maps, which is why `createEvent` stored a broken date
  while `updateEvent` worked. `toJsDate` (`event-utils.ts`) also coerces legacy
  `{seconds, nanoseconds}` maps so old broken docs still display.
  `scripts/repair-event-dates.cjs` (dry-run by default) permanently repairs
  them — see the **bmrc-migrations** skill before running it.
- **Scope user-specific queries by `effectiveUid`**, not the raw auth uid, or
  test identities bleed into each other (D-18). `app/events/page.tsx`
  (`actor.uid` + `subscribeMyRequests`) and `app/history/page.tsx` both do this.
- Roster editing lives in a click-row `MemberDetailModal`, not in table cells
  (`onRowAction` + `selectionMode="none"`).
- The events `<main>` needs `pb-28 md:pb-8` so the fixed mobile bottom nav
  doesn't cover the Requests-inbox Approve/Reject buttons.
