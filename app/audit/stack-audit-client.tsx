"use client";
import React, { useEffect, useMemo, useState } from 'react';
import { Spinner, Button, Input, Card, CardBody, Chip, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Textarea, Select, SelectItem } from '@heroui/react';
import { Plus, Camera, Box } from 'lucide-react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
  addDoc,
  serverTimestamp,
  setDoc,
  deleteDoc,
  writeBatch
} from 'firebase/firestore';
import { auth, db } from '@/firebase';
import type { InventoryItem } from '@/app/types';
import { parseGs1Barcode } from '@/app/lib/gs1';
import { addAuditEventToBatch } from '@/app/lib/audit';
import BarcodeScanner from '@/app/components/barcode-scanner';
import CountControl from '@/app/components/count-control';
import ConditionToggle from '@/app/components/condition-toggle';
import { Timestamp } from 'firebase/firestore';
import { useOrgConfig } from '@/app/hooks/useOrgConfig';
import { deriveItemName } from '@/app/lib/item-naming';

type Props = { zone: string; zoneLabel?: string; onClose?: () => void };

export default function StackAuditClient({ zone, zoneLabel, onClose }: Props) {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [index, setIndex] = useState(0);
  const [locked, setLocked] = useState<{ by?: string; byName?: string } | null>(null);

  // Local staged edits keyed by item id
  const [staged, setStaged] = useState<Record<string, any>>({});
  // Found items (quick-capture)
  const [foundItems, setFoundItems] = useState<any[]>([]);
  const [barcode, setBarcode] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  const touchStartX = React.useRef<number | null>(null);

  // Variance review modal
  const [showReview, setShowReview] = useState(false);

  // Auth
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => { if (u) setUser(u); });
    return () => unsub();
  }, []);

  // Load audit items (filtered by room/zone client-side)
  useEffect(() => {
    const q = query(collection(db, 'inventory'), orderBy('name'));
    const unsub = onSnapshot(q, (snap) => {
      const arr = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) } as InventoryItem));
      const zoneItems = arr.filter(i => ((i.room || 'HQ') === zone || i.location === zone));
      setItems(zoneItems);
      setLoading(false);
    }, (err) => { console.error('stack audit listener', err); setLoading(false); });
    return () => unsub();
  }, [zone]);

  // Zone locking: try to create lock doc on mount and remove on unmount
  useEffect(() => {
    let active = true;
    async function lockZone() {
      if (!user) return;
      const lockRef = doc(db, 'audit_locks', zone);
      const snap = await getDoc(lockRef);
      if (snap.exists()) {
        const data = snap.data() as any;
        // locked by someone else
        if (data.lockedBy && data.lockedBy !== user.uid) {
          setLocked({ by: data.lockedBy, byName: data.lockedByName });
          return;
        }
      }
      // take lock
      await setDoc(lockRef, { lockedBy: user.uid, lockedByName: (user as any)?.email ?? null, lockedAt: serverTimestamp() });
      setLocked({ by: user.uid, byName: (user as any)?.email ?? null });
    }
    lockZone();
    return () => {
      // release lock
      (async () => {
        try {
          const lockRef = doc(db, 'audit_locks', zone);
          const snap = await getDoc(lockRef);
          if (snap.exists()) {
            const data = snap.data() as any;
            if (data.lockedBy === (user as any)?.uid) {
              await deleteDoc(lockRef);
            }
          }
        } catch (e) { /* ignore */ }
      })();
    };
  }, [zone, user]);

  const current = items[index];

  const toInputDate = (val: any) => {
    if (!val && val !== 0) return '';
    try {
      if (val instanceof Date) {
        if (isNaN(val.getTime())) return '';
        return val.toISOString().slice(0, 10);
      }
      // Firestore Timestamp
      if (val && typeof val.toDate === 'function') {
        const d = val.toDate();
        if (isNaN(d.getTime())) return '';
        return d.toISOString().slice(0, 10);
      }
      if (typeof val === 'number') {
        const d = new Date(val);
        if (isNaN(d.getTime())) return '';
        return d.toISOString().slice(0, 10);
      }
      if (typeof val === 'string') {
        // accept YYYY-MM-DD directly
        if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
        const d = new Date(val);
        if (isNaN(d.getTime())) return '';
        return d.toISOString().slice(0, 10);
      }
    } catch (e) {
      return '';
    }
    return '';
  };

  const updateStaged = (id: string, patch: any) => {
    setStaged(s => ({ ...s, [id]: { ...(s[id] || {}), ...patch } }));
  };

  const handleCountChange = (id: string, value: number) => {
    updateStaged(id, { counted: Number(value) });
    // force condition check by clearing condition so user must confirm
    updateStaged(id, { conditionPrompt: true });
  };

  const cycleCondition = (id: string, v: 'Good'|'Damaged'|'Expired') => {
    updateStaged(id, { condition: v, conditionPrompt: false });
  };

  const addFoundItem = (payload: any) => {
    setFoundItems(f => [...f, payload]);
  };

  const next = () => { if (index < items.length - 1) setIndex(i => i + 1); };
  const prev = () => { if (index > 0) setIndex(i => i - 1); };

  const onTouchStart = (e: any) => { touchStartX.current = e.touches?.[0]?.clientX ?? null; };
  const onTouchEnd = (e: any) => {
    if (touchStartX.current == null) return;
    const endX = e.changedTouches?.[0]?.clientX ?? 0;
    const delta = endX - (touchStartX.current || 0);
    if (delta > 60) prev();
    else if (delta < -60) next();
    touchStartX.current = null;
  };

  const openReview = () => setShowReview(true);

  const submitAll = async () => {
    try {
      const batch = writeBatch(db);
      const logsToWrite: any[] = [];

      // Add inventory updates to batch
      for (const [id, entry] of Object.entries(staged)) {
        const it = items.find((x) => x.id === id);
        if (!it) continue;
        const newCount = Number(entry.counted ?? it.totalStockQuantity ?? 0);

        batch.update(doc(db, 'inventory', id), {
          totalStockQuantity: newCount,
          auditVerified: true,
          auditCondition: entry.condition ?? 'Good',
          auditNotes: entry.notes ?? null,
          updatedAt: serverTimestamp(),
        });

        // Add audit event to batch
        addAuditEventToBatch(batch, {
          eventType: 'audit_stack_verified',
          source: 'stack_audit',
          sourceId: id,
          actor: {
            userId: user?.uid ?? null,
            userEmail: user?.email ?? null,
          },
          targets: [{ collection: 'inventory', docId: id }],
          after: {
            totalStockQuantity: newCount,
            auditCondition: entry.condition ?? 'Good',
            auditVerified: true,
          },
        });

        logsToWrite.push({
          action: 'audit_count_update',
          itemId: id,
          itemName: it.name,
          userId: user?.uid ?? null,
          timestamp: serverTimestamp(),
          notes: `Zone audit: counted ${newCount}, condition ${entry.condition ?? 'Good'}`,
        });
      }

      // Add found items to batch
      for (const f of foundItems) {
        const payload: any = { ...(f || {}) };
        payload.reviewNeeded = true;
        payload.totalStockQuantity = Number(payload.totalStockQuantity ?? 0);
        payload.createdAt = serverTimestamp();
        payload.updatedAt = serverTimestamp();

        const newItemRef = doc(collection(db, 'inventory'));
        batch.set(newItemRef, payload);

        addAuditEventToBatch(batch, {
          eventType: 'audit_item_found',
          source: 'stack_audit',
          sourceId: newItemRef.id,
          actor: {
            userId: user?.uid ?? null,
            userEmail: user?.email ?? null,
          },
          targets: [{ collection: 'inventory', docId: newItemRef.id }],
          after: payload,
        });
      }

      // Commit the batch
      await batch.commit();

      // Write logs separately (non-transactional)
      for (const log of logsToWrite) {
        await addDoc(collection(db, 'inventory_logs'), log);
      }

      // Release zone lock
      try {
        await deleteDoc(doc(db, 'audit_locks', zone));
      } catch (e) {
        /* ignore */
      }

      setShowReview(false);
      alert('Zone counts submitted.');
      if (onClose) onClose();
    } catch (err) {
      console.error('submitAll failed', err);
      alert('Failed to submit counts.');
    }
  };

  if (loading) return <div className="h-56 flex items-center justify-center"><Spinner /></div>;

  if (locked && locked.by && locked.by !== (user as any)?.uid) {
    return (
      <Card className="p-4">
        <CardBody>
          <h3 className="font-semibold">Zone Locked</h3>
          <p className="text-sm">This zone is currently locked by {locked.byName || locked.by}. Try another zone or wait.</p>
        </CardBody>
      </Card>
    );
  }

  if (!current) return <div className="p-4">No items to audit in this zone.</div>;

  const stagedForCurrent = staged[current.id] || {};

  return (
    <div onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">{zoneLabel || zone} — Stack Mode</h3>
          <div className="text-sm text-gray-500">Item {index + 1} of {items.length}</div>
        </div>
        <div className="flex items-center gap-2">
          <Chip size="sm" color="primary">{current.name}</Chip>
        </div>
      </div>

      <Card className="mb-3">
        <CardBody className="p-4">
          <div className="text-xl font-bold mb-2">{current.name}</div>
          <div className="mb-4 text-sm text-gray-500 flex items-center gap-1">
            <Box size={14} /> System: {current.unopenedBoxes ?? 0} box{(current.unopenedBoxes ?? 0) !== 1 ? 'es' : ''}
            {(current.itemsPerBox ?? 0) > 1 && <span className="text-gray-400 ml-1">({current.itemsPerBox} per box)</span>}
          </div>

          {/* Count Control */}
          <div className="mb-4">
            <CountControl
              value={Number(stagedForCurrent.counted ?? '')}
              onChange={(v) => handleCountChange(current.id, v)}
              label="Count"
              presets={[1, 5, 10]}
            />
          </div>

          {/* Barcode Scan */}
          <div className="mt-4 mb-4">
            <div className="flex gap-2 mb-2">
              <Input
                label="Scan Barcode (optional)"
                placeholder="Scan GS1 barcode"
                value={stagedForCurrent._barcode ?? ''}
                onValueChange={(v) => {
                  updateStaged(current.id, { _barcode: v });
                  const parsed = parseGs1Barcode(v || '');
                  if (parsed.expiration) updateStaged(current.id, { expiration: parsed.expiration });
                  if (parsed.lot) updateStaged(current.id, { lot: parsed.lot });
                }}
              />
              <Button size="sm" onPress={() => setScannerOpen(true)} isIconOnly variant="flat" color="secondary">
                <Camera size={20} />
              </Button>
            </div>
          </div>

          {/* Expiration */}
          <div className="mt-4 mb-4">
            <label className="block text-sm font-medium mb-2">Expiration</label>
            <div className="flex items-center gap-2">
              <Input
                type="date"
                value={toInputDate(stagedForCurrent.expiration ?? (current.expirationDate ?? ''))}
                onValueChange={(v) => updateStaged(current.id, { expiration: v })}
              />
              <Button
                size="sm"
                variant="flat"
                onPress={() => {
                  const cur = stagedForCurrent.expiration ?? current.expirationDate ?? new Date();
                  const base = cur && typeof cur === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cur)
                    ? new Date(cur)
                    : cur && typeof cur.toDate === 'function'
                    ? cur.toDate()
                    : cur instanceof Date
                    ? cur
                    : new Date();
                  base.setFullYear(base.getFullYear() + 1);
                  updateStaged(current.id, { expiration: base.toISOString().slice(0, 10) });
                }}
              >
                +1y
              </Button>
              <Button
                size="sm"
                variant="flat"
                onPress={() => {
                  const cur = stagedForCurrent.expiration ?? current.expirationDate ?? new Date();
                  const base = cur && typeof cur === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cur)
                    ? new Date(cur)
                    : cur && typeof cur.toDate === 'function'
                    ? cur.toDate()
                    : cur instanceof Date
                    ? cur
                    : new Date();
                  base.setFullYear(base.getFullYear() + 2);
                  updateStaged(current.id, { expiration: base.toISOString().slice(0, 10) });
                }}
              >
                +2y
              </Button>
              <Button
                size="sm"
                variant="flat"
                onPress={() => {
                  const cur = stagedForCurrent.expiration ?? current.expirationDate ?? new Date();
                  const base = cur && typeof cur === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cur)
                    ? new Date(cur)
                    : cur && typeof cur.toDate === 'function'
                    ? cur.toDate()
                    : cur instanceof Date
                    ? cur
                    : new Date();
                  base.setFullYear(base.getFullYear() + 3);
                  updateStaged(current.id, { expiration: base.toISOString().slice(0, 10) });
                }}
              >
                +3y
              </Button>
            </div>
          </div>

          {/* Condition Toggle */}
          <div className="mt-4 mb-4">
            <ConditionToggle
              value={stagedForCurrent.condition ?? 'Good'}
              onChange={(v) => cycleCondition(current.id, v)}
              label="Condition"
            />
          </div>

          {/* Notes */}
          <div className="mt-4 mb-4">
            <Textarea
              label="Notes"
              placeholder="Add notes about this item"
              value={stagedForCurrent.notes ?? ''}
              onValueChange={(v) => updateStaged(current.id, { notes: v })}
              size="sm"
            />
          </div>

          {/* Navigation */}
          <div className="mt-4 flex items-center gap-2">
            <Button onPress={prev} isDisabled={index === 0}>
              Previous
            </Button>
            <Button onPress={next} isDisabled={index >= items.length - 1}>
              Next
            </Button>
            <Button color="primary" onPress={() => updateStaged(current.id, { counted: stagedForCurrent.counted ?? current.totalStockQuantity, condition: stagedForCurrent.condition ?? 'Good' })}>
              Save
            </Button>
          </div>
        </CardBody>
      </Card>

      {/* Quick-capture */}
      <Card className="mb-3">
        <CardBody>
          <div className="flex items-center justify-between mb-2">
            <div className="font-semibold">Found Item (Quick Capture)</div>
            <div className="text-sm text-gray-500">Add minimal info and continue</div>
          </div>
          <QuickCapture onAdd={addFoundItem} />
        </CardBody>
      </Card>

      <div className="flex justify-end gap-2">
        <Button variant="light" onPress={() => { if (onClose) onClose(); }}>Close</Button>
        <Button color="danger" onPress={openReview}><Plus /> Finish Zone</Button>
      </div>

      {/* Review modal */}
      <Modal isOpen={showReview} onOpenChange={setShowReview}>
        <ModalContent>
          <ModalHeader>Review Variances</ModalHeader>
          <ModalBody>
            <div className="space-y-2">
              {Object.entries(staged).map(([id, s]) => {
                const it = items.find(x => x.id === id);
                if (!it) return null;
                const sysBoxes = Number(it.unopenedBoxes ?? 0);
                const counted = Number(s.counted ?? sysBoxes);
                const diff = counted - sysBoxes;
                return (
                  <div key={id} className="p-2 border rounded">
                    <div className="font-semibold">{it.name}</div>
                    <div className="text-sm">System: {sysBoxes} boxes — You: {counted} boxes — Delta: {diff>0? `+${diff}`: diff}</div>
                  </div>
                );
              })}
              {foundItems.length > 0 && (
                <div className="pt-2">
                  <div className="font-semibold">Found Items</div>
                  {foundItems.map((f, i) => <div key={i} className="text-sm">{f.name} — {f.unopenedBoxes ?? f.totalStockQuantity} boxes</div>)}
                </div>
              )}
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={() => setShowReview(false)}>Cancel</Button>
            <Button color="primary" onPress={submitAll}>Confirm & Submit</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
      <BarcodeScanner isOpen={scannerOpen} onClose={() => setScannerOpen(false)} onDetected={(val) => { updateStaged(current.id, { _barcode: val }); const parsed = parseGs1Barcode(val); if (parsed.expiration) updateStaged(current.id, { expiration: parsed.expiration }); if (parsed.lot) updateStaged(current.id, { lot: parsed.lot }); setScannerOpen(false); }} />
    </div>
  );
}

function QuickCapture({ onAdd }: { onAdd: (p: any) => void }) {
  const { itemFamilies } = useOrgConfig();
  const [family, setFamily] = useState('');
  const [variantLabel, setVariantLabel] = useState('');
  const [qty, setQty] = useState<number>(1);
  const [exp, setExp] = useState('');
  const [barcode, setBarcode] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const derivedName = deriveItemName(family, variantLabel);

  const submit = () => {
    if (!family) { alert('Family required'); return; }
    onAdd({
      name: derivedName,
      family,
      variantLabel: variantLabel || undefined,
      unopenedBoxes: Number(qty || 0),
      totalStockQuantity: Number(qty || 0),
      expirationDate: exp || undefined,
      photoName: photo?.name,
      barcode: barcode || undefined,
    });
    setFamily(''); setVariantLabel(''); setQty(1); setExp(''); setPhoto(null);
  };

  return (
    <div className="space-y-2">
      <Select
        label="Family"
        variant="bordered"
        size="sm"
        selectedKeys={family ? [family] : []}
        onSelectionChange={(keys) => setFamily(String(Array.from(keys)[0] ?? ''))}
        className="overflow-visible"
        popoverProps={{ classNames: { content: 'w-fit' } }}
      >
        {itemFamilies.map((fam) => (
          <SelectItem key={fam}>{fam}</SelectItem>
        ))}
      </Select>
      <Input label="Variant (optional)" placeholder="e.g. Small, M, 28 Fr" value={variantLabel} onValueChange={setVariantLabel} />
      <p className="text-xs text-foreground-400">
        Name: <span className="font-semibold text-foreground-600">{derivedName || '—'}</span>
      </p>
      <Input label="Scan Barcode (optional)" placeholder="Scan GS1 barcode" value={barcode} onValueChange={(v) => {
        setBarcode(v);
        const parsed = parseGs1Barcode(v || '');
        if (parsed.expiration) setExp(parsed.expiration);
      }} />
      <Input label="Qty" type="number" value={String(qty)} onValueChange={(v) => setQty(Number(v || 0))} />
      <Input label="Expiration" type="date" value={exp} onValueChange={setExp} />
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 cursor-pointer">
          <Camera /> <span className="text-sm">Photo</span>
          <input type="file" accept="image/*" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} className="hidden" />
        </label>
        <Button color="primary" onPress={submit}>Add</Button>
      </div>
    </div>
  );
}
