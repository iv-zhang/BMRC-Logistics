# Branch and worktree audit — 2026-10-16

This audit records the local checkout and branch refs against the freshly fetched `origin/main` base `fdbf6574a51257cd05d52dff65f2af947817b1e5` (`fdbf657`). It covers the root checkout and all entries returned by `git worktree list --porcelain`, cross-checked against a directory inventory of `.claude/worktrees/`: 16 `.claude` worktree directories plus the root checkout, 17 total. No worktree was changed or removed.

## How to read the comparison

Behind/ahead counts are Git ancestry counts from `git rev-list --left-right --count origin/main...<ref>`: behind is commits reachable from the base but not the ref; ahead is commits reachable from the ref but not the base. `Merged` means the branch HEAD is an ancestor of the base (ahead = 0). This is an ancestry statement only; it does not establish patch equivalence, prove that equivalent changes were or were not cherry-picked, or describe deploy state. HEAD is the committed snapshot. Dirty paths below are uncommitted work in the respective worktree and are separate from its HEAD merge status.

## Worktrees

| Worktree | Branch | HEAD | Behind | Ahead | HEAD merged into base? | Dirty files |
|---|---|---|---:|---:|---|---|
| root checkout | `codex/workflow-remediation-phase-1` | `fdbf6574a51257cd05d52dff65f2af947817b1e5` | 0 | 0 | Yes | docs/plans/2026-10-16-workflow-and-ux-remediation-plan.md; docs/plans/2026-10-16-workflow-review-notes.md |
| `.claude/worktrees/agent-a18a45921e9865aec` | `feat/roles-access` | `f3b530e79a1ac93cb55ff519adf57fcc638fe342` | 21 | 0 | Yes | — |
| `.claude/worktrees/agent-a4379bd89a9ae5fe8` | `feat/ui-system` | `56fe3505043ffd2eb7a1847a8b2c05c7bc80413d` | 22 | 0 | Yes | — |
| `.claude/worktrees/agent-a51196678d944e508` | `worktree-agent-a51196678d944e508` | `eb3b0eb6f966a4e670a6758a5e679beac94ad5a6` | 61 | 0 | Yes | app/assets/page.tsx; app/audit/page.tsx; app/buy-list/page.tsx; app/components/appnavbar.tsx; app/components/statpack-checkoff-modal.tsx; app/dashboard/member-dashboard.tsx; app/dashboard/page.tsx; app/inventory/page.tsx; app/member/report/page.tsx; app/page.tsx; app/profile/page.tsx; app/restock/page.tsx; app/roster/page.tsx; app/statpacks/[id]/page.client.tsx; app/statpacks/checkin/page.tsx; app/statpacks/checkout/page.tsx; app/statpacks/page.tsx; app/storage/page.tsx; app/tasks/page.tsx; tailwind.config.ts |
| `.claude/worktrees/agent-a51a5c0fb15c4ea66` | `fix/firestore-rules` | `e0c79feee1889e27ff49abd1b3621905fe452250` | 21 | 0 | Yes | — |
| `.claude/worktrees/agent-a66a182f7fbd750bd` | `worktree-agent-a66a182f7fbd750bd` | `eb3b0eb6f966a4e670a6758a5e679beac94ad5a6` | 61 | 0 | Yes | app/components/statpack-checkoff-modal.tsx; app/dashboard/member-dashboard.tsx; app/member/report/page.tsx; app/statpacks/checkout/page.tsx |
| `.claude/worktrees/agent-a7972a63cc41acb00` | `worktree-agent-a7972a63cc41acb00` | `eb3b0eb6f966a4e670a6758a5e679beac94ad5a6` | 61 | 0 | Yes | app/assets/page.tsx; app/audit/page.tsx; app/buy-list/page.tsx; app/components/appnavbar.tsx; app/components/statpack-checkoff-modal.tsx; app/dashboard/member-dashboard.tsx; app/dashboard/page.tsx; app/fix-timestamps/page.tsx; app/forgot-password/page.tsx; app/inventory/page.tsx; app/issue-reports/page.tsx; app/login/page.tsx; app/member/report/page.tsx; app/page.tsx; app/print-labels/page.tsx; app/profile/page.tsx; app/register/page.tsx; app/restock-stats/page.tsx; app/restock/page.tsx; app/roster/page.tsx; app/statpacks/[id]/page.client.tsx; app/statpacks/checkin/page.tsx; app/statpacks/checkout/page.tsx; app/statpacks/page.tsx; app/storage/page.tsx; app/tasks/page.tsx; tailwind.config.ts |
| `.claude/worktrees/agent-a9834950fa26e3dd8` | `feat/inventory-hygiene` | `14bc2af7501416af8bcaa1b65b7e2cb9164505a6` | 19 | 0 | Yes | — |
| `.claude/worktrees/doctor-claude-md-trim` | `worktree-doctor-claude-md-trim` | `612ab54738833e4c2e09e88768c864fb47ee1cc4` | 37 | 1 | No | — |
| `.claude/worktrees/fix-duplicate-deploy-workflow` | `worktree-fix-duplicate-deploy-workflow` | `1087471dc5cfd0b624b4922c4e5f27a928737e6f` | 4 | 1 | No | — |
| `.claude/worktrees/fto-intern-attendance` | `worktree-fto-intern-attendance` | `c49c8ca0e4cc3f3d635b107c81b731ab29624136` | 40 | 1 | No | — |
| `.claude/worktrees/integration-overhaul` | `integration/overhaul` | `0afd2bcb91ef620eaf7b123156b83b406a1e3570` | 8 | 4 | No | — |
| `.claude/worktrees/mobile-tour-panel-fixes` | `worktree-mobile-tour-panel-fixes` | `2fa67097c4c02a48f9cca5cd9ef5feffa835666b` | 40 | 1 | No | — |
| `.claude/worktrees/tableau-stats` | `worktree-tableau-stats` | `ba4d6db78ad6efa12efbab51874952436c771eeb` | 37 | 1 | No | — |
| `.claude/worktrees/w2-assets` | `feat/assets-expiry` | `ee59a261606738902b5911ea5483f6be1ddf4da2` | 8 | 9 | No | — |
| `.claude/worktrees/w2-hygiene` | `feat/inventory-hygiene-w2` | `dc70c1d4609917779d8de52ed5443a41f461ab95` | 8 | 6 | No | — |
| `.claude/worktrees/w2-roles` | `feat/roles-access-w2` | `46a11ad0ad7b45dde2f02f5f0a954b6f5258e7ab` | 8 | 6 | No | — |

The three dirty legacy worktrees are `agent-a51196678d944e508` (20 modified files), `agent-a66a182f7fbd750bd` (4), and `agent-a7972a63cc41acb00` (27). The root checkout also had two untracked plan/review documents at capture time. The new audit file itself is necessarily created after that snapshot and is not included in the captured root dirty list.

## Local and remote branch refs

All 51 branch refs present in the captured ref inventory are listed. Counts use the same `origin/main` base and ancestry interpretation above. `Merged` means ahead = 0.

| Ref | Behind | Ahead | HEAD merged into base? |
|---|---:|---:|---|
| `chore/ci-hosting-fix` | 36 | 1 | No |
| `codex/workflow-remediation-phase-1` | 0 | 0 | Yes |
| `feat/assets-expiry` | 8 | 9 | No |
| `feat/inventory-hygiene` | 19 | 0 | Yes |
| `feat/inventory-hygiene-w2` | 8 | 6 | No |
| `feat/purchases-budget` | 25 | 0 | Yes |
| `feat/roles-access` | 21 | 0 | Yes |
| `feat/roles-access-w2` | 8 | 6 | No |
| `feat/statpack-checkin-fast-path` | 27 | 0 | Yes |
| `feat/statpack-partial-restock` | 33 | 0 | Yes |
| `feat/statpack-restock-flag` | 24 | 0 | Yes |
| `feat/ui-system` | 22 | 0 | Yes |
| `feat/uniforms` | 25 | 0 | Yes |
| `feat/waitlist-p0-schema` | 36 | 3 | No |
| `feat/waitlist-p05-rules` | 36 | 5 | No |
| `feat/waitlist-p1-queue` | 36 | 6 | No |
| `feat/waitlist-p2-tiers` | 36 | 7 | No |
| `feat/waitlist-p3-reminders` | 36 | 19 | No |
| `fix/firestore-rules` | 21 | 0 | Yes |
| `integration-2026-08-06` | 37 | 11 | No |
| `integration/overhaul` | 8 | 4 | No |
| `main` | 25 | 0 | Yes |
| `plan/platform-overhaul` | 25 | 10 | No |
| `worktree-agent-a18a45921e9865aec` | 25 | 0 | Yes |
| `worktree-agent-a4379bd89a9ae5fe8` | 25 | 0 | Yes |
| `worktree-agent-a51196678d944e508` | 61 | 0 | Yes |
| `worktree-agent-a51a5c0fb15c4ea66` | 25 | 0 | Yes |
| `worktree-agent-a66a182f7fbd750bd` | 61 | 0 | Yes |
| `worktree-agent-a7972a63cc41acb00` | 61 | 0 | Yes |
| `worktree-agent-a9834950fa26e3dd8` | 25 | 0 | Yes |
| `worktree-doctor-claude-md-trim` | 37 | 1 | No |
| `worktree-fix-duplicate-deploy-workflow` | 4 | 1 | No |
| `worktree-fto-intern-attendance` | 40 | 1 | No |
| `worktree-mobile-tour-panel-fixes` | 40 | 1 | No |
| `worktree-tableau-stats` | 37 | 1 | No |
| `origin/feat/assets-expiry` | 8 | 9 | No |
| `origin/feat/inventory-hygiene` | 19 | 0 | Yes |
| `origin/feat/inventory-hygiene-w2` | 8 | 6 | No |
| `origin/feat/inventory-units-display` | 3 | 0 | Yes |
| `origin/feat/roles-access` | 21 | 0 | Yes |
| `origin/feat/roles-access-w2` | 8 | 6 | No |
| `origin/feat/statpack-checkin-fast-path` | 27 | 0 | Yes |
| `origin/feat/statpack-partial-restock` | 33 | 0 | Yes |
| `origin/feat/statpack-restock-flag` | 24 | 0 | Yes |
| `origin/feat/ui-system` | 22 | 0 | Yes |
| `origin/feat/waitlist-p3-reminders` | 36 | 19 | No |
| `origin/fix/firestore-rules` | 21 | 0 | Yes |
| `origin/main` | 0 | 0 | Yes |
| `origin/plan/platform-overhaul` | 25 | 10 | No |
| `origin/testing` | 104 | 0 | Yes |
| `origin/worktree-fix-duplicate-deploy-workflow` | 4 | 1 | No |

## Scope note

This file records the branch/worktree portion of plan item 0a. It does not integrate, rebase, clean, or delete any branch/worktree, and does not verify live Hosting state.
