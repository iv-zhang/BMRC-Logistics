# Statpack check-in fast path + restock flagging

**Branch:** `feat/statpack-checkin-fast-path`
**Status:** in progress — plan approved, open questions resolved, implementation dispatched
**Date:** 2026-09-14 (last updated 2026-09-14)

## Problem

Check-in currently runs the same flow as checkout and audit: the full pocket-by-pocket
form in `app/statpacks/check-off/page.tsx` (1664 lines), where a crew walks every pocket
and confirms every item. That cost is justified on checkout (you're about to deploy with
this pack) and on audit (that's the point). On check-in it is mostly wasted — the common
case is that a shift used nothing at all, and the crew is re-verifying a pack they never
opened.

The consequence isn't just annoyance: a flow people resent is a flow people rush, and a
rushed full check-off is *less* trustworthy than an honest "we used nothing."

## Goal

1. **Used nothing → one tap.** No pockets, no counts.
2. **Used something → say what and how much.** Only the items actually touched.
3. **Assume the crew did not restock.** The pack's shortage must reach the logistics team
   by itself, without anyone remembering to look.

## What already exists (don't rebuild)

- `logStatpackCheckOff` already accepts **`quickCheckin?: boolean`** (`app/lib/inventory.ts:358`)
  and already stamps it onto the log (`:450-452`) for admin audit visibility. It has never
  been wired to any UI. The backend hook for this feature is already there.
- Check-in already has an intermediate confirm sheet the other modes lack — `showReview`
  (`check-off/page.tsx:1181-1190`, sheet at `:1525-1619`). The new flow reuses it.
- Auto-creating docs *after* the transaction, best-effort, never throwing, is the
  established convention — `issue_reports` are created exactly that way
  (`app/lib/inventory.ts:792-821`), as is `endEventShifts` (`:772-782`).
- Shortage display is already derived, never stored: `getPackShortages`
  (`app/lib/statpack-shortages.ts`) + `StatpackRestockChips`, rendered on `/audit`,
  `/dashboard`, `/statpacks/checkout`, and pack detail.

## Design

### Flow

`?mode=checkin` gains a gate step rendered **before** the existing accordion form. Checkout
and audit are untouched.

```
Step 0  "Did you use anything from this pack?"
          ├─ No  → submit immediately. quickCheckin: true, checkEntries: []
          └─ Yes → Step 1
Step 1  Used-items picker — searchable, grouped by pocket
Step 2  Existing showReview confirm sheet → submit
```

An **"Open full check-off"** escape hatch stays visible on Step 0, so anything the fast
path can't express (a broken AED, a full sharps box, an expiration to enter) still has the
old form. The fast path is a shortcut, never a ceiling.

### Step 0 is safe with zero entries

With `checkEntries: []` the per-entry loop at `app/lib/inventory.ts:649-681` never runs, so
`anyExpired` / `anyOutConsumable` / `anyUnknown` all stay false. But `deriveStatus`
(`:714-721`) *also* reads signals that come from the pack's own persisted state:

- `anyStoredExpired` — a stored `contents[].expirationDate` in the past
- `anyQuarantined` — a recalled lot
- `hazard.assetCurrencyLapsed` — a stale life-safety asset

Those still fire on an empty submission. **A one-tap check-in therefore still fail-closes
on an expired item, a recalled lot, or a lapsed AED/O₂** without asking the crew anything.
That is what makes "one tap, nothing else" defensible rather than reckless.

### The one real bug this exposes — must fix

`anyOutConsumable` is accumulated **only from `checkEntries`**. Today every check-in
submits every item, so a persisted `currentQuantity: 0` is always resubmitted as `0` and
correctly derives `Restock Needed`. Under a partial submission that stops being true:

> A pack left at 0 gauze by the last crew, checked in by the next crew with "used nothing",
> would derive **`Ready`** — because the zero is in `contents` but not in `checkEntries`.

That silently un-flags a genuinely depleted pack, which is precisely the failure D-8 exists
to prevent. Fix, in the same fail-closed spirit already applied to expiry and recall:

- Collect `restockedItemIds` from entries with `restockStatus === 'restocked'`.
- After the entry loop (once `contents[].currentQuantity` has been updated in place),
  scan the **final `contents` array** for any non-asset item with
  `requiredQuantity > 0` and `currentQuantity <= 0` that isn't in `restockedItemIds`,
  using the same `isAssetEntry` test already in the loop (`:656`).
- Feed that into `anyOutConsumable`.

This is behaviour-preserving for full submissions (every item is present either way) and
for audits. It only *adds* signal for items not submitted this pass. It should land as its
own commit-sized change regardless of the rest of the feature.

### Used-items picker (Step 1)

New component, `app/components/statpacks/checkin-used-picker.tsx`:

- Consumables only. Assets (`serialNumber` / `assetInstanceId`) are status-tracked, never
  counted — same exclusion `getPackShortages` and `logStatpackCheckOff` already make.
- One scroll view of the whole pack, search box pinned at top, pocket names as section
  headers (`POCKETS` from the check-off page).
- Tap an item → quantity stepper, default 1, clamped to its `currentQuantity`.
- Untouched items produce **no entry at all** — that's what preserves their stored count.

Entries built for touched items only:

```ts
{
  itemId, itemName, batchId, compartmentId, pocket,
  requiredQuantity: it.requiredQuantity,
  countedQuantity: Math.max(0, (it.currentQuantity ?? it.requiredQuantity) - usedQty),
  ok: countedQuantity >= it.requiredQuantity,
  // restockStatus deliberately UNSET — the crew did not restock.
  // Setting 'restocked' here would suppress the Restock Needed derivation.
}
```

### Flagging the logistics team

All three channels, fired **after the transaction commits**, best-effort, each in its own
try/catch, never able to roll back the check-in — mirroring the `issue_reports` block.

Trigger: `getPackShortages(updatedPack).total > 0`. This deliberately includes *partial*
shortages (pack still derives `Ready` per the D-8 amendment) — the crew used something and
logistics should know, even though the pack stays deployable.

1. **Status + chips** — free. Falls out of the persisted `currentQuantity`; every existing
   surface picks it up with no new code.

2. **Committee Board task.** Note: the `tasks` collection is **dead** — `/tasks` is a
   21-line redirect stub to `/committee-board`, and nothing in the app writes `tasks` any
   more (`MODEL.md` is stale on this). The live logistics queue is **`team_tasks`**. New
   helper `app/lib/statpack-restock-flag.ts` writes a doc matching the Committee Board's own
   payload (`app/committee-board/page.tsx:433-441`):

   ```ts
   {
     title: `Restock ${pack.name}`,
     definitionOfDone: 'All pack contents back to par quantity.',
     owners: [],                 // unassigned — see open question 1
     status: 'backlog',
     subtasks: shortages.map(s => ({ id, text: `${s.name} ${s.currentQuantity}/${s.requiredQuantity}`, done: false })),
     updates: [], dueDate: null,
     linkedStatpackId: pack.id,  // new optional field — see open question 2
     createdBy: userId, createdByName: userName, createdAt: serverTimestamp(),
   }
   ```

   **De-duplicated**: if an open (`status !== 'done'`) task already exists for this pack,
   update its subtasks instead of creating a second card — otherwise every check-in of a
   chronically short pack spawns another. This mirrors how `addToBuyList`
   (`app/lib/buy-list.ts:49`) de-dupes against open entries.

3. **In-app notification.** `broadcastNotification` to users with role in
   **`['admin', 'quartermaster']`**. Note this deliberately differs from the events
   broadcast at `app/lib/events.ts:300`, which includes `medops` — **medops must not
   receive logistics notifications** (D-13: medops is a reduced-admin role that never sees
   logistics surfaces). Link to `/statpacks/<id>`.

### This reverses a documented non-behaviour — record it

`MODEL.md:408-424` explicitly documents that "post-event scan → auto-flag below-par item"
does *not* exist, and D-8 frames restock as a human pull process caught by the next crew or
the admin audit. Auto-creating a task and a notification is a deliberate reversal of that,
scoped to **statpacks only** (inventory below-par still drives display chips only).

So this needs a new `decisions.md` entry (**D-31**) recording the fast path, the
`quickCheckin` semantics, the untouched-contents fail-closed fix, and the auto-flag — plus
a correction to the stale `tasks`/`team_tasks` note in `MODEL.md`. Not a silent patch.

## Files to touch

Strictly non-overlapping sets, safe to run in parallel:

| # | Agent | Files | Work |
|---|---|---|---|
| A | Sonnet / medium | `app/lib/inventory.ts` | `deriveStatus` untouched-contents fix; `quickCheckin` passthrough; post-commit flag call |
| B | Sonnet / medium | `app/statpacks/check-off/page.tsx`, `app/components/statpacks/checkin-used-picker.tsx` (new) | Step 0 gate, picker component, payload assembly, reuse of `showReview` |
| C | Sonnet / low | `app/lib/statpack-restock-flag.ts` (new) | `team_tasks` de-duped write + scoped broadcast |
| D | Haiku / low | `app/types.ts`, `decisions.md`, `MODEL.md` | `linkedStatpackId` on `TeamTask`; D-31; fix stale `tasks` note |

Order: **D and C first** (types + helper), then **A** (imports C). **B** is independent of
all three and can run concurrently. Orchestrator wires the A↔B seam (the payload contract)
and does the integration pass.

## Verification

Per CLAUDE.md's tiered rule:

- After each agent lands: `npx tsc --noEmit`, `npm run lint` on touched files.
- Before reporting done: `npm run build`, `npm run test`.
- The `run-bmrc-logistics` emulator driver is **not** run until immediately before a
  commit. Until then this ships as built-and-typechecked, **not runtime-verified**, and
  will be reported that way.

Smoke cases to write as we go, for that eventual run:
- Check in a pack with "used nothing" → status stays `Ready`, log has `quickCheckin: true`,
  no task, no notification.
- Check in a pack that already had an item at 0, using nothing → status is `Restock Needed`
  (this is the regression the fail-closed fix prevents).
- Use 2 of 2 gauze → `Restock Needed`, task created with a gauze subtask, admin+QM notified,
  medops **not** notified.
- Use 1 of 2 gauze → pack stays `Ready`, chip shows `1/2`, task still created.
- Check in twice while short → one task, subtasks updated, not two cards.

## Open questions — RESOLVED

1. **Task owner.** ✅ **Confirmed: `owners: []`.** The card is created unassigned and a
   person claims it. The Committee Board's form requires an owner
   (`chosen.length === 0` early-returns), but that is form validation, not a data
   invariant. Auto-assigning every admin/QM was rejected as noisy. The helper carries a
   comment saying so, so nobody "fixes" the empty array later.
2. **`linkedStatpackId` on `TeamTask`.** ✅ **Confirmed.** Additive and optional. It is both
   the de-dupe key and the back-link from a card to its pack.
3. **Sharps / O₂ on the fast path.** Accepted as a known residual risk, not re-litigated.
   These are *not* asked on "used nothing." A crew that filled the sharps container but
   used no consumables reports nothing, and the next flag comes from the biweekly audit.
   The escape hatch to the full form covers it if they're conscientious.

## Pre-flight verification (orchestrator, before dispatch)

Every load-bearing claim in the plan above was checked against the code first. All five
held: `quickCheckin` at `inventory.ts:358` stamped at `:450-452`; the entry loop at
`:649-681` with `isAssetEntry` at `:656`; `deriveStatus` at `:714-721` reading the three
persisted-state hazard signals; the post-commit best-effort blocks at `:772-821`; and the
`showReview` sheet the check-in flow already has.

Three things the plan did **not** know, found during that pass:

- **`NotificationInput` is not exported** from `app/lib/notifications.ts` — it's a bare
  `interface`. The flag helper must pass an inline object literal, not import the type.
- **`app/components/statpacks/` does not exist.** The picker's directory is created new.
- **The last decision is D-30**, so `D-31` is free as planned. The stale `tasks` note in
  `MODEL.md` is in **three** places, not one: `:187-188`, the `### tasks` section at `:190`,
  and the cross-reference at `:419`.

Two useful confirmations for the implementation:

- `getPackShortages` already exports **`formatShortage(s)`** rendering `"Gauze 4x4 1/2"` —
  exactly the subtask text the task card needs. No new formatter.
- `broadcastNotification(userIds, input, actor)` takes **UIDs**, not roles, so the helper
  queries `users` itself — mirroring `events.ts:300` but with `['admin', 'quartermaster']`
  and deliberately **without `medops`** (D-13).

## Progress log

**2026-09-14 — dispatched.** Four agents on strictly non-overlapping file sets. The plan
sequenced these D→C→A with B concurrent, because A imports C. Run concurrently instead by
pinning C's export signature up front, so A could be written against a fixed contract:

```ts
export interface RestockFlagActor { uid: string; name: string }
export async function flagStatpackRestock(
  pack: Pick<Statpack, 'id' | 'name' | 'contents'>,
  actor: RestockFlagActor,
): Promise<void>   // never throws
```

| # | Model | Files | Status |
|---|---|---|---|
| A | Sonnet | `app/lib/inventory.ts` | ✅ landed, verified by orchestrator |
| B | Sonnet | `check-off/page.tsx`, `checkin-used-picker.tsx` (new) | running |
| C | Sonnet | `app/lib/statpack-restock-flag.ts` (new) | ✅ landed, tsc + lint clean |
| D | Haiku | `app/types.ts`, `decisions.md`, `MODEL.md` | ✅ landed |

**Committed + pushed** as `8cee820` (backend half: A + C + D), doc as `ef206f9`. Branch now
tracks `origin/feat/statpack-checkin-fast-path`. The UI half lands in a second commit.

`npm run test` against the committed backend half: **69 passed, 0 failed.** So the
`deriveStatus` change does not regress the audit/restock integration suite. Note what that
does *not* cover, though — that suite exercises audit/restock analysis, not the statpack
check-in path, so none of the fast path's own smoke cases (listed above) are tested by it.
They still need the emulator driver, which per CLAUDE.md is not run until immediately
before a commit. `npm run build` is deliberately deferred until agent B lands, since it
would otherwise compile a half-written page.

Orchestrator verification of A's diff (read line by line, not taken on trust): the
untouched-contents scan gates on `typeof current !== 'number' || !Number.isFinite(current)`
→ `continue`, so "never counted" correctly does **not** flag as zero; it reuses
`isAssetContent`'s test, not `isAssetEntry`; it runs after the entry loop's in-place
mutation and before `deriveStatus`; and `anyUnknown` was left purely entry-level. The
capture of final contents is guarded on `Array.isArray(spData?.contents)`, so a pack with
no contents array simply skips the flag — correct, since it has no shortages to report.

The one correctness point flagged hardest to agent A, because it silently breaks the whole
feature if gotten wrong: in the new untouched-contents scan, a `currentQuantity` that is
**missing/non-finite means "never counted", not "zero"**. `getPackShortages` already draws
exactly this distinction (`statpack-shortages.ts:28-34`). Treating missing as zero would
make every one-tap check-in of a never-counted pack derive `Restock Needed`. A was also
told to use `isAssetContent` (not the entry-level `isAssetEntry`) for that scan, so the
derived status and the flag trigger can never disagree about what counts as a consumable.

### Findings / bugs

**F-1 — pre-existing: two test files are orphaned, and they permanently break the
project's own default verification command.** Unrelated to this feature, predates the
branch, but worth fixing separately because of what it costs.

`app/lib/__tests__/o2-checkout-integration.test.ts` and `o2-validation.test.ts` import
`vitest`. **`vitest` is not installed** — not in `dependencies`, not in `devDependencies`,
not in `node_modules`. And `npm run test` is `node ./scripts/test-audit-restock.cjs`, which
never invokes vitest. So nothing in the repo runs these two files: they are dead tests
providing zero coverage while looking like coverage.

Worse, `tsconfig.json` includes `**/*.ts` with no `__tests__` exclusion, so `tsc` compiles
them and fails on the missing module. CLAUDE.md's default post-change verification tier is
`npx tsc --noEmit` — **that command cannot exit clean on a healthy tree today.** A
verification step that is always red trains everyone to skim past it, which is exactly how
a real error gets through. Either install vitest and wire it into `npm run test`, or delete
the two orphans; leaving them is the one option with ongoing cost.

**F-2 — `statpack-restock-flag.ts` deliberately omits `'use client'`.**
Its import `notifications.ts` declares `'use client'`, but the file follows its closest
sibling (`buy-list.ts`, a pure Firestore CRUD helper) and its actual caller
(`inventory.ts`), neither of which declares it. Noting it because it looks like an
oversight and is not one; if a "use client" boundary error ever surfaces here, this is the
line to revisit.

**F-3 — ⚠️ DEPLOY RISK: this feature makes a *regular member* write `team_tasks` and
`notifications`, and the repo cannot tell us whether production allows that.**
`firestore.rules` in this repo is **emulator-only** — a wide-open
`match /{document=**} { allow read, write: if true; }` catch-all, with a file-level banner
saying it is "NOT the production security model" and "Do NOT deploy this file to a live
project." So nothing here will *reject* the write locally, and the emulator smoke run will
happily pass.

But the auto-flag fires inside `logStatpackCheckOff` as **whoever checked the pack in** —
typically a plain `member`, the exact role this fast path is built for. If the live
project's rules restrict `team_tasks` (a logistics/committee collection) or `notifications`
to admin/quartermaster, both channels fail in production while working perfectly in every
local test. And because each channel is deliberately wrapped in a try/catch that only
`console.error`s — correct, so a flag can never roll back a check-in — **it fails
silently.** The pack's status and chips still update (those ride the pack doc), so the
failure is invisible: logistics simply never gets told, which is the one thing this feature
exists to do.

Before this ships, someone must check the deployed rules for `team_tasks` and
`notifications` write access by a `member`. If they're admin-gated, the options are to
relax them for these two specific shapes, or to move the flag write behind something
trusted. Not fixable from inside this repo — flagging, not guessing.

**F-4 — composite index: checked, not needed.** The de-dupe query combines
`where('linkedStatpackId','==',…)` with `where('status','in',[…])`, and
`firestore.indexes.json` is completely empty (`{"indexes": [], "fieldOverrides": []}`).
That looked like a missing-index runtime failure, but it isn't: these are all
equality-family filters with no range or `orderBy`, which Firestore serves by merging
single-field indexes. The proof is precedent — `addToBuyList` already ships the identical
`==` + `in` shape against the same empty index file. Recording it so it doesn't get
re-raised.

**F-5 — re-flagging overwrites hand-ticked subtasks.** On a repeat check-in the de-dupe
path replaces the card's `subtasks` array wholesale. That's right for keeping the list
honest to current stock, but a subtask someone manually ticked `done` gets reset. Accepted
for v1 — the array reflects live reality, not a worklog — but noting it as the likely
first complaint from whoever works the Committee Board.
