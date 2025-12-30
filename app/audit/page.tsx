'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card,
  CardBody,
  Button,
  Chip,
  Progress,
  Input,
  Table,
  TableHeader,
  TableColumn,
  TableBody,
  TableRow,
  TableCell,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
  Spinner
} from '@heroui/react';
import { ClipboardCheck, ShieldAlert, ScanLine, Plus, FileWarning, Search, RefreshCw } from 'lucide-react';

// Firebase
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import {
  collection,
  doc,
  onSnapshot,
  query,
  orderBy,
  updateDoc,
  addDoc,
  serverTimestamp,
  getDocs,
  where
} from 'firebase/firestore';
import { auth, db } from '@/firebase';

import InventoryModal from '@/app/components/additemmodal';
import type { InventoryItem, User as AppUser } from '@/app/types';
import MobileQuickCount from '@/app/mobile/quick-count-client';
import StackAuditClient from '@/app/audit/stack-audit-client';

export default function AuditPage() {
  const router = useRouter();
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<AppUser['role'] | null>(null);
  const isAdmin = userRole === 'admin' || userRole === 'quartermaster';

  // Inventory state
  const [inventory, setInventory] = useState<InventoryItem[]>([]);

  // Quick-Add modal
  const quickAddDisclosure = useDisclosure();
  const { isOpen: isQuickAddOpen, onOpen: openQuickAdd, onOpenChange: onQuickAddChange, onClose: closeQuickAdd } = quickAddDisclosure;
  const [quickAddInitial, setQuickAddInitial] = useState<Partial<InventoryItem> | null>(null);

  // Verify-by-scan state
  const [scanQuery, setScanQuery] = useState('');
  const [verifying, setVerifying] = useState(false);

  // Auth
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      if (u) setUser(u);
      else router.push('/login');
    });
    return () => unsub();
  }, [router]);

  // Role
  useEffect(() => {
    if (!user) return;
    const userRef = doc(db, 'users', user.uid);
    const unsub = onSnapshot(userRef, (snap) => {
      const data = snap.data() as AppUser | undefined;
      setUserRole(data?.role ?? 'member');
    });
    return () => unsub();
  }, [user]);

  // Inventory stream
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'inventory'), orderBy('name'));
    const unsub = onSnapshot(q, (snapshot) => {
      const items = snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as any) })) as InventoryItem[];
      setInventory(items);
      setLoading(false);
    }, (err) => {
      console.error('audit inventory listener error', err);
      setLoading(false);
    });
    return () => unsub();
  }, [user]);

  // Derived counts
  const auditItems = useMemo(() => inventory.filter(i => i.isAuditRequired), [inventory]);
  const verifiedCount = useMemo(() => auditItems.filter(i => i.auditVerified === true).length, [auditItems]);
  const remaining = useMemo(() => auditItems.filter(i => !i.auditVerified).length, [auditItems]);
  const progressPct = auditItems.length > 0 ? Math.round((verifiedCount / auditItems.length) * 100) : 0;

  const handleZeroOut = async () => {
    if (!isAdmin) {
      alert('Only admins/managers can start an audit.');
      return;
    }
    if (!confirm('Start Semester Audit? This will flag ALL items as Unverified.')) return;
    try {
      const snap = await getDocs(collection(db, 'inventory'));
      const batchOps: Promise<any>[] = [];
      snap.forEach((docSnap) => {
        const ref = doc(db, 'inventory', docSnap.id);
        batchOps.push(updateDoc(ref, { isAuditRequired: true, auditVerified: false, lastAuditDate: serverTimestamp() }));
      });
      await Promise.all(batchOps);
      await addDoc(collection(db, 'inventory_logs'), {
        action: 'audit_zero_out',
        userId: user?.uid ?? null,
        userName: (user as any)?.email ?? null,
        timestamp: serverTimestamp()
      });
      alert('Audit started. All items set to Unverified.');
    } catch (err) {
      console.error('Zero-Out failed', err);
      alert('Failed to start audit.');
    }
  };

  const handleVerify = async () => {
    const q = scanQuery.trim().toLowerCase();
    if (!q) return;
    setVerifying(true);
    try {
      // Simple matching by name or id; can expand to barcode later
      const matched = auditItems.find(i => (i.name || '').toLowerCase().includes(q) || i.id === q);
      if (!matched) {
        alert('No matching item requiring audit found.');
        return;
      }
      const ref = doc(db, 'inventory', matched.id);
      await updateDoc(ref, { auditVerified: true });
      await addDoc(collection(db, 'inventory_logs'), {
        action: 'audit_verify',
        itemId: matched.id,
        itemName: matched.name,
        userId: user?.uid ?? null,
        userName: (user as any)?.email ?? null,
        timestamp: serverTimestamp()
      });
      setScanQuery('');
    } catch (err) {
      console.error('Verify failed', err);
      alert('Failed to verify item.');
    } finally {
      setVerifying(false);
    }
  };

  const handleFinalizeAudit = async () => {
    if (!isAdmin) {
      alert('Only admins/managers can finalize an audit.');
      return;
    }
    if (!confirm('Finalize audit? Remaining unverified items will be recorded as Lost/Ghost.')) return;
    try {
      const remainingItems = auditItems.filter(i => !i.auditVerified);
      const report = {
        finalizedAt: serverTimestamp(),
        finalizedBy: user?.uid ?? null,
        finalizedByName: (user as any)?.email ?? null,
        totalAudited: auditItems.length,
        verifiedCount,
        lostGhostCount: remainingItems.length,
        lostGhostItems: remainingItems.map(i => ({ id: i.id, name: i.name, location: i.location, room: (i as any).room ?? undefined }))
      };
      await addDoc(collection(db, 'audit_reports'), report);
      // Log each lost/ghost item and clear auditRequired
      const ops: Promise<any>[] = [];
      for (const it of remainingItems) {
        ops.push(addDoc(collection(db, 'inventory_logs'), {
          action: 'audit_mark_lost',
          itemId: it.id,
          itemName: it.name,
          userId: user?.uid ?? null,
          userName: (user as any)?.email ?? null,
          timestamp: serverTimestamp(),
          notes: 'Auto-marked Lost/Ghost on audit finalize'
        }));
        ops.push(updateDoc(doc(db, 'inventory', it.id), { isAuditRequired: false }));
      }
      // Also clear auditRequired for verified items
      for (const it of auditItems.filter(i => i.auditVerified)) {
        ops.push(updateDoc(doc(db, 'inventory', it.id), { isAuditRequired: false }));
      }
      await Promise.all(ops);
      alert('Audit finalized. Loss/Ghost report saved.');
    } catch (err) {
      console.error('Finalize audit failed', err);
      alert('Failed to finalize audit.');
    }
  };

  const openQuickAddModal = () => {
    setQuickAddInitial({ isLegacyItem: true });
    openQuickAdd();
  };

  // Zones lobby + locks
  const zones = [
    { id: 'Back Room', label: 'Back Room' },
    { id: 'Front', label: 'Front' },
    { id: 'Forward Staging', label: 'Forward Staging' },
    { id: 'Office', label: 'Office' }
  ];
  const [locks, setLocks] = useState<Record<string, any>>({});
  const [selectedZone, setSelectedZone] = useState<string | null>(null);

  useEffect(() => {
    const q = query(collection(db, 'audit_locks'));
    const unsub = onSnapshot(q, (snap) => {
      const map: Record<string, any> = {};
      snap.docs.forEach(d => { map[d.id] = d.data(); });
      setLocks(map);
    });
    return () => unsub();
  }, []);

  // Minimal add handler reused from inventory page semantics
  const handleAddItem = async (newItemData: Partial<InventoryItem>) => {
    try {
      const payload: any = { ...(newItemData || {}) };
      // Normalize minimal fields
      payload.name = (payload.name || '').toString();
      payload.totalStockQuantity = Number(payload.totalStockQuantity ?? 0);
      payload.createdAt = serverTimestamp();
      payload.updatedAt = serverTimestamp();
      payload.isAuditRequired = true;
      payload.auditVerified = true; // Quick-add during audit is immediately verified
      await addDoc(collection(db, 'inventory'), payload);
      closeQuickAdd();
    } catch (err) {
      console.error('Quick-add failed', err);
      alert('Failed to add item.');
    }
  };

  if (loading) return <div className="h-screen flex items-center justify-center"><Spinner /></div>;

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-gray-800 dark:text-white flex items-center gap-2">
            <ClipboardCheck className="text-indigo-600" size={28} />
            Semester Audit
          </h1>
          <p className="text-gray-600 dark:text-gray-400">Zero-out, verify by scan, and finalize loss report.</p>
        </div>

        {/* Controls */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
          <Button color="danger" variant="flat" onPress={handleZeroOut} className="h-12">
            <ShieldAlert size={18} className="mr-2" /> Zero-Out (Start Audit)
          </Button>
          <Button color="primary" variant="flat" onPress={openQuickAddModal} className="h-12">
            <Plus size={18} className="mr-2" /> Found Unlisted Item
          </Button>
          <Button color="secondary" variant="flat" onPress={handleFinalizeAudit} className="h-12">
            <FileWarning size={18} className="mr-2" /> Finalize & Save Loss Report
          </Button>
        </div>

        {/* Progress */}
        <Card className="bg-white/80 dark:bg-slate-800/80 border-gray-200/70 dark:border-slate-700 mb-6">
          <CardBody className="p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                <Chip size="sm" color="primary" variant="flat">Auditing: {auditItems.length}</Chip>
                <Chip size="sm" color="success" variant="flat">Verified: {verifiedCount}</Chip>
                <Chip size="sm" color="warning" variant="flat">Remaining: {remaining}</Chip>
              </div>
              <Button size="sm" variant="light" onPress={() => setScanQuery('')}><RefreshCw size={14} /> Reset</Button>
            </div>
            <Progress aria-label="Audit progress" value={progressPct} color={progressPct < 50 ? 'warning' : 'success'} />
          </CardBody>
        </Card>

        {/* Verify-by-scan */}
        <Card className="bg-white/80 dark:bg-slate-800/80 border-gray-200/70 dark:border-slate-700 mb-6">
          <CardBody className="p-4">
            <div className="flex items-center gap-3">
              <Input
                value={scanQuery}
                onValueChange={setScanQuery}
                placeholder="Scan barcode or type item name/ID"
                startContent={<ScanLine size={18} className="text-gray-400" />}
                endContent={<Search size={16} className="text-gray-400" />}
                classNames={{ inputWrapper: 'bg-white dark:bg-slate-800 shadow-sm h-12' }}
              />
              <Button color="primary" className="h-12" onPress={handleVerify} isDisabled={verifying}>
                Verify
              </Button>
            </div>
          </CardBody>
        </Card>

        {/* Zone Lobby */}
        <Card className="bg-white/80 dark:bg-slate-800/80 border-gray-200/70 dark:border-slate-700 mb-6">
          <CardBody className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold">Zones</h2>
              <Chip size="sm" color="primary" variant="flat">Select a zone to lock and audit</Chip>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {zones.map(z => {
                const l = locks[z.id];
                return (
                  <div key={z.id} className={`p-3 border rounded cursor-pointer ${selectedZone===z.id? 'ring-2 ring-indigo-300': ''}`} onClick={() => setSelectedZone(z.id)}>
                    <div className="font-semibold">{z.label}</div>
                    <div className="text-sm text-gray-500">{l?.lockedByName ? `Locked by ${l.lockedByName}` : 'Open'}</div>
                  </div>
                );
              })}
            </div>
          </CardBody>
        </Card>

        {/* Stack Mode for selected zone */}
        {selectedZone ? (
          <Card className="bg-white/80 dark:bg-slate-800/80 border-gray-200/70 dark:border-slate-700 mb-6">
            <CardBody className="p-4">
              <StackAuditClient zone={selectedZone} zoneLabel={selectedZone} onClose={() => setSelectedZone(null)} />
            </CardBody>
          </Card>
        ) : (
          <Card className="bg-white/80 dark:bg-slate-800/80 border-gray-200/70 dark:border-slate-700 mb-6">
            <CardBody className="p-4">
              <div className="text-sm text-gray-500">Or use Quick Count below for single-item adds</div>
            </CardBody>
          </Card>
        )}

        {/* Remaining items table */}
        <Card className="bg-white/80 dark:bg-slate-800/80 border-gray-200/70 dark:border-slate-700">
          <CardBody className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold">Unverified Items</h2>
              <Chip size="sm" color="warning" variant="flat">{remaining} pending</Chip>
            </div>
            <Table aria-label="Unverified items">
              <TableHeader>
                <TableColumn>Name</TableColumn>
                <TableColumn>Location</TableColumn>
                <TableColumn>Room</TableColumn>
                <TableColumn>Par</TableColumn>
              </TableHeader>
              <TableBody emptyContent={remaining === 0 ? 'All audited items verified.' : 'No items'}>
                {auditItems.filter(i => !i.auditVerified).map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>{i.name}</TableCell>
                    <TableCell>{i.location || 'HQ'}</TableCell>
                    <TableCell>{(i as any).room || '—'}</TableCell>
                    <TableCell>{Number(i.reorderThreshold ?? 0) || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardBody>
        </Card>

        {/* Quick-Add Modal */}
        <InventoryModal
          isOpen={isQuickAddOpen}
          onOpenChange={onQuickAddChange}
          onAddItem={handleAddItem}
          onUpdateItem={() => {}}
          initialData={quickAddInitial as any}
          canToggleExpiration={isAdmin}
        />
      </div>
    </div>
  );
}
