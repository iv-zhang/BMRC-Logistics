# H6 + H7 proposal (needs Ivan's call before any code)

Companion to [platform-overhaul.md](platform-overhaul.md) §1 and §8.5. The v2 packet text for these two is lost; this
is a re-derivation from the §1 summary and what wave 1 actually shipped. Nothing here is built. Mark each choice and
the packets get written from your answers.

## What already exists (wave 1, live)

- `InventoryItem.family` + `variantLabel`; `name` is derived as `"<family>, <variantLabel>"`.
- `app/lib/variant-signature.ts`: `variantSignature(name)`, `itemVariantSignature(item)`, `variantsMatch`,
  `checkVariantMerge` (`ok | blocked | conflict`). Merges already refuse cross-variant pairs (D-33).
- `Container` has `isBox`/`isSealed`/`boxContents` but no notion of *what kind* of container it is.
- `storage-location-picker.tsx` picks zone → shelf → level → container in one flat flow; `additemmodal.tsx` suggests
  duplicates with Levenshtein only (cross-size false positives).

## H6: variant picker + "On shelf | In a container"

| # | Choice | Options | Recommended |
|---|---|---|---|
| 1 | How a new item gets its `family` / `variantLabel` | **a)** type the name once; the form splits it with `variantSignature` and shows the split for confirmation · **b)** two separate fields (Family, Size/variant) with family autocomplete | **b**, with autocomplete from existing families. Typing "NPA" then picking "28 Fr" is what stops near-duplicate names; (a) keeps free-text names as the source |
| 2 | Duplicate suggestions in Add Item | **a)** keep Levenshtein, filter with `checkVariantMerge` · **b)** same-family list only ("NPA exists in: 26 Fr, 28 Fr, 30 Fr") | **b** when a family is chosen, **a** as fallback for legacy items with no family |
| 3 | Where the *On shelf / In a container* control lives | **a)** in `storage-location-picker.tsx` (every caller gets it: audit Move, intake, item editor) · **b)** only in the item editor | **a**; one picker, one behavior |
| 4 | `Container.kind` values | **a)** `bin \| box \| bag \| drawer \| other` (free list in code) · **b)** org-config list editable in `/settings` | **a** for now; it is a label plus a sort hint, not a rule. Existing `isBox` containers read as `box` (derived, no migration) |
| 5 | "Variant-matched bin first" | When moving `NPA, 28 Fr`, containers on that shelf already holding another NPA variant sort to the top, and one holding the *same* variant is preselected | Yes as described; sort only, never auto-move |
| 6 | Creating a container inline | **a)** allowed from the picker (today: audit operators can) · **b)** Storage Management only | **a**, unchanged; R4 rules already allow operators to create |

Files (one owner each): `storage-location-picker.tsx`, `additemmodal.tsx`, `container-editor.tsx`, `app/types.ts`
(`Container.kind`), `app/lib/variant-signature.ts` (name-splitting fix for `NPA 28 Fr`, see findings). No page edits, so
it can run beside 2c.

## H7: split by size

The case: one record `NPA` (or `Gloves`) holding mixed sizes, which should be several variant records.

| # | Choice | Options | Recommended |
|---|---|---|---|
| 1 | What a split does to stock | **a)** you enter a count per size; the original's reserve is divided accordingly, nothing created or lost (sum must equal the original) · **b)** new variants start at 0 and get counted at the next audit | **a** for box/loose-tracked items. For bag/lot-tracked items, each **lot** is assigned to one size (lots are not divided) |
| 2 | What happens to the original record | **a)** it *becomes* the first variant (keeps its id, history, statpack references) · **b)** retired, all variants new | **a**; statpack contents and buy-list links point at the id |
| 3 | Statpack contents that reference the original | **a)** left on the kept record, listed for manual review · **b)** a prompt per pack | **a** plus a "N packs reference this item" warning before confirming |
| 4 | Audit state of the new variants | **a)** inherit `lastAuditDate` (stay confirmed) · **b)** start unverified | **b**; the per-size counts are a guess until someone counts each bin (fits D-32) |
| 5 | Where it lives | **a)** item editor action "Split by size" (admin/QM) · **b)** also offered in the `/audit` drawer | **a** first |
| 6 | Shelf pool (`shelfQuantity`) | **a)** split by entered counts like reserve · **b)** reset to 0 on new variants, re-anchored at next shelf check | **b**; the shelf pool is re-anchored weekly anyway |

Touches D-11/D-12 (per-lot quantity for box-tracked SKUs is pooled): H7 does **not** change that model; box-tracked
splits divide the pooled count only.

Files: `app/lib/inventory-split.ts` (new) + tests, one modal component (new), one action entry in the item editor.
Writes follow the triple-write rule (inventory + `inventory_logs` + `auditEvents`).

## What I need from you

For each row: "recommended" or the letter you want. H6 rows 1 and 3 and H7 rows 1, 2 and 4 are the ones that change
the shape of the work; the rest can default.
