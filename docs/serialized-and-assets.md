Serialized Batches and Asset Workflow

Overview

- Serialized batches: batches can be marked as `serialized: true` and contain `serialNumbers` (one ID per physical unit). The UI in `Add Item` -> Batches allows adding serials and will keep `stock` in sync with the number of serials.

- Statpack assignment: `StatpackItem` may include `serialNumber` when a serialized unit is placed into a statpack.

- Assets (AEDs, generators, etc): `InventoryItem` can be `isAsset: true` and has `assetSerial`, `parentAssetId`, `assignedToId`, and `assetChecks` (batteryStatus, padsSealed, notes).

Developer Notes / Next Steps

- Enforce restock handshake: update mobile `restock` or `move` flows to require choosing `batchId` and, for serialized batches, the specific `serialNumber` being moved.
- For AEDs, mobile check-in should ask for `batteryStatus` and `padsSealed`; these should be saved into `assetChecks` on the asset item.
- Consider adding audit reports that can query by `serialNumber` to locate recalled units.

Manual Test Steps

1. Open `Add Item` modal and add a batch; toggle "Serialized" and add serial IDs. Verify the `Qty Total` updates to match the number of serials.
2. Save the item and inspect Firestore document for `batches[].serialized` and `batches[].serialNumbers`.
3. For an asset, enable "Is Asset" and enter `Asset Serial #` and `Assigned To` if needed; fill `Battery Status` and `Pads Sealed` then save.
4. Optional: add a `StatpackItem` that references a batch and, for serialized items, set `serialNumber` to the specific unit moved.

Contact

If you want, I can implement the restock/move UI changes (mobile check-in and statpack restock flow) to require batch+serial selection during moves. Say "Yes, implement restock handshake" and I'll patch the relevant flows.
