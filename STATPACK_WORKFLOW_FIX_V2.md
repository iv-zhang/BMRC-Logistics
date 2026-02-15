# Statpack Checkout/Check-In Workflow Fix — V2 Implementation Plan

## Audit Summary

After a full codebase audit, here are the **critical issues** found:

### 🔴 Critical Issues

| # | Issue | File(s) | Impact |
|---|-------|---------|--------|
| C1 | **Members can BS verification** — submit button is always enabled for non-admins; no items need to be checked off | `statpack-checkoff-modal.tsx` L760 | Entire accountability system is defeated |
| C2 | **Errors silently swallowed** — checkout/checkin catch blocks only `console.error`, then redirect to dashboard as if successful | `checkout/page.tsx` L313, `checkin/page.tsx` L275 | Users think checkout worked when it failed |
| C3 | **Checkin shows all packs, not just user's** — checkin page shows all "In Use" packs. Server rejects non-owner but silently | `checkin/page.tsx` L100-120 | Members waste time checking in someone else's pack and get silent failure |
| C4 | **No log history on admin page** — admin statpack manager has zero log display. Admins can't see checkout/checkin history | `statpacks/page.tsx` (all 958 lines) | Admin has no visibility into member activity |
| C5 | **Quick check-in has no confirmation** — one tap immediately completes with zero friction, no "are you sure?" | `checkin/page.tsx` L218 | Too easy to BS |

### 🟡 Important Issues

| # | Issue | File(s) | Impact |
|---|-------|---------|--------|
| I1 | **No final review screen** — after all pockets verified, auto-submits without showing summary | `checkout/page.tsx` L329-336, `checkin/page.tsx` | Users don't see what they just verified |
| I2 | **Quick checkin badge not shown** — `quickCheckin` field stored but never displayed to admin | `log-detail-modal.tsx` | Admin can't distinguish quick from full |
| I3 | **allPocketCheckData not reset when switching packs** on checkout page | `checkout/page.tsx` | Stale pocket data from previous pack persists |
| I4 | **Summary stats computed but not used in admin UI** | `inventory.ts`, `log-detail-modal.tsx` | Wasted computation, missing admin insight |
| I5 | **No checkout duration tracking displayed** — `formatDuration` and `calculateEventDuration` exist in logs.ts but unused | `logs.ts` | Admin can't see how long packs were out |

## Implementation Plan

### Phase 1: Member UX — Prevent BS and Show Errors

**1a. Require item verification for members** (`statpack-checkoff-modal.tsx`)
- Change submit button: members MUST check off every item (not just admins)
- Add progress indicator: "5/12 items verified"
- Auto-check items that match count (tap card = toggle check + confirm count)
- Show clear "X items remaining" before submit is enabled

**1b. Show error messages** (`checkout/page.tsx`, `checkin/page.tsx`)
- Replace silent `console.error` with visible error alerts using state
- Show "This pack is already checked out" / "You can only check in your own pack"
- Don't redirect on error

**1c. Filter checkin to user's packs** (`checkin/page.tsx`)
- Filter statpack list: show only packs assigned to current user
- Or show others grayed out with "Assigned to [other person]" label

**1d. Quick check-in confirmation** (`checkin/page.tsx`)
- Add confirmation modal: "Are you sure? This will be flagged for admin review."
- Show pack contents summary before confirming

**1e. Final review screen before submit** (`checkout/page.tsx`, `checkin/page.tsx`)
- After all pockets verified, show summary modal with:
  - Pack name, items verified count, any mismatches, any expired items
  - "Confirm Checkout" / "Confirm Check-In" button
  - Option to go back and re-check

### Phase 2: Admin View — Log History & Visibility

**2a. Add log history panel to admin statpack page** (`statpacks/page.tsx`)
- New "Activity Log" button on each statpack widget
- Opens modal showing paired checkout/checkin timeline
- Uses existing `pairStatpackLogs` from `logs.ts`
- Shows quick-checkin badge, duration, usage rate
- Links to `LogDetailModal` for drill-down

**2b. Enhance log detail modal** (`log-detail-modal.tsx`)
- Show "⚡ Quick Check-in" badge prominently
- Show checkout duration for paired logs
- Show summary stats (verified/total, mismatches, expired)
- Show usage rate for paired checkout/checkin

**2c. Admin "Currently Checked Out" dashboard section**
- On admin statpack page, add a pinned section showing all checked-out packs
- Show: pack name, assigned to, checked out at, duration since checkout
- One-click to view log details or force checkin

### Phase 3: Data Integrity — Retroactive Log Fix

**3a. Migration script to pair orphaned logs** (already exists: `backfill-statpack-pairid.cjs`)
- Verify the existing script works with production data
- Run `--dry-run` first, then `--force`

**3b. Normalize action values** (already exists: `normalize-statpack-log-actions.cjs`)
- Run to ensure all logs use canonical action names

### Phase 4: Testing Plan

**4a. Automated E2E test script** (`scripts/test-e2e-checkout-flow.cjs`)
- Simulates full checkout → checkin cycle using Firebase Admin SDK
- Creates test data, runs through the flow, verifies logs
- Checks: log creation, pairId linking, statpack status updates

**4b. Manual verification checklist**
- [ ] Checkout: member must verify all items before submitting
- [ ] Checkout: error shown if pack already checked out
- [ ] Checkout: final review screen appears
- [ ] Checkin: only user's packs shown
- [ ] Checkin: pocket-by-pocket verification works
- [ ] Checkin: quick checkin shows confirmation
- [ ] Checkin: error shown if not your pack
- [ ] Admin: can see log history per statpack
- [ ] Admin: quick checkin badge visible
- [ ] Admin: checkout duration shown
- [ ] Admin: currently checked out section works

## Files to Modify

| File | Changes |
|------|---------|
| `app/components/statpack-checkoff-modal.tsx` | Require all items checked for members; progress bar |
| `app/statpacks/checkout/page.tsx` | Error alerts; final review modal; clear stale data |
| `app/statpacks/checkin/page.tsx` | Filter to user's packs; error alerts; confirmation for quick; final review |
| `app/statpacks/page.tsx` | Add log history panel; checked-out section for admin |
| `app/components/log-detail-modal.tsx` | Quick checkin badge; duration; summary stats |
| `app/components/statpack-log-history.tsx` | NEW: reusable log history component for admin |
| `app/lib/logs.ts` | Already has helpers, may need minor additions |
