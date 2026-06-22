'use client';
import React, { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import {
  Card,
  CardBody,
  Button,
  Chip,
  Divider,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Input,
  Select,
  SelectItem,
  Spinner,
  useDisclosure,
} from '@heroui/react';
import { Package, MapPin, Pencil, Save, X, Clock } from 'lucide-react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { doc, onSnapshot, updateDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '@/firebase';
import type { Statpack, User, StatpackPocket } from '@/app/types';
import { BagVisualizer } from '@/app/components/statpackvisualizer';
import BarcodeScanner from '@/app/components/barcode-scanner';
import StatpackCheckOffModal from '@/app/components/statpack-checkoff-modal';
import StatpackHistory from '@/app/components/statpack-history';
import { computeStatpackAssetValue } from '@/app/lib/inventory';

export default function StatpackDetailClient() {
  const router = useRouter();
  const params = useParams();
  
  const statpackId = Array.isArray(params?.id) ? params.id[0] : (params?.id as string);

  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [userRole, setUserRole] = useState<User['role'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [pack, setPack] = useState<Statpack | null>(null);

  const editorDisclosure = useDisclosure();
  const [editingPack, setEditingPack] = useState<Statpack | null>(null);
  const [editorSelectedPocket, setEditorSelectedPocket] = useState<StatpackPocket | 'all'>('all');

  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerTarget, setScannerTarget] = useState<Statpack | null>(null);

  const checkoffDisclosure = useDisclosure();
  const [checkoffAction, setCheckoffAction] = useState<'checkout' | 'checkin' | 'maintenance'>('checkout');

  const [isEditingSummary, setIsEditingSummary] = useState(false);
  const [summaryForm, setSummaryForm] = useState({ name: '', status: '', currentLocation: '', assetValue: '' });

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (currentUser) => {
      if (!currentUser) {
        router.push('/login');
        return;
      }
      setUser(currentUser);
    });
    return () => unsub();
  }, [router]);

  useEffect(() => {
    if (!user) return;
    const userRef = doc(db, 'users', user.uid);
    const unsub = onSnapshot(userRef, (snap) => {
      const data = snap.data() as User | undefined;
      setUserRole(data?.role ?? 'member');
    });
    return () => unsub();
  }, [user]);

  useEffect(() => {
    if (!statpackId) return;
    setLoading(true);
    const ref = doc(db, 'statpacks', statpackId);
    const unsub = onSnapshot(
      ref,
      (snapshot) => {
        const data = snapshot.data() as Statpack | undefined;
        setPack(data ?? null);
        setLoading(false);
      },
      (error) => {
        console.error('Error loading statpack:', error);
        setLoading(false);
      }
    );
    return () => unsub();
  }, [statpackId]);

  const beginSummaryEdit = () => {
    if (!pack) return;
    setSummaryForm({
      name: pack.name || '',
      status: pack.status || 'Ready',
      currentLocation: pack.currentLocation || '',
      assetValue: pack.assetValue !== undefined ? String(pack.assetValue) : '',
    });
    setIsEditingSummary(true);
  };

  const cancelSummaryEdit = () => setIsEditingSummary(false);

  const saveSummaryEdit = async () => {
    if (!pack) return;
    const parsedValue = summaryForm.assetValue !== '' ? Number(summaryForm.assetValue) : undefined;
    try {
      await updateDoc(doc(db, 'statpacks', pack.id as string), {
        name: summaryForm.name || pack.name,
        status: (summaryForm.status || pack.status) as Statpack['status'],
        currentLocation: summaryForm.currentLocation || '',
        assetValue: parsedValue,
        updatedAt: serverTimestamp(),
      });
      setIsEditingSummary(false);
    } catch (err) {
      console.error('Failed to save summary:', err);
      alert('Failed to save changes');
    }
  };

  const openScanner = () => {
    if (!pack) return;
    setScannerTarget(pack);
    setScannerOpen(true);
  };

  const handleDetected = async (value: string) => {
    if (!scannerTarget) return;
    try {
      await updateDoc(doc(db, 'statpacks', scannerTarget.id as string), {
        currentLocation: value,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      console.error('Failed to update location:', err);
      alert('Failed to update location');
    } finally {
      setScannerOpen(false);
      setScannerTarget(null);
    }
  };

  const openEditor = () => {
    if (!pack) return;
    setEditingPack(JSON.parse(JSON.stringify(pack)) as Statpack);
    editorDisclosure.onOpen();
  };

  const saveEditor = async () => {
    if (!editingPack) return;
    try {
      await updateDoc(doc(db, 'statpacks', editingPack.id as string), {
        ...editingPack,
        updatedAt: serverTimestamp(),
      });
      editorDisclosure.onClose();
      setEditingPack(null);
    } catch (err) {
      console.error('Failed to save statpack:', err);
      alert('Failed to save statpack');
    }
  };

  const recomputeAssetValue = async () => {
    if (!pack) return;
    try {
      const computed = computeStatpackAssetValue(pack);
      await updateDoc(doc(db, 'statpacks', pack.id as string), {
        assetValue: computed,
        updatedAt: serverTimestamp(),
      });
      alert('Statpack asset value updated');
    } catch (err) {
      console.error('Failed to recompute statpack value:', err);
      alert('Failed to recompute value');
    }
  };

  if (statpackId === '_') {
    return (
      <div className="h-screen flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardBody className="text-center gap-4">
            <p className="text-foreground-500">Statpack not found. Redirecting...</p>
            <Button onPress={() => router.push('/statpacks')}>
              Back to Statpacks
            </Button>
          </CardBody>
        </Card>
      </div>
    );
  }

  if (loading || !pack) return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center"><Spinner size="lg" color="primary" /></div>
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Package className="text-primary" />
            <h1 className="text-2xl font-semibold">{pack.name}</h1>
          </div>
          <div className="flex gap-2">
            <Button variant="light" onPress={() => router.push('/assets')}>Back to Assets</Button>
            <Button variant="light" onPress={openScanner} startContent={<MapPin size={16} />}>Scan Location</Button>
            <Button color="primary" onPress={() => { setCheckoffAction('checkout'); checkoffDisclosure.onOpen(); }}>Check-Off</Button>
            {userRole === 'admin' && (
              <Button variant="light" onPress={openEditor} startContent={<Pencil size={16} />}>Edit</Button>
            )}
          </div>
        </div>

        <Card>
          <CardBody className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-sm font-semibold text-foreground-500">Status</p>
                <Chip size="sm" variant="flat">{pack.status}</Chip>
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground-500">Location</p>
                <div className="flex items-center gap-2 text-sm">
                  <MapPin size={14} className="text-foreground-400" />
                  <span>{pack.currentLocation || '—'}</span>
                </div>
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground-500">Asset Value</p>
                <p className="text-sm">{pack.assetValue ? `$${pack.assetValue.toFixed(2)}` : '—'}</p>
              </div>
              {userRole === 'admin' && (
                <div>
                  <p className="text-sm font-semibold text-foreground-500">Actions</p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="light" onPress={beginSummaryEdit} startContent={<Pencil size={14} />}>Edit Summary</Button>
                    <Button size="sm" onPress={recomputeAssetValue}>Recompute Value</Button>
                  </div>
                </div>
              )}
            </div>

            {isEditingSummary && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Input label="Name" value={summaryForm.name} onValueChange={(v) => setSummaryForm({ ...summaryForm, name: v })} />
                <Select label="Status" selectedKeys={[summaryForm.status || 'Ready']} onChange={(e) => setSummaryForm({ ...summaryForm, status: e.target.value })}>
                  <SelectItem key="Ready">Ready</SelectItem>
                  <SelectItem key="In Use">In Use</SelectItem>
                  <SelectItem key="Not Ready">Not Ready</SelectItem>
                  <SelectItem key="Pending Initial Check">Pending Initial Check</SelectItem>
                </Select>
                <Input label="Location" value={summaryForm.currentLocation} onValueChange={(v) => setSummaryForm({ ...summaryForm, currentLocation: v })} />
                <Input label="Asset Value" type="number" value={summaryForm.assetValue} onValueChange={(v) => setSummaryForm({ ...summaryForm, assetValue: v })} />
                <div className="col-span-2 flex gap-2">
                  <Button startContent={<Save size={16} />} color="primary" onPress={saveSummaryEdit}>Save</Button>
                  <Button startContent={<X size={16} />} variant="light" onPress={cancelSummaryEdit}>Cancel</Button>
                </div>
              </div>
            )}

            <Divider />

            <div>
              <h3 className="font-semibold mb-2 flex items-center gap-2"><Package size={16} /> Contents ({pack.contents?.length || 0})</h3>
              {pack.contents && pack.contents.length > 0 ? (
                <div className="space-y-2 max-h-80 overflow-y-auto">
                  {pack.contents.map((item, idx) => (
                    <div key={idx} className="p-2 border rounded-md bg-content2 text-sm">
                      <div className="flex justify-between items-start">
                        <div className="flex-1">
                          <p className="font-medium">{item.itemDetails?.name || item.itemId}</p>
                          <p className="text-xs text-foreground-500">
                            Qty: {item.currentQuantity}/{item.requiredQuantity}
                            {item.serialNumber && ` • Serial: ${item.serialNumber}`}
                            {item.lotNumber && ` • Lot: ${item.lotNumber}`}
                          </p>
                          {item.expirationDate && (
                            <p className="text-xs text-foreground-500">Exp: {new Date(item.expirationDate).toLocaleDateString()}</p>
                          )}
                        </div>
                        {item.itemValue && (
                          <p className="text-xs font-semibold tabular-nums">${(item.itemValue * item.currentQuantity).toFixed(2)}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-foreground-500">No contents recorded</p>
              )}
            </div>

            <Divider />

            <div>
              <h3 className="font-semibold mb-2 flex items-center gap-2"><Clock size={16} /> Statpack History</h3>
              <StatpackHistory statpackId={pack.id as string} maxRows={12} />
            </div>

            <Divider />

            <div>
              <h3 className="font-semibold mb-2 flex items-center gap-2"><Clock size={16} /> Maintenance History</h3>
              {pack.maintenance_logs && pack.maintenance_logs.length > 0 ? (
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {pack.maintenance_logs.map((log, idx) => (
                    <div key={log.id || idx} className="p-3 border rounded-md bg-content2">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <p className="font-medium text-sm">{log.serviceType}</p>
                          <p className="text-xs text-foreground-500">{log.reason}</p>
                        </div>
                        <Chip size="sm" color={log.status === 'completed' ? 'success' : 'warning'} variant="flat">
                          {log.status}
                        </Chip>
                      </div>
                      {log.technician && <p className="text-xs text-foreground-500">Technician: {log.technician}</p>}
                      {log.timestamp && (
                        <p className="text-xs text-foreground-500">
                          {log.timestamp instanceof Date ? log.timestamp.toLocaleDateString() : new Date(log.timestamp).toLocaleDateString()}
                        </p>
                      )}
                      {log.notes && <p className="text-xs text-foreground-500 mt-1 italic">{log.notes}</p>}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-foreground-500">No maintenance records</p>
              )}
            </div>
          </CardBody>
        </Card>
      </div>

      <Modal isOpen={editorDisclosure.isOpen} onOpenChange={editorDisclosure.onOpenChange} size="3xl">
        <ModalContent>
          <ModalHeader>Statpack Editor - {editingPack?.name}</ModalHeader>
          <ModalBody className="space-y-4">
            {!editingPack && <p className="text-sm text-foreground-500">No statpack loaded.</p>}
            {editingPack && (
              <div className="space-y-4">
                <div className="flex justify-center">
                  <BagVisualizer
                    statpack={editingPack}
                    selectedPocket={editorSelectedPocket}
                    onSelectPocket={(p) => setEditorSelectedPocket(p)}
                    completedPockets={new Set()}
                  />
                </div>
                <div className="flex gap-2">
                  <Input label="Pack Name" value={editingPack.name} onValueChange={(v) => setEditingPack({ ...editingPack, name: v })} />
                  <Select label="Status" selectedKeys={[editingPack.status || 'Ready']} onChange={(e) => setEditingPack({ ...editingPack, status: e.target.value as Statpack['status'] })}>
                    <SelectItem key="Ready">Ready</SelectItem>
                    <SelectItem key="In Use">In Use</SelectItem>
                    <SelectItem key="Not Ready">Not Ready</SelectItem>
                  </Select>
                </div>
                <Divider />
                <p className="text-sm text-foreground-500">Use the visualizer to navigate compartments and edit items as needed.</p>
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={() => { editorDisclosure.onClose(); setEditingPack(null); }}>Cancel</Button>
            <Button color="primary" onPress={saveEditor}>Save Changes</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <StatpackCheckOffModal
        isOpen={checkoffDisclosure.isOpen}
        onOpenChange={(open) => (open ? checkoffDisclosure.onOpen() : checkoffDisclosure.onClose())}
        statpack={pack}
        action={checkoffAction}
        userId={user?.uid || 'unknown'}
        userName={user?.displayName || 'Unknown'}
        onCheckOffComplete={() => checkoffDisclosure.onClose()}
      />

      <BarcodeScanner
        isOpen={scannerOpen}
        onClose={() => { setScannerOpen(false); setScannerTarget(null); }}
        onDetected={handleDetected}
      />
    </div>
  );
}
