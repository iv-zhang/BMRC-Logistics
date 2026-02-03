'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card,
  CardBody,
  CardHeader,
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
  Table,
  TableHeader,
  TableColumn,
  TableBody,
  TableRow,
  TableCell,
  Textarea,
  useDisclosure,
  Spinner,
  Badge,
} from '@heroui/react';
import {
  collection,
  query,
  where,
  onSnapshot,
  addDoc,
  updateDoc,
  doc,
  serverTimestamp,
} from 'firebase/firestore';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { auth, db } from '@/firebase';
import type { Statpack, InventoryItem, User, StatpackPocket, StatpackCompartment } from '@/app/types';
import { BagVisualizer } from '@/app/components/statpackvisualizer';
import StatpackCheckOffModal from '@/app/components/statpack-checkoff-modal';
import StatpackHistory from '@/app/components/statpack-history';
import { updateAssetAssignment, assignBarcode } from '@/app/lib/inventory';
import {
  Package,
  Wrench,
  MapPin,
  Clock,
  Eye,
  CheckCircle,
  Pencil,
  Save,
  X,
  Printer,
} from 'lucide-react';
import AssetModal from '@/app/components/assetmodal';
import BarcodeScanner from '@/app/components/barcode-scanner';
import AssetHistory from '@/app/components/asset-history';
import AdminAuditModal from '@/app/components/admin-audit-modal';

interface AssetRecord {
  id: string;
  name: string;
  type: 'statpack' | 'inventory';
  status: string;
  assetValue?: number;
  currentLocation?: string;
  maintenance_logs?: Array<{
    id?: string;
    timestamp?: Date;
    serviceType: string;
    reason?: string; // Made optional to match Statpack type
    technician?: string;
    notes?: string;
    status: 'pending' | 'in-progress' | 'completed';
    completedAt?: Date;
  }>;
  data: Statpack | InventoryItem;
}

export default function AssetsPage() {
  const router = useRouter();
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [userRole, setUserRole] = useState<User['role'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [assets, setAssets] = useState<AssetRecord[]>([]);

  const [selectedAsset, setSelectedAsset] = useState<AssetRecord | null>(null);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [hoveredRowId, setHoveredRowId] = useState<string | null>(null);
  const [selectedForPrint, setSelectedForPrint] = useState<Set<string>>(new Set());
  // Statpack editor state (admin-only)
  const statpackDisclosure = useDisclosure();
  const [editingPack, setEditingPack] = useState<Statpack | null>(null);
  const [editorSelectedPocket, setEditorSelectedPocket] = useState<StatpackPocket | 'all'>('all');
  const assetModalDisclosure = useDisclosure();
  const [editingAsset, setEditingAsset] = useState<any | null>(null);
  // Admin audit modal state
  const auditModalDisclosure = useDisclosure();
  const [auditType, setAuditType] = useState<'asset' | 'statpack'>('asset');
  const [auditTarget, setAuditTarget] = useState<AssetRecord | null>(null);
  const auditPocketDisclosure = useDisclosure();
  const auditCheckoffDisclosure = useDisclosure();
  const [auditStatpack, setAuditStatpack] = useState<Statpack | null>(null);
  const [auditSelectedPocketId, setAuditSelectedPocketId] = useState<string | null>(null);
  const [auditCompletedPockets, setAuditCompletedPockets] = useState<string[]>([]);

  // Helpers to update contents and compartment items by index (avoid id-collision issues)
  const updateContentAt = (idx: number, patch: Partial<any>) => {
    if (!editingPack) return;
    const contents = [...(editingPack.contents || [])];
    contents[idx] = { ...contents[idx], ...patch };
    setEditingPack({ ...editingPack, contents });
  };

  const removeContentAt = (idx: number) => {
    if (!editingPack) return;
    const contents = [...(editingPack.contents || [])];
    contents.splice(idx, 1);
    setEditingPack({ ...editingPack, contents });
  };

  const auditPocketIds = useMemo(() => {
    if (!auditStatpack) return [] as string[];
    const pockets = ['main', 'front_aux', 'side_left', 'side_right'];
    return pockets.filter((p) => {
      const hasCompartments = (auditStatpack.compartments || []).some((c: any) => c.parentPocket === p);
      const hasLooseItems = (auditStatpack.contents || []).some((i: any) => i.pocket === p && !i.compartmentId);
      return hasCompartments || hasLooseItems;
    });
  }, [auditStatpack]);

  const buildPocketStatpack = (pack: Statpack, pocketId: string | null): Statpack => {
    if (!pocketId) return pack;
    const pocketComp = (pack.compartments || []).filter((c) => c.parentPocket === pocketId);
    let pocketContents: any[] = [];
    if (pocketComp.length > 0) {
      pocketContents = pocketComp.flatMap((c) => (pack.contents || []).filter((i) => i.compartmentId === c.id));
    }
    const loose = (pack.contents || []).filter((i) => i.pocket === pocketId && !i.compartmentId);
    pocketContents = [...pocketContents, ...loose];

    if (pocketComp.length === 0 && pocketContents.length === 0) {
      pocketContents = (pack.contents || []).filter((i) => i.compartmentId === pocketId);
      const directComp = (pack.compartments || []).filter((c) => c.id === pocketId);
      return ({ ...pack, contents: pocketContents, compartments: directComp } as Statpack);
    }

    return ({ ...pack, contents: pocketContents, compartments: pocketComp } as Statpack);
  };

  const openStatpackAudit = (asset: AssetRecord) => {
    const pack = asset.data as Statpack;
    setAuditStatpack(JSON.parse(JSON.stringify(pack)) as Statpack);
    setAuditSelectedPocketId(null);
    setAuditCompletedPockets([]);
    auditPocketDisclosure.onOpen();
  };
  const [maintenanceReason, setMaintenanceReason] = useState('');
  const [maintenanceNotes, setMaintenanceNotes] = useState('');
  
  // Quick-assign barcode state
  const [showQuickAssignScanner, setShowQuickAssignScanner] = useState(false);
  const [quickAssignAsset, setQuickAssignAsset] = useState<AssetRecord | null>(null);
  const [scannedBarcodeQuick, setScannedBarcodeQuick] = useState<string>('');
  const [duplicateWarningQuick, setDuplicateWarningQuick] = useState<{
    show: boolean;
    barcode: string;
    duplicateItem?: { id: string; name: string; serial?: string };
  } | null>(null);
  const [assigningBarcodeQuick, setAssigningBarcodeQuick] = useState(false);
  const [maintenanceTechnician, setMaintenanceTechnician] = useState('');
  const [maintenanceServiceType, setMaintenanceServiceType] = useState<'routine' | 'repair' | 'inspection' | 'replacement'>('routine');

  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerTargetAsset, setScannerTargetAsset] = useState<AssetRecord | null>(null);

  const [isEditingDetails, setIsEditingDetails] = useState(false);
  const [detailsForm, setDetailsForm] = useState({
    name: '',
    status: '',
    currentLocation: '',
    assetValue: '',
  });
  const [editingLocationId, setEditingLocationId] = useState<string | null>(null);
  const [editingLocationValue, setEditingLocationValue] = useState('');

  const maintenanceDisclosure = useDisclosure();
  const detailsDisclosure = useDisclosure();

  // Auth
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      if (!currentUser) {
        router.push('/login');
        return;
      }
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, [router]);

  // Fetch user role
  useEffect(() => {
    if (!user) return;
    const userRef = doc(db, 'users', user.uid);
    const unsubscribe = onSnapshot(
      userRef,
      (snapshot) => {
        const data = snapshot.data() as User | undefined;
        setUserRole(data?.role ?? 'member');
      },
      (error) => {
        console.error('Error fetching user role:', error);
        setUserRole('member');
      }
    );
    return () => unsubscribe();
  }, [user]);

  // Clear row selection when details modal closes
  useEffect(() => {
    if (!detailsDisclosure.isOpen) setSelectedRowId(null);
  }, [detailsDisclosure.isOpen]);

  // Fetch statpacks and high-value inventory items
  useEffect(() => {
    if (!user) return;
    setLoading(true);

    let statpacksReady = false;
    let inventoryReady = false;

    const finishLoadingIfReady = () => {
      if (statpacksReady && inventoryReady) {
        setLoading(false);
      }
    };

    // Fetch statpacks (treat all statpacks as assets)
    const statpacksUnsubscribe = onSnapshot(
      collection(db, 'statpacks'),
      (snapshot) => {
        const statpackAssets: AssetRecord[] = snapshot.docs.map((d) => {
          const data = d.data() as Statpack;
          return {
            id: d.id,
            name: data.name,
            type: 'statpack' as const,
            status: data.status,
            assetValue: data.assetValue,
            currentLocation: data.currentLocation,
            maintenance_logs: data.maintenance_logs,
            data,
          };
        });

        setAssets((prev) => {
          const nonStatpacks = prev.filter((a) => a.type !== 'statpack');
          return [...nonStatpacks, ...statpackAssets];
        });
        statpacksReady = true;
        finishLoadingIfReady();
      },
      (error) => {
        console.error('Error fetching statpacks:', error);
        statpacksReady = true;
        finishLoadingIfReady();
      }
    );

    // Fetch high-value non-disposable inventory items (O2 tanks, AEDs, bikes, radios, etc.)
    const inventoryUnsubscribe = onSnapshot(
      query(collection(db, 'inventory'), where('isAsset', '==', true)),
      (snapshot) => {
        const inventoryAssets: AssetRecord[] = snapshot.docs.map((d) => {
          const data = d.data() as InventoryItem;
          return {
            id: d.id,
            name: data.name,
            type: 'inventory' as const,
            status: data.assetStatus || 'Ready',
            assetValue: data.assetValue,
            currentLocation: data.currentLocation,
            maintenance_logs: data.maintenance_logs,
            data,
          };
        });

        setAssets((prev) => {
          const statpacks = prev.filter((a) => a.type !== 'inventory' || (a.type === 'inventory' && (a.data as InventoryItem).isAsset !== true));
          return [...statpacks, ...inventoryAssets];
        });
        inventoryReady = true;
        finishLoadingIfReady();
      },
      (error) => {
        console.error('Error fetching inventory assets:', error);
        inventoryReady = true;
        finishLoadingIfReady();
      }
    );

    return () => {
      statpacksUnsubscribe();
      inventoryUnsubscribe();
    };
  }, [user]);

  const handleStartMaintenance = (asset: AssetRecord) => {
    setSelectedAsset(asset);
    setMaintenanceReason('');
    setMaintenanceNotes('');
    setMaintenanceTechnician(user?.displayName || '');
    setMaintenanceServiceType('routine');
    maintenanceDisclosure.onOpen();
  };

  const handleSubmitMaintenance = async () => {
    if (!selectedAsset || !maintenanceReason) {
      alert('Please provide a maintenance reason');
      return;
    }

    try {
      const logEntry = {
        id: `log_${Date.now()}`,
        timestamp: new Date(),
        serviceType: maintenanceServiceType,
        reason: maintenanceReason,
        technician: maintenanceTechnician || user?.displayName || 'Unknown',
        notes: maintenanceNotes,
        status: 'in-progress' as const,
      };

      if (selectedAsset.type === 'statpack') {
        const statpackData = selectedAsset.data as Statpack;
        const existing = statpackData.maintenance_logs || [];
        await updateDoc(doc(db, 'statpacks', selectedAsset.id), {
          maintenance_logs: [...existing, logEntry],
          status: 'Pending Initial Check', // Mark as under maintenance
          updatedAt: serverTimestamp(),
        });
      } else {
        const inventoryData = selectedAsset.data as InventoryItem;
        const existing = inventoryData.maintenance_logs || [];
        await updateDoc(doc(db, 'inventory', selectedAsset.id), {
          maintenance_logs: [...existing, logEntry],
          assetStatus: 'Not Ready',
          updatedAt: serverTimestamp(),
        });
      }

      maintenanceDisclosure.onClose();
      setSelectedAsset(null);
    } catch (error) {
      console.error('Failed to submit maintenance:', error);
      alert('Failed to record maintenance');
    }
  };

  const handleCompleteMaintenance = async (asset: AssetRecord, logId: string | undefined) => {
    if (!logId) return;

    try {
      if (asset.type === 'statpack') {
        const statpackData = asset.data as Statpack;
        const updated = (statpackData.maintenance_logs || []).map((log) =>
          log.id === logId ? { ...log, status: 'completed' as const, completedAt: new Date() } : log
        );
        await updateDoc(doc(db, 'statpacks', asset.id), {
          maintenance_logs: updated,
          status: 'Ready',
          updatedAt: serverTimestamp(),
        });
      } else {
        const inventoryData = asset.data as InventoryItem;
        const updated = (inventoryData.maintenance_logs || []).map((log) =>
          log.id === logId ? { ...log, status: 'completed' as const, completedAt: new Date() } : log
        );
        await updateDoc(doc(db, 'inventory', asset.id), {
          maintenance_logs: updated,
          assetStatus: 'Ready',
          updatedAt: serverTimestamp(),
        });
      }
    } catch (error) {
      console.error('Failed to complete maintenance:', error);
      alert('Failed to complete maintenance');
    }
  };

  const openScannerForAsset = (asset: AssetRecord) => {
    setScannerTargetAsset(asset);
    setSelectedAsset(asset);
    setScannerOpen(true);
  };

  const handleBarcodeDetected = async (value: string) => {
    if (!scannerTargetAsset) return;
    try {
      if (scannerTargetAsset.type === 'statpack') {
        await updateDoc(doc(db, 'statpacks', scannerTargetAsset.id), {
          currentLocation: value,
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(doc(db, 'inventory', scannerTargetAsset.id), {
          currentLocation: value,
          updatedAt: serverTimestamp(),
        });
      }

      setAssets((prev) => prev.map((a) => (a.id === scannerTargetAsset.id ? { ...a, currentLocation: value } : a)));
      setSelectedAsset((prev) => (prev && prev.id === scannerTargetAsset.id ? { ...prev, currentLocation: value } : prev));
    } catch (error) {
      console.error('Failed to record scan:', error);
      alert('Failed to update location from scan');
    } finally {
      setScannerOpen(false);
      setScannerTargetAsset(null);
    }
  };

  const startLocationEdit = (asset: AssetRecord) => {
    setEditingLocationId(asset.id);
    setEditingLocationValue(asset.currentLocation || '');
  };

  const cancelLocationEdit = () => {
    setEditingLocationId(null);
    setEditingLocationValue('');
  };

  const saveLocationEdit = async (asset: AssetRecord) => {
    if (!editingLocationId) return;
    try {
      if (asset.type === 'statpack') {
        await updateDoc(doc(db, 'statpacks', asset.id), { currentLocation: editingLocationValue, updatedAt: serverTimestamp() });
      } else {
        await updateDoc(doc(db, 'inventory', asset.id), { currentLocation: editingLocationValue, updatedAt: serverTimestamp() });
      }
      setAssets((prev) => prev.map((a) => (a.id === asset.id ? { ...a, currentLocation: editingLocationValue } : a)));
      setSelectedAsset((prev) => (prev && prev.id === asset.id ? { ...prev, currentLocation: editingLocationValue } : prev));
    } catch (err) {
      console.error('Failed to save location:', err);
      alert('Failed to save location');
    } finally {
      cancelLocationEdit();
    }
  };

  const beginDetailsEdit = (asset: AssetRecord | null) => {
    if (!asset) return;
    setDetailsForm({
      name: asset.name || '',
      status: asset.status || '',
      currentLocation: asset.currentLocation || '',
      assetValue: asset.assetValue !== undefined ? String(asset.assetValue) : '',
    });
    setIsEditingDetails(true);
  };

  const cancelDetailsEdit = () => {
    setIsEditingDetails(false);
  };

  const handleSaveDetails = async () => {
    if (!selectedAsset) return;
    const parsedValue = detailsForm.assetValue !== '' ? Number(detailsForm.assetValue) : undefined;
    const statusValue = detailsForm.status || selectedAsset.status || 'Ready';
    const nameValue = detailsForm.name || selectedAsset.name;
    const locationValue = detailsForm.currentLocation || '';
    const inventoryStatus: InventoryItem['assetStatus'] = statusValue === 'Not Ready' ? 'Not Ready' : 'Ready';

    try {
      if (selectedAsset.type === 'statpack') {
        await updateDoc(doc(db, 'statpacks', selectedAsset.id), {
          name: nameValue,
          status: statusValue as Statpack['status'],
          currentLocation: locationValue,
          assetValue: parsedValue,
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(doc(db, 'inventory', selectedAsset.id), {
          name: nameValue,
          assetStatus: inventoryStatus,
          currentLocation: locationValue,
          assetValue: parsedValue,
          updatedAt: serverTimestamp(),
        });
      }

      setAssets((prev) =>
        prev.map((a) =>
          a.id === selectedAsset.id
            ? { ...a, name: nameValue, status: selectedAsset.type === 'statpack' ? statusValue : inventoryStatus, currentLocation: locationValue, assetValue: parsedValue }
            : a
        )
      );

      setSelectedAsset({
        ...selectedAsset,
        name: nameValue,
        status: selectedAsset.type === 'statpack' ? statusValue : inventoryStatus,
        currentLocation: locationValue,
        assetValue: parsedValue,
        data:
          selectedAsset.type === 'statpack'
            ? { ...(selectedAsset.data as Statpack), name: nameValue, status: statusValue as Statpack['status'], currentLocation: locationValue, assetValue: parsedValue }
            : { ...(selectedAsset.data as InventoryItem), name: nameValue, assetStatus: inventoryStatus, currentLocation: locationValue, assetValue: parsedValue },
      });

      setIsEditingDetails(false);
    } catch (error) {
      console.error('Failed to save details:', error);
      alert('Failed to save changes');
    }
  };

  const getStatusColor = (status: string) => {
    if (status === 'Ready') return 'success';
    if (status === 'In Use') return 'warning';
    if (status === 'Not Ready') return 'danger';
    if (status === 'Pending Initial Check') return 'secondary';
    return 'default';
  };

  const getMaintenanceStatus = (asset: AssetRecord) => {
    const logs = asset.maintenance_logs || [];
    const activeLog = logs.find((l) => l.status === 'pending' || l.status === 'in-progress');
    return activeLog;
  };

  // Quick-assign barcode handlers
  const handleQuickAssignBarcode = (asset: AssetRecord) => {
    if (asset.type !== 'inventory') {
      alert('Barcode assignment is only supported for inventory assets currently.');
      return;
    }
    setQuickAssignAsset(asset);
    setScannedBarcodeQuick('');
    setDuplicateWarningQuick(null);
    setShowQuickAssignScanner(true);
  };

  const handleQuickScanDetected = (code: string) => {
    setScannedBarcodeQuick(code);
    setShowQuickAssignScanner(false);
  };

  const handleQuickAssign = async (allowDuplicate = false) => {
    if (!quickAssignAsset || !scannedBarcodeQuick.trim() || !user) {
      return;
    }

    setAssigningBarcodeQuick(true);
    setDuplicateWarningQuick(null);

    try {
      const result = await assignBarcode({
        itemId: quickAssignAsset.id,
        barcode: scannedBarcodeQuick,
        user: { id: user.uid, fullName: user.displayName || user.email || 'Unknown' },
        options: { allowDuplicate },
      });

      if (!result.success) {
        if (result.isDuplicate && !allowDuplicate) {
          setDuplicateWarningQuick({
            show: true,
            barcode: scannedBarcodeQuick,
            duplicateItem: result.duplicateItem,
          });
        } else {
          alert(result.message);
        }
      } else {
        alert(result.message);
        setScannedBarcodeQuick('');
        setQuickAssignAsset(null);
        setDuplicateWarningQuick(null);
      }
    } catch (error: any) {
      alert(error.message || 'Failed to assign barcode');
    } finally {
      setAssigningBarcodeQuick(false);
    }
  };

  const handleQuickDuplicateOverride = () => {
    handleQuickAssign(true);
  };

  const handleQuickCancelDuplicate = () => {
    setDuplicateWarningQuick(null);
    setScannedBarcodeQuick('');
    setQuickAssignAsset(null);
  };

  const sortedAssets = [...assets].sort((a, b) => {
    const aActive = getMaintenanceStatus(a);
    const bActive = getMaintenanceStatus(b);
    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;
    return a.name.localeCompare(b.name);
  });

  if (loading) return <div className="h-screen flex items-center justify-center"><Spinner /></div>;

  // Restrict access: general members should not access the Asset Management UI
  if (!loading && userRole === 'member') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-6">
        <div className="max-w-3xl mx-auto">
          <Card>
            <CardBody className="text-center">
              <h2 className="text-xl font-semibold">Access Denied</h2>
              <p className="mt-2 text-sm text-gray-600">You do not have permission to view the Asset Management area.</p>
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
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
              <Package className="text-indigo-600" />
              Asset Management
            </h1>
            <p className="text-gray-500">Manage statpacks, O2 tanks, AEDs, bikes, radios, and other valuable equipment</p>
          </div>
          <div className="flex gap-2">
            {userRole === 'admin' && selectedForPrint.size > 0 && (
              <Button
                color="success"
                variant="flat"
                startContent={<Printer size={16} />}
                onPress={() => {
                  localStorage.setItem('printAssetIds', JSON.stringify(Array.from(selectedForPrint)));
                  router.push('/print-labels');
                }}
              >
                Print ({selectedForPrint.size})
              </Button>
            )}
            {userRole === 'admin' && (
              <Button onPress={() => { setEditingAsset(null); assetModalDisclosure.onOpen(); }}>Add Asset</Button>
            )}
          </div>
        </div>
        <Divider />

        {/* Assets Table */}
        <Card>
          <CardBody>
            <Table
              aria-label="Assets table"
              classNames={{
                table: 'text-sm',
              }}
            >
              <TableHeader>
                <TableColumn key="checkbox" className={userRole === 'admin' ? '' : 'hidden'}>✓</TableColumn>
                <TableColumn>Asset Name</TableColumn>
                <TableColumn>Type</TableColumn>
                <TableColumn>Status</TableColumn>
                <TableColumn>Location</TableColumn>
                <TableColumn>Value</TableColumn>
                <TableColumn>Maintenance</TableColumn>
                <TableColumn>Actions</TableColumn>
              </TableHeader>
              <TableBody emptyContent="No assets found">
                {sortedAssets.map((asset) => {
                  const activeMaintenance = getMaintenanceStatus(asset);
                  return (
                    <TableRow
                      key={asset.id}
                      onClick={() => { setSelectedRowId(asset.id); setSelectedAsset(asset); setIsEditingDetails(false); detailsDisclosure.onOpen(); }}
                      onMouseEnter={() => setHoveredRowId(asset.id)}
                      onMouseLeave={() => setHoveredRowId((id) => id === asset.id ? null : id)}
                      className={`cursor-pointer transition-colors duration-150 ease-in-out ${selectedRowId === asset.id || hoveredRowId === asset.id ? 'bg-gray-100 dark:bg-slate-800' : ''}`}
                    >
                      <TableCell className={userRole === 'admin' ? '' : 'hidden'}>
                        {userRole === 'admin' && (
                          <input
                            type="checkbox"
                            checked={selectedForPrint.has(asset.id)}
                            onChange={(e) => {
                              const newSelected = new Set(selectedForPrint);
                              if (e.target.checked) {
                                newSelected.add(asset.id);
                              } else {
                                newSelected.delete(asset.id);
                              }
                              setSelectedForPrint(newSelected);
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        )}
                      </TableCell>
                      <TableCell className="font-medium">{asset.name}</TableCell>
                      <TableCell>
                        <Chip size="sm" variant="flat">
                          {asset.type === 'statpack' ? 'Statpack' : (asset.data as InventoryItem).category || 'Item'}
                        </Chip>
                      </TableCell>
                      <TableCell>
                        <Chip size="sm" color={getStatusColor(asset.status)} variant="flat">
                          {asset.status}
                        </Chip>
                      </TableCell>
                      <TableCell>
                        {editingLocationId === asset.id ? (
                          <div className="flex items-center gap-2">
                            <Input
                              size="sm"
                              value={editingLocationValue}
                              onValueChange={setEditingLocationValue}
                              onKeyDown={(e: any) => {
                                if (e.key === 'Enter') saveLocationEdit(asset);
                                if (e.key === 'Escape') cancelLocationEdit();
                              }}
                            />
                            <Button size="sm" onPress={() => saveLocationEdit(asset)}>
                              <Save size={14} />
                            </Button>
                            <Button size="sm" variant="light" onPress={() => cancelLocationEdit()}>
                              <X size={14} />
                            </Button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 text-sm">
                            <MapPin size={14} className="text-gray-400" />
                            <span>{asset.currentLocation || '—'}</span>
                            <Button isIconOnly size="sm" variant="light" onPress={() => startLocationEdit(asset)}>
                              <Pencil size={14} />
                            </Button>
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        {asset.assetValue ? `$${asset.assetValue.toFixed(2)}` : '—'}
                      </TableCell>
                      <TableCell>
                        {activeMaintenance ? (
                          <Badge color="danger" content={activeMaintenance.status === 'in-progress' ? 'IN PROGRESS' : 'PENDING'}>
                            <div className="text-xs">
                              <div className="font-semibold">{activeMaintenance.serviceType}</div>
                              <div className="text-gray-600">{activeMaintenance.reason}</div>
                            </div>
                          </Badge>
                        ) : (
                          <span className="text-xs text-gray-500">No active maintenance</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-2">
                          <Button
                                isIconOnly
                                size="sm"
                                variant="light"
                                onPress={(e: any) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); setSelectedRowId(asset.id); setSelectedAsset(asset); setIsEditingDetails(false); detailsDisclosure.onOpen(); }}
                              >
                            <Eye size={16} />
                          </Button>
                          <Button
                            isIconOnly
                            size="sm"
                            variant="light"
                            onPress={(e: any) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); openScannerForAsset(asset); }}
                            aria-label="Scan location"
                          >
                            <MapPin size={18} />
                          </Button>
                          {userRole === 'admin' && (
                            <Button
                              isIconOnly
                              size="sm"
                              variant="light"
                              color={activeMaintenance ? 'success' : 'warning'}
                              onPress={(e: any) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); if (activeMaintenance) { handleCompleteMaintenance(asset, activeMaintenance.id); } else { handleStartMaintenance(asset); } }}
                              aria-label={activeMaintenance ? 'Complete maintenance' : 'Start maintenance'}
                            >
                              {activeMaintenance ? <CheckCircle size={18} /> : <Wrench size={18} />}
                            </Button>
                          )}
                          {asset.type === 'statpack' && (
                            <Button
                              isIconOnly
                              size="sm"
                              variant="light"
                              onPress={() => {
                                // open statpack editor with a deep copy
                                router.push(`/statpacks/${asset.id}`);
                              }}
                              aria-label="Open statpack"
                            >
                              <Pencil size={18} />
                            </Button>
                          )}
                          {asset.type === 'inventory' && userRole === 'admin' && (
                            <Button isIconOnly size="sm" variant="light" onPress={(e:any) => { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); setEditingAsset(asset.data); assetModalDisclosure.onOpen(); }} aria-label="Edit asset">
                              <Pencil size={18} />
                            </Button>
                          )}
                          {asset.type === 'inventory' && (userRole === 'admin' || userRole === 'quartermaster' || userRole === 'inventory_helper') && (
                            <Button
                              isIconOnly
                              size="sm"
                              variant="light"
                              color="secondary"
                              onPress={(e: any) => {
                                if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
                                handleQuickAssignBarcode(asset);
                              }}
                              title="Assign external barcode tag"
                              aria-label="Assign barcode"
                            >
                              <Package size={18} />
                            </Button>
                          )}
                          {userRole === 'admin' && (
                            <Button
                              size="sm"
                              variant="light"
                              onPress={(e: any) => {
                                e.stopPropagation();
                                if (asset.type === 'statpack') {
                                  openStatpackAudit(asset);
                                  return;
                                }
                                setAuditTarget(asset);
                                setAuditType('asset');
                                auditModalDisclosure.onOpen();
                              }}
                              title="Run Manual Audit"
                              startContent={<Wrench size={18} />}
                            >
                              Audit
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardBody>
        </Card>
      </div>

      {/* Maintenance Modal */}
      <Modal isOpen={maintenanceDisclosure.isOpen} onOpenChange={maintenanceDisclosure.onOpenChange} size="lg">
        <ModalContent>
          <ModalHeader>Record Maintenance - {selectedAsset?.name}</ModalHeader>
          <ModalBody className="space-y-4">
            <Select
              label="Service Type"
              selectedKeys={[maintenanceServiceType]}
              onChange={(e) => setMaintenanceServiceType(e.target.value as 'routine' | 'repair' | 'inspection' | 'replacement')}
            >
              <SelectItem key="routine">Routine Inspection</SelectItem>
              <SelectItem key="repair">Repair</SelectItem>
              <SelectItem key="inspection">Inspection</SelectItem>
              <SelectItem key="replacement">Component Replacement</SelectItem>
            </Select>

            <Textarea
              label="Reason for Maintenance"
              placeholder="Why is this asset being serviced?"
              value={maintenanceReason}
              onValueChange={setMaintenanceReason}
              minRows={2}
            />

            <Input
              label="Technician Name"
              placeholder="Your name"
              value={maintenanceTechnician}
              onValueChange={setMaintenanceTechnician}
            />

            <Textarea
              label="Notes (Optional)"
              placeholder="Additional details..."
              value={maintenanceNotes}
              onValueChange={setMaintenanceNotes}
              minRows={2}
            />
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={() => maintenanceDisclosure.onClose()}>
              Cancel
            </Button>
            <Button color="primary" onPress={handleSubmitMaintenance}>
              Start Maintenance
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* Details Modal */}
      <Modal isOpen={detailsDisclosure.isOpen} onOpenChange={detailsDisclosure.onOpenChange} size="2xl">
        <ModalContent>
          <ModalHeader className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Package size={18} />
              <span>{selectedAsset?.name}</span>
            </div>
            {selectedAsset && (
              <Button
                size="sm"
                variant="light"
                startContent={isEditingDetails ? <X size={14} /> : <Pencil size={14} />}
                onPress={() => {
                  if (isEditingDetails) {
                    cancelDetailsEdit();
                  } else {
                    beginDetailsEdit(selectedAsset);
                  }
                }}
              >
                {isEditingDetails ? 'Cancel edit' : 'Edit'}
              </Button>
            )}
          </ModalHeader>
          <ModalBody className="space-y-4">
            {isEditingDetails ? (
              <div className="grid grid-cols-2 gap-3">
                <Input label="Name" value={detailsForm.name} onValueChange={(v) => setDetailsForm({ ...detailsForm, name: v })} />
                <Select
                  label="Status"
                  selectedKeys={[detailsForm.status || 'Ready']}
                  onChange={(e) => setDetailsForm({ ...detailsForm, status: e.target.value })}
                >
                  {(selectedAsset?.type === 'inventory'
                    ? ['Ready', 'Not Ready']
                    : ['Ready', 'In Use', 'Not Ready', 'Pending Initial Check']
                  ).map((statusKey) => (
                    <SelectItem key={statusKey}>{statusKey}</SelectItem>
                  ))}
                </Select>
                <Input
                  label="Location"
                  value={detailsForm.currentLocation}
                  onValueChange={(v) => setDetailsForm({ ...detailsForm, currentLocation: v })}
                  placeholder="Bay, rig, or shelf"
                />
                <Input
                  label="Asset Value"
                  type="number"
                  value={detailsForm.assetValue}
                  onValueChange={(v) => setDetailsForm({ ...detailsForm, assetValue: v })}
                  placeholder="500"
                />
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-semibold text-gray-600">Type</p>
                  <p className="text-sm">{selectedAsset?.type === 'statpack' ? 'Statpack' : 'Inventory Item'}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-600">Status</p>
                  <Chip color={getStatusColor(selectedAsset?.status || '')} size="sm">
                    {selectedAsset?.status}
                  </Chip>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-600">Location</p>
                  <p className="text-sm">{selectedAsset?.currentLocation || 'Not specified'}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-600">Asset Value</p>
                  <p className="text-sm">{selectedAsset?.assetValue ? `$${selectedAsset.assetValue.toFixed(2)}` : 'Not specified'}</p>
                </div>
              </div>
            )}

            <Divider />

            {/* Statpack Contents */}
            {selectedAsset?.type === 'statpack' && (
              <>
                <div>
                  <h3 className="font-semibold mb-3 flex items-center gap-2">
                    <Package size={16} />
                    Contents {(selectedAsset.data as Statpack).contents?.length ? `(${(selectedAsset.data as Statpack).contents?.length} items)` : ''}
                  </h3>
                  {(selectedAsset.data as Statpack).contents && (selectedAsset.data as Statpack).contents.length > 0 ? (
                    <div className="space-y-2 max-h-60 overflow-y-auto">
                      {(selectedAsset.data as Statpack).contents.map((item, idx) => (
                        <div key={idx} className="p-2 border rounded-md bg-gray-50 dark:bg-slate-800 text-sm">
                          <div className="flex justify-between items-start">
                            <div className="flex-1">
                              <p className="font-medium">{item.itemDetails?.name || item.itemId}</p>
                              <p className="text-xs text-gray-500">
                                Qty: {item.currentQuantity}/{item.requiredQuantity}
                                {item.serialNumber && ` • Serial: ${item.serialNumber}`}
                                {item.lotNumber && ` • Lot: ${item.lotNumber}`}
                              </p>
                              {item.expirationDate && (
                                <p className="text-xs text-gray-500">
                                  Exp: {item.expirationDate instanceof Date ? item.expirationDate.toLocaleDateString() : new Date(item.expirationDate).toLocaleDateString()}
                                </p>
                              )}
                            </div>
                            {item.itemValue && (
                              <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                                ${(item.itemValue * item.currentQuantity).toFixed(2)}
                              </p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500">No contents recorded</p>
                  )}
                </div>
                <Divider />
              </>
            )}

            <div>
              {selectedAsset?.id && (
                <div className="mb-4">
                  <h3 className="font-semibold mb-3 flex items-center gap-2">
                    <Clock size={16} />
                    Recent Activity
                  </h3>
                  {selectedAsset.type === 'statpack' ? (
                    <StatpackHistory statpackId={selectedAsset.id} maxRows={12} />
                  ) : (
                    <AssetHistory assetId={selectedAsset.id} maxRows={10} />
                  )}
                </div>
              )}
              <h3 className="font-semibold mb-3 flex items-center gap-2">
                <Clock size={16} />
                Maintenance History
              </h3>
              {selectedAsset?.maintenance_logs && selectedAsset.maintenance_logs.length > 0 ? (
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {selectedAsset.maintenance_logs.map((log, idx) => (
                    <div key={log.id || idx} className="p-3 border rounded-md bg-gray-50 dark:bg-slate-800">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <p className="font-medium text-sm">{log.serviceType}</p>
                          <p className="text-xs text-gray-600">{log.reason}</p>
                        </div>
                        <Chip size="sm" color={log.status === 'completed' ? 'success' : 'warning'} variant="flat">
                          {log.status}
                        </Chip>
                      </div>
                      {log.technician && <p className="text-xs text-gray-500">Technician: {log.technician}</p>}
                      {log.timestamp && (
                        <p className="text-xs text-gray-500">
                          {log.timestamp instanceof Date ? log.timestamp.toLocaleDateString() : new Date(log.timestamp).toLocaleDateString()}
                        </p>
                      )}
                      {log.notes && <p className="text-xs text-gray-600 mt-1 italic">{log.notes}</p>}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-500">No maintenance records</p>
              )}
            </div>
          </ModalBody>
          <ModalFooter>
            <div className="flex items-center gap-2">
              {userRole === 'admin' && selectedAsset && (
                <Button variant="light" onPress={() => handleStartMaintenance(selectedAsset)}>
                  Record Maintenance
                </Button>
              )}
              <Button variant="light" onPress={() => { setIsEditingDetails(false); detailsDisclosure.onClose(); }}>
                Close
              </Button>
            </div>
            {isEditingDetails && (
              <Button color="primary" startContent={<Save size={16} />} onPress={handleSaveDetails}>
                Save
              </Button>
            )}
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* Statpack Editor Modal (admin) */}
      <Modal isOpen={statpackDisclosure.isOpen} onOpenChange={statpackDisclosure.onOpenChange} size="3xl">
        <ModalContent>
          <ModalHeader>Statpack Editor - {editingPack?.name}</ModalHeader>
          <ModalBody className="space-y-4">
            {!editingPack && <p className="text-sm text-gray-500">No statpack loaded.</p>}
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
                  <Input
                    label="Pack Name"
                    value={editingPack.name}
                    onValueChange={(v) => setEditingPack({ ...editingPack, name: v })}
                  />
                  <Select
                    label="Status"
                    selectedKeys={[editingPack.status || 'Ready']}
                    onChange={(e) => setEditingPack({ ...editingPack, status: e.target.value as Statpack['status'] })}
                  >
                    <SelectItem key="Ready">Ready</SelectItem>
                    <SelectItem key="In Use">In Use</SelectItem>
                    <SelectItem key="Not Ready">Not Ready</SelectItem>
                  </Select>
                </div>

                <Divider />

                <div className="space-y-4">
                  <div>
                    <h3 className="font-semibold mb-2">Statpack Pockets</h3>
                    <p className="text-xs text-gray-500 mb-3">Configure items for each pocket (Center • Front • Left • Right)</p>
                    
                    {/* Pocket tabs */}
                    <div className="flex gap-2 mb-4 flex-wrap">
                      {[
                        { id: 'all' as const, label: 'All Pockets' },
                        { id: 'main' as const, label: 'Center Pocket (Main)' },
                        { id: 'front_aux' as const, label: 'Front Pocket' },
                        { id: 'side_left' as const, label: 'Left Side Pocket' },
                        { id: 'side_right' as const, label: 'Right Side Pocket' },
                      ].map(p => (
                        <Button
                          key={p.id}
                          size="sm"
                          variant={editorSelectedPocket === p.id ? 'solid' : 'bordered'}
                          color={editorSelectedPocket === p.id ? 'primary' : 'default'}
                          onPress={() => setEditorSelectedPocket(p.id)}
                        >
                          {p.label}
                        </Button>
                      ))}
                    </div>
                  </div>

                  {editorSelectedPocket !== 'all' && (
                    <Card>
                      <CardHeader className="flex justify-between items-center bg-default-50">
                        <div>
                          <h4 className="font-semibold">
                            {editorSelectedPocket === 'main' && 'Center Pocket (Main)'}
                            {editorSelectedPocket === 'front_aux' && 'Front Pocket'}
                            {editorSelectedPocket === 'side_left' && 'Left Side Pocket'}
                            {editorSelectedPocket === 'side_right' && 'Right Side Pocket'}
                          </h4>
                          <p className="text-xs text-gray-500">Sealed compartments and loose items</p>
                        </div>
                        <Button
                          size="sm"
                          onPress={() => {
                            const pocketForNew = editorSelectedPocket;
                            const newComp: StatpackCompartment = {
                              id: `comp_${Date.now()}`,
                              name: 'New Sealed Compartment',
                              parentPocket: pocketForNew as StatpackPocket,
                              isSealed: false,
                              sealNumber: '',
                              expirationDate: undefined,
                            };
                            setEditingPack({ ...editingPack, compartments: [...(editingPack.compartments || []), newComp] });
                          }}
                        >
                          + Add Compartment
                        </Button>
                      </CardHeader>
                      <CardBody className="gap-4">
                        {/* Loose items section */}
                        <div className="space-y-2">
                          <h5 className="text-sm font-medium">Loose Items</h5>
                          {((editingPack.contents || []).filter((it) => it.pocket === editorSelectedPocket)).length === 0 && (
                            <p className="text-xs text-gray-500">No loose items yet.</p>
                          )}
                          {((editingPack.contents || [])
                            .map((c, idx) => ({ c, idx }))
                            .filter(({ c }) => c.pocket === editorSelectedPocket))
                            .map(({ c: it, idx }) => (
                              <div key={it.itemId || idx} className="flex items-center gap-2 p-2 bg-default-50 rounded">
                                <Input
                                  label="Item"
                                  size="sm"
                                  value={(it as any).name ?? it.itemDetails?.name ?? it.itemId ?? ''}
                                  onValueChange={(v) => updateContentAt(idx, { name: v } as any)}
                                />
                                <Input
                                  label="Qty"
                                  size="sm"
                                  className="w-20"
                                  value={String((it as any).qty ?? it.currentQuantity ?? it.requiredQuantity ?? 1)}
                                  onValueChange={(v) => updateContentAt(idx, { qty: Number(v), currentQuantity: Number(v) } as any)}
                                />
                                <Button size="sm" variant="light" isIconOnly onPress={() => removeContentAt(idx)}>
                                  <X size={16} />
                                </Button>
                              </div>
                            ))}
                          <Button
                            size="sm"
                            variant="flat"
                            onPress={() => {
                              const newItem = { id: `free_${Date.now()}`, name: 'New Item', qty: 1, pocket: editorSelectedPocket } as any;
                              const contents = [...(editingPack.contents || []), newItem];
                              setEditingPack({ ...editingPack, contents });
                            }}
                          >
                            + Add Loose Item
                          </Button>
                        </div>

                        {/* Compartments for this pocket */}
                        <div className="space-y-2">
                          <h5 className="text-sm font-medium">Sealed Compartments</h5>
                          {((editingPack.compartments || []).filter((c) => c.parentPocket === editorSelectedPocket)).length === 0 && (
                            <p className="text-xs text-gray-500">No sealed compartments yet.</p>
                          )}
                          {((editingPack.compartments || []).filter((c) => c.parentPocket === editorSelectedPocket)).map((comp, ci) => {
                            const origIndex = (editingPack.compartments || []).indexOf(comp);
                            return (
                              <Card key={comp.id || ci} className="border-l-4 border-l-primary bg-default-50">
                                <CardBody className="gap-2 py-3 px-3">
                                  <div className="flex justify-between items-start gap-2">
                                    <div className="flex-1">
                                      <Input
                                        label="Compartment Name"
                                        size="sm"
                                        value={comp.name}
                                        onValueChange={(v) => {
                                          const comps = [...(editingPack.compartments || [])];
                                          comps[origIndex] = { ...comps[origIndex], name: v };
                                          setEditingPack({ ...editingPack, compartments: comps });
                                        }}
                                      />
                                      <div className="flex gap-2 mt-2">
                                        <Chip
                                          size="sm"
                                          variant="flat"
                                          color={comp.isSealed ? 'success' : 'default'}
                                          onClick={() => {
                                            const comps = [...(editingPack.compartments || [])];
                                            comps[origIndex] = { ...comps[origIndex], isSealed: !comps[origIndex].isSealed };
                                            setEditingPack({ ...editingPack, compartments: comps });
                                          }}
                                        >
                                          {comp.isSealed ? '🔒 Sealed' : '🔓 Open'}
                                        </Chip>
                                        {comp.isSealed && (
                                          <Input
                                            label="Seal #"
                                            size="sm"
                                            className="flex-1"
                                            value={comp.sealNumber || ''}
                                            onValueChange={(v) => {
                                              const comps = [...(editingPack.compartments || [])];
                                              comps[origIndex] = { ...comps[origIndex], sealNumber: v };
                                              setEditingPack({ ...editingPack, compartments: comps });
                                            }}
                                          />
                                        )}
                                      </div>
                                    </div>
                                    <Button
                                      size="sm"
                                      variant="light"
                                      isIconOnly
                                      onPress={() => {
                                        const comps = [...(editingPack.compartments || [])];
                                        comps.splice(origIndex, 1);
                                        setEditingPack({ ...editingPack, compartments: comps });
                                      }}
                                    >
                                      <X size={16} />
                                    </Button>
                                  </div>
                                  
                                  <Divider />
                                  
                                  <div className="text-xs text-gray-500 font-medium">Items in this compartment:</div>
                                  {((comp as any).items || []).length === 0 && (
                                    <p className="text-xs text-gray-500 italic">No items assigned yet.</p>
                                  )}
                                  {((comp as any).items || []).map((it: any, ii: number) => (
                                    <div key={it.id || it.itemId || ii} className="flex items-center gap-2 p-2 bg-white dark:bg-slate-700 rounded text-xs">
                                      <Input
                                        label="Item"
                                        size="sm"
                                        value={(it as any).name ?? it.itemDetails?.name ?? it.itemId ?? ''}
                                        onValueChange={(v) => {
                                          const comps = [...(editingPack.compartments || [])];
                                          const items = [...((comps[origIndex] as any).items || [])];
                                          items[ii] = { ...items[ii], name: v };
                                          comps[origIndex] = { ...comps[origIndex], items } as any;
                                          setEditingPack({ ...editingPack, compartments: comps });
                                        }}
                                      />
                                      <Input
                                        label="Qty"
                                        size="sm"
                                        className="w-20"
                                        value={String((it as any).qty ?? (it as any).currentQuantity ?? 1)}
                                        onValueChange={(v) => {
                                          const comps = [...(editingPack.compartments || [])];
                                          const items = [...((comps[origIndex] as any).items || [])];
                                          items[ii] = { ...items[ii], qty: Number(v), currentQuantity: Number(v) };
                                          comps[origIndex] = { ...comps[origIndex], items } as any;
                                          setEditingPack({ ...editingPack, compartments: comps });
                                        }}
                                      />
                                      <Button
                                        size="sm"
                                        variant="light"
                                        isIconOnly
                                        onPress={() => {
                                          const comps = [...(editingPack.compartments || [])];
                                          const items = [...((comps[origIndex] as any).items || [])];
                                          items.splice(ii, 1);
                                          comps[origIndex] = { ...comps[origIndex], items } as any;
                                          setEditingPack({ ...editingPack, compartments: comps });
                                        }}
                                      >
                                        <X size={14} />
                                      </Button>
                                    </div>
                                  ))}
                                  <Button
                                    size="sm"
                                    variant="flat"
                                    onPress={() => {
                                      const comps = [...(editingPack.compartments || [])];
                                      const items = (comps[origIndex] as any).items ? [...(comps[origIndex] as any).items] : [];
                                      items.push({ id: `it_${Date.now()}`, name: 'New Item', qty: 1 });
                                      comps[origIndex] = { ...comps[origIndex], items } as any;
                                      setEditingPack({ ...editingPack, compartments: comps });
                                    }}
                                  >
                                    + Add Item
                                  </Button>
                                </CardBody>
                              </Card>
                            );
                          })}
                        </div>
                      </CardBody>
                    </Card>
                  )}
                </div>
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button
              variant="light"
              onPress={() => {
                statpackDisclosure.onClose();
                setEditingPack(null);
              }}
            >
              Cancel
            </Button>
            <Button
              color="primary"
              onPress={async () => {
                if (!editingPack) return;
                try {
                  await updateDoc(doc(db, 'statpacks', editingPack.id as string), {
                    ...editingPack,
                    updatedAt: serverTimestamp(),
                  });
                  statpackDisclosure.onClose();
                  setEditingPack(null);
                } catch (err) {
                  console.error('Failed to save statpack:', err);
                  alert('Failed to save statpack');
                }
              }}
            >
              Save Changes
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* Asset Add/Edit Modal */}
      <AssetModal
        isOpen={assetModalDisclosure.isOpen}
        onOpenChange={assetModalDisclosure.onOpenChange}
        initial={editingAsset}
        onAdd={async (payload) => {
          try {
            const ref = await addDoc(collection(db, 'inventory'), {
              ...payload,
              isAsset: true,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
            const assignedToId = (payload as any)?.assignedToId;
            if (assignedToId) {
              await updateAssetAssignment({
                itemId: ref.id,
                newAssignedToId: assignedToId,
                user: {
                  id: user?.uid ?? 'system',
                  fullName: user?.displayName || user?.email || 'System',
                },
                note: 'Assigned on asset creation',
              });
            }
          } catch (err) {
            console.error('Failed to add asset:', err);
            alert('Failed to add asset');
          }
        }}
        onUpdate={async (id, payload) => {
          try {
            const assignedToId = (payload as any)?.assignedToId;
            const prevAssignedToId = (editingAsset as any)?.assignedToId;
            const assignedChanged = assignedToId !== prevAssignedToId;
            const { assignedToId: _omit, ...rest } = payload as any;

            await updateDoc(doc(db, 'inventory', id), { ...rest, updatedAt: serverTimestamp() });

            if (assignedChanged) {
              await updateAssetAssignment({
                itemId: id,
                newAssignedToId: assignedToId ?? null,
                user: {
                  id: user?.uid ?? 'system',
                  fullName: user?.displayName || user?.email || 'System',
                },
                note: 'Updated via asset editor',
              });
            }
          } catch (err) {
            console.error('Failed to update asset:', err);
            alert('Failed to update asset');
          }
        }}
      />

      {/* Statpack Audit Pocket Selection */}
      <Modal isOpen={auditPocketDisclosure.isOpen} onOpenChange={auditPocketDisclosure.onOpenChange} backdrop="blur" size="lg" placement="center">
        <ModalContent>
          <ModalHeader>Choose Pocket to Audit</ModalHeader>
          <ModalBody className="gap-4 max-h-[70vh] overflow-y-auto">
            {auditStatpack ? (
              <div className="space-y-3">
                <Card className="bg-default-100">
                  <CardBody>
                    <p className="font-semibold">{auditStatpack.name}</p>
                    <p className="text-sm text-default-500">Audit pocket-by-pocket to verify expirations and O2.</p>
                  </CardBody>
                </Card>

                <div className="flex flex-col gap-3 py-1">
                  {auditPocketIds.length === 0 && (
                    <Card>
                      <CardBody className="text-center">
                        <p className="text-sm text-default-500">No pockets defined — audit the entire pack.</p>
                        <div className="mt-3">
                          <Button onPress={() => {
                            setAuditSelectedPocketId(null);
                            auditPocketDisclosure.onClose();
                            auditCheckoffDisclosure.onOpen();
                          }}>Audit Full Pack</Button>
                        </div>
                      </CardBody>
                    </Card>
                  )}
                  {[
                    { id: 'main', name: 'Center Pocket' },
                    { id: 'front_aux', name: 'Front Pocket' },
                    { id: 'side_left', name: 'Left Side Pocket' },
                    { id: 'side_right', name: 'Right Side Pocket' },
                  ].filter((p) => auditPocketIds.includes(p.id)).map((p) => {
                    const compForPocket = (auditStatpack.compartments || []).filter((c: any) => c.parentPocket === p.id);
                    const compItemsCount = compForPocket.flatMap((c: any) => (auditStatpack.contents || []).filter((i: any) => i.compartmentId === c.id)).length;
                    const looseCount = (auditStatpack.contents || []).filter((i: any) => i.pocket === p.id && !i.compartmentId).length;
                    const count = compItemsCount + looseCount;
                    const isDone = auditCompletedPockets.includes(p.id);

                    return (
                      <Card
                        key={p.id}
                        isPressable={!isDone}
                        onPress={() => {
                          if (isDone) return;
                          setAuditSelectedPocketId(p.id);
                          auditPocketDisclosure.onClose();
                          auditCheckoffDisclosure.onOpen();
                        }}
                        className={`w-full transition-shadow ${isDone ? 'border-2 border-green-400 bg-green-50 opacity-90' : 'hover:shadow-md'}`}
                      >
                        <CardBody className="flex flex-col items-center text-center gap-3 py-6">
                          <div className="space-y-1">
                            <p className="font-semibold text-base">{p.name}</p>
                            <p className="text-xs text-default-500">{count} items</p>
                          </div>
                          {isDone ? (
                            <div className="w-full flex justify-center">
                              <Chip size="sm" variant="flat" color="success">Completed</Chip>
                            </div>
                          ) : (
                            <div className="w-full px-4">
                              <div
                                role="button"
                                tabIndex={0}
                                className="w-full h-12 rounded-md bg-blue-600 text-white flex items-center justify-center"
                                aria-label={`Start audit for ${p.name}`}
                              >
                                Tap to start
                              </div>
                            </div>
                          )}
                        </CardBody>
                      </Card>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div>No statpack selected.</div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button color="default" onPress={() => { auditPocketDisclosure.onClose(); setAuditStatpack(null); }}>Cancel</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* Statpack Audit Check-Off (pocket-level) */}
      {auditStatpack && user && (
        <StatpackCheckOffModal
          isOpen={auditCheckoffDisclosure.isOpen}
          onOpenChange={auditCheckoffDisclosure.onOpenChange}
          statpack={buildPocketStatpack(auditStatpack, auditSelectedPocketId)}
          action="maintenance"
          userId={user.uid}
          userName={user.displayName || user.email || 'Unknown User'}
          onCheckOffComplete={() => {
            const newCompleted = auditSelectedPocketId ? [...auditCompletedPockets, auditSelectedPocketId] : [...auditCompletedPockets];
            setAuditCompletedPockets(newCompleted);
            setAuditSelectedPocketId(null);

            auditCheckoffDisclosure.onClose();
            if (newCompleted.length > 0 && newCompleted.length >= auditPocketIds.length) {
              setAuditStatpack(null);
              setAuditCompletedPockets([]);
              return;
            }
            setTimeout(() => auditPocketDisclosure.onOpen(), 250);
          }}
        />
      )}

      <AdminAuditModal
        isOpen={auditModalDisclosure.isOpen}
        onOpenChange={auditModalDisclosure.onOpenChange}
        auditType={auditType}
        targetAsset={auditType === 'asset' && auditTarget ? (auditTarget.data as InventoryItem) : undefined}
        targetStatpack={auditType === 'statpack' && auditTarget ? (auditTarget.data as Statpack) : undefined}
        userId={user?.uid || ''}
        userName={user?.displayName || user?.email || 'Unknown'}
        onAuditComplete={() => {
          setAuditTarget(null);
        }}
      />

      <BarcodeScanner
        isOpen={scannerOpen}
        onClose={() => {
          setScannerOpen(false);
          setScannerTargetAsset(null);
        }}
        onDetected={handleBarcodeDetected}
      />

      {/* Quick Assign Barcode Scanner */}
      <BarcodeScanner
        isOpen={showQuickAssignScanner}
        onClose={() => setShowQuickAssignScanner(false)}
        onDetected={handleQuickScanDetected}
      />

      {/* Quick Assign Result/Duplicate Warning Modal */}
      <Modal
        isOpen={!!scannedBarcodeQuick && !showQuickAssignScanner}
        onOpenChange={(open) => {
          if (!open) {
            setScannedBarcodeQuick('');
            setQuickAssignAsset(null);
            setDuplicateWarningQuick(null);
          }
        }}
        size="md"
      >
        <ModalContent>
          <ModalHeader>Assign Barcode Tag</ModalHeader>
          <ModalBody>
            {quickAssignAsset && (
              <div className="space-y-3">
                <div className="bg-blue-50 border border-blue-200 rounded p-3">
                  <p className="text-sm font-medium text-blue-900">Asset: {quickAssignAsset.name}</p>
                  <p className="text-sm text-blue-700 mt-1">Scanned: <span className="font-mono">{scannedBarcodeQuick}</span></p>
                </div>

                {duplicateWarningQuick?.show && (
                  <div className="bg-yellow-50 border border-yellow-300 rounded p-3">
                    <p className="text-sm font-semibold text-yellow-900 mb-1">⚠️ Duplicate Barcode</p>
                    <p className="text-sm text-yellow-800 mb-2">
                      This barcode is already assigned to{' '}
                      <strong>{duplicateWarningQuick.duplicateItem?.name}</strong>
                      {duplicateWarningQuick.duplicateItem?.serial && (
                        <span> (Serial: {duplicateWarningQuick.duplicateItem.serial})</span>
                      )}
                    </p>
                  </div>
                )}
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            {duplicateWarningQuick?.show ? (
              <>
                <Button variant="light" onPress={handleQuickCancelDuplicate}>
                  Cancel
                </Button>
                <Button
                  color="warning"
                  onPress={handleQuickDuplicateOverride}
                  isLoading={assigningBarcodeQuick}
                >
                  Assign Anyway
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="light"
                  onPress={() => {
                    setScannedBarcodeQuick('');
                    setQuickAssignAsset(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  color="primary"
                  onPress={() => handleQuickAssign(false)}
                  isLoading={assigningBarcodeQuick}
                >
                  Assign to Asset
                </Button>
              </>
            )}
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}

