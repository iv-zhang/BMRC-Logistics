# Targeted workflow review — 2026-10-16

Historical evidence for the [small-fixes-first plan](2026-10-16-workflow-and-ux-remediation-plan.md). This was a targeted local run, not a release gate or usability study. The emulator and all its records were discarded; this report does not describe a retained test environment or the live release.

## Environment and test labeling

- App: `http://localhost:3100`, current working-tree source via `npm run dev:emulator -- --port 3100`.
- Firebase: fresh local Auth/Firestore emulators, project **`demo-bmrc-logistics`**. Fixed loopback fixture endpoints; no hosted Firebase writes, no service-account use, and no production seed.
- Run ID: **`TEST-WORKFLOW-2026-10-16`**. All 19 Firestore records at run close were tagged `isTest: true`, `testRunId`, and a test-purpose note, including generated logs/task/notification and auto-created organization defaults.
- Fixture names and user display names begin `[TEST]`; inventory/pack/storage IDs begin `TEST-WORKFLOW-`. Auth emails are `test-workflow-member@bmrc.test` and `test-workflow-quartermaster@bmrc.test`. These are disposable local test identities, not organizational users.
- Historical temporary paths: `/tmp/bmrc-workflow-review.K3HR6H/fixtures.mjs` and read-only `/tmp/bmrc-workflow-review.K3HR6H/inspect.mjs`. **The /tmp recipe is likely gone and must be recreated** from the fixture description/results below; do not assume these paths are runnable. In a future approved code change, place the recreated recipe in `scripts/emulator/`, preserving demo/loopback guards and test labels. No script was recreated or moved in this docs revision.

No application fixes, migrations, commits, or deployments were made. Existing automated suites and the full expensive smoke driver were not run; this was the specifically authorized targeted workflow review.

## Representative fixture

The following sizes/counts are synthetic examples, not current BMRC stock or clinical guidance. Each size is a separate inventory item; several items reference the same physical container.

| Inventory item | Loose reserve units | Container | Short-pack contents / required |
|---|---:|---|---:|
| `[TEST] OPA, 80 mm` | 12 | Shared blue bin | 0 / 2, main pocket |
| `[TEST] OPA, 90 mm` | 10 | Same shared bin | 1 / 2, main pocket |
| `[TEST] NPA, 28 Fr` | 5 | Same shared bin | 2 / 2, front aux |
| `[TEST] NPA, 30 Fr` | 2 | Same shared bin | 2 / 2, left side |
| `[TEST] SAM Splint, standard` | 6 | Same shared bin for this fixture | 2 / 2, right side |
| `[TEST] Cold Pack, individual` | 60 | Bulk tote | Not in pack |

Both containers are on the test shelf in the test storage room. The short pack starts `Restock Needed`; a second, fully stocked Ready pack is the control. Inventory reserve quantities and pack contents remain separate.

## Observed results

1. **Short-pack discovery — passed locally.** A real synthetic member login saw both the Ready control and the Restock Needed pack. The latter displayed a two-item restock chip and was selectable. No role override or Ready override was used.
2. **Checkout while short — passed locally.** Skipped the optional event association, verified five contents across all four pockets, and completed checkout without setting either short item to par. The UI showed a success message. The return picker subsequently showed the pack In Use and assigned to the test member; a checkout log existed.
3. **Return without using more — passed locally.** Used the “No, used nothing” return path. Direct emulator inspection confirmed `isCheckedOut: false`, status `Restock Needed`, and the original 0/1/2/2/2 quantities. A check-in log, unclaimed restock task, and logistics notification were created. The pack was visible/selectable again in member checkout.
4. **Loose-unit audit — current UI cannot express the recount.** As the synthetic quartermaster, opened Supply Audit → Count for the 80 mm OPA. The drawer located its shared bin and displayed System boxes 0 / Total units 12, but its only quantity input was “Count sealed boxes/bags on hand” ([audit-action-drawer.tsx:394](../../app/components/audit-action-drawer.tsx#L394)); `AuditEntry` also lacks a loose-count field ([audit-helpers.ts:336–353](../../app/lib/audit-helpers.ts#L336)). No count was submitted: a made-up package quantity would not verify the 12 individual units. This reproduces the reported mismatch; fix in Batch 0d.
5. **Assigned-pack dashboard — observed failure.** After checkout, the dashboard said no packs were assigned, while the return picker found the pack. The query uses `assignedTo` ([member-dashboard.tsx:190](../../app/dashboard/member-dashboard.tsx#L190)); checkout writes `assignedToUserId` ([inventory.ts:783](../../app/lib/inventory.ts#L783)). Fix in Batch 0b, testing checkout → dashboard → return together.
6. **Return status label — observed misleading display.** The return gate displayed “Ready” for the checked-out pack. Unhandled statuses, including In Use/In Maintenance, default to green Ready ([check-off/page.tsx:1392–1395](../../app/statpacks/check-off/page.tsx#L1392)). Fix in Batch 0c.

The missing Restock Needed pack was **not reproduced locally because this checkout includes the fix**. A fresh `git fetch origin` for this revision supersedes the previous branch claims: `origin/main` is now `fdbf657` (PR #9), containing `381cec5`; local `main` (`f9943a1`, Sept 26) is its ancestor, 25 behind; `feat/statpack-restock-flag` is 0 ahead / 24 behind. The supplied earlier 21-behind / 1-ahead snapshot is also superseded. **Merged does not establish live deployment.** Live deployment is main-push driven ([firebase-hosting.yml:4–6](../../.github/workflows/firebase-hosting.yml#L4), [40–41](../../.github/workflows/firebase-hosting.yml#L40)); 0a verifies the actual live SHA/backend and audits `.claude/worktrees/` as well as branches.

Release A groups 0a/0b/0c/0e after the director's maintenance decision. Base remaining work on current `origin/main` via rebase/merge and re-test checkout/check-off drift; don't replay already-merged `381cec5` or reuse this historical pass as integration evidence. After deployment, observe a real member checking out a real short pack on the next shift. **Production test writes require the user's explicit approval.** Release B keeps 0d separate and requires `npm run test:invariants` and `npm run test:properties` in addition to normal code tiers because it changes `computeBagStock` ([package.json:18–19](../../package.json#L18)). These tests were not run for this docs-only revision.

## Historical record manifest — discarded emulator only

These paths no longer exist in a retained dataset. They document only this discarded local demo run, not current cleanup targets. Reruns need a fresh manifest and generated Auth/log/task IDs; never use these IDs to delete records in another environment.

- `users/fuf4Yd6mABOX1lPkU65WSwpkn7cZ` — test logistics account.
- `users/mjiJjiZ3g1jQu6hq2fkCqGULM6nz` — test member account.
- `inventory/TEST-WORKFLOW-OPA80`, `inventory/TEST-WORKFLOW-OPA90`, `inventory/TEST-WORKFLOW-NPA28`, `inventory/TEST-WORKFLOW-NPA30`, `inventory/TEST-WORKFLOW-SAM`, `inventory/TEST-WORKFLOW-COLD`.
- `statpacks/TEST-WORKFLOW-PACK-SHORT`, `statpacks/TEST-WORKFLOW-PACK-READY`.
- `storage_zones/TEST-WORKFLOW-ZONE`, `shelves/TEST-WORKFLOW-SHELF`.
- `containers/TEST-WORKFLOW-MIXED-BIN`, `containers/TEST-WORKFLOW-TOTE`.
- `org_settings/current` — defaults auto-created by the app in this fresh demo project, then tagged test.
- `statpack_logs/yQp4zrZF9v0nh6mQmxrA` — checkout.
- `statpack_logs/SY5AH8gcKXriv0j0ACi8` — return.
- `team_tasks/maE0WwcNmFXCMYHZBHMY` — unclaimed restock work.
- `notifications/03hgFpt0w67dWDv0p3At` — logistics restock notification.

For a retained staging run, cleanup must enumerate records by run ID and their generated dependencies, plus the corresponding test Auth users. Do not apply emulator-wide cleanup to shared staging or production.

**Cleanup completed:** the test app and dedicated emulators were shut down; ports 3100, 8080, and 9099 no longer had listeners. No export was retained, so the 19 Firestore records and two Auth accounts were discarded. This report retains the fixture description/results, not a durable runnable recipe; recreate the likely-lost /tmp recipe before rerunning. No hosted records were deleted or modified.

## Still to validate

- Current-main integration, live SHA/backend, branch/worktree shipping gaps, and next-shift observation of real member checkout after the combined approved release (Batch 0a).
- One physical walkthrough with 1–2 people: pocket order, narrow mobile width, repeated SKU, interruptions, and size recognition. This is Batch 1 feedback, not a study or release prerequisite.
- Successful individual-unit recount, packaged-plus-loose correction, and shared-bin audit after implementation; the present form cannot complete those acceptance cases.
- Real-world need for one SKU split across multiple containers, per-container quantities, and optional color labels.
- Event/standalone-asset workflows, concurrency/retry cases, and all remaining acceptance criteria in the plan. This run does not close them.
