"use client";
import React, { useEffect, useState } from 'react';
import BarcodeScanner from '@/app/components/barcode-scanner';
import { Button, Spinner, Input, Textarea, Checkbox, Select, SelectItem } from '@heroui/react';
import { db, auth } from '@/firebase';
import { doc, getDoc, collection, addDoc, serverTimestamp, getDocs } from 'firebase/firestore';
import { useSearchParams } from 'next/navigation';

export default function MobileScanReportClient() {
  const searchParams = useSearchParams();
  const initialId = searchParams?.get('id') || '';

  const [scannerOpen, setScannerOpen] = useState<boolean>(false);
  const [scanned, setScanned] = useState<string | null>(initialId || null);
  const [boxOptions, setBoxOptions] = useState<{id:string,name:string}[]>([]);
  const [selectedBoxId, setSelectedBoxId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [pack, setPack] = useState<any | null>(null);
  const [itemsState, setItemsState] = useState<any[]>([]);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (scanned) fetchPack(scanned);
  }, [scanned]);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const snaps = await getDocs(collection(db, 'restock_boxes'));
        const opts = snaps.docs.map((d: any) => ({ id: d.id, name: (d.data()?.name) || d.id }));
        if (mounted) setBoxOptions(opts);
      } catch (e) {
        console.error('failed to load restock boxes', e);
      }
    };
    load();
    return () => { mounted = false; };
  }, []);

  const onDetected = (val: string) => {
    try {
      const u = new URL(val);
      const id = u.searchParams.get('id');
      if (id) {
        setScanned(id);
        return;
      }
    } catch (e) {
      // not a URL
    }
    setScanned(val);
  };

  const fetchPack = async (id: string) => {
    setLoading(true);
    setMessage(null);
    try {
      const ref = doc(db, 'restock_boxes', id);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        setMessage('Restock box not found');
        setPack(null);
        setItemsState([]);
        return;
      }
      const data = snap.data();
      setPack({ id: snap.id, ...data });
      const contents = (data.contents || []).map((it: any) => ({
        itemId: it.itemId,
        name: it.itemDetails?.name || it.itemId,
        requiredQuantity: it.requiredQuantity || 0,
        observedQuantity: it.currentQuantity ?? 0,
        low: false,
        note: ''
      }));
      setItemsState(contents);
    } catch (e) {
      console.error(e);
      setMessage('Failed to load restock box');
    } finally {
      setLoading(false);
    }
  };

  const toggleLow = (idx: number) => {
    setItemsState(prev => prev.map((it, i) => i === idx ? {...it, low: !it.low} : it));
  };

  const updateObserved = (idx: number, v: number) => {
    setItemsState(prev => prev.map((it, i) => i === idx ? {...it, observedQuantity: v} : it));
  };

  const submitReport = async () => {
    if (!pack) return;
    const user = auth.currentUser;
    const reporter = user ? (user.displayName || user.email || user.uid) : 'anonymous';
    const reportedItems = itemsState.filter(i => i.low).map(i => ({
      itemId: i.itemId,
      name: i.name,
      requiredQuantity: i.requiredQuantity,
      observedQuantity: i.observedQuantity,
      note: i.note || ''
    }));
    if (reportedItems.length === 0) {
      setMessage('Select at least one item to report as low.');
      return;
    }
    setSubmitting(true);
    try {
      await addDoc(collection(db, 'restock_reports'), {
        restockBoxId: pack.id,
        restockBoxName: pack.name || null,
        reporter,
        reporterId: user?.uid || null,
        items: reportedItems,
        notes: notes || null,
        createdAt: serverTimestamp()
      });
      setMessage('Report submitted. Thank you!');
      setItemsState(prev => prev.map(i => ({...i, low: false, note: ''})));
      setNotes('');
    } catch (e) {
      console.error(e);
      setMessage('Failed to submit report.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-4">
      <div className="max-w-xl mx-auto space-y-4">
        <h2 className="text-xl font-bold">Scan Restock Box QR to Report Low Stock</h2>
        <p className="text-sm text-gray-600">Scan the QR on the restock box or paste the box id below.</p>

        <div className="space-y-2">
          <div className="flex gap-2">
            <div className="w-48">
              <Select
                placeholder="Select restock box"
                selectedKeys={selectedBoxId ? [selectedBoxId] : []}
                onChange={(e) => { setSelectedBoxId(e.target.value); setScanned(e.target.value); }}
              >
                {boxOptions.map(s => (
                  <SelectItem key={s.id} textValue={s.name}>{s.name}</SelectItem>
                ))}
              </Select>
            </div>
            <Input placeholder="Or paste restock box id or URL" value={scanned ?? ''} onValueChange={(v) => { setScanned(v); setSelectedBoxId(''); }} />

            <Button color="primary" onPress={() => setScannerOpen(true)}>Scan</Button>
          </div>
          <div className="text-xs text-gray-500">Tip: QR typically encodes a URL with `?id=` parameter.</div>
        </div>

        <BarcodeScanner isOpen={scannerOpen} onClose={() => setScannerOpen(false)} onDetected={(v) => { onDetected(v); setScannerOpen(false); }} />

        {loading && <div className="flex items-center justify-center"><Spinner /></div>}

        {message && <div className="text-sm text-primary-700">{message}</div>}

        {pack && (
          <div className="bg-white p-4 rounded-lg shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="font-bold">{pack.name}</div>
                <div className="text-xs text-gray-500">{pack.type || ''}</div>
              </div>
            </div>

            <div className="space-y-2">
              {itemsState.length === 0 && <div className="text-xs text-gray-500">No items found in this restock box.</div>}
              {itemsState.map((it, idx) => (
                <div key={`${it.itemId}_${idx}`} className="flex items-center gap-3 border-b border-gray-100 py-2">
                  <div className="w-6">
                    <Checkbox isSelected={it.low} onValueChange={() => toggleLow(idx)} />
                  </div>
                  <div className="flex-grow">
                    <div className="font-medium">{it.name}</div>
                    <div className="text-xs text-gray-500">Required: {it.requiredQuantity}</div>
                  </div>
                  <div className="w-28">
                    <Input size="sm" type="number" value={String(it.observedQuantity ?? 0)} onValueChange={(v) => updateObserved(idx, Number(v))} />
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-3">
              <Textarea label="Notes (optional)" placeholder="e.g., missing airway kit, no seals" value={notes} onValueChange={setNotes} />
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <Button variant="light" onPress={() => { setPack(null); setScanned(null); setItemsState([]); setMessage(null); }}>Clear</Button>
              <Button color="primary" onPress={submitReport} isLoading={submitting}>Submit Report</Button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
