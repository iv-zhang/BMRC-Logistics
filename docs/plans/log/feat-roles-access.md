# Log: feat/roles-access

## Packets done
- R1 · `app/lib/roles.ts` capabilities, `treasurer` role, `privateFinanceRoles` setting · 7a50459 · `scripts/test-roles.ts` 133/0; tsc 0 errors outside the 5 known o2 tests; eslint 0 new
- R2a · lib/components/dashboard: 13 inline admin/QM checks -> `canManageLogistics` (12 files) · 1dbd8f2 · tsc 0 new; eslint identical to baseline (65 problems)
- R2b · route pages: 22 checks -> `canManageLogistics` (19 files) · 504c9fe · tsc 0 new; eslint identical to baseline (15 problems); after both: `npm run test` 69/0 + 133/0, `NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run build` pass; smoke driver NOT run (drive the sandbox before merge)
- R4 · `firestore.prod.rules` per-role rules + `app/lib/__tests__/rules.test.ts` (`npm run test:rules` now runs only this file) · 313143a; re-cut onto `main` 2026-10-17 as `claude/r4-per-role-rules` · rules suite 92/0; tsc 0 new; eslint clean; NOT deployed (deploy is a separate reviewed step, see fix-firestore-rules.md)

## R4 write table (every Firestore write in `app/`, by who can reach it in the UI)
Roles: M = admin/QM, EM = admin/QM/medops, OP = admin/QM/inventory_helper/any user with `canAudit`, ALL = any signed-in. "Rule" is what the rules now enforce.

| Collection | Writers in the UI | Rule (create / update / delete) |
|---|---|---|
| users | self (register, sidebar self-heal, tour, certs); M/medops roster; admin test identities | unchanged from stopgap |
| org_settings | M (/settings); seed by non-admin is swallowed | M / M (only admin may change `privateFinanceRoles`) / admin |
| dashboards | own layout: ALL; `published__*`: M | owner-or-M; published = M |
| events | EM create/edit/delete; ALL via cancelRequest (`teams` only) | EM / EM, or ALL touching only `teams`+`updatedAt` / EM |
| shift_requests | requester (own); EM approve/reject/retro; FTO + statpack check-in sweep write `attendance` | own userId or EM / EM, or ALL only `attendance`, or requester cancelling own / M |
| notifications | ALL create (member request broadcast, check-in flag); recipient marks read; test identity delete | ALL / recipient or M, `read` only / M. Read = recipient or M |
| inventory | consumables: OP (audit, intake, receive, merge); assets: ALL (checkout/checkin); delete: M buttons | OP / OP, or ALL on `isAsset` docs touching only checkout fields / M |
| inventory_logs, statpack_logs, auditEvents, box_logs, medication_logs, exchange_bag_events, apparel_claims, inventory_alerts | ALL append | ALL / M / M |
| barcode_index, audit_locks | OP | OP all |
| storage_zones, shelves, containers | edit in settings: M; inline create in audit picker: OP; merge repoints containers: OP | OP / M (containers also OP for `boxContents`+`updatedAt`) / M |
| statpacks | check-off/audit: ALL (update); create (duplicate) and delete: admin buttons | M / ALL / M |
| vehicles, vehicle_logs | roster: M; checkout/checkin: ALL | vehicles M / ALL / M; vehicle_logs ALL / ALL / M |
| exchange_bags | editor: M; swap at check-off: ALL | M / ALL / M |
| restock_categories, restock_shelf_events, restock_actions | /restock hard-gated to M; merge repoints categories: OP | M (categories: OP may touch `itemRestocks`) |
| issue_reports, restock_reports | create: ALL; triage/resolve/delete: M page | ALL / M / M |
| team_tasks | committee members + check-in flag (ALL) edit; delete admin button | ALL / ALL / M |
| tasks (dead), vendors, laf_records, purchase_history, purchase_requests, apparel_categories | M only in UI | M (purchase_requests read M too; `tasks` OP may repoint `linkedInventoryId`) |
| buyList | M manage; medops request (R3); merge repoint: OP | M or medops / M, medops `quantity` only, OP `linkedInventoryId` only / M |
| purchases | Log Purchase M; receive: helper + M | M, no payment fields unless admin / M or helper (payment fields admin; treasurer payment fields only) / M. Read: M, treasurer, helper |
| `**/private/*` | none yet (plan §4 P2) | read: admin always + `privateFinanceRoles` (default admin); write: M + treasurer |
| apparel_items | members list/claim/waitlist | ALL |
| uniform_orders, uniform_rounds, loaner_checkouts | none yet (provisional) | read own (`userId`) or M/treasurer; write M |
| anything unlisted | n/a | stopgap floor: signed-in top-level docs only |

## 2026-10-17 re-check on current `main` (38 commits after the 2026-09-30 base f3b530e)
- Rules suite `npm run test:rules` (via `npx firebase-tools@13.35.1`): **92/0**. `npm run test`: pass. tsc: 0 new errors (only the 5 known o2-test ones). eslint is clean on `rules.test.ts`.
- Write-path audit of every Firestore write that is new or changed since f3b530e: **none is denied**.
  - Buy-list delivery and post-intake (`buyList` update): admin/QM only, so covered by `callerIsAdminOrQm()`.
  - Intake stock posting (`addShipment`): `inventory` update by an operator, plus creates of `inventory_logs/intake_*` and `auditEvents`.
  - `submitAuditEntries`, now a transaction: operator inventory update, plus log creates.
  - The audit-cadence setting (`org_settings`, admin/QM), `createReport`, and the check-off gate. The check-off gate writes no new fields.
  - No new collections. `retireInventoryItem` has no caller yet; check its rule if a UI is added.
- **Merging does not deploy rules.** CI deploys hosting only. A human must run `firebase deploy --only firestore:rules --project <prod>`, and should do it only after the staging pass below.
- No record exists that the S1–S3 stopgap was ever deployed by hand (S4). **Live rules may still be the wide-open ones.** That's an open finding; you need to check it in the Firebase console under Firestore → Rules.

### Staging checklist before the prod rules deploy
1. `firebase deploy --only firestore:rules --project staging`, then `npm run seed:staging` and `npm run dev:staging` (see STAGING.md).
2. **member**: statpack checkout, then check-in; vehicle checkout/check-in; submit a report; request a shift slot; cancel your own request; mark a notification read. All should succeed. Opening `/inventory` by URL and trying an edit should be **denied**.
3. **FTO**: check yourself in, then check in a teammate, then end the shift for your own team.
4. **medops**: create/edit an event; approve a request; retro-edit attendance; request a buy-list item. Any inventory edit should be **denied**.
5. **inventory_helper**: audit count; Move; Shipment; receive a purchase.
6. **QM**: buy-list "Receive delivery", both "Add to stock" and "intake later" then "Post intake"; edit `/settings`; publish a `/stats` layout.
7. **Logged out**: the live site should show the login screen and no data.

## Left open, needs a decision
- **Member-reachable updates left at "any signed-in"**: `statpacks` update, `vehicles` update, `vehicle_logs` create/update, `exchange_bags` update, `team_tasks` create/update, `apparel_items`, and the ledger/log creates. Each is written by every member in check-off/vehicle/uniform flows and is not field-limited, so a member could still edit a pack/vehicle outside those flows.
- **`events.teams` and `shift_requests.attendance` are writable by any signed-in user.** Needed for member cancel-approved (rewrites `teams`), the assigned FTO (assigned by slot, not role) and the auto end-shift sweep that any member's statpack check-in runs on other members' rows. Cannot be narrowed without moving those writes server-side.
- **`canAudit` is honoured for any role** (including medops) for inventory create/update, storage create, barcode, locks: the UI does (`canUserAudit`), so plan "medops read-only" holds only for a medops without the flag.
- **`notifications` create is unrestricted** (needed for member -> manager broadcasts); a member can spoof one.
- **Reads kept signed-in** for everything except `notifications` (recipient), `purchases` (M/treasurer/helper), `purchase_requests` (M), `private/*`, and uniform/loaner docs. `users`, `medication_logs`, `purchase_history`, `issue_reports` are still readable by every signed-in user.
- **QM "Reset to defaults" in /settings fails** while the stored `privateFinanceRoles` differs from `['admin']` (only admin may change that list). Admin can still reset.
- **`private/*` write set** (M + treasurer) and the payment field names (`paidAt`, `paidFrom`, `asucPrNumber`, `reimbursedAt`, ...) are provisional until P2; `purchases` update by `inventory_helper` covers receive, a plain `canAudit` member using the inventory page by URL cannot receive.
- **Treasurer may read all `uniform_orders`/`loaner_checkouts`** (plan: canViewLogistics 'full'); the task text said members-own only, tell me if the treasurer should not.
- `rules-stopgap.test.ts` is now redundant and stale (2 of its 25 cases assert the old open behavior and fail); its cases are folded into `rules.test.ts`. Left in place per the no-delete rule; the deletion is yours to approve.

## Findings from R4 (not yet folded)
- `app/inventory/page.tsx:970-976`: "Merge selected" is not gated by `isAdmin`; any inventory-page user can start a destructive merge (rules allow only the exact repoint fields for operators).
- Stats comments claiming "role-gated by firestore.rules" (`useStatsData.ts`, `stats/page.tsx`, `dashboards.ts`) are now true for `published__*`.
