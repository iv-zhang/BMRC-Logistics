# Statpack editor stale-write fix (handoff plan for Codex)

Status: plan drafted 2026-10-28 by Claude Code from a read-only investigation of live data. The owner approved implementing it. Follow the repo's CLAUDE.md / AGENTS.md workflow: one branch, one ready PR into `main`, never push `main`, never force-push. The owner prohibits running the repair script with `--apply` in this task, including against the emulator. Save this plan as `docs/plans/2026-10-28-statpack-editor-stale-write-fix.md` on the branch and keep its progress log current.

## 1. What happened

Symptom: no statpacks on `/statpacks/checkout`. PR #25 (client-side picker filtering) is merged and deployed, but it was not the root cause: prod already had the `status + name` composite index.

All four live packs (BMRC1-4) were in a contradictory state: `status: 'Ready'` **and** `isCheckedOut: true`. Checkout correctly hides checked-out packs, and the pre-#25 check-in query (`status == 'In Use'`) hid them too, so they showed nowhere. Each was genuinely checked out by a member (Sep 30 to Oct 27) and never checked in.

Cause: **the statpack editor writes back a stale, JSON-cloned copy of the whole pack.**
- `StatpackEditorModal` seeds its draft with `JSON.parse(JSON.stringify(pack))` (`app/components/statpack-editor-modal.tsx` ~L192). `app/audit/page.tsx` ~L384 and `app/assets/page.tsx` ~L177 also JSON-clone before opening it.
- Every save path spreads the full draft into the write:
  - `app/assets/page.tsx` `saveStatpackDraft` -> `saveStatpackContents`
  - `app/audit/page.tsx` `saveContentEdit` -> `updateStatpackDetails({...docFields})`
  - `app/statpacks/[id]/page.client.tsx` `saveEditor` -> `updateStatpackDetails({...draftBody})`
  - `app/statpacks/page.tsx` `buildStatpackUpdate` (~L283), a "whitelist" that still includes `isCheckedOut`, `assignedTo*`, `checkedOutAt`, `lastChecked*`
- So a save overwrites ownership/check-off fields with their values from when the editor opened. The status picker can set `Ready` without clearing `isCheckedOut`. Prod `statpack_logs` show editor saves at 2026-10-27 01:50 UTC (BMRC1/2/4) and 2026-10-28 03:31 UTC (BMRC2/3, 7 minutes after an admin set them `In Use`) that flipped status to `Ready`. They ran pre-PR-#24 code (an old open tab or a local dev server on an older branch; `.env.local` points at prod), which logged status edits as `content_edit`. Current `main` logs status changes correctly but still does the stale whole-doc write.

Collateral damage: the JSON clone turns Firestore `Timestamp`s into plain maps and FieldValue sentinels into `{_methodName: 'serverTimestamp'}` maps. On all four packs:
- `checkedOutAt`, `checkedInAt`, `lastCheckedAt`, `lastAuditAt`, some `createdAt` are `{type, seconds, nanoseconds}` maps (recoverable).
- `updatedAt`, `contentsUpdatedAt`, some `createdAt` are `{_methodName}` maps (value lost).
- 5 `contents[].expirationDate` values are maps (AEDs in BMRC1/2/4, dates 2028-02 to 2028-04, not expired). **Readers silently ignore them**: check-off hydration in `app/statpacks/check-off/page.tsx` ~L1033 (`instanceof Timestamp`, else `undefined`) and `toMillisLoose` in `app/lib/inventory.ts` ~L289 (`new Date(map)` is NaN). An expired item stored this way would not be flagged. Treat as safety-relevant.
- 11 of 238 `statpack_logs` have a `{_methodName}` map as `timestamp` (all `content_edit`), so time-range queries never match them.

## 2. Ops, no code (owner handles)

1. Close old app tabs; stop any local `npm run dev` on an old branch (it writes to live Firestore).
2. Don't use the statpack editor until this fix ships.
3. An admin checks in BMRC1-4 at `/statpacks/checkin` (PR #25 lists them; admin/QM bypass the holder check). Check-in carries stored `contents` through unchanged, so the AED dates are not lost.

## 3. Code fix (one branch, one PR)

Branch: `git fetch origin && git switch -c codex/statpack-editor-stale-write origin/main`.

**3a. The editor writes only what it edits.** New pure helper in `app/lib/statpacks.ts`, e.g. `buildStatpackEditorPatch(draft, seed)`:
- Allowed keys: `name`, `currentLocation`, `contents`, `exchangeBagAssignments`, `assetValue`, and `status` **only when `draft.status !== seed.status`**. Add `contentsUpdatedAt: serverTimestamp()`.
- Never written from a draft: `isCheckedOut`, `assignedToUserId/Name`, `checkedOutAt`, `checkedInAt`, `lastCheckedAt/By`, `lastAuditAt/By`, `currentEvent(Id)`, `readyOverride`, `sharpsContainer`, `createdAt`, `updatedAt`, `maintenance_logs`.
- Rehydrate dates inside `contents[]` (`expirationDate` and any other item date fields) from `{seconds,nanoseconds}` maps / ISO strings / `Date` to `Timestamp` before writing. Also consider replacing the JSON clone in the editor seed with a Timestamp-preserving clone; the save-side normalizer is still required.
- Route all four save paths above through it. Keep `saveStatpackContents` / `updateStatpackDetails` as the writers so logging stays the same.

**3b. Status guard against the live doc** (`app/lib/statpacks.ts`): switch `updateStatpackDetails` and `saveStatpackContents` from `writeBatch` to `runTransaction`, read the live pack, and refuse any `status` other than `In Use` while the live doc has `isCheckedOut: true` ("Check this pack in first"). Decide `status_change` vs `content_edit` from the **live** status, not the caller's snapshot. This covers every caller, including the `/assets` maintenance and edit-details flows.
- In the editor UI, disable non-`In Use` statuses for a checked-out pack, with an inline reason. Follow the `bmrc-ui` skill: concise copy, no em dashes.

**3c. Readers tolerate map-shaped timestamps** (the 5 AED dates depend on this):
- One shared coercer in `app/lib/`. Reuse or move the legacy-map handling in `toJsDate` (`app/components/events/event-utils.ts`); don't add another near-duplicate `toDate`.
- Use it in `toMillisLoose` (`app/lib/inventory.ts`) and the check-off contents hydration (`app/statpacks/check-off/page.tsx`).

**3d. Rules:** no new collections or write shapes, and `statpacks` read/update are already `isSignedIn()`, so no `firestore.prod.rules` change is expected. Confirm it and say so in the PR.

**3e. Owner rule (2026-10-27): the editor never removes a pack item.** Owner's words: you can't remove anything in the statpack editor; you can set it to quantity 0, but it won't disappear from the statpack checklist.
- UI: remove the per-item **Remove** button and its handler in `app/components/statpack-editor-modal.tsx` (~L642 `p.contents.splice(idx, 1)`, button ~L927), and the legacy list-page path in `app/statpacks/page.tsx` (`removeContentItem` ~L232, called ~L1093). Keep the par stepper's floor at 0 (it already clamps with `Math.max(0, …)`). Add a short hint near the stepper or footer, e.g. "Set par to 0 to stop stocking an item. It stays on the checklist." Follow `bmrc-ui` copy rules.
- Out of scope: the item-level **custom warning** remove (`customWarnings`), the **exchange-bag assignment** remove, and **Delete statpack**. They don't remove checklist items. Adding items (Add item / import) stays allowed.
- Save-side guard, in the 3b transaction: refuse a write whose `contents.length` is less than the live doc's ("Items can't be removed. Set par to 0 instead."). Don't match by `statpackEntryKey`, because a legitimate pocket move or lot/serial swap changes the key.
- Already safe at par 0 (verified on `1e6b5ac`, no change needed): the check-off page lists a pocket's items by `pocket` only (`check-off/page.tsx` ~L1225), so a par-0 item still shows (as `n / 0`). `logStatpackCheckOff` skips `requiredQuantity <= 0` in both the zero-stock check and the untouched-contents scan (`inventory.ts` ~L680, ~L721), and `getPackShortages` does the same. So a par-0 item never blocks `Ready` or raises a shortage. Lock this in with a test.
- Record this as a new `decisions.md` entry (next free number, D-33) on this branch.

### Decisions resolved by the owner (2026-10-27)
- D1 (approved: require check-in first): Can an admin put a checked-out pack into `In Maintenance` / `Pending Initial Check` from `/assets` maintenance? Plan default and Claude's recommendation: **no, check it in first.** Admins can already check in anyone's pack, so this never blocks them. It matches `overrideStatpackReady`, which already refuses checked-out packs. The BMRC1-4 incident was exactly a status change on a checked-out pack.
- D2 (approved: recover from metadata, label approximate): For the unrecoverable `{_methodName}` fields in the repair: should `updatedAt` come from the doc's `updateTime`, `contentsUpdatedAt` from the latest `content_edit` log's `createTime`, and `createdAt` from the doc's `createTime`? Or should they be nulled? Claude's recommendation: **recover from metadata**, and have the dry run label each recovered value as approximate. `createTime` is exact for `createdAt` and for log `timestamp`s. Null would leave fields that sort and filter as missing. Run the repair after the owner's BMRC1-4 check-ins, then re-scan. Check-in rewrites several of these fields, so the set left to repair will shrink.
- D3 (approved: optimistic-concurrency rejection): **the editor writes `contents` wholesale from the snapshot taken when it opened.** A check-in, audit, or restock that lands while an admin has the editor open gets silently overwritten: counts (`currentQuantity`), entered expirations, and restock state all revert. 3a stops this for ownership and status fields, but not for `contents`. Claude's recommendation: an optimistic-concurrency check inside the 3b transaction. The editor keeps its seed's `lastCheckedAt`, `lastAuditAt`, `isCheckedOut` and `status`. If any of them differ on the live doc, refuse with "This pack changed since you opened it. Reopen the editor." and keep the draft on screen. Compare with the 3c coercer so map-shaped legacy dates compare correctly.

## 4. Data repair script (write it and dry-run it; never execute `--apply` in this task)

`scripts/repair-statpack-timestamps.cjs`, modeled on `scripts/repair-event-dates.cjs`. Read the `bmrc-migrations` skill first. **Dry-run by default**; `--apply` writes.
- `statpacks`: every top-level date field, `contents[].expirationDate`, `readyOverride.at`, and `maintenance_logs[]` dates. Convert `{seconds,nanoseconds}` maps to `Timestamp`; handle `{_methodName}` maps per D2.
- `statpack_logs`: replace a `{_methodName}`-map `timestamp` with the doc's `createTime` (exact, since the log was created in the same write).
- The dry run prints every field it would change, per doc. Run the real thing only after the owner's check-ins so it doesn't race them.

## 5. Tests and verification

- Unit/emulator tests in `app/lib/__tests__/statpack-status-log.test.ts` (or a sibling):
  - the patch builder drops ownership fields
  - JSON-cloned `contents` dates come back as `Timestamp`
  - a status left unchanged in the draft isn't written
  - a live checked-out pack rejects `Ready`
  - status-change detection uses the live status
  - a save with fewer `contents` than the live doc is rejected; a par change to 0 is accepted and keeps the item (3e)
  - a par-0 consumable at count 0 still derives `Ready` on check-in and produces no shortage (3e)
  - if D3 is approved: a save is rejected when the live `lastCheckedAt` differs from the seed's
  - the coercer handles `Timestamp`, `Date`, ISO string, `{seconds,nanoseconds}`, `{type,seconds,nanoseconds}`, and the sentinel map (returns undefined)
- Repair script: emulator rehearsal with seeded broken docs (follow `scripts/emulator/rehearse-statpack-dates.cjs`).
- Smoke case in `.claude/skills/run-bmrc-logistics/smoke.spec.ts`: check out a pack, open the editor from `/audit` or `/statpacks/[id]`, edit a par, save. Expect `isCheckedOut` still true, status `In Use`, `checkedOutAt` still a Timestamp, and the Ready option disabled. Also expect no Remove button on an item. Set an item's par to 0, save, open check-off, and expect the item still listed.
- Verification tiers:
  - after each change: `npx tsc --noEmit` and `npm run lint`
  - before calling it done: `npm run build` and `npm run test`
  - once, right before commit: the emulator smoke driver
  - Report anything you didn't run.

## 6. Codex delegation

**Orchestrator:** strongest Codex model, high reasoning. Owns the plan doc, 3a + 3b in `app/lib/statpacks.ts` (the cross-file seam), integration, verification, and the PR. Land 3a/3b first so subagents code against the real helper signatures.

Then run parallel subagents on **non-overlapping files**:

| Agent | Model / effort | Files | Task |
|---|---|---|---|
| A | mid-tier, medium | `app/components/statpack-editor-modal.tsx`, `app/assets/page.tsx`, `app/audit/page.tsx`, `app/statpacks/[id]/page.client.tsx`, `app/statpacks/page.tsx` | Route save paths through the helper, pass the seed, add the status-picker guard UI, remove the item Remove paths and add the par-0 hint (3e) |
| B | mid-tier, medium | new coercer in `app/lib/` (+ `event-utils.ts` re-export), `app/lib/inventory.ts` (`toMillisLoose` only), `app/statpacks/check-off/page.tsx` (hydration only) | 3c |
| C | small/fast, low | `scripts/repair-statpack-timestamps.cjs`, `scripts/emulator/` rehearsal | Step 4, dry-run only; never run `--apply` |
| D | small/fast, low | `app/lib/__tests__/*`, `.claude/skills/run-bmrc-logistics/smoke.spec.ts` | Step 5 tests, after A/B land |

Escalate a subagent to the top model only if it reports it can't finish within its file set.

## 7. Progress log

- 2026-10-27: Owner authorized sections 3–5, the section 6 delegation, a fresh feature branch, and one ready PR into `main`. Never run the repair script with `--apply`, including during rehearsal.
- Read repository workflow, UI standards, and relevant domain, statpack, migration, testing, and smoke-driver skills. Existing audit cadence guidance in older skills describes the intended cadence; the current audit plan confirms biweekly checks have not started.
- Fetched `origin/main` and created `codex/statpack-editor-stale-write` at `1e6b5ac` from a clean working tree. Copied this handoff into the requested plan path.
- Asked the owner D1 and D2; resolved below by the owner's follow-up. Implementation resumed.
- UI scope: admin/QM content edits use the existing editor panel and status select. Show a concise nearby reason and check-in next step for disabled statuses; preserve input when a live transaction rejects a stale edit.
- Verification: not started. No repair command has run and no production data has been written.
- 2026-10-27 (Claude Code, plan update): added owner rule 3e (no item removal in the editor; par 0 keeps the item on the checklist), with its tests and smoke steps, and gave Agent A the removal paths. Added Claude's recommendations for D1 (no; check in first) and D2 (recover from metadata). Logged new finding D3 (the editor's `contents` write clobbers concurrent check-offs) with a recommended optimistic-concurrency check. D1, D2 and D3 await the owner's answer.
- 2026-10-27 (owner decisions): D1 requires check-in before any non-`In Use` status on a checked-out pack, including maintenance/pending initial check. D2 recovers `createdAt` from document createTime, `updatedAt` from updateTime, `contentsUpdatedAt` from the latest content_edit log createTime, and log timestamps from their createTime; label metadata recoveries approximate. D3 optimistic concurrency approved. Rule 3e approved and recorded as D-33 in `decisions.md`.
- Production repair dry run is pending explicit confirmation that the owner has checked in BMRC1–4. Re-scan first after that confirmation. Never execute `--apply`, including against the emulator. Rehearsal will verify dry-run output/no writes and pure planned repairs on guarded emulator fixtures.
- Implemented the core patch whitelist and live transaction guards in `app/lib/statpacks.ts`. Contents writes require their opening seed; unchanged draft status is omitted; logging uses live status. Shared timestamp imports are awaiting Agent B.
- Delegated Agent A (mid-tier/medium) editor callers/UI; Agent B (mid-tier/medium) shared timestamp coercion/readers; Agent C (small/low) repair and rehearsal. Agent D (small/low) starts after A/B land. Root owns core library, D-33, integration, verification, progress log, and PR.
- 2026-10-27 (Claude Code): opened GitHub issues, all assigned to Ian and Sid: #26 (3a/3b/D1, Ready while checked out), #27 (D3, editor clobbers concurrent check-offs), #28 (3c + repair, broken dates), #29 (3e/D-33, no item removal). Reference them in the PR (`Closes #26 #27 #28 #29`). Separate follow-up, not in this PR: #30 check-off reports don't reach admins, plan `docs/plans/2026-10-27-checkoff-reports-not-reaching-admin.md`.

- A/B landed: immutable modal opening seed and legacy editor seed; all editor paths use the patch builder; item-removal controls removed; checked-out status options disabled with reason; errors retain drafts. Root expanded A's scope to `app/components/sortable-statpack-list.tsx`, which renders the legacy Remove control, with no file overlap. Shared timestamp coercion now covers inventory expiry and check-off hydration.
- `npm run test` passed (all existing offline suites). Agent-scoped lint passed with existing warnings. Full typecheck awaits D's update of old tests to the new required seed API.
- Repair review corrected real log key (`statpackId`) and root field path construction before rehearsal. Initial emulator rehearsal failed because fixture IDs matched Firestore's reserved `__.*__` pattern; root changed them to ordinary IDs and added type-tagged maintenance completion map coverage. No production read/write and no `--apply` execution occurred.

- Integration verification: production build and `npx tsc --noEmit` passed. Touched-file lint passed with 0 errors and 19 existing warnings. Offline `npm run test` passed. The emulator repair rehearsal passed, including approximate metadata labels, no-write dry runs, exact in-memory nanoseconds, persisted Firestore microsecond precision, and a clean idempotent re-scan. Never invoked `--apply`.
- The full `test:emulator` chain stopped at the known invariant baseline: 70 passed, 2 failed (the D-11/D-12 stock-pool/per-lot limitations already documented in FINDINGS.md). Ran the remaining property and semester suites separately: all 7 properties passed at 500 runs each; simulation held all structural/derived Tier-1 checks and caught all 19 induced problems in its reconciliation report.
- Targeted statpack regressions passed 16/16, including par-0 check-in, atomic removal rejection, live-status logging, all four D3 fields, and an expired legacy-map item detected on fast check-in. Fixed test fixture/cleanup issues found during the first runs. Integration review strengthened D3 comparison to preserve timestamp nanoseconds; rechecking that change before commit.
- Review scope note: the approved D3 observations protect check-in/audit/checkout updates. A concurrent asset attachment or another editor save that does not change those four observations still needs a future contents-version policy. This PR follows the owner's specified four-field guard; no broader editor conflict policy added.
- A user dev server occupies port 3000 in this checkout. Pre-commit smoke will run an isolated source copy on port 3001 with fresh demo-project emulators, leaving that server untouched. No production scan yet; BMRC1–4 check-in confirmation is still pending.

- Final build passed again after the timestamp-precision adjustment; targeted emulator regressions remain 16/16. The JSON clone test now uses an actual JSON serialization of a native Timestamp and passed with all nanoseconds retained.
- First full browser smoke: 13/22 passed, 9 failed. Two new scenarios attempted the Audit edit action, which is intentionally disabled for checked-out packs; moved them to the supported Assets editor entry point. Five existing cases encountered a dev reload that cleared the login form; added one bounded retry only for a confirmed blank reset. Two other existing cases timed out on loading screens. Re-running the full driver on the isolated port-3001 copy with one retry and a 90-second per-test budget. No app behavior changed to accommodate the harness.

- Browser verification has now exercised a real checkout followed by an Assets editor save: ownership and exact checkedOutAt timestamp retained, Ready disabled, no item Remove action, par 0 persisted, and the item still visible on the 390px checklist. Reviewed desktop status-menu and mobile checklist screenshots. Stale check-in protection also produced the correct retained-draft error; narrowed its test selector to exclude Next's empty route-announcer alert. That single case will get a focused recheck after the full run completes.
- Confirmed production rules already allow signed-in statpack reads/updates and log reads/creates. No collection, rules, or rule-write shape changes were needed; the separate rules suite was not run. No production repair scan/dry run or apply has been performed.

- Second full smoke run: 20/22 passed. Remaining failures were the stale-draft test's ambiguous alert selector (corrected after that worker had loaded the spec) and the existing restock checkout scenario timing out on dashboard/check-off loading. The latter passed in the first run. All other first-run loading/sign-in failures passed in this run. Focused rechecking the two editor scenarios plus restock checkout with fresh emulators; no application edits since the successful build/regressions.

- Focused smoke rerun passed 3/3 with fresh emulators: both editor cases and the existing restock checkout case. All 22 smoke cases have now passed across the full and focused runs; this was not a single clean 22/22 run. Reviewed the stale-draft screenshot and confirmed the inline error and unsaved par remain visible.
- Expanded nested editor-date normalization to cover assetLastChecked and maintenance-log timestamp/date names, with a regression for actual Date/ISO serialization alongside exact Timestamp nanoseconds. Final typecheck, scoped lint, production build, and 16/16 statpack regressions passed. Re-running the two browser editor cases against this final source before the authorized commit.
- Final pre-commit emulator run passed: 16/16 statpack regressions and 2/2 editor browser scenarios on the final source, no retries. Implementation and verification complete; preparing the authorized feature-branch commit and ready PR into main. Separate #30 plan remains outside this commit. Production re-scan/dry run remains deferred until owner confirmation of BMRC1–4 check-in; no production reads/writes or repair apply execution occurred.
