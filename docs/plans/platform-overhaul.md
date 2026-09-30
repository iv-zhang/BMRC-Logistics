# Platform overhaul plan

Status: **v5, wave 0 + wave 1 landed 2026-09-30; paused for your review before wave 2** · Updated 2026-09-30 · Plan branch `plan/platform-overhaul`

**Scope:** Logistics + MedOps spending and stock. Three documents stay the source of truth for their own areas,
and the app **feeds** them, never duplicates them:
- Treasurer's **Budget Tracker 2026-2027** (official club ledger) ← app exports rows matching its *Expenses* tab headers.
- **BMRC_Standby_Venture_Forecast_v6.xlsx** (statements, cash flow, scenarios) ← app supplies the *actual* values for the
  logistics lines: medical supplies at cost (currently a placeholder), merchandise inventory, equipment register,
  reimbursements owed, member deposits, and the uniform term ledger.
- **Budget 26-27** (department budgets) ← entered once per FY in `/settings`.

The app does **not** compute depreciation, cash-flow, or club-wide statements. The workbook does that.

## Branches (all off `main` @ f9943a1, empty)

| # | Branch | What | Size | Merge order |
|---|---|---|---|---|
| 0 | `fix/firestore-rules` (**new, urgent**) | Stop wide-open production rules; make them impossible to redeploy by accident | S | **first, ASAP** |
| 1 | `feat/inventory-hygiene` | Confirmed stock (≥ 2026-06-01), audit-cadence setting, variant-safe merge, easy containers | M | 2nd |
| 2 | `feat/ui-system` | Shared primitives + anti-clutter; U1 merges early | L | U1 early, rest last |
| 3 | `feat/roles-access` | Capabilities, `treasurer`, medops read-only logistics, full production rules + private docs | M | 3rd |
| 4 | `feat/assets-expiry` | **A**: asset lifecycle + register, component expiry, 30/60/90, reorder cost, shrinkage, supplies-at-cost | M | 4th |
| 5 | `feat/purchases-budget` | **B**: lifecycle dates, paid_from, ASUC PR#, budgets, `/finance`, Treasurer CSV, forecast feed | L | 5th |
| 6 | `feat/uniforms` | **C + D**: rounds, questionnaire import, custody, vendor-by-size, distribution, stock, patches, loaners | L | 6th |

```
now:     [0 rules stopgap]
wave 1:  [1 hygiene]   [3 roles R1-R2]   [2 U1]
wave 2:  [4 assets-expiry]   [3 roles R3-R4]   [2 page migrations]
wave 3:  [5 purchases-budget]
wave 4:  [6 uniforms]
wave 5:  [2 U-seam]
```

---

## 0. Operating rules (for Sonnet/Haiku subagents)

1. `git switch <branch>` (or a worktree; replay any dirty tree first).
2. The subagent gets: packet text + **Skills** + "only touch files under *Owns*."
3. It ends with `npx tsc --noEmit` + `npm run lint` on its files and reports its file list and open questions. Never commit,
   never run the smoke driver, never run a migration/seed live, never deploy rules.
4. The orchestrator (**O**, Opus) does seams, rebases, `decisions.md`, §9 Status, and [findings.md](findings.md).
5. **Review gate:** each wave stops when its packets land. Nothing from the next wave starts until the user has
   manually reviewed the branches and said "go". Agents never chain into later packets on their own.
6. **Read only what you need.** Agents read this file's header (to the first `---`), §0, **their own branch's section**,
   their branch log, and their branch's section of [findings.md](findings.md). Open another § only when your packet
   cites it (e.g. §7 fixtures). Don't read other branches' sections or logs.
7. **Branch log = open work only.** `docs/plans/log/<branch>.md` holds: one line per packet done (+ commit), open
   questions, and new findings not yet folded. When O folds a finding into findings.md, or it's fixed, or it becomes
   a decision (→ `decisions.md` via O), **delete it from the log**. No verification transcripts; one result line per packet.
8. **Known environment noise (not your bug):** `tsc` errors in `app/lib/__tests__/o2-*.test.ts` (`vitest` missing, T-D1).
   Build without `.env.local` as `NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run build` (demo key, touches
   nothing real). Any emulator script passes `--config firebase.emulator.json`.

**Never delete or rename a repo file without asking the user first**; list it in the report instead.
Packets in the same wave own **disjoint files**. A `decisions.md` conflict means stop. New non-admin writes get flagged.
New money code uses **integer cents**. Unknown = `null`, never 0. **No member PII (names, emails, handles) in logs,
tests, fixtures, or reports**; fixtures use fake names.

Model key: **H/low** Haiku · **S/med** Sonnet · **O** orchestrator.

---

## 0.5 URGENT: production Firestore is open to the internet (`fix/firestore-rules`)

**What we found:** the rules you pasted from the console are the repo's *emulator-only* file
(`allow read, write: if true`). It's the older revision, without the `/dashboards` block added on 2026-08-06, so it was
deployed at some point between Jul 4 and Aug 6. `firebase.json` pointed `firestore.rules` at that emulator file, so a
bare `firebase deploy` would ship it, but `.firebaserc` defaults to `bmrc-staging`, so prod was likely hit via an
explicit `--project` or a console paste (see §10). The CI workflows deploy hosting only.

**Impact:** the Firebase web config ships inside the public JS bundle. Anyone who opens the site can read, write, or
delete **every collection** without logging in: member names/emails, roles (including making themselves admin),
inventory, events.

| ID | Model | Owns | Task |
|---|---|---|---|
| **S1** | O | `firestore.prod.rules` (new) | **Stopgap** (keeps every current app flow working): signed-in required everywhere; `users/{uid}` create only by self with `role == 'member'` (matches `register/page.tsx:80`); self-update may not change `role`; admin/QM/medops may update other users (roster, D-15); all other collections = signed in. |
| **S2** | O | `firebase.json`, `firebase.emulator.json` (new), emulator/sandbox scripts, `.github/copilot-instructions.md` | `firestore.rules` stays where it is (no rename). Production `firebase.json` points at `firestore.prod.rules`; the new `firebase.emulator.json` points at the open `firestore.rules`, and emulator/sandbox scripts pass `--config firebase.emulator.json`. A bare `firebase deploy` can then never ship open rules again. |
| **S3** | S/med | `app/lib/__tests__/rules-stopgap.test.ts` (new) | Emulator test with prod rules loaded: anonymous read/write denied; register works; self role change denied; roster edit by medops works; normal member flows (check-off, shift request, issue report) work. |
| **S4** | **you** | none | Deploy from the tip of the branch: `firebase deploy --only firestore:rules --project <PROD_PROJECT_ID>` (id = `NEXT_PUBLIC_FIREBASE_PROJECT_ID` in `.env.local`; no `--config`). Optional dry run on staging first: `--project staging` + `npm run dev:staging`. Then open the live site logged out: login screen, no data. |

Remaining risk after the stopgap: anyone can register an account and then read/write logistics data. R4 closes that
with per-role rules. Signups could also be restricted to `@berkeley.edu` later (**S-D1**).

---

## 1. Consumable hygiene (`feat/inventory-hygiene`)

Unchanged from v2 except as noted:
- `existence: confirmed|unverified|retired`. **Baseline cutoff `lastAuditDate >= 2026-06-01`.**
- `thresholds.auditCadence` (monthly default; quarterly/semester/yearly selectable) amends D-6.
- `/inventory` shows confirmed only by default. The `/audit` Unverified queue has *Found it* / *Doesn't exist → retire*.
  Unverified items are excluded from alerts and restock.
- `variantSignature` gates merge (size/`size N`/Fr/mm/in/mL/gauge, S–XL, adult/peds/infant, triage colors); cross-variant
  SKU/barcode → `conflict`. The ALCO Required Equipment tab is both the naming standard and the test corpus. Families
  are seeded from it.
- Containers: **On shelf | In a container** control, `Container.kind`, variant-matched bin first, **Split by size** helper.

Packets **H0–H8 + H-seam** as in v2 (H0 diagnose-merges · H1 naming/merge + tests · H2 types/status/stamping/retire/cadence ·
H3 baseline migration · H4 inventory page · H5 audit queue + retire · H6 picker/editor · H7 split-by-size · H8 cadence
setting · H-seam dashboard/restock/stats + D-32/D-33).
Waves: H0 H1 H2 H6 H8 → H3 H4 H5 H7 → H-seam.

---

## 2. Roles & access (`feat/roles-access`)

`app/lib/roles.ts` holds capabilities only; no page ever compares role strings again:

| Capability | admin | QM | treasurer | medops | member |
|---|---|---|---|---|---|
| `canManageLogistics`: purchases, inventory, uniforms (old `isAdmin`) | ✓ | ✓ | | | |
| `canViewLogistics` | ✓ | ✓ | ✓ | inventory + expirations only | |
| `canRecordPayment`: mark paid / reimbursed / payment confirmed | ✓ | | ✓ | | |
| `canRequestSupplies` → `buyList` request | ✓ | ✓ | | ✓ | |
| `canSeePrivateFinance`: payee names, Zelle/Venmo handles | ✓ | configurable | configurable | configurable | |
| `canManageEvents` (unchanged) | ✓ | ✓ | | ✓ | |
| Own uniform balance + own loaners | ✓ | ✓ | ✓ | ✓ | ✓ |

`canSeePrivateFinance` reads `org_settings.privateFinanceRoles` (**default `['admin']`**, editable in `/settings`).
Private fields live in `…/private/*` docs that the rules only let those roles read.

| ID | Model | Owns | Task |
|---|---|---|---|
| **R1** | S/med | `app/lib/roles.ts` + test, `app/types.ts` (role union), `app/config/org-config.ts` + store (`ROLES += treasurer`, `privateFinanceRoles`) | Capability functions. |
| **R2a/b** | H/low ×2 | 28 inline `isAdmin` sites, split in two | Mechanical, behavior-preserving → `canManageLogistics(role)`. |
| **R3** | S/med | sidebar, bottom nav, `app/inventory/page.tsx`, `app/dashboard/page.tsx`, `buy-list-panel.tsx`, `app/lib/buy-list.ts`, `member-dashboard.tsx` | Read gates; medops/treasurer read-only nav; "Request supplies" → `buyList`; retire dead `purchase_requests`. **After hygiene merges.** |
| **R4** | S/med | `firestore.prod.rules`, `app/lib/__tests__/rules.test.ts` | Full per-role rules replacing the stopgap: logistics writes = manage roles; payment fields = admin/treasurer; `private/*` = `privateFinanceRoles`; members read their own uniform/loaner docs only. |
| **R-seam** | O | `decisions.md`, `CLAUDE.md` roles section | **D-34** capabilities + treasurer + privateFinanceRoles; **D-13 amendment** (medops read-only logistics + supply requests; restock notifications still exclude medops). |

---

## 3. Goal A: inventory, expiration, assets (`feat/assets-expiry`)

### What changed with the workbook
- Its **Balances §3 equipment register** has columns Item · Category · **Owner** · Qty with a **$500 capitalization
  threshold**. That matches the app's existing `ASSET_VALUE_THRESHOLD = 500`. Some gear isn't BMRC's (UTV → OEM,
  N95s → UCPD), so assets need an **owner**. Only BMRC-owned items at or above the threshold count as capitalized.
- **Medical supplies on hand (at cost)** is a placeholder the workbook is waiting on. Consumable valuation comes back into scope.

### Design
- Asset fields: `lifecycle` (active/loaned_out/lost/damaged/retired) + dated `lifecycleHistory`, `assetTag`,
  `owner` (org-config list: BMRC, OEM, UCPD, …), `acquiredAt`, `acquisitionCostCents`, `sourcePurchaseId`, `assignedTo`.
  Readiness (Ready/Not Ready) stays a separate axis. Same fields on `AssetInstance`.
- `app/lib/expiry.ts`: expired/≤30/≤60/≤90 (`thresholds.expiryBuckets`) over lots **and** asset components (pads/batteries).
  `reorderCostExpiringThisFY`. `shrinkage(fy)` = lifecycle → lost/damaged/retired in the FY × original cost.
- `app/lib/valuation.ts`: **medical supplies on hand at cost** = reserve lots × lot cost (FIFO from `batch.purchase`),
  plus shelf pool × latest cost (flagged *estimated*). Confirmed items only. Reported as "$X valued · N items with no
  cost" so the gap is visible. Also the **equipment register** export in the workbook's §3 column order.
- `app/lib/fiscal.ts` (FY Jul–Jun from `fiscalYearStartMonth`; "FY27" = Jul 2026–Jun 2027) lives here; later branches import it.

| ID | Model | Owns | Task |
|---|---|---|---|
| **A1** | S/med | `app/types.ts` (asset fields), `app/lib/asset-lifecycle.ts`, `app/lib/fiscal.ts` + tests, org-config + store (`fiscalYearStartMonth`, `expiryBuckets`, `assetOwners`) | Types, lifecycle writes (history + `inventory_logs` + `auditEvents`), FY helpers. |
| **A2** | S/med | `app/lib/expiry.ts`, `app/lib/valuation.ts` + tests | Buckets, reorder cost, shrinkage, supplies-at-cost, register rows. |
| **A3** | S/med | `app/assets/page.tsx` | Lifecycle control + history, tag/owner/acquired/cost, per-component expiry. |
| **A4** | S/med | `app/dashboard/page.tsx` | Replace the hardcoded `d <= 60` widget (`:199,216`) with 30/60/90/expired, reorder cost this FY, shrinkage list. |
| **A5** | H/low | `app/components/intake-wizard.tsx` | Optional unit cost + "Donated / unknown". |
| **A6** | S/med | `scripts/backfill-asset-acquisition.cjs` | Dry-run: cost/date from `batch.purchase`; seed the workbook's §3 register rows (AEDs ×3, stat packs ×3, manikins 4+8, UTV owner OEM, N95s owner UCPD) where no matching record exists, flagged for review. |
| **A-seam** | O | `decisions.md` | **D-35** lifecycle ≠ readiness; owner + capitalization; valuation method. |

---

## 4. Goal B: purchases, budget, `/finance` (`feat/purchases-budget`)

### Design
- **Lifecycle = dates, stage derived:** `requestedAt → approvedAt → orderedAt → receivedAt → paidAt → reimbursedAt`.
  These map onto the Treasurer's columns: *Date Submitted* = requestedAt, *Date Approved* = approvedAt,
  *Reimbursed?* = reimbursedAt set.
- `paidFrom: asuc|misc|venmo_zelle|grant|other` → the Treasurer's `ASUC Fund?` / `Misc Funds?` / `Venmo/Zelle?` booleans.
  `asucPrNumber` (e.g. `#1866980`) → `PR Number`. `invoiceNumber` + `invoiceUrl` (**Drive link**).
  **Payee** (member owed money) → `purchases/{id}/private/payment`.
- `department` + `budgetLine`, both from config. Seeded from Budget 26-27: **Logistics $1,700** (Uniforms $1,400,
  Misc supplies $300) and **MedOps/Training $1,000**, with the post-insurance scenario (Logistics $1,950, MedOps
  $3,000) stored as an alternate. **Default = pre-insurance.** Flip only when the policy is actually *bound*, not when it's voted on
  (as of 9/29 the quote was extended ~1 month and a 10/5 meeting is pending).
- **Cash basis.** Spent(FY) = paid in FY. Committed = ordered, not paid. View per department/line:
  **Budget · Spent · Committed · Remaining**. Uniform lines are also shown **net of member collections**, because
  uniforms are pass-through (members pay first).
- **Cross-FY:** each purchase shows its order FY and paid FY; a "Carried over" list covers ordered in N, paid or unpaid in N+1.
- **Liabilities** (the three lines the workbook's Balances tab asks for):
  - *Accounts payable* = invoice received, org owes the vendor, not paid;
  - *Reimbursements owed to members* = `paidFrom=asuc`, member paid, not reimbursed; aging + ASUC deadline warning (`asucDeadlines[FY]`);
  - *Member deposits* = uniform money collected for items not yet delivered (from `feat/uniforms`).
- **`/finance`** tabs: Overview · Purchases · Reimbursements · Data quality · **Exports**:
  1. **Treasurer CSV**, headers exactly: `Payee, Cost, Reasons of Purchase / Items Purchased, Reimbursed?, Date Submitted,
     Date Approved, PR Number, ASUC Fund?, Misc Funds?, Venmo/Zelle?` (+ `Category`, `Confirmed?`).
     The Payee column is blank unless the viewer can see private finance.
  2. **Forecast feed** (one CSV per workbook section): Balances lines (merch inventory, medical supplies at cost,
     AP, reimbursements owed, member deposits), §2 merchandise table, §3 equipment register, Uniforms term ledger rows.
  Both are also printable.

| ID | Model | Owns | Task |
|---|---|---|---|
| **P1** | S/med | `app/types.ts` (purchase fields, `PurchasePrivate`), org-config + store (paidFrom, departments/lines, `budgets[FY]`, alternate scenario, `asucDeadlines`) | Types + config + FY27 seed values. |
| **P2** | S/med | `app/lib/purchases.ts` | approve/paid/reimbursed/invoice actions, private payee write, `auditEvents`; stamp asset acquisition on receive. |
| **P3** | S/med | `app/lib/finance/*.ts` + tests | budgetView, liabilities, carriedOver, dataQuality, `treasurerCsv`, `forecastFeed`. Fixtures in §7. |
| **P4** | S/med | `purchase-modal.tsx`, `receive-drawer.tsx`, `app/components/purchases/payment-actions.tsx` (new) | Order-time fields; actual invoice total at receive; Mark paid/reimbursed. |
| **P5** | S/med | `app/finance/page.tsx`, `app/components/finance/*`, nav entries | Page on U1 primitives (`bmrc-new-page` skill). |
| **P6** | H/low | `app/components/settings/budget-section.tsx` + registration | Budgets, FY start, ASUC deadlines, paidFrom list, `privateFinanceRoles`. |
| **P7** | S/med | `scripts/backfill-purchase-lifecycle.cjs` | Dry-run; `paidAt` = `receivedAt` flagged `paidAtEstimated` for Data quality. |
| **P-seam** | O | `app/lib/stats/procurement.ts`, `decisions.md`, `MODEL.md` | `/stats` spend = `/finance` spent to the cent; **D-36**. |

---

## 5. Goals C + D: uniforms, patches, loaners (`feat/uniforms`)

### What the Drive + workbook research changed
- The **Fall 2026 questionnaire** (Lang's Google Form) is the real intake: name, email, new/returning, grad year, tee size
  (S–XL), quarter-zip yes/no + size (S–L), already-owns checklist, needs patches, payment method (Zelle to Lang /
  cash at training), loaner interest. Tracker-added columns: `paid?`, `amount owed`, `amount paid`.
  **Known flaw:** the form can't skip the tee, so 6 returning members who wanted a zip only have `amount owed`
  overstated by $90 in total (the workbook caught this). Import must use `amount paid` + the free-text note, not the form's tee answer.
- Payments were **manually verified against Lang's Zelle**, so each imported payment gets `confirmedBy`/`confirmedAt`.
  This maps to the Treasurer's `Confirmed?` column.
- **Custody:** the $1,500 sits in Lang's personal Zelle (the workbook flags this). Each round records a
  **custodian** and the "**surplus to remit to Treasurer**" ($143.73 for Fall 2026), plus a `remittedAt` stamp.
- Workbook numbers: **landed unit cost incl. 9.25% tax** (tee $13.57, zip $27.12). Proposed patch prices: CA patch $4,
  BMRC patch $6 (cost recovery), but **not adopted**: patch price and design are pending treasurer/board sign-off.
  Patch member price defaults to **`null` (TBD)**. The UI shows "price TBD", owed totals exclude TBD lines and flag
  them, and the user fills the price in later. **Opening stock 7/1/26:** zips 21 (S2/M4/L15) @ $27.12, tees 19 @ $13.57, old BMRC
  patches 16 @ $5.82, "Berkeley MRC" patches 22 @ $5.82, CA EMT patches 1 @ $3.69 = **$1,052.21**.
- An old **Loaner Log** tab (Borrower · Item · Checkout Date · Return Date; several still unreturned) lives in
  "BMRC Old uniform catalog". Import open loans. Pants and uniforms there use waist-inseam / cut codes, so loaner sizes
  stay free text.
- The Uniform Plan doc recommends a **~15-piece BMRC loaner pool** (S–L) → loaner stock is a first-class list.

### Design (additions to v2)
- `uniform_rounds`: catalog per round (item, sizes, **member price**, **landed unit cost**), `custodian`, `vendorPurchaseId`,
  `vendorQtyBySize`, status, `surplusRemittedAt`.
- `uniform_orders`: per member, lines + payments `{amountCents, method: zelle|venmo|cash, paidAt, confirmedBy, confirmedAt}` + refunds;
  contact details → `private/contact`.
- Derived: owed/paid per member · **member deposits** (collected − refunded for undelivered lines) · ordered vs paid by size
  · round surplus/deficit · leftover stock (opening + received − distributed) valued at landed cost, which feeds the
  workbook's *Merchandise inventory*.
- Patches: stock by type with landed cost + issuance log. Loaners: `loaner_checkouts` + overdue/lost (`loanerLostAfterDays`, default 30).
- Member "My uniforms" card on `/profile`.

| ID | Model | Owns | Task |
|---|---|---|---|
| **C1** | S/med | `app/types.ts` (uniform types), `app/lib/uniforms/{rounds,orders,derive}.ts` + tests | Writes + derivations; §7 fixtures. |
| **C2** | S/med | `app/lib/uniforms/{patches,loaners}.ts` + tests | Patch stock/issuance, loaner overdue/lost. |
| **C3** | S/med | `app/uniforms/page.tsx`, `app/components/uniforms/rounds/*` | Rounds list; round detail (collections grid with Confirmed column, vendor-by-size vs paid-by-size, distribution checklist, custody + remit). |
| **C4** | S/med | `app/components/uniforms/{loaners,patches}/*` | Tabs mounted via C3's tab slot. |
| **C5** | H/low | `app/components/uniforms/my-uniforms-card.tsx` + 1 line in `app/profile/page.tsx` | Member self-view. |
| **C6** | S/med | `scripts/import-uniform-questionnaire.cjs`, `.gitignore` (add `imports/`) | Reads a local **CSV export** from `imports/` (git-ignored; no PII passes through agents). Dry-run default. Matches members to `users` by Berkeley email. **Never prints or logs names/emails**: flags reference row number + amounts only (`--show-names` prints names to the terminal on explicit request, never to a file). Must reconcile to **52 responses / 50 paid / 44 tees / 28 zips / $1,500**. Expected flags: **6 zip-only rows owe $45 instead of $30 (+$90 overstated)** → corrected to the amount paid; **2 unpaid rows ($15, $45)** → imported as unpaid, not in the vendor order. Any other difference → print row # and stop. |
| **C7** | S/med | `scripts/seed-uniform-history.cjs` | Dry-run; historical rounds (§7, to the cent), opening stock, patch purchases, open loans from the old Loaner Log CSV. |
| **C-seam** | O | `/finance` Overview + forecast feed (member deposits, merch inventory), `app/lib/expiry.ts` shrinkage (+ lost loaners), `decisions.md` | **D-37**; retire the Exchange's `loaner` disposition in favor of the loaner log. |

---

## 6. UI system (`feat/ui-system`)

Unchanged from v2: primitives in `app/components/ui/` (`PageShell`, `PageHeader`, `StatRow`, `SectionCard`, `Callout`,
`EmptyState`, `ResponsiveModal`, `DataList`, `MoneyText`) in your inventory/dashboard style; anti-clutter rules in
`bmrc-ui`; packets U0 (screenshot pass, needs OK) · U1 (merge early) · U2 (tokenize MapModal; dead files **reported only**, deleted only with your approval) · U3a–f page migrations · U4 modals
(after P4/A5) · U-seam canonical pages last.

---

## 7. Fixtures (must match to the cent)

| Round / order | Lines | Subtotal | Total | Tax + ship |
|---|---|---|---|---|
| Fall 2024 (FY25) | 110 tees @ 10.15 + 62 zips @ 21.64 | 2,458.18 | 2,697.85 | 239.67 |
| Fall 2025 (FY26) | 40 tees @ 13.34 + 30 zips @ 26.00 | 1,313.60 | 1,441.68 | 128.08 |
| Spring 2026 (FY26) | 15 zips @ 31.37 | 470.55 | 514.08 | 43.53 |
| Fall 2026 (FY27), est. #55080, approved 9/24/26 | 44 tees @ 12.42 + 28 zips @ 24.82 | 1,241.44 | 1,356.27 | 114.83 (9.25%) |
| CopQuest 10/8/25 | 45 CA shoulder @ 3.38 | 152.10 | 163.13 | 11.03 |
| 1-800-NameTape | 70 @ 3.25 + 12 ship | 239.50 | 239.50 | 0 |

Fall 2026: collected **$1,500.00** = 44 × $15 + 28 × $30 → surplus to remit **$143.73**; unpaid $60 (2 respondents,
not in the order); member deposits = $1,500 until distributed. Opening merch stock = **$1,052.21**.
Budget FY27: Logistics $1,700 · MedOps/Training $1,000.

---

## 8. Decisions

**Resolved (v4):** B-D1 pre-insurance default, flip only when bound · F-D0 the app feeds the workbook, no statements in the app, Logistics + MedOps only · C-D1 patch price per round, default `null` until board sign-off · questionnaire import from a local git-ignored CSV, no PII in logs · no file deletions without asking.

**Resolved (earlier):** confirmed cutoff 2026-06-01 · unverified excluded from alerts · cash basis + lifecycle dates · FY Jul–Jun "FY27",
configurable · paidFrom list · role matrix · private finance = **admin only**, configurable · invoices = Drive link ·
priority A > B > C > D · uniforms verified via Lang's Zelle · CSV = Treasurer's Expenses headers · the app feeds the
forecast workbook.

| ID | Blocks | Question | Recommendation |
|---|---|---|---|
| **S-D1** | later | Restrict sign-up to `@berkeley.edu` emails? | Yes, after the stopgap ships. |
| **C-D2** | C2 | Loaner lost after N days overdue | 30. |
| **U-D1/2** | U1/U2 | Visual direction; which dead files to delete: `tutorial-overlay.tsx` (no importers; would also trip the `users` create rule if revived), `statpack-import-modal.tsx.new` (duplicate), the `/fix-timestamps` page (unlinked; its lib is still used), `itemNameSimilarity` in `statpack-import.ts` (no callers) | Your style everywhere; **you approve each deletion**. |
| **H-D1** | H-seam | Semester audit window: start at `semesterStartDate` (current, clamped to Jan 1/Jul 1, ignored if future) or a fixed Jan–Jun / Jul–Dec split? | Keep `semesterStartDate`. |
| **H-D2** | H merge | Approve the D-32 (existence + cadence) and D-33 (merge only identical variants) wording in the hygiene branch log | Approve; O copies it into `decisions.md` at merge. |
| **T-D1** | any | Tests run three ways (`vitest` `o2-*` tests never run; `scripts/test-roles.ts`; `node:test` via `npx tsx --test`), and `npm test` runs none of the hygiene tests. `scripts/test-audit-restock.cjs` re-implements the restock logic, so it doesn't test the real code. | One runner: `node:test` + `tsx`, a `test:unit` script chained into `npm test`; fix or delete the `o2-*` tests (your call). |
| **R-D1** | R3 | Should treasurer receive restock notifications (recipients hard-coded admin/QM at `statpack-restock-flag.ts:111`)? | No: they're operational, not finance. |

## 9. Status

| Branch | Status |
|---|---|
| fix/firestore-rules | **S1–S3 done, awaiting your review** (6779f71, 63cd57d, c42a253; `npm run test:rules` 25/25 on emulator; app not driven). **S4: deploy from c42a253 only**, never 6779f71 |
| feat/inventory-hygiene | **H0 H1 H2 H8 done, awaiting your review** (d539160 … ff3f34e; build/test/lint pass, 119 new unit tests, not runtime-verified). Fixes a real merge-across-sizes bug, so **no dedupe in prod until this merges**. **H6 skipped** (needs design calls). Proposed D-32/D-33 text is in the branch log |
| feat/ui-system | **U1 done, awaiting your review** (a980c8d, 9b01e34; built + typechecked, not runtime-verified); U0 needs OK |
| feat/roles-access | **R1 + R2 done, awaiting your review** (7a50459, 1dbd8f2, 504c9fe; tsc/lint/test/build pass, not runtime-verified). 35 `isAdmin` expressions in 31 files → `canManageLogistics` |
| feat/assets-expiry | after hygiene H2 |
| feat/purchases-budget | after R1 + A1; B-D1 |
| feat/uniforms | after P1; C6 needs your CSV export of the responses sheet |

Each in-flight branch keeps a short log at `docs/plans/log/<branch-name>.md` (§0 rule 7). O folds its findings into
[findings.md](findings.md) at each review gate and prunes the log.

## 10. Unassigned findings

Branch-owned findings live in **[findings.md](findings.md)** (one section per branch). Only open items no branch owns yet
stay here; delete a line once it's done.

- 2026-09-30 · Open rules reached prod some other way than a bare deploy (`.firebaserc` default is `bmrc-staging`; the
  prod id isn't in the repo), so maybe an explicit `--project` or a console paste. · **You:** check the prod rules
  history in the Firebase console.
- 2026-09-30 · "Remote" agents actually ran locally in `.claude/worktrees/`, so they stop if the laptop sleeps. · Confirm
  the cloud option works before relying on unattended runs.
- 2026-09-30 · `npm run build` fails without `.env.local` (`auth/invalid-api-key` prerendering `/reports`,
  `/_not-found`). · Make Firebase init lazy so CI/worktrees build without env.
- 2026-09-30 · Pre-existing `no-explicit-any` lint errors in `app/types.ts:1158,1589`. · Fix opportunistically.
