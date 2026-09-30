# Log: feat/inventory-hygiene

Plan: `docs/plans/platform-overhaul.md` §1 (on `plan/platform-overhaul`). Wave-1 packets H0, H1, H2, H8 (H6 attempted last).
Model/agent: Sonnet 5.5 (autonomous). Nothing here touches live data; no migration was run (H3 is out of scope).

## Packets

| Packet | Status | Commit |
|---|---|---|
| H0 diagnose-merges | done (read-only, findings below) | (this commit) |
| H1 variant signature + merge gate | done | (H1 commit) |
| H2 existence types/status | pending | |
| H8 audit cadence | pending | |
| H6 picker/editor | pending | |

## H0 findings: where could different sizes/variants get merged?

Grepped `merge|dedupe|dedup|normalize|levenshtein|similar|fuzzy` over `app/lib`, `app/components`, `scripts`.

### Real merge / dedupe paths

1. **`app/lib/inventory-merge.ts` `findDuplicateCandidates()`** (used by `/inventory` via `duplicateGroups`).
   Groups items by exact SKU, exact barcode, exact normalized name, **or fuzzy name (Levenshtein <= max(2, 25% of the
   longer name))**, transitively via union-find. **Unsafe for variants:** `NPA 28 Fr` vs `NPA 30 Fr` (distance 2),
   `Gloves M` vs `Gloves L` (distance 1), `BVM adult` vs `BVM peds`, `14g IV` vs `18g IV` (distance 1) all group as
   "fuzzy" duplicates. Union-find transitivity makes it worse: S~M~L all land in one group. It only *suggests* a group;
   nothing merges automatically.
2. **`app/lib/inventory-merge.ts` `buildMergePlan()` / `mergeInventoryItems()`** (the write path, called from
   `app/inventory/page.tsx` `handleConfirmMerge`). Existing guards: same tracking mode (bag vs box) and, for box mode,
   same `itemsPerBox`. **No variant guard at all**: an admin can pick `Gloves M` as survivor and `Gloves L` as loser
   (the modal accepts any selection, `openMergeModal(ids)`), and the stock is summed, losers archived, and every
   forward reference (statpacks, exchange bags, containers, purchases, buyList, tasks, restock categories) is
   repointed to the survivor. That would silently corrupt pack contents (a pack requiring size M now points at the
   merged SKU). This is the path that matters.
3. **`app/components/additemmodal.tsx` duplicate check** (lines ~176-228). Name-prefix query + `levenshtein` + exact
   SKU/barcode; suggestion-only UI (shows "possible duplicates", no merge). Same false-positive class as (1): typing
   `NPA 30 Fr` surfaces `NPA 28 Fr` as a fuzzy duplicate. Low risk, nudges users toward wrong merges.

### Paths checked and judged safe / not merge-related

- `app/lib/buy-list.ts` `addToBuyList`: dedupe is by `linkedInventoryId`, else exact `trim().toLowerCase()` name. Exact
  match, so variants stay distinct. Safe.
- `app/lib/vendors.ts`: exact lowercase vendor name match. Not items.
- `app/lib/purchases.ts` (placeholder creation): creates a new doc per unlinked line; splits name via
  `parseLegacyName`. No merge.
- `app/lib/item-naming.ts`: `parseLegacyName` / `deriveItemName` / `propagateFamilyRename` operate per family. A family
  rename rewrites names but never merges docs. Note `parseLegacyName` only splits on `(..)`, last comma, or ` - `, so a
  name like `NPA 28 Fr` (no separator) parses as family `NPA 28 Fr` with no variant: sizes can end up embedded in the
  family string. (Relevant for H3 baseline/naming backfill and H6.)
- `app/lib/scan-resolve.ts` / `gs1.ts`: barcode to item resolution, first exact match. No merge.
- `scripts/normalize-inventory.cjs`: converts legacy `variants[]` into batches per doc and writes `set(..., {merge:false})`
  for each doc; never merges two docs together. (Converting dead `variants[]` into batches with a note is per-doc.)
- `scripts/migrate-item-naming.cjs`: per-doc family/variant split; flags `namingReviewNeeded`; no merge.
- `app/lib/statpack-import.ts` `itemNameSimilarity`: substring match scores 0.85 ("high") so `NPA` would "high
  confidence" match either size. **Dead code**: no callers anywhere in `app/` (the import modal uses its own matching).
  If it is ever revived it needs the variant gate.

### Conclusion / what H1 does

- Gate **(2)** (hard refuse, no data risk: only adds refusals) and **(1)** (stop suggesting cross-variant groups as
  duplicates; same-SKU/barcode cross-variant pairs surface as a distinct `conflict` reason instead of a mergeable
  duplicate). Both are pure additions; nothing that used to be blocked becomes allowed.
- (3) is UI-level suggestion only; it lives in a component (not owned by these packets), so it is logged, not edited.

## H1 notes

- `app/lib/variant-signature.ts` (pure): `variantSignature(name)`, `itemVariantSignature(item)`, `variantsMatch`,
  `checkVariantMerge(a, b)` -> `ok | blocked | conflict`. Token kinds: dim, size N, Fr, gauge/grams (`g`), mm/cm/in/ft,
  mL (L converted), oz/mg/mcg/lb, letter sizes (S..XXXL, words, `S/M` ranges), age (adult/peds/infant/neo), colors,
  bare numbers (so `Stat Pack 1` != `Stat Pack 2`, `ET Tube 7.0` != `7.5`). Pack counts (`100 ct`, `box of 50`, `x100`,
  `100/box`) are deliberately stripped.
- Decision: unsized vs sized (`Gloves` vs `Gloves, M`) is a **mismatch** (strict). Gauge and grams share one `g:` token.
- Wired (refuse-only, nothing newly allowed): `findDuplicateCandidates` no longer links pairs with different
  signatures (no more chaining S~M~L); `buildMergePlan` throws on any survivor/loser variant mismatch (third guard after
  tracking-mode and itemsPerBox). New `findVariantConflicts(items)` lists same-SKU/barcode, different-variant pairs.
- Not wired: `additemmodal.tsx` duplicate suggestions (a component, outside these packets): still lists `NPA 28 Fr` when
  typing `NPA 30 Fr`. Suggestion-only; the merge itself is now refused. No UI consumes `findVariantConflicts` yet (H4/H5).
- Tests run on Node's built-in runner (`npx tsx --test ...`); see Findings on the missing vitest install.

## Verification

### H1
- `npx tsx --test app/lib/__tests__/variant-signature.test.ts`: 84 tests, 84 pass, 0 fail.
- `NEXT_PUBLIC_FIREBASE_API_KEY=fake-key NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-bmrc-logistics npx tsx --test app/lib/__tests__/inventory-merge-variants.test.ts`: 7 tests, 7 pass.
- `npx tsc --noEmit`: only the 5 pre-existing errors in `app/lib/__tests__/o2-*.test.ts` (missing `vitest`); nothing new.
- `npx eslint` on the 4 touched/new files: clean.
- Not runtime-verified in the app (no emulator smoke driver run); `mergeInventoryItems` itself (Firestore) was not exercised.

## Open questions

(appended)

## Findings / notes for later

- **Baseline tsc is not clean.** `app/lib/__tests__/o2-checkout-integration.test.ts` and `o2-validation.test.ts` import
  `vitest`, which is not in `package.json` or `node_modules`, and no vitest config or npm script exists. So they never
  run and `npx tsc --noEmit` already reports 5 errors on `main`. Also `npm run test` only runs
  `scripts/test-audit-restock.cjs`. New hygiene tests use `node:test` via `tsx` instead. Suggest: either install vitest
  and wire `test:unit`, or convert the o2 tests; add a `test:unit` script that runs `tsx --test app/lib/__tests__/*.test.ts`.
- `app/lib/statpack-import.ts` `itemNameSimilarity` has zero callers (dead) and would score `NPA` vs `NPA 28 Fr` as
  "high" confidence. Candidate for deletion (needs user approval; not deleted).
- `parseLegacyName` only splits on parentheses, last comma, or ` - `; `NPA 28 Fr` parses as family `NPA 28 Fr` with no
  variant. Relevant to H3/H6: sizes can be embedded in family strings, so the variant picker should split by
  `variantSignature` tokens, not only separators.
- Existing fuzzy matcher is weak in the other direction too: `NPA 28 Fr` vs `NPA, 28 French` (distance 5) is not
  linked as a duplicate. Out of scope; a signature-first matcher could link them.
