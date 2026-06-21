"use client";

import React, { useEffect, useState } from 'react';
import { Card, CardBody, CardHeader, Button, Input, Select, SelectItem, Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Spinner } from '@heroui/react';
import { Edit2, Trash2 } from 'lucide-react';
import { db } from '@/firebase';
import { collection, doc, onSnapshot, addDoc, setDoc, runTransaction, deleteDoc, serverTimestamp, query, orderBy, where, getDoc, getDocs, limit } from 'firebase/firestore';

const LOCATIONS = ['HQ', 'Shed'];
const LOCATION_MAP: Record<string, string[]> = { HQ: ['Receiving', 'Storage'], Shed: ['A', 'B'] };

export default function RestockPage() {
  const [shelves, setShelves] = useState<any[]>([]);
  const [inventoryOptions, setInventoryOptions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState('');
  const [selectedItemId, setSelectedItemId] = useState('');
  const [location, setLocation] = useState(LOCATIONS[0]);
  const [locationDetail, setLocationDetail] = useState(LOCATION_MAP[LOCATIONS[0]][0]);
  const [frontRoom, setFrontRoom] = useState('');
  const [frontShelf, setFrontShelf] = useState('');
  const [frontLevel, setFrontLevel] = useState('');
  const [pendingCount, setPendingCount] = useState<number>(0);

  const [inventoryLoaded, setInventoryLoaded] = useState(false);
  const [opLoading, setOpLoading] = useState(false);
  const [restockOpen, setRestockOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [activeShelf, setActiveShelf] = useState<any>(null);
  const [expandedShelfId, setExpandedShelfId] = useState<string | null>(null);
  const [shelfLogs, setShelfLogs] = useState<any[]>([]);
  const [shelfEvents, setShelfEvents] = useState<any[]>([]);
  const [shelfReports, setShelfReports] = useState<any[]>([]);
  const [restockQty, setRestockQty] = useState<number>(1);
  const [note, setNote] = useState('');
  const [restockDebug, setRestockDebug] = useState<string | null>(null);
  const [availableBatches, setAvailableBatches] = useState<any[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);

  useEffect(() => {
    const q = query(collection(db, 'restock_shelves'), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(q, snap => {
      const arr: any[] = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
      setShelves(arr);
      setLoading(false);
    });

    const iq = collection(db, 'inventory');
    const unsub2 = onSnapshot(iq, snap => {
      setInventoryOptions(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })));
      setInventoryLoaded(true);
    });

    return () => { unsub(); unsub2(); };
  }, []);

  function formatDate(ts: any) {
    if (!ts) return 'Never';
    if (typeof ts?.toDate === 'function') return ts.toDate().toLocaleString();
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return String(ts);
    }
  }

  async function createShelf() {
    setOpLoading(true);
    try {
      await addDoc(collection(db, 'restock_shelves'), {
        name,
        itemId: selectedItemId || null,
        location,
        locationDetail: locationDetail || null,
        frontRoom: frontRoom || null,
        frontShelf: frontShelf || null,
        frontLevel: frontLevel ? Number(frontLevel) : null,
        pendingCount: Number(pendingCount) || 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      setName(''); setSelectedItemId(''); setLocation(LOCATIONS[0]); setLocationDetail(LOCATION_MAP[LOCATIONS[0]][0]); setFrontRoom(''); setFrontShelf(''); setFrontLevel(''); setPendingCount(0);
    } catch (e) {
      console.error(e);
    }
    setOpLoading(false);
  }

  function openRestock(shelf: any) {
    setActiveShelf(shelf);
    setRestockQty(1);
    setNote('');
    // fetch available batches for this shelf's item (if any)
    (async () => {
      setAvailableBatches([]);
      setSelectedBatchId(null);
      try {
        let invId = shelf.itemId || null;
        if (!invId && shelf.itemName) {
          const iq = query(collection(db, 'inventory'), where('name', '==', shelf.itemName), limit(1));
          const found = await getDocs(iq);
          if (!found.empty) invId = found.docs[0].id;
        }
        if (invId) {
          const invSnap = await getDoc(doc(db, 'inventory', invId));
          if (invSnap.exists()) {
            const inv = invSnap.data() as any;
            const batches = Array.isArray(inv.batches) ? inv.batches.map((b: any) => ({ ...(b||{}), id: b.id || b.batchId || null })) : [];
            // default select earliest exp
            batches.sort((a: any,b: any) => { const ta = a.expirationDate?new Date(a.expirationDate).getTime():Infinity; const tb = b.expirationDate?new Date(b.expirationDate).getTime():Infinity; return ta - tb; });
            setAvailableBatches(batches);
            if (batches.length > 0) setSelectedBatchId(batches[0].id || null);
          }
        }
      } catch (e) { console.error('Error loading batches for restock', e); }
      setRestockOpen(true);
    })();
  }

  function toggleShelfLog(shelf: any) {
    if (expandedShelfId === shelf.id) {
      setExpandedShelfId(null);
      setShelfLogs([]);
      setShelfEvents([]);
      setShelfReports([]);
      setActiveShelf(null);
      return;
    }
    setExpandedShelfId(shelf.id);
    setActiveShelf(shelf);
  }

  useEffect(() => {
    if (!expandedShelfId) {
      setShelfLogs([]);
      setShelfEvents([]);
      setShelfReports([]);
      return;
    }

    const evQ = query(collection(db, 'restock_shelf_events'), where('shelfId', '==', expandedShelfId));
    const repQ = query(collection(db, 'restock_reports'), where('shelfId', '==', expandedShelfId));

    const unsubE = onSnapshot(evQ, snap => {
      const evs = snap.docs.map(d => ({ id: d.id, ...(d.data() as any), type: 'event' }));
      setShelfEvents(evs);
      const merged = [...evs, ...shelfReports];
      merged.sort((a,b) => (b.createdAt?.toMillis?.() || Date.parse(b.createdAt || '')) - (a.createdAt?.toMillis?.() || Date.parse(a.createdAt || '')));
      setShelfLogs(merged);
    });

    const unsubR = onSnapshot(repQ, snap => {
      const reps = snap.docs.map(d => ({ id: d.id, ...(d.data() as any), type: 'report' }));
      setShelfReports(reps);
      const merged = [...shelfEvents, ...reps];
      merged.sort((a,b) => (b.createdAt?.toMillis?.() || Date.parse(b.createdAt || '')) - (a.createdAt?.toMillis?.() || Date.parse(a.createdAt || '')));
      setShelfLogs(merged);
    });

    return () => { unsubE(); unsubR(); };
  }, [expandedShelfId]);

  async function confirmRestock() {
    if (!activeShelf) return;
    setOpLoading(true);
    const qty = Number(restockQty) || 0;
    const shelfRef = doc(db, 'restock_shelves', activeShelf.id);

    if (qty <= 0) { setOpLoading(false); return; }

    try {
      const attemptMsg = `Attempting restock: shelf=${activeShelf.id} qty=${qty} note=${note}`;
      console.debug(attemptMsg);
      // fetch pre-transaction snapshot for debugging and attempt to resolve an inventory id by name
      let resolvedItemId: string | null = null;
      try {
        const preShelfSnap = await getDoc(shelfRef);
        const preShelf = preShelfSnap.exists() ? preShelfSnap.data() : null;
        let preInv: any = null;
        if (preShelf?.itemId) {
          resolvedItemId = preShelf.itemId;
          const preInvSnap = await getDoc(doc(db, 'inventory', preShelf.itemId));
          preInv = preInvSnap.exists() ? preInvSnap.data() : null;
        } else if (preShelf?.itemName) {
          // try to find inventory by matching name
          try {
            const iq = query(collection(db, 'inventory'), where('name', '==', preShelf.itemName), limit(1));
            const found = await getDocs(iq);
            if (!found.empty) {
              const d = found.docs[0];
              resolvedItemId = d.id;
              preInv = d.data();
            }
          } catch (qe) { console.error('Error querying inventory by name', qe); }
        }
        const preMsg = `Pre-transaction shelf: ${JSON.stringify(preShelf)}, pre-inv: ${JSON.stringify(preInv)}, resolvedItemId: ${resolvedItemId}`;
        console.debug(preMsg);
        setRestockDebug(attemptMsg + ' | ' + preMsg);
      } catch (e) { console.error('Error fetching pre-transaction docs', e); }

      let batchAdjustmentsLocal: Array<{ batchId?: string | null; delta: number }> = [];
      await runTransaction(db, async (tx) => {
        // Read first: shelf and (if present) inventory
        const shelfSnap = await tx.get(shelfRef);
        if (!shelfSnap.exists()) throw new Error('Shelf not found');
        const shelfData = shelfSnap.data() as any;
        const itemId = shelfData.itemId || resolvedItemId || null;

        let invRef: any = null;
        let newQty: number | null = null;
        let inv: any = null;
        if (itemId) {
          invRef = doc(db, 'inventory', itemId);
          const invSnap = await tx.get(invRef);
          if (!invSnap.exists()) throw new Error('Inventory not found');
            inv = invSnap.data() as any;
            const invQty = Number(inv.totalStockQuantity ?? inv.quantity ?? 0);
            if (isNaN(invQty)) throw new Error('Inventory quantity invalid');

            // If inventory uses batches, consume from earliest-expiring batches first.
            let batchAdjustments: Array<{ batchId?: string | null; delta: number }> = [];
            if (Array.isArray(inv.batches) && inv.batches.length > 0) {
              const batches = (inv.batches || []).map((b: any, idx: number) => ({ ...(b || {}), __idx: idx, id: b.id || b.batchId || null }));
              batches.sort((a: any, b: any) => {
                const ta = a.expirationDate ? new Date(a.expirationDate).getTime() : Infinity;
                const tb = b.expirationDate ? new Date(b.expirationDate).getTime() : Infinity;
                return ta - tb;
              });

              let remaining = qty;
              // If user selected a specific batch, only consume from that batch
              if (selectedBatchId) {
                const target = batches.find((bb: any) => (bb.id || bb.batchId) === selectedBatchId);
                if (!target) throw new Error('Selected batch not found');
                const stock = Number(target.stock ?? 0);
                if (stock < qty) throw new Error(`Selected batch only has ${stock} units`);
                const origIdx = target.__idx;
                inv.batches[origIdx] = { ...(inv.batches[origIdx] || {}), stock: Math.max(0, stock - qty) };
                batchAdjustments.push({ batchId: inv.batches[origIdx]?.id || inv.batches[origIdx]?.batchId || null, delta: -qty });
              } else {
                for (const b of batches) {
                  const stock = Number(b.stock ?? 0);
                  if (stock <= 0) continue;
                  const take = Math.min(remaining, stock);
                  // update the original inv.batches slot
                  const origIdx = b.__idx;
                  inv.batches[origIdx] = { ...(inv.batches[origIdx] || {}), stock: Math.max(0, stock - take) };
                  batchAdjustments.push({ batchId: inv.batches[origIdx]?.id || inv.batches[origIdx]?.batchId || null, delta: -take });
                  remaining -= take;
                  if (remaining <= 0) break;
                }
                if (remaining > 0) throw new Error(`Not enough inventory in batches: need ${qty}, available ${qty - remaining}`);
              }
              // After adjusting batch stocks, recompute total quantity from batches
              const totalFromBatches = (inv.batches || []).reduce((acc: number, bb: any) => acc + Number(bb?.stock ?? 0), 0);
              newQty = totalFromBatches;
              // attach batchAdjustments for event recording
              batchAdjustmentsLocal = batchAdjustments;
            } else {
              if (invQty < qty) throw new Error(`Not enough inventory: have ${invQty}, need ${qty}`);
              newQty = invQty - qty;
            }
        }

        // All reads done — now perform writes
        const shelfUpdates: any = { pendingCount: Math.max(0, (shelfData.pendingCount || 0) - qty), updatedAt: serverTimestamp() };
        if (!shelfData.itemId && resolvedItemId) shelfUpdates.itemId = resolvedItemId;
        tx.update(shelfRef, shelfUpdates);
        if (invRef && newQty !== null) {
          console.debug('Transaction will update inventory', { itemId, qty, newQty });
          if (inv && Array.isArray(inv.batches) && inv.batches.length > 0) {
            // Sync both fields: unopenedBoxes stays as-is (handled by consumeBox), totalStockQuantity = batch sum
            tx.update(invRef, { totalStockQuantity: newQty, batches: inv.batches, updatedAt: serverTimestamp() });
          } else {
            tx.update(invRef, { totalStockQuantity: newQty, updatedAt: serverTimestamp() });
          }
        }

        const eventsRef = collection(db, 'restock_shelf_events');
        tx.set(doc(eventsRef), {
          shelfId: shelfSnap.id,
          itemId: itemId || null,
          delta: -qty,
          note: note || null,
          batchAdjustments: batchAdjustmentsLocal.length ? batchAdjustmentsLocal : undefined,
          createdAt: serverTimestamp()
        } as any);

        // record lastRestockedAt on shelf for quick UI reads
        tx.update(shelfRef, { lastRestockedAt: serverTimestamp(), updatedAt: serverTimestamp() });
      });
      // after transaction, fetch and log updated inventory value for debugging
      try {
        const postId = resolvedItemId || activeShelf?.itemId;
        if (postId) {
          const postInvSnap = await getDoc(doc(db, 'inventory', postId));
          const info = postInvSnap.exists() ? JSON.stringify(postInvSnap.data()) : 'null';
          const postMsg = `Post-transaction inventory for ${postId}: ${info}`;
          console.debug(postMsg);
          setRestockDebug(postMsg);
        }
      } catch (e) { console.error('Error fetching post-transaction inventory', e); setRestockDebug('Error fetching post-transaction inventory: ' + String(e)); }
      setAvailableBatches([]);
      setSelectedBatchId(null);
      setRestockOpen(false);
    } catch (err) {
      console.error(err);
      const em = (err as any)?.message || 'Restock failed';
      setRestockDebug('Error: ' + em);
      alert(em);
    }
    setOpLoading(false);
  }

  async function deleteShelf(id: string) {
    if (!confirm('Delete shelf?')) return;
    setOpLoading(true);
    try { await deleteDoc(doc(db, 'restock_shelves', id)); } catch (e) { console.error(e); }
    setOpLoading(false);
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-8">
        <div>
          <h1 className="text-2xl font-semibold mb-3">Restock</h1>
          <Card className="p-4 mb-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Input label="Shelf Name" value={name} onValueChange={setName} />
              <Select label="Inventory Item (optional)" selectedKeys={selectedItemId ? [selectedItemId] : []} onSelectionChange={(keys: any) => { const v = Array.from(keys)[0] as string | undefined; setSelectedItemId(v || ''); }}>
                <SelectItem key="none" textValue="-- none --">-- none --</SelectItem>
                {inventoryOptions.map((i: any) => {
                  const label = i.name + (typeof i.quantity !== 'undefined' ? ' (qty ' + i.quantity + ')' : '');
                  return <SelectItem key={i.id} textValue={label}>{label}</SelectItem>;
                }) as any}
              </Select>
              <div className="grid grid-cols-2 gap-2">
                <Select label="Location" selectedKeys={[location]} onSelectionChange={(keys: any) => { const v = Array.from(keys)[0] as string; setLocation(v); setLocationDetail(LOCATION_MAP[v]?.[0] || ''); }}>
                  {LOCATIONS.map(l => <SelectItem key={l} textValue={l}>{l}</SelectItem>)}
                </Select>
                <Select label="Location Detail" selectedKeys={[locationDetail]} onSelectionChange={(keys: any) => { const v = Array.from(keys)[0] as string; setLocationDetail(v); }}>
                  {(LOCATION_MAP[location] || []).map(d => <SelectItem key={d} textValue={d}>{d}</SelectItem>)}
                </Select>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <Input type="number" label="Initial Pending" value={String(pendingCount)} onValueChange={(v: any) => setPendingCount(Number(v) || 0)} className="max-w-[140px]" />
              <div className="flex-1" />
              <Button color="primary" onPress={createShelf} isLoading={opLoading}>Create Shelf</Button>
            </div>
            <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3 bg-amber-50 dark:bg-amber-900/10 p-3 rounded-lg border border-amber-100">
              <Input label="Front Room" placeholder="e.g., Reception, Main Hall" value={frontRoom} onValueChange={setFrontRoom} description="Which room in the front" />
              <Input label="Front Shelf" placeholder="e.g., Wall Shelf A" value={frontShelf} onValueChange={setFrontShelf} description="Which shelf/rack" />
              <Input label="Level" type="number" placeholder="e.g., 1 (top)" value={frontLevel} onValueChange={setFrontLevel} description="Shelf level" />
            </div>
          </Card>
        </div>

        {restockDebug ? (
          <div className="max-w-7xl mx-auto">
            <div className="mt-2 p-3 bg-yellow-50 text-sm text-yellow-800 rounded">
              <div className="flex items-start justify-between gap-4">
                <div>{restockDebug}</div>
                <button className="text-xs text-yellow-700 underline" onClick={() => setRestockDebug(null)}>Dismiss</button>
              </div>
            </div>
          </div>
        ) : null}

        <Card>
          <CardHeader><h2 className="text-lg font-semibold">Created Shelves</h2></CardHeader>
          <CardBody>
            <div className="grid gap-3">
              {loading ? (
                <div className="flex justify-center py-6"><Spinner /></div>
              ) : shelves.length === 0 ? (
                <div className="text-sm text-foreground-500">No shelves yet</div>
                ) : (
                shelves.map((s: any) => (
                  <div key={s.id}>
                    <div className="p-3 bg-content1 rounded-md grid grid-cols-[1fr_auto] items-center cursor-pointer" onClick={() => toggleShelfLog(s)}>
                    <div>
                      <div className="text-lg font-semibold">{s.name}</div>
                      <div className="text-sm text-foreground-500 mt-1">
                        {s.location}{s.locationDetail ? ' — ' + s.locationDetail : ''}
                        {(s.frontRoom || s.frontShelf || s.frontLevel) && (
                          <span className="ml-2 text-indigo-500">
                            [{[s.frontRoom, s.frontShelf, s.frontLevel ? `Level ${s.frontLevel}` : ''].filter(Boolean).join(', ')}]
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-2">
                        <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded bg-primary-50 text-primary">Last: {formatDate(s.lastRestockedAt)}</span>
                        {s.itemId ? <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium rounded bg-content2 text-foreground-500">Item: {inventoryOptions.find((i:any)=>i.id===s.itemId)?.name || s.itemName || (inventoryLoaded ? 'Unknown Item' : '…')}</span> : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                      <Button color="primary" className="shadow-md" onPress={() => openRestock(s)}>Restock</Button>
                      <Button variant="ghost" onPress={() => { setActiveShelf(s); setEditOpen(true); }} aria-label="Edit shelf"><Edit2 size={16} /></Button>
                      <Button variant="ghost" color="danger" onPress={() => deleteShelf(s.id)} aria-label="Delete shelf"><Trash2 size={16} /></Button>
                    </div>

                    </div>

                                    {expandedShelfId === s.id ? (
                      <div className="mt-2 p-3 bg-content2 rounded">
                        {shelfLogs.length === 0 ? (
                          <div className="text-sm text-foreground-500">No activity recorded for this shelf.</div>
                        ) : (
                          <ul className="space-y-3">
                            {shelfLogs.map((l: any) => (
                              <li key={l.id} className="p-3 bg-content1 rounded">
                                <div className="flex justify-between">
                                  <div className="font-medium text-sm">{l.type === 'event' ? 'Restock' : 'Report'}</div>
                                  <div className="text-xs text-foreground-400">{formatDate(l.createdAt)}</div>
                                </div>
                                <div className="text-sm text-foreground-500 mt-1">{l.note || l.message || JSON.stringify(l)}</div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </CardBody>
        </Card>
      </div>

      <Modal isOpen={restockOpen} onOpenChange={setRestockOpen} placement="center" size="sm">
        <ModalContent>
          <>
            <ModalHeader>Confirm Restock</ModalHeader>
            <ModalBody>
                <div className="space-y-3">
                    <div className="text-sm">Shelf: {activeShelf?.name}</div>
                    {availableBatches.length > 0 ? (
                      <Select label="Batch to use" selectedKeys={selectedBatchId ? [selectedBatchId] : []} onSelectionChange={(keys: any) => { const v = Array.from(keys)[0] as string | undefined; setSelectedBatchId(v || null); }}>
                        <SelectItem key="__auto" textValue="Auto choose">-- auto choose (earliest-first) --</SelectItem>
                        {availableBatches.map((b: any) => {
                          const exp = b.expirationDate ? new Date(b.expirationDate).toLocaleDateString() : 'no exp';
                          const label = `${b.lotNumber || b.id || 'batch'} — exp: ${exp}`;
                          const val = b.id || '';
                          return <SelectItem key={val} textValue={label}>{label}</SelectItem>;
                        }) as any}
                      </Select>
                    ) : null}
                    <Input label="Quantity" type="number" value={String(restockQty)} onValueChange={(v: any) => setRestockQty(Number(v) || 0)} />
                    <Input label="Note (optional)" value={note} onValueChange={setNote} />
                </div>
              </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={() => { setRestockOpen(false); setAvailableBatches([]); setSelectedBatchId(null); }}>Cancel</Button>
              <Button color="primary" onPress={confirmRestock} isLoading={opLoading}>Confirm</Button>
            </ModalFooter>
        </>
      </ModalContent>
      </Modal>

      <Modal isOpen={editOpen} onOpenChange={setEditOpen} placement="center" size="sm">
        <ModalContent>
          <>
            <ModalHeader>Edit Shelf</ModalHeader>
            <ModalBody>
                <div className="space-y-3">
                  <Input label="Shelf Name" value={activeShelf?.name || ''} onValueChange={(v: any) => setActiveShelf((s: any) => ({ ...s, name: v }))} />
                  <Select label="Inventory Item (optional)" selectedKeys={activeShelf?.itemId ? [activeShelf.itemId] : []} onSelectionChange={(keys: any) => { const v = Array.from(keys)[0] as string | undefined; setActiveShelf((s: any) => ({ ...s, itemId: v || null })); }}>
                    <SelectItem key="none" textValue="-- none --">-- none --</SelectItem>
                    {inventoryOptions.map((i: any) => <SelectItem key={i.id} textValue={i.name}>{i.name}</SelectItem>) as any}
                  </Select>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                    <Select label="Location" selectedKeys={[activeShelf?.location || LOCATIONS[0]]} onSelectionChange={(keys: any) => { const v = Array.from(keys)[0] as string; setActiveShelf((s: any) => ({ ...s, location: v })); }}>
                      {LOCATIONS.map(l => <SelectItem key={l} textValue={l}>{l}</SelectItem>)}
                    </Select>
                    <Select label="Location Detail" selectedKeys={[activeShelf?.locationDetail || (LOCATION_MAP[activeShelf?.location || LOCATIONS[0]]?.[0] || '')]} onSelectionChange={(keys: any) => { const v = Array.from(keys)[0] as string; setActiveShelf((s: any) => ({ ...s, locationDetail: v })); }}>
                      {(LOCATION_MAP[activeShelf?.location || location] || []).map(d => <SelectItem key={d} textValue={d}>{d}</SelectItem>)}
                    </Select>
                  </div>
                  <div className="grid grid-cols-3 gap-3 bg-amber-50 dark:bg-amber-900/10 p-3 rounded-lg border border-amber-100">
                    <Input label="Front Room" placeholder="e.g., Reception" value={activeShelf?.frontRoom || ''} onValueChange={(v: any) => setActiveShelf((s: any) => ({ ...s, frontRoom: v }))} />
                    <Input label="Front Shelf" placeholder="e.g., Wall Shelf A" value={activeShelf?.frontShelf || ''} onValueChange={(v: any) => setActiveShelf((s: any) => ({ ...s, frontShelf: v }))} />
                    <Input label="Level" type="number" placeholder="e.g., 1" value={activeShelf?.frontLevel?.toString() || ''} onValueChange={(v: any) => setActiveShelf((s: any) => ({ ...s, frontLevel: v ? Number(v) : null }))} />
                  </div>
                </div>
              </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={() => setEditOpen(false)}>Cancel</Button>
              <Button color="primary" onPress={async () => {
                if (!activeShelf?.id) return;
                setOpLoading(true);
                try {
                  await setDoc(doc(db, 'restock_shelves', activeShelf.id), { ...activeShelf, updatedAt: serverTimestamp() }, { merge: true });
                  setEditOpen(false);
                } catch (e) { console.error(e); }
                setOpLoading(false);
              }} isLoading={opLoading}>Save</Button>
            </ModalFooter>
        </>
      </ModalContent>
      </Modal>

      

    </div>
  );
}
