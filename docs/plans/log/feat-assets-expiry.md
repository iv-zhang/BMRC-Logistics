# Log: feat/assets-expiry

## Packets done
- A1 asset fields + lifecycle + fiscal + config · `AssetRegisterFields` on `InventoryItem`/`AssetInstance`; `asset-lifecycle.ts` (`changeAssetLifecycle`: transaction + `inventory_logs` + `auditEvents`), `fiscal.ts`, config `fiscalYearStartMonth`/`assetOwners`/`thresholds.expiryBuckets` · 6085c1a · 38 unit tests pass, tsc/eslint clean, write path not exercised
- A2 expiry + valuation · `expiry.ts` (buckets, `reorderCostExpiringThisFY`, `shrinkage`), `valuation.ts` (supplies at cost, equipment register); pure lifecycle split to `asset-lifecycle-core.ts` · f8f9cd0 · 49 unit tests pass (115 across the touched suites), tsc only the 5 known o2 errors, eslint clean

## Open questions
- Valuing expired/quarantined lots: included (still physically on hand). Should expired stock be excluded or shown separately in "supplies at cost"?
- Box-tracked SKUs (D-11/D-12): reserve valued at the latest known unit cost, flagged `estimated`; not per-lot. Expiry for them is invisible (lots are zero-stock tombstones, same as `getItemStatus`).
- Expiry lots are confirmed-items-only by default (D-32 stance); components are not gated (assets are not on the supply-audit cycle). Right call?
- Lifecycle rules chosen: `retired` is terminal; `loaned_out` requires `assignedTo`; moving off `loaned_out` clears it. Retiring an asset does not set `existence: 'retired'`.
- `acquisitionCostCents` vs legacy `assetValue` (dollars): register/shrinkage prefer the cents field and fall back to `assetValue`. Per-instance owner/cost are read for shrinkage only; the register is one row per doc using doc-level owner/cost.
- `pricePerUnit <= 0` is treated as unknown (a donated item must be recorded some other way; A5 "Donated / unknown").

## Seams for O / later packets
- `app/hooks/useOrgConfig.ts` `buildResult` and `app/settings/page.tsx` do not expose or edit the new keys. `fiscalYearStartMonth` and `assetOwners` are optional on `OrgConfigDoc` (type only) so the hand-built settings draft still typechecks and its merge-save cannot clobber them. A3/A4 can read via `getAssetOwnersRuntime()` / `getExpiryBuckets()` / `getFiscalYearStartMonthRuntime()`.
- Callers pass `determineIsAsset` (inventory.ts) as `isAsset` to the selectors, so they stay Firebase-free; `item-status.ts` still loads the Firebase client module transitively (needs the fake env in tests, like existing suites).
- A4 must pass `getExpiryBuckets()`, `getFiscalYearStartMonthRuntime()` and `getThresholds().assetValueThreshold` into the selectors.
