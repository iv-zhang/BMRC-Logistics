'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Input, Button, Select, SelectItem, Card, CardBody, Spinner } from '@heroui/react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { collection, query, orderBy, onSnapshot, doc, getDoc, updateDoc, serverTimestamp, addDoc } from 'firebase/firestore';
import { db, auth } from '@/firebase';
import type { InventoryItem } from '@/app/types';
import { parseGs1Barcode } from '@/app/lib/gs1';
import BarcodeScanner from '@/app/components/barcode-scanner';

type Props = { auditVerify?: boolean };

export default function MobileQuickCount({ auditVerify = false }: Props) {
  const router = useRouter();
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lot, setLot] = useState('');
  const [expiration, setExpiration] = useState('');
  const [barcode, setBarcode] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  const [locationName, setLocationName] = useState('');
  const [quantity, setQuantity] = useState<number>(1);
  const uniqueId = () => (typeof crypto !== 'undefined' && (crypto as any).randomUUID ? (crypto as any).randomUUID() : `${Date.now().toString()}-${Math.random().toString(36).slice(2,9)}`);

  useEffect(() => {
    const unsubAuth = onAuthStateChanged(auth, (u) => {
      if (!u) router.push('/login'); else setUser(u);
    });
    const q = query(collection(db, 'inventory'), orderBy('name'));
    const unsub = onSnapshot(q, snap => {
      const arr: InventoryItem[] = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) } as InventoryItem));
      setItems(arr);
      setLoading(false);
    });
    return () => { unsub(); unsubAuth(); };
  }, [router]);

  const filtered = items.filter(i => !search || i.name.toLowerCase().includes(search.toLowerCase()));

  const onSave = async () => {
    if (!selectedId) { alert('Select an item first'); return; }
    try {
      const itemRef = doc(db, 'inventory', selectedId);
      const snap = await getDoc(itemRef);
      if (!snap.exists()) {
        alert('Item not found');
        return;
      }
      const data = snap.data() as any;
      const batches = Array.isArray(data.batches) ? data.batches.slice() : [];
      // Try to match batch by lot + expiration
      let foundIdx = -1;
      for (let i = 0; i < batches.length; i++) {
        const b = batches[i];
        const sameLot = lot && b.lotNumber && b.lotNumber === lot;
        const sameExp = expiration && b.expirationDate && new Date(b.expirationDate).toISOString().split('T')[0] === expiration;
        if ((lot && sameLot) || (expiration && sameExp)) { foundIdx = i; break; }
      }

      const locEntry = { id: uniqueId(), name: locationName || 'Unknown', quantity: Number(quantity || 0) };

      if (foundIdx >= 0) {
        const b = batches[foundIdx];
        b.stock = Number(b.stock ?? 0) + Number(quantity || 0);
        b.locations = Array.isArray(b.locations) ? b.locations : [];
        b.locations.push(locEntry);
        batches[foundIdx] = b;
      } else {
        const newBatch = { id: uniqueId(), lotNumber: lot || undefined, expirationDate: expiration ? new Date(expiration) : undefined, stock: Number(quantity || 0), locations: [locEntry], notes: 'quick-count' };
        batches.push(newBatch);
      }

      const total = batches.reduce((acc: number, b: any) => acc + Number(b.stock ?? 0), 0) + (Number(data.totalStockQuantity ?? 0) - (Array.isArray(data.batches) ? data.batches.reduce((a:any,b:any)=>a+Number(b.stock||0),0):0));

      const payload: any = { batches, totalStockQuantity: total, updatedAt: serverTimestamp() };
      if (auditVerify) payload.auditVerified = true;
      await updateDoc(itemRef, payload);
      await addDoc(collection(db, 'inventory_logs'), {
        action: auditVerify ? 'audit_quickcount' : 'quick_count',
        itemId: selectedId,
        userId: user?.uid ?? null,
        timestamp: serverTimestamp(),
        notes: 'quick-count'
      });
      alert('Quick count saved');
      // Reset
      setLot(''); setExpiration(''); setLocationName(''); setQuantity(1);
    } catch (err) {
      console.error(err); alert('Save failed');
    }
  };

  if (loading) return <div className="h-screen flex items-center justify-center"><Spinner /></div>;

  return (
    <div className="p-4 min-h-screen bg-white dark:bg-slate-900">
      <h2 className="text-xl font-bold mb-3">Quick Count</h2>
      <Input label="Search item" placeholder="Search" value={search} onValueChange={setSearch} />
      <div className="mt-3 max-h-56 overflow-auto">
        {filtered.map(it => (
          <div key={it.id} className={`p-2 border rounded mb-2 ${selectedId===it.id? 'border-indigo-500 bg-indigo-50': ''}`} onClick={() => setSelectedId(it.id)}>
            <div className="font-semibold">{it.name}</div>
            <div className="text-xs text-gray-500">Total: {it.totalStockQuantity ?? 0}</div>
          </div>
        ))}
      </div>

      <div className="mt-4 space-y-2">
        <div className="flex gap-2">
          <Input label="Scan Barcode (optional)" placeholder="Scan GS1 barcode" value={barcode} onValueChange={(v) => {
            setBarcode(v);
            const parsed = parseGs1Barcode(v || '');
            if (parsed.lot) setLot(parsed.lot);
            if (parsed.expiration) setExpiration(parsed.expiration);
          }} />
          <Button size="sm" onPress={() => setScannerOpen(true)}>Scan</Button>
        </div>
        <Input label="Lot / Batch # (optional)" value={lot} onValueChange={setLot} />
        <Input type="date" label="Expiration (optional)" value={expiration} onValueChange={setExpiration} />
        <Input label="Location name" placeholder="Back storage / Statpack" value={locationName} onValueChange={setLocationName} />
        <Input type="number" label="Quantity" value={String(quantity)} onValueChange={(v) => setQuantity(Number(v))} />
        <Button color="primary" onPress={onSave} className="w-full">Save Count</Button>
      </div>
      <BarcodeScanner isOpen={scannerOpen} onClose={() => setScannerOpen(false)} onDetected={(val) => { setBarcode(val); const parsed = parseGs1Barcode(val); if (parsed.lot) setLot(parsed.lot); if (parsed.expiration) setExpiration(parsed.expiration); setScannerOpen(false); }} />
    </div>
  );
}
