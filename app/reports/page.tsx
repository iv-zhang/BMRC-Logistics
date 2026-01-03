"use client";
import React, { useEffect, useState } from 'react';
import { db, auth } from '@/firebase';
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  updateDoc,
  doc,
  deleteDoc,
  serverTimestamp
} from 'firebase/firestore';
import {
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Button,
  Checkbox,
  Spinner,
  Divider,
  Textarea
} from '@heroui/react';

function formatDate(ts: any) {
  if (!ts) return '';
  try {
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleString();
  } catch (e) {
    return String(ts);
  }
}

export default function ReportsPage() {
  const [reports, setReports] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterUnresolved, setFilterUnresolved] = useState(true);

  useEffect(() => {
    setLoading(true);
    const q = query(collection(db, 'restock_reports'), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(q, snap => {
      const out: any[] = [];
      snap.forEach(s => out.push({ id: s.id, ...(s.data() as any) }));
      setReports(out);
      setLoading(false);
    }, err => {
      console.error('reports snapshot error', err);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  const handleResolve = async (r: any) => {
    const user = auth.currentUser;
    if (!user) {
      alert('Sign in to resolve reports.');
      return;
    }
    if (!confirm(`Mark report for ${r.restockBoxName || r.restockBoxId} as resolved?`)) return;
    try {
      await updateDoc(doc(db, 'restock_reports', r.id), {
        resolved: true,
        resolvedBy: user.uid,
        resolvedByName: user.displayName || user.email || null,
        resolvedAt: serverTimestamp()
      });
    } catch (e) {
      console.error(e);
      alert('Failed to mark resolved');
    }
  };

  const handleDelete = async (r: any) => {
    if (!confirm('Delete this report? This cannot be undone.')) return;
    try {
      await deleteDoc(doc(db, 'restock_reports', r.id));
    } catch (e) {
      console.error(e);
      alert('Failed to delete');
    }
  };

  const visible = filterUnresolved ? reports.filter(r => !r.resolved) : reports;

  return (
    <div className="min-h-screen p-6 bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
      <div className="max-w-5xl mx-auto space-y-4">
        <div className="flex justify-between items-center">
          <h1 className="text-2xl font-bold">Reports & Alerts</h1>
          <div className="flex items-center gap-3">
            <Checkbox isSelected={filterUnresolved} onValueChange={setFilterUnresolved}>Unresolved only</Checkbox>
          </div>
        </div>

        <Divider />

        {loading ? (
          <div className="flex items-center justify-center h-48"><Spinner /></div>
        ) : visible.length === 0 ? (
          <div className="text-sm text-gray-500">No reports found.</div>
        ) : (
          <div className="space-y-3">
            {visible.map(r => (
              <Card key={r.id} className="shadow-sm">
                <CardHeader>
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-semibold">{r.restockBoxName || r.restockBoxId}</div>
                      <div className="text-xs text-gray-500">Reported by {r.reporter || r.reporterId || 'unknown'} • {formatDate(r.createdAt)}</div>
                    </div>
                    <div className="flex gap-2">
                      {!r.resolved && <Button color="primary" onPress={() => handleResolve(r)}>Resolve</Button>}
                      <Button variant="light" color="danger" onPress={() => handleDelete(r)}>Delete</Button>
                    </div>
                  </div>
                </CardHeader>
                <CardBody>
                  <div className="text-sm text-gray-700">
                    {r.items && r.items.length > 0 ? (
                      <div className="space-y-2">
                        {r.items.map((it: any, idx: number) => (
                          <div key={idx} className="flex justify-between items-center">
                            <div>
                              <div className="font-medium">{it.name || it.itemId}</div>
                              <div className="text-xs text-gray-500">Required: {it.requiredQuantity} • Observed: {it.observedQuantity}</div>
                              {it.note && <div className="text-xs mt-1">Note: {it.note}</div>}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-gray-500">No item details included.</div>
                    )}
                    {r.notes && <div className="mt-3 text-xs text-gray-600">Notes: {r.notes}</div>}
                  </div>
                </CardBody>
                <CardFooter className="text-xs text-gray-500">{r.resolved ? `Resolved by ${r.resolvedByName || r.resolvedBy} • ${formatDate(r.resolvedAt)}` : 'Unresolved'}</CardFooter>
              </Card>
            ))}
          </div>
        )}

      </div>
    </div>
  );
}
