# Log: feat/inventory-hygiene

## Packets done
- H0 diagnose-merges · read-only; merge paths found (`inventory-merge.ts` fuzzy grouping + `buildMergePlan` with no variant guard) · d539160 · n/a (docs only)
- H1 variant signature + merge gate · `variant-signature.ts`; `findDuplicateCandidates`/`buildMergePlan` refuse cross-variant · df671fc · 91 unit tests pass, tsc/eslint clean, not runtime-verified
- H2 existence status · `getExistence`, `retireInventoryItem`; unverified/retired excluded from restock, rollups, reconciliation · 5466877 · 11 unit tests pass, `retireInventoryItem` not exercised
- H8 audit cadence · `thresholds.auditCadence` + `isAuditCurrent` + settings select (amends D-6) · 579045a · 17 unit tests pass, settings form not viewed in browser
- Final pass · ff3f34e · `npm run build` ok, `npm run test` 69/0, 119 node:test pass, tsc only the 5 known o2 errors, eslint clean; emulator smoke driver NOT run, no live data touched

## Unfolded findings
- Retired items still appear in `findDuplicateCandidates` and the `/inventory` list; hide retired by default. No UI consumes `findVariantConflicts` yet. (H4/H5)

## H6: skipped
The v2 packet text is lost, and H6 (family/variant picker, **On shelf | In a container** control, `Container.kind`,
variant-matched bin first) is UI with real design choices that would likely be thrown away if guessed. Suggested scope
once re-expanded: a variant picker that fills `family` + `variantLabel` from `variantSignature` tokens, and swap the
`additemmodal.tsx` Levenshtein-only suggestions for `checkVariantMerge`.

## Proposed decisions text (for O to add to decisions.md; not edited here)

### D-32 (proposed): Item existence is derived; unverified stock is not actionable
**Decision:** every `inventory` record has an existence: `confirmed` (audited on/after 2026-06-01), `unverified`
(everything else), or `retired` (audited and found not to exist). Only `retired` is stored; confirmed/unverified are
derived from `lastAuditDate` by `getExistence()` (`app/lib/item-status.ts`). Unverified and retired items are excluded
from restock analysis (`analyzeRestockNeeds`), storage-rollup alerts (`computeStorageRollups`), and reconciliation
exceptions (`buildExceptions`). `getItemStatus`/`computeBagStock` are unchanged (D-4/D-5). Retiring never deletes
(`retireInventoryItem`: triple write, history and references kept).
**Why:** Principle 1 (fail safe) and 2 (derive, don't assert): a record nobody has seen since the baseline may be a
ghost, and must not trigger purchases or crowd the exception list; a stored "confirmed" flag would go stale forever.
**Amends D-6:** the audit window is `thresholds.auditCadence` (`monthly` default, `quarterly`, `semester`, `yearly`),
evaluated by `isAuditCurrent()`. `isAuditedThisMonth` remains as the monthly special case. Semester windows start at
`semesterStartDate`, clamped to no earlier than the calendar half-year start.

### D-33 (proposed): Merge only identical variants
**Decision:** two items may be treated as duplicates or merged only when their variant signatures match
(`variantSignature()` in `app/lib/variant-signature.ts`: size N, Fr, gauge, mm/in/mL, S-XL, adult/peds/infant, triage
colors, bare numbers; pack counts ignored). `findDuplicateCandidates` never links different variants,
`mergeInventoryItems` refuses them, and a shared SKU/barcode across different variants is reported as a `conflict`
(`findVariantConflicts`) for a human to resolve. Unsized vs sized is a mismatch.
**Why:** merging `NPA 28 Fr` into `NPA 30 Fr` pools two products and repoints every statpack that requires the 28 Fr.
Near-identical names (edit distance 1-2) are exactly what differs between sizes, so fuzzy name matching alone is unsafe.

