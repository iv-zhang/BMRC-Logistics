"use client";
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card,
  CardBody,
  Button,
  Table,
  TableHeader,
  TableColumn,
  TableBody,
  TableRow,
  TableCell,
  Chip,
  Divider,
  Spinner,
  Badge,
  useDisclosure,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Input,
  Select,
  SelectItem,
} from '@heroui/react';
import { Package, MapPin, Eye, Wrench, Pencil, Save, X } from 'lucide-react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { collection, onSnapshot, query, orderBy, updateDoc, doc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '@/firebase';
import type { Statpack } from '@/app/types';
import StatpackCheckOffModal from '@/app/components/statpack-checkoff-modal';
import BarcodeScanner from '@/app/components/barcode-scanner';
import { BagVisualizer } from '@/app/components/statpackvisualizer';
import AdminAuditModal from '@/app/components/admin-audit-modal';
import { useUserRole } from '@/app/hooks/useUserRole';

export default function StatpacksListPage() {
  const router = useRouter();
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [statpacks, setStatpacks] = useState<Statpack[]>([]);
  const [loading, setLoading] = useState(true);
  const { role: userRole } = useUserRole();

  const [selectedPack, setSelectedPack] = useState<Statpack | null>(null);
  const editorDisclosure = useDisclosure();
  const [editingPack, setEditingPack] = useState<Statpack | null>(null);
  const [isEditingSummary, setIsEditingSummary] = useState(false);
  const [summaryForm, setSummaryForm] = useState({ name: '', status: '', currentLocation: '', assetValue: '' });
  const checkoffDisclosure = useDisclosure();
  const [checkoffAction, setCheckoffAction] = useState<'checkin' | 'maintenance' | 'checkout'>('checkin');
  const auditModalDisclosure = useDisclosure();
  const [auditTarget, setAuditTarget] = useState<Statpack | null>(null);

  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerTarget, setScannerTarget] = useState<Statpack | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsub();
  }, []);

  const updateEditingContent = (index: number, patch: Partial<any>) => {
    setEditingPack(prev => {
      const base = prev || selectedPack;
      if (!base) return prev;
      const contents = Array.isArray(base.contents) ? [...base.contents] : [];
      contents[index] = { ...(contents[index] || {}), ...patch };
      return ({ ...base, contents } as Statpack);
    });
  };

  const addNewContentItem = () => {
    const newItem = {
      itemId: `new-${Date.now()}`,
      itemDetails: { name: 'New Item', createdAt: new Date(), updatedAt: new Date() },
      requiredQuantity: 1,
      currentQuantity: 0,
      pocket: 'main',
      compartmentId: undefined,
      batchId: '',
      itemValue: 0,
    } as any;
    setEditingPack(prev => {
      const base = prev || selectedPack;
      if (!base) return prev;
      const contents = Array.isArray(base.contents) ? [...base.contents, newItem] : [newItem];
      return ({ ...base, contents } as Statpack);
    });
  };

  const removeContentItem = (index: number) => {
    setEditingPack(prev => {
      const base = prev || selectedPack;
      if (!base) return prev;
      const contents = Array.isArray(base.contents) ? [...base.contents] : [];
      contents.splice(index, 1);
      return ({ ...base, contents } as Statpack);
    });
  };

  const formatDateForInput = (v: any) => {
    if (!v) return '';
    // Firestore Timestamp
    if (v && typeof v.toDate === 'function') {
      const d = v.toDate();
      return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
    }
    const d = typeof v === 'string' ? new Date(v) : v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  };

  // Remove `undefined` values recursively to make objects safe for Firestore
  const sanitizeForFirestore = (v: any): any => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (v instanceof Date) return v;
    if (Array.isArray(v)) {
      return v.map((it) => sanitizeForFirestore(it)).filter((it) => it !== undefined);
    }
    if (typeof v === 'object') {
      const out: any = {};
      Object.keys(v).forEach((k) => {
        const s = sanitizeForFirestore(v[k]);
        if (s !== undefined) out[k] = s;
      });
      return out;
    }
    return v;
  };

  // Build an explicit, whitelist-based payload for statpack updates to avoid
  // sending any unexpected/undefined values to Firestore.
  const buildStatpackUpdate = (pack: any) => {
    if (!pack) return {};
    const out: any = {};
    const pickIf = (key: string, val: any) => {
      if (val !== undefined) out[key] = val;
    };

    pickIf('name', pack.name);
    pickIf('type', pack.type);
    pickIf('status', pack.status);
    pickIf('currentLocation', pack.currentLocation);
    pickIf('assetValue', pack.assetValue);
    pickIf('isCheckedOut', pack.isCheckedOut);
    pickIf('assignedToUserId', pack.assignedToUserId);
    pickIf('assignedToUserName', pack.assignedToUserName);
    pickIf('checkedOutAt', pack.checkedOutAt instanceof Date ? pack.checkedOutAt : (pack.checkedOutAt ? new Date(pack.checkedOutAt) : undefined));
    pickIf('lastCheckedBy', pack.lastCheckedBy);
    pickIf('lastCheckedAt', pack.lastCheckedAt instanceof Date ? pack.lastCheckedAt : (pack.lastCheckedAt ? new Date(pack.lastCheckedAt) : undefined));

    // compartments: canonicalize array entries
    if (Array.isArray(pack.compartments)) {
      out.compartments = pack.compartments.map((c: any) => {
        const comp: any = {};
        if (c.id !== undefined) comp.id = c.id;
        if (c.name !== undefined) comp.name = c.name;
        if (c.parentPocket !== undefined) comp.parentPocket = c.parentPocket;
        if (typeof c.isSealed === 'boolean') comp.isSealed = c.isSealed;
        if (c.sealNumber !== undefined) comp.sealNumber = c.sealNumber;
        if (c.expirationDate instanceof Date) comp.expirationDate = c.expirationDate;
        return comp;
      });
    }

    // contents: whitelist per-item fields
    if (Array.isArray(pack.contents)) {
      out.contents = pack.contents.map((it: any) => {
        const ci: any = {};
        if (it.itemId !== undefined) ci.itemId = it.itemId;
        if (it.itemDetails !== undefined) ci.itemDetails = it.itemDetails;
        if (it.variantId !== undefined) ci.variantId = it.variantId;
        if (it.variantName !== undefined) ci.variantName = it.variantName;
        if (it.requiredQuantity !== undefined) ci.requiredQuantity = it.requiredQuantity;
        if (it.currentQuantity !== undefined) ci.currentQuantity = it.currentQuantity;
        if (it.pocket !== undefined) ci.pocket = it.pocket;
        if (it.compartmentId !== undefined) ci.compartmentId = it.compartmentId;
        if (it.batchId !== undefined) ci.batchId = it.batchId;
        if (it.serialNumber !== undefined) ci.serialNumber = it.serialNumber;
        if (it.expirationDate instanceof Date) ci.expirationDate = it.expirationDate;
        if (it.lotNumber !== undefined) ci.lotNumber = it.lotNumber;
        if (it.effectiveExpiration instanceof Date) ci.effectiveExpiration = it.effectiveExpiration;
        if (it.requiresExpirationCheck !== undefined) ci.requiresExpirationCheck = it.requiresExpirationCheck;
        if (it.itemValue !== undefined) ci.itemValue = it.itemValue;
        return ci;
      });
    }

    // Maintenance logs (optional)
    if (Array.isArray(pack.maintenance_logs)) {
      out.maintenance_logs = pack.maintenance_logs.map((m: any) => ({
        id: m.id,
        timestamp: m.timestamp instanceof Date ? m.timestamp : (m.timestamp ? new Date(m.timestamp) : undefined),
        serviceType: m.serviceType,
        reason: m.reason,
        technician: m.technician,
        notes: m.notes,
        status: m.status,
        completedAt: m.completedAt instanceof Date ? m.completedAt : (m.completedAt ? new Date(m.completedAt) : undefined),
      }));
    }

    return out;
  };

  // Recursively remove invalid Date objects (which would throw on toISOString)
  const stripInvalidDates = (v: any): any => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? undefined : v;
    if (Array.isArray(v)) {
      return v.map((it) => stripInvalidDates(it)).filter((it) => it !== undefined);
    }
    if (typeof v === 'object') {
      const out: any = {};
      Object.keys(v).forEach((k) => {
        const s = stripInvalidDates(v[k]);
        if (s !== undefined) out[k] = s;
      });
      return out;
    }
    return v;
  };

  useEffect(() => {
    setLoading(true);
    const q = query(collection(db, 'statpacks'), orderBy('name'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const packs: Statpack[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
        setStatpacks(packs);
        setLoading(false);
      },
      (err) => {
        console.error('Failed to load statpacks:', err);
        setLoading(false);
      }
    );
    return () => unsub();
  }, []);

  const openCheckin = (pack: Statpack) => {
    setSelectedPack(pack);
    setCheckoffAction('checkin');
    checkoffDisclosure.onOpen();
  };
  const openMaintenance = (pack: Statpack) => {
    setSelectedPack(pack);
    setCheckoffAction('maintenance');
    checkoffDisclosure.onOpen();
  };

  const openScanner = (pack: Statpack) => {
    setScannerTarget(pack);
    setScannerOpen(true);
  };

  const onDetected = async (value: string) => {
    if (!scannerTarget) return;
    try {
      await updateDoc(doc(db, 'statpacks', scannerTarget.id as string), { currentLocation: value, updatedAt: serverTimestamp() });
    } catch (err) {
      console.error('Failed to update location from scan', err);
      alert('Failed to save scanned location');
    } finally {
      setScannerOpen(false);
      setScannerTarget(null);
    }
  };

  if (loading) return <div className="h-screen flex items-center justify-center"><Spinner /></div>;

  // Restrict access: general members should not access the Statpacks management UI
  if (!loading && userRole === 'member') {
    return (
      <div className="min-h-screen p-6 bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
        <div className="max-w-3xl mx-auto">
          <Card>
            <CardBody className="text-center">
              <h2 className="text-xl font-semibold">Access Denied</h2>
              <p className="mt-2 text-sm text-gray-600">You do not have permission to view Statpack management.</p>
              <div className="mt-4">
                <Button onPress={() => router.push('/dashboard')}>Back to Dashboard</Button>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6 bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Package className="text-indigo-600" />
            <h1 className="text-2xl font-bold">Statpacks</h1>
          </div>
          <div className="flex gap-2">
            <Button variant="light" onPress={() => router.push('/assets')}>Back to Assets</Button>
            <Button color="primary" onPress={() => router.push('/statpacks/new')}>Add Statpack</Button>
          </div>
        </div>

        <Card>
          <CardBody>
            <Table aria-label="Statpacks table">
              <TableHeader>
                <TableColumn>Name</TableColumn>
                <TableColumn>Status</TableColumn>
                <TableColumn>Location</TableColumn>
                <TableColumn>Value</TableColumn>
                <TableColumn>Actions</TableColumn>
              </TableHeader>
              <TableBody emptyContent="No statpacks">
                {statpacks.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell>
                      <Chip size="sm" variant="flat">{p.status}</Chip>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <MapPin size={14} className="text-gray-400" />
                        <span>{p.currentLocation || '—'}</span>
                      </div>
                    </TableCell>
                    <TableCell>{p.assetValue ? `$${p.assetValue.toFixed(2)}` : '—'}</TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button size="sm" variant="light" onPress={() => { setSelectedPack(p); editorDisclosure.onOpen(); }}>
                          <Eye size={14} />
                        </Button>
                        <Button size="sm" onPress={() => openCheckin(p)}>Check-In</Button>
                        <Button size="sm" variant="light" onPress={() => openMaintenance(p)}>Maintenance</Button>
                        {userRole === 'admin' && (
                          <Button isIconOnly size="sm" variant="light" onPress={() => { setAuditTarget(p); auditModalDisclosure.onOpen(); }} title="Manual Audit">
                            <Wrench size={14} />
                          </Button>
                        )}
                        <Button isIconOnly size="sm" variant="light" onPress={() => openScanner(p)}>
                          <MapPin size={14} />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardBody>
        </Card>
      </div>

      <StatpackCheckOffModal
        isOpen={checkoffDisclosure.isOpen}
        onOpenChange={(open) => (open ? checkoffDisclosure.onOpen() : checkoffDisclosure.onClose())}
        statpack={selectedPack}
        action={checkoffAction}
        userId={user?.uid || 'unknown'}
        userName={user?.displayName || 'Unknown'}
        onCheckOffComplete={() => checkoffDisclosure.onClose()}
      />

      <BarcodeScanner isOpen={scannerOpen} onClose={() => { setScannerOpen(false); setScannerTarget(null); }} onDetected={onDetected} />

      {/* In-page Statpack Editor Modal */}
      <Modal isOpen={editorDisclosure.isOpen} onOpenChange={editorDisclosure.onOpenChange} size="3xl">
        <ModalContent>
          <ModalHeader>Statpack Editor - {editingPack?.name || selectedPack?.name}</ModalHeader>
          <ModalBody className="space-y-4">
            {!selectedPack && <p className="text-sm text-gray-500">No statpack selected.</p>}
            {selectedPack && (
              <div className="space-y-4">
                <div className="flex justify-center">
                  <BagVisualizer
                    statpack={editingPack || selectedPack}
                    selectedPocket={'all'}
                    onSelectPocket={() => {}}
                    completedPockets={new Set()}
                  />
                </div>

                <div className="flex gap-2">
                  <div className="flex-[0.7]">
                    <p className="text-sm font-semibold">Name</p>
                    <Input className="w-full" value={editingPack?.name ?? selectedPack.name} onValueChange={(v) => setEditingPack(prev => ({ ...(prev || selectedPack), name: v } as Statpack))} />
                  </div>
                  <div className="flex-[0.3] min-w-[160px]">
                    <p className="text-sm font-semibold">Status</p>
                    <Select className="w-full" selectedKeys={[String((editingPack?.status ?? selectedPack?.status) || 'Ready')]} onChange={(e) => setEditingPack(prev => ({ ...(prev || selectedPack), status: e.target.value } as Statpack))}>
                      <SelectItem key="Ready">Ready</SelectItem>
                      <SelectItem key="In Use">In Use</SelectItem>
                      <SelectItem key="Not Ready">Not Ready</SelectItem>
                    </Select>
                  </div>
                </div>

                <div>
                  <p className="text-sm font-semibold">Location</p>
                  <Input value={editingPack?.currentLocation ?? selectedPack.currentLocation ?? ''} onValueChange={(v) => setEditingPack(prev => ({ ...(prev || selectedPack), currentLocation: v } as Statpack))} />
                </div>

                {/* Contents editor: compact list */}
                <div>
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">Contents</p>
                    <Button size="sm" onPress={addNewContentItem}>Add Item</Button>
                  </div>

                  <div className="mt-2 max-h-64 overflow-y-auto">
                    <Table aria-label="Statpack contents">
                      <TableHeader>
                        <TableColumn>Item</TableColumn>
                        <TableColumn>Quantity</TableColumn>
                        <TableColumn>Pocket</TableColumn>
                        <TableColumn>Actions</TableColumn>
                      </TableHeader>
                      <TableBody>
                        {(editingPack?.contents || selectedPack.contents || []).map((item: any, idx: number) => (
                          <TableRow key={item.itemId || idx}>
                            <TableCell>
                              <div className="flex flex-col">
                                <Input value={item.itemDetails?.name ?? ''} onValueChange={(v) => updateEditingContent(idx, { itemDetails: { ...(item.itemDetails || {}), name: v } })} />
                              </div>
                            </TableCell>
                            <TableCell>
                              <Input className="w-24" type="number" value={String(item.requiredQuantity ?? 0)} onValueChange={(v) => updateEditingContent(idx, { requiredQuantity: Number(v) || 0 })} />
                            </TableCell>
                            <TableCell>
                              <Select className="min-w-[120px]" selectedKeys={[String(item.pocket || 'main')]} onChange={(e) => updateEditingContent(idx, { pocket: e.target.value })}>
                                <SelectItem key="main">Main</SelectItem>
                                <SelectItem key="front_aux">Front</SelectItem>
                                <SelectItem key="side_left">Left</SelectItem>
                                <SelectItem key="side_right">Right</SelectItem>
                              </Select>
                            </TableCell>
                            <TableCell>
                              <div className="flex gap-2">
                                <Button isIconOnly size="sm" variant="light" color="danger" onPress={() => removeContentItem(idx)}>
                                  <X size={14} />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <div className="flex gap-2">
              <Button variant="light" onPress={() => { editorDisclosure.onClose(); setEditingPack(null); }}>Close</Button>
              {userRole === 'admin' && (
                <Button color="primary" onPress={async () => {
                  const packToSave = editingPack || selectedPack;
                  if (!packToSave) return;
                  try {
                    // normalize expiration date strings to Date objects
                    const normalized = { ...packToSave } as any;
                    if (Array.isArray(normalized.contents)) {
                      normalized.contents = normalized.contents.map((it: any) => {
                        const copy = { ...it };
                        if (copy.expirationDate && typeof copy.expirationDate === 'string' && copy.expirationDate.length > 0) {
                          copy.expirationDate = new Date(copy.expirationDate);
                        }
                        return copy;
                      });
                    }
                    // Build a whitelist payload and send only allowed fields to Firestore
                    const payload = buildStatpackUpdate(normalized);
                    const cleaned = stripInvalidDates(payload);
                    await updateDoc(doc(db, 'statpacks', packToSave.id as string), { ...cleaned, updatedAt: serverTimestamp() } as any);
                    editorDisclosure.onClose();
                    setEditingPack(null);
                    // refresh handled by snapshot listener
                  } catch (err) {
                    console.error('Failed to save statpack', err);
                    alert('Failed to save statpack');
                  }
                }}>Save</Button>
              )}
            </div>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <AdminAuditModal
        isOpen={auditModalDisclosure.isOpen}
        onOpenChange={(open) => (open ? auditModalDisclosure.onOpen() : auditModalDisclosure.onClose())}
        auditType="statpack"
        targetStatpack={auditTarget}
        userId={user?.uid || 'unknown'}
        userName={user?.displayName || 'Unknown'}
        onAuditComplete={() => auditModalDisclosure.onClose()}
      />
    </div>
  );
}
