"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  Autocomplete,
  AutocompleteItem,
  Button,
  Checkbox,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from "@heroui/react";
import { collection, onSnapshot } from "firebase/firestore";
import { db } from "@/firebase";
import { postBuyListDelivery, postPendingIntake, type BuyListActor } from "@/app/lib/buy-list";
import type { BuyListItem, InventoryItem } from "@/app/types";

interface BuyListIntakeModalProps {
  isOpen: boolean;
  onClose: () => void;
  entry: BuyListItem | null;
  /** When set, post stock for this earlier unposted delivery instead of recording a new one. */
  pendingSeq?: number | null;
  actor: BuyListActor;
}

function defaultPerUnit(item: InventoryItem | undefined): number {
  if (!item) return 1;
  if (item.itemsPerBox && item.itemsPerBox > 0) return item.itemsPerBox;
  const bag = (item.batches ?? []).find((b) => (b.itemsPerBag ?? 0) > 0);
  return bag?.itemsPerBag ?? 1;
}

export default function BuyListIntakeModal({
  isOpen,
  onClose,
  entry,
  pendingSeq = null,
  actor,
}: BuyListIntakeModalProps) {
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [itemId, setItemId] = useState<string>("");
  const [quantity, setQuantity] = useState("");
  const [perUnit, setPerUnit] = useState("1");
  const [lot, setLot] = useState("");
  const [expiry, setExpiry] = useState("");
  const [complete, setComplete] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pendingDelivery =
    pendingSeq != null ? entry?.deliveries?.find((d) => d.seq === pendingSeq) : undefined;

  useEffect(() => {
    if (!isOpen) return;
    const unsub = onSnapshot(
      collection(db, "inventory"),
      (snap) => {
        setInventory(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<InventoryItem, "id">) })) as InventoryItem[],
        );
      },
      (err) => console.error("Failed to load inventory:", err),
    );
    return () => unsub();
  }, [isOpen]);

  const selected = useMemo(() => inventory.find((i) => i.id === itemId), [inventory, itemId]);

  // Reset the form each time the modal opens for an entry / delivery.
  useEffect(() => {
    if (!isOpen || !entry) return;
    const remaining =
      entry.quantity != null ? Math.max(0, entry.quantity - (entry.receivedQuantity ?? 0)) : null;
    setItemId(entry.linkedInventoryId ?? "");
    setQuantity(
      pendingDelivery ? String(pendingDelivery.quantity) : remaining ? String(remaining) : "",
    );
    setPerUnit("1");
    setLot("");
    setExpiry("");
    setComplete(true);
    setError(null);
    setSaving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, entry?.id, pendingSeq]);

  // Default units-per-package once the picked item is known — and again on every
  // (re)open, since the reset above clears it even when the item is unchanged.
  useEffect(() => {
    if (isOpen && selected) setPerUnit(String(defaultPerUnit(selected)));
  }, [selected?.id, isOpen, entry?.id, pendingSeq]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!entry) return null;

  const qtyNum = Number(quantity);
  const perNum = Number(perUnit);
  const qtyValid = Number.isInteger(qtyNum) && qtyNum > 0;
  const perValid = Number.isFinite(perNum) && perNum > 0;
  const remaining =
    entry.quantity != null ? Math.max(0, entry.quantity - (entry.receivedQuantity ?? 0)) : null;
  const dated = !!selected && (selected.tracksExpiration === true || selected.requiresExpirationCheck === true);
  const unit = entry.unit || "units";
  const total = qtyValid && perValid ? qtyNum * perNum : null;

  const run = async (post: boolean) => {
    setError(null);
    if (!qtyValid) return setError("Enter a whole number of packages received.");
    if (post) {
      if (!selected) return setError("Pick the inventory item to add stock to.");
      if (!perValid) return setError("Units per package must be greater than zero.");
      if (dated && !expiry) return setError("Expiration month is required for this item.");
    }
    setSaving(true);
    try {
      if (pendingDelivery) {
        if (!selected) throw new Error("Pick the inventory item to add stock to.");
        await postPendingIntake(
          entry,
          pendingDelivery.seq,
          {
            item: selected,
            perUnit: perNum,
            lotNumber: lot.trim() || undefined,
            expirationMonth: expiry || undefined,
          },
          actor,
        );
      } else {
        await postBuyListDelivery(
          entry,
          {
            quantity: qtyNum,
            final: complete,
            post,
            // Link the picked item even for "intake later" so Post intake is prefilled.
            item: selected || undefined,
            perUnit: post || perValid ? perNum : undefined,
            lotNumber: lot.trim() || undefined,
            expirationMonth: expiry || undefined,
          },
          actor,
        );
      }
      onClose();
    } catch (err) {
      console.error("Buy list intake failed:", err);
      setError(err instanceof Error ? err.message : "Failed to save. Please retry.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => !open && !saving && onClose()} size="lg" scrollBehavior="inside">
      <ModalContent data-testid="buylist-intake-modal">
        <ModalHeader className="flex flex-col gap-0.5">
          <span>{pendingDelivery ? "Post intake" : "Receive delivery"}</span>
          <span className="text-xs font-normal text-default-500">
            {entry.itemName}
            {entry.quantity != null
              ? ` · ordered ${entry.quantity} ${unit}, received ${entry.receivedQuantity ?? 0}`
              : ""}
          </span>
        </ModalHeader>
        <ModalBody className="gap-3">
          <Autocomplete
            label="Inventory item"
            placeholder="Search inventory…"
            size="sm"
            selectedKey={itemId || null}
            onSelectionChange={(key) => setItemId(key ? String(key) : "")}
          >
            {inventory.map((i) => (
              <AutocompleteItem key={i.id} textValue={i.name}>
                {i.name}
              </AutocompleteItem>
            ))}
          </Autocomplete>
          <div className="flex gap-3">
            <Input
              label={`Quantity received (${unit})`}
              type="number"
              size="sm"
              min={1}
              value={quantity}
              onValueChange={setQuantity}
              isDisabled={!!pendingDelivery}
              description={remaining != null && !pendingDelivery ? `${remaining} remaining` : undefined}
            />
            <Input
              label="Units per package"
              type="number"
              size="sm"
              min={1}
              value={perUnit}
              onValueChange={setPerUnit}
            />
          </div>
          <div className="flex gap-3">
            <Input label="Lot number" size="sm" value={lot} onValueChange={setLot} />
            <label className="flex flex-1 flex-col text-xs text-default-600">
              <span className="mb-1">Expiration month{dated ? " *" : ""}</span>
              <input
                type="month"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                className="rounded-medium border border-default-200 bg-default-100 px-2 py-2 text-sm"
              />
            </label>
          </div>
          {total != null && (
            <p className="text-sm text-default-600">
              {qtyNum} {unit} × {perNum} = {total} units
            </p>
          )}
          {!pendingDelivery && (
            <Checkbox size="sm" isSelected={complete} onValueChange={setComplete}>
              This completes the order
            </Checkbox>
          )}
          {error && (
            <p className="text-sm text-danger" role="alert" data-testid="buylist-intake-error">
              {error}
            </p>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={onClose} isDisabled={saving}>
            Cancel
          </Button>
          {!pendingDelivery && (
            <Button
              variant="flat"
              onPress={() => run(false)}
              isDisabled={saving}
              data-testid="buylist-intake-later"
            >
              Mark delivered — intake later
            </Button>
          )}
          <Button
            color="primary"
            onPress={() => run(true)}
            isLoading={saving}
            isDisabled={saving}
            data-testid="buylist-intake-submit"
          >
            Add to stock
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
