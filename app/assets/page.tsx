'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useEffect, useMemo, useState, useRef } from 'react';
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
  Tabs,
  Tab,
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem,
  Tooltip,
  Checkbox,
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
import { recordAuditEvent, removeUndefined } from '@/app/lib/audit';
import { deleteDoc } from 'firebase/firestore';
import { getDoc } from 'firebase/firestore';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { auth, db } from '@/firebase';
import type { Statpack, InventoryItem, User, StatpackPocket, StatpackCompartment } from '@/app/types';
import StatpackCheckOffModal from '@/app/components/statpack-checkoff-modal';
import StatpackHistory from '@/app/components/statpack-history';
import StatpackEditorModal from '@/app/components/statpack-editor-modal';
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
  ShieldCheck,
  Lock,
  Unlock,
  ScanBarcode,
  MoreVertical,
  Trash,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Search,
} from 'lucide-react';
import AssetModal from '@/app/components/assetmodal';
import BarcodeScanner from '@/app/components/barcode-scanner';
import AssetHistory from '@/app/components/asset-history';
import AdminAuditModal from '@/app/components/admin-audit-modal';
import AssetAttachModal from '@/app/components/asset-attach-modal';
import AssetStatpackBadge from '@/app/components/asset-statpack-badge';
import AssetCheckoutModal from '@/app/components/asset-checkout-modal';

  
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
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedAssetId, setExpandedAssetId] = useState<string | null>(null);
  // Statpack editor state (admin-only)
  const statpackDisclosure = useDisclosure();
  const [editingPack, setEditingPack] = useState<Statpack | null>(null);
  const [editorSelectedPocket, setEditorSelectedPocket] = useState<StatpackPocket | 'all'>('all');
  const assetModalDisclosure = useDisclosure();
  const [editingAsset, setEditingAsset] = useState<any | null>(null);
  // Deletion state for assets/statpacks (admin only)
  const [deletingAsset, setDeletingAsset] = useState<AssetRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Admin audit modal state
  const auditModalDisclosure = useDisclosure();
  const [auditType, setAuditType] = useState<'asset' | 'statpack'>('asset');
  const [auditTarget, setAuditTarget] = useState<AssetRecord | null>(null);
  const auditPocketDisclosure = useDisclosure();
  const auditCheckoffDisclosure = useDisclosure();
  const [auditStatpack, setAuditStatpack] = useState<Statpack | null>(null);
  const [auditSelectedPocketId, setAuditSelectedPocketId] = useState<string | null>(null);
  const [auditCompletedPockets, setAuditCompletedPockets] = useState<string[]>([]);
  const assetAttachDisclosure = useDisclosure();

    const handleAssetAttachedToLoose = (assetId: string, serial?: string, displayName?: string) => {
      if (!editingPack) return;
      const newItem = {
        id: `asset_${assetId}_${Date.now()}`,
        name: displayName || (serial ? `Asset ${serial}` : 'Attached Asset'),
        qty: 1,
        pocket: editorSelectedPocket,
        assetInstanceId: assetId,
        serialNumber: serial,
      } as any;
      const contents = [...(editingPack.contents || []), newItem];
      setEditingPack({ ...editingPack, contents });
      assetAttachDisclosure.onClose();
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

  const openAssetPolicyEditor = async (assetId: string) => {
    try {
      const snap = await getDoc(doc(db, 'inventory', assetId));
      if (!snap.exists()) {
        alert('Asset not found');
        return;
      }
      const data = snap.data();
      setEditingAsset({ id: snap.id, ...(data as any) });
      assetModalDisclosure.onOpen();
    } catch (err) {
      console.error('Failed to load asset:', err);
      alert('Failed to load asset');
    }
  };

  const openStatpackAudit = (asset: AssetRecord) => {
    const pack = asset.data as Statpack;
    setAuditStatpack(JSON.parse(JSON.stringify(pack)) as Statpack);
    setAuditSelectedPocketId(null);
    setAuditCompletedPockets([]);
    auditPocketDisclosure.onOpen();
  };
  const statpackBodyRef = useRef<HTMLDivElement | null>(null);

  // When opening the statpack editor modal, ensure the internal scroll resets to top
  useEffect(() => {
    if (statpackDisclosure.isOpen) {
      // allow layout to settle
      setTimeout(() => {
        if (statpackBodyRef.current) statpackBodyRef.current.scrollTop = 0;
      }, 50);
    }
  }, [statpackDisclosure.isOpen]);
  
  const openStatpackEditorModal = (asset: AssetRecord) => {
    if (!asset || asset.type !== 'statpack') return;
    const pack = JSON.parse(JSON.stringify(asset.data)) as Statpack;
    // preserve the Firestore document id so saving updates the existing statpack
    const packWithId = { ...pack, id: asset.id } as Statpack;
    setEditingPack(packWithId);
    setEditorSelectedPocket('all');
    statpackDisclosure.onOpen();
  };

  // Statpack check-out / check-in route into the shared pocket-by-pocket flow.
  const openStatpackCheckout = (asset: AssetRecord) => {
    if (asset.id) router.push(`/statpacks/check-off?id=${asset.id}&mode=checkout`);
  };
  const openStatpackCheckin = (asset: AssetRecord) => {
    if (asset.id) router.push(`/statpacks/check-off?id=${asset.id}&mode=checkin`);
  };

  // Persist an edited statpack draft coming from StatpackEditorModal.
  const saveStatpackDraft = async (draft: Statpack) => {
    try {
      await updateDoc(doc(db, 'statpacks', String(draft.id)), {
        ...draft,
        updatedAt: serverTimestamp(),
      });
      statpackDisclosure.onClose();
      setEditingPack(null);
    } catch (err) {
      console.error('Failed to save statpack:', err);
      alert('Failed to save statpack');
    }
  };
  const deleteStatpackFromEditor = async () => {
    if (!editingPack?.id) return;
    if (!confirm(`Delete statpack "${editingPack.name}"? This cannot be undone.`)) return;
    try {
      await deleteDoc(doc(db, 'statpacks', String(editingPack.id)));
      statpackDisclosure.onClose();
      setEditingPack(null);
    } catch (err) {
      console.error('Failed to delete statpack:', err);
      alert('Failed to delete statpack');
    }
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

  // Asset checkout/checkin state
  const checkoutModalDisclosure = useDisclosure();
  const [selectedCheckoutAsset, setSelectedCheckoutAsset] = useState<InventoryItem | null>(null);
  const [checkoutMode, setCheckoutMode] = useState<'checkout' | 'checkin'>('checkout');
  const [checkoutScannerOpen, setCheckoutScannerOpen] = useState(false);

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

  // Handle checkout scanner - search for asset and open checkout modal
  const handleCheckoutScan = async (barcode: string) => {
    setCheckoutScannerOpen(false);
    
    // Search for asset by barcode, qr, or serial
    const foundAsset = assets.find((a) => {
      if (a.type !== 'inventory') return false;
      const item = a.data as InventoryItem;
      return item.qr === barcode || 
             item.barcode === barcode || 
             item.assetSerial === barcode;
    });

    if (!foundAsset) {
      alert(`No asset found with barcode: ${barcode}`);
      return;
    }

    const item = foundAsset.data as InventoryItem;
    setSelectedCheckoutAsset(item);
    
    // Determine mode based on current status
    if (item.checkedOutBy) {
      setCheckoutMode('checkin');
    } else {
      setCheckoutMode('checkout');
    }
    
    checkoutModalDisclosure.onOpen();
  };

  // Helper to open checkout modal
  const openCheckout = (asset: AssetRecord) => {
    if (asset.type !== 'inventory') return;
    const item = asset.data as InventoryItem;
    setSelectedCheckoutAsset(item);
    setCheckoutMode('checkout');
    checkoutModalDisclosure.onOpen();
  };

  // Helper to open checkin modal
  const openCheckin = (asset: AssetRecord) => {
    if (asset.type !== 'inventory') return;
    const item = asset.data as InventoryItem;
    setSelectedCheckoutAsset(item);
    setCheckoutMode('checkin');
    checkoutModalDisclosure.onOpen();
  };

  // Handle checkout completion - refresh assets list
  const handleCheckoutComplete = () => {
    // Assets list will refresh automatically via onSnapshot
    checkoutModalDisclosure.onClose();
    setSelectedCheckoutAsset(null);
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
        const payload: any = {
          name: nameValue,
          status: statusValue as Statpack['status'],
          currentLocation: locationValue,
          assetValue: parsedValue,
          updatedAt: serverTimestamp(),
        };
        if (payload.assetValue === undefined) delete payload.assetValue;
        await updateDoc(doc(db, 'statpacks', selectedAsset.id), payload);
      } else {
        const payload: any = {
          name: nameValue,
          assetStatus: inventoryStatus,
          currentLocation: locationValue,
          assetValue: parsedValue,
          updatedAt: serverTimestamp(),
        };
        if (payload.assetValue === undefined) delete payload.assetValue;
        await updateDoc(doc(db, 'inventory', selectedAsset.id), payload);
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

  

  const formatTimestampForTable = (ts?: any) => {
    if (!ts) return '';
    let d: Date;
    if (typeof ts === 'object' && typeof ts.toDate === 'function') d = ts.toDate();
    else if (ts instanceof Date) d = ts;
    else d = new Date(ts);
    return d.toLocaleString('en-US', {
      month: 'short',
      day: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  };

  const getMaintenanceColor = (status?: string) => {
    if (!status) return 'default';
    if (status === 'in-progress') return 'warning';
    if (status === 'completed') return 'success';
    if (status === 'pending') return 'secondary';
    return 'default';
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

  // Category filter state
  const [categoryFilter, setCategoryFilter] = useState<string>('all');

  // Compute category for an asset
  const getAssetCategory = (asset: AssetRecord): string => {
    if (asset.type === 'statpack') return 'Statpack';
    const item = asset.data as InventoryItem;
    return (item.assetCategory as string) || item.category || 'Uncategorized';
  };

  // Get unique categories and their counts
  const categoryStats = useMemo(() => {
    const map = new Map<string, number>();
    assets.forEach((a) => {
      const cat = getAssetCategory(a);
      map.set(cat, (map.get(cat) || 0) + 1);
    });
    // Sort: Statpack first, then alphabetical
    return Array.from(map.entries()).sort(([a], [b]) => {
      if (a === 'Statpack') return -1;
      if (b === 'Statpack') return 1;
      return a.localeCompare(b);
    });
  }, [assets]);

  // Filter then group by category
  const groupedAssets = useMemo(() => {
    const lowerSearch = searchTerm.toLowerCase();
    const filtered = assets.filter((a) => {
      if (categoryFilter !== 'all' && getAssetCategory(a) !== categoryFilter) return false;
      if (lowerSearch) {
        const name = ((a.data as any).name || (a.data as any).packId || '').toLowerCase();
        const status = (a.status || '').toLowerCase();
        const location = ((a.data as any).location || '').toLowerCase();
        if (!name.includes(lowerSearch) && !status.includes(lowerSearch) && !location.includes(lowerSearch)) return false;
      }
      return true;
    });

    const groups = new Map<string, AssetRecord[]>();
    filtered.forEach((a) => {
      const cat = getAssetCategory(a);
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(a);
    });

    // Sort groups: Statpack first, then alphabetical
    return Array.from(groups.entries()).sort(([a], [b]) => {
      if (a === 'Statpack') return -1;
      if (b === 'Statpack') return 1;
      return a.localeCompare(b);
    });
  }, [assets, categoryFilter, searchTerm]);

  if (loading) return <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center"><Spinner size="lg" color="primary" /></div>;

  // Restrict access: general members should not access the Asset Management UI
  if (!loading && userRole === 'member') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-6">
        <div className="max-w-3xl mx-auto">
          <Card>
            <CardBody className="text-center">
              <h2 className="text-xl font-semibold">Access Denied</h2>
              <p className="mt-2 text-sm text-foreground-500">You do not have permission to view the Asset Management area.</p>
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
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-3 md:p-6">
      <div className="max-w-7xl mx-auto space-y-4 md:space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
              <Package className="text-primary" size={24} />
              Asset Management
            </h1>
            <p className="text-xs md:text-sm text-foreground-500">Manage statpacks, O2 tanks, AEDs, bikes, radios, and other valuable equipment</p>
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
            <Button
              color="primary"
              variant="flat"
              startContent={<ScanBarcode size={16} />}
              onPress={() => setCheckoutScannerOpen(true)}
            >
              Scan to Checkout
            </Button>
            {userRole === 'admin' && (
              <Button onPress={() => { setEditingAsset(null); assetModalDisclosure.onOpen(); }}>Add Asset</Button>
            )}
          </div>
        </div>
        <Divider />

        {/* Category Filter */}
        <div className="flex gap-2 flex-wrap">
          <Chip
            variant={categoryFilter === 'all' ? 'solid' : 'flat'}
            color={categoryFilter === 'all' ? 'primary' : 'default'}
            className="cursor-pointer"
            onClick={() => setCategoryFilter('all')}
          >
            All ({assets.length})
          </Chip>
          {categoryStats.map(([cat, count]) => (
            <Chip
              key={cat}
              variant={categoryFilter === cat ? 'solid' : 'flat'}
              color={categoryFilter === cat ? 'primary' : 'default'}
              className="cursor-pointer"
              onClick={() => setCategoryFilter(cat)}
            >
              {cat} ({count})
            </Chip>
          ))}
        </div>

        {/* Search */}
        <Input
          placeholder="Search assets by name, status, or location..."
          value={searchTerm}
          onValueChange={setSearchTerm}
          startContent={<Search size={16} className="text-foreground-400" />}
          isClearable
          onClear={() => setSearchTerm('')}
          classNames={{ inputWrapper: 'bg-content1' }}
        />

        {/* Assets List */}
        {groupedAssets.length === 0 ? (
          <p className="text-sm text-foreground-500 text-center py-8">No assets found</p>
        ) : (
          <div className="space-y-4">
            {groupedAssets.map(([category, groupAssets]) => (
              <div key={category}>
                {(categoryFilter === 'all' && groupedAssets.length > 1) && (
                  <p className="text-xs font-semibold uppercase tracking-wider text-foreground-400 mb-2 px-1">
                    {category} ({groupAssets.length})
                  </p>
                )}
                <div className="divide-y divide-divider border border-divider rounded-xl overflow-hidden">
                  {groupAssets.map((asset) => {
                    const activeMaintenance = getMaintenanceStatus(asset);
                    const isExpanded = expandedAssetId === asset.id;
                    return (
                      <div key={asset.id} className="bg-content1">
                        <div
                          className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-content2 transition-colors"
                          onClick={() => setExpandedAssetId(isExpanded ? null : asset.id)}
                        >
                          {userRole === 'admin' && (
                            <Checkbox
                              size="sm"
                              isSelected={selectedForPrint.has(asset.id)}
                              onValueChange={(checked) => {
                                const newSelected = new Set(selectedForPrint);
                                if (checked) { newSelected.add(asset.id); } else { newSelected.delete(asset.id); }
                                setSelectedForPrint(newSelected);
                              }}
                              onClick={(e: React.MouseEvent) => e.stopPropagation()}
                            />
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-semibold text-sm truncate">{asset.name}</span>
                              <Chip size="sm" color={getStatusColor(asset.status)} variant="flat">
                                {asset.status}
                              </Chip>
                              {asset.type === 'inventory' && (asset.data as InventoryItem).statpackAssignment && (
                                <AssetStatpackBadge
                                  assignment={(asset.data as InventoryItem).statpackAssignment as any}
                                  size="sm"
                                />
                              )}
                            </div>
                            <div className="flex items-center gap-1 mt-1 text-xs text-foreground-400">
                              <MapPin size={12} className="text-foreground-400" />
                              <span>{asset.currentLocation || 'No location'}</span>
                              <span className="mx-1">·</span>
                              <Chip size="sm" variant="flat" className="text-xs">
                                {asset.type === 'statpack' ? 'Statpack' : (asset.data as InventoryItem).category || 'Item'}
                              </Chip>
                              {asset.assetValue && (
                                <>
                                  <span className="mx-1">·</span>
                                  <span className="tabular-nums">${asset.assetValue.toFixed(2)}</span>
                                </>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <Tooltip content="View details">
                              <Button
                                isIconOnly
                                size="sm"
                                variant="light"
                                onPress={() => { setSelectedRowId(asset.id); setSelectedAsset(asset); setIsEditingDetails(false); detailsDisclosure.onOpen(); }}
                              >
                                <Eye size={16} />
                              </Button>
                            </Tooltip>
                            <Dropdown>
                              <DropdownTrigger>
                                <Button isIconOnly size="sm" variant="light">
                                  <MoreVertical size={16} />
                                </Button>
                              </DropdownTrigger>
                              <DropdownMenu aria-label="Asset actions">
                                <DropdownItem key="scan" startContent={<MapPin size={14} />} onPress={() => openScannerForAsset(asset)}>
                                  Scan Location
                                </DropdownItem>
                                {asset.type === 'inventory' && asset.status === 'Ready' ? (
                                  <DropdownItem key="checkout" startContent={<Package size={14} />} onPress={() => openCheckout(asset)}>
                                    Check Out
                                  </DropdownItem>
                                ) : asset.type === 'inventory' && (asset.data as InventoryItem).checkedOutBy ? (
                                  <DropdownItem key="checkin" startContent={<CheckCircle size={14} />} color="success" onPress={() => openCheckin(asset)}>
                                    Check In
                                  </DropdownItem>
                                ) : null}
                                {asset.type === 'statpack' ? (
                                  (asset.data as Statpack).isCheckedOut ? (
                                    <DropdownItem key="sp-checkin" startContent={<CheckCircle size={14} />} color="success" onPress={() => openStatpackCheckin(asset)}>
                                      Check In
                                    </DropdownItem>
                                  ) : (
                                    <DropdownItem key="sp-checkout" startContent={<Package size={14} />} onPress={() => openStatpackCheckout(asset)}>
                                      Check Out
                                    </DropdownItem>
                                  )
                                ) : (
                                  <DropdownItem key="noop-sp" className="hidden">.</DropdownItem>
                                )}
                                {asset.type === 'statpack' ? (
                                  <DropdownItem key="edit" startContent={<Pencil size={14} />} onPress={() => openStatpackEditorModal(asset)}>
                                    Edit Statpack
                                  </DropdownItem>
                                ) : userRole === 'admin' ? (
                                  <DropdownItem key="edit" startContent={<Pencil size={14} />} onPress={() => { setEditingAsset({ ...(asset.data as any), id: asset.id }); assetModalDisclosure.onOpen(); }}>
                                    Edit Asset
                                  </DropdownItem>
                                ) : (
                                  <DropdownItem key="noop" className="hidden">.</DropdownItem>
                                )}
                                {userRole === 'admin' ? (
                                  activeMaintenance ? (
                                    <DropdownItem key="maint" startContent={<CheckCircle size={14} />} color="success" onPress={() => handleCompleteMaintenance(asset, activeMaintenance.id)}>
                                      Complete Maintenance
                                    </DropdownItem>
                                  ) : (
                                    <DropdownItem key="maint" startContent={<Wrench size={14} />} onPress={() => handleStartMaintenance(asset)}>
                                      Start Maintenance
                                    </DropdownItem>
                                  )
                                ) : (
                                  <DropdownItem key="noop2" className="hidden">.</DropdownItem>
                                )}
                                {asset.type === 'inventory' && (userRole === 'admin' || userRole === 'quartermaster' || userRole === 'inventory_helper') ? (
                                  <DropdownItem key="barcode" startContent={<ScanBarcode size={14} />} onPress={() => handleQuickAssignBarcode(asset)}>
                                    Assign Barcode Tag
                                  </DropdownItem>
                                ) : (
                                  <DropdownItem key="noop3" className="hidden">.</DropdownItem>
                                )}
                                {userRole === 'admin' ? (
                                  <DropdownItem key="audit" startContent={<ShieldCheck size={14} />} onPress={() => {
                                    if (asset.type === 'statpack') { openStatpackAudit(asset); return; }
                                    setAuditTarget(asset); setAuditType('asset'); auditModalDisclosure.onOpen();
                                  }}>
                                    Run Audit
                                  </DropdownItem>
                                ) : (
                                  <DropdownItem key="noop4" className="hidden">.</DropdownItem>
                                )}
                                {userRole === 'admin' ? (
                                  <DropdownItem key="delete" startContent={<Trash size={14} />} onPress={() => setDeletingAsset(asset)}>
                                    Delete
                                  </DropdownItem>
                                ) : (
                                  <DropdownItem key="noop5" className="hidden">.</DropdownItem>
                                )}
                              </DropdownMenu>
                            </Dropdown>
                            <button
                              className="p-1 text-foreground-400 transition-colors"
                              onClick={(e) => { e.stopPropagation(); setExpandedAssetId(isExpanded ? null : asset.id); }}
                            >
                              {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                            </button>
                          </div>
                        </div>
                        {isExpanded && (
                          <div className="px-4 py-3 bg-content2 border-t border-divider space-y-3">
                            <div className="flex flex-wrap gap-4 text-sm">
                              <div>
                                <p className="text-xs text-foreground-400 mb-1">Location</p>
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
                                  <div className="flex items-center gap-2">
                                    <span>{asset.currentLocation || '—'}</span>
                                    <Tooltip content="Edit location">
                                      <Button isIconOnly size="sm" variant="light" onPress={() => startLocationEdit(asset)}>
                                        <Pencil size={14} />
                                      </Button>
                                    </Tooltip>
                                  </div>
                                )}
                              </div>
                              {asset.assetValue && (
                                <div>
                                  <p className="text-xs text-foreground-400 mb-1">Value</p>
                                  <span className="tabular-nums">${asset.assetValue.toFixed(2)}</span>
                                </div>
                              )}
                              {activeMaintenance && (
                                <div>
                                  <p className="text-xs text-foreground-400 mb-1">Maintenance</p>
                                  <div className="flex items-center gap-2">
                                    <Chip size="sm" color={activeMaintenance.status === 'in-progress' ? 'warning' : 'secondary'} variant="flat">
                                      {activeMaintenance.status === 'in-progress' ? 'In Progress' : 'Pending'}
                                    </Chip>
                                    <span className="text-xs font-semibold">{activeMaintenance.serviceType}</span>
                                    {activeMaintenance.reason && (
                                      <span className="text-xs text-foreground-500">{activeMaintenance.reason}</span>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
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

      {/* Delete Confirmation Modal */}
      <Modal isOpen={!!deletingAsset} onOpenChange={(open) => { if (!open) setDeletingAsset(null); }} size="sm">
        <ModalContent>
          <ModalHeader>Confirm Deletion</ModalHeader>
          <ModalBody>
            <p className="text-sm">Are you sure you want to delete <strong>{deletingAsset?.name}</strong>? This action cannot be undone.</p>
            <p className="text-xs text-default-500 mt-2">{deletingAsset?.type === 'statpack' ? 'Deleting a statpack will remove its configuration and contents references.' : 'Deleting an asset will remove it from inventory.'}</p>
          </ModalBody>
          <ModalFooter>
            <div className="flex gap-2">
              <Button variant="light" onPress={() => setDeletingAsset(null)}>Cancel</Button>
              <Button color="danger" isLoading={deleting} onPress={async () => {
                if (!deletingAsset) return;
                setDeleting(true);
                try {
                  if (deletingAsset.type === 'statpack') {
                    await deleteDoc(doc(db, 'statpacks', deletingAsset.id));
                    await recordAuditEvent({
                      eventType: 'delete_statpack',
                      source: 'statpacks',
                      sourceId: deletingAsset.id,
                      actor: {
                        userId: user?.uid ?? null,
                        userName: user?.displayName ?? null,
                      },
                      targets: [{ collection: 'statpacks', docId: deletingAsset.id }],
                      details: { name: deletingAsset.name },
                    });
                  } else {
                    await deleteDoc(doc(db, 'inventory', deletingAsset.id));
                    await recordAuditEvent({
                      eventType: 'delete_asset',
                      source: 'inventory',
                      sourceId: deletingAsset.id,
                      actor: {
                        userId: user?.uid ?? null,
                        userName: user?.displayName ?? null,
                      },
                      targets: [{ collection: 'inventory', docId: deletingAsset.id }],
                      details: { name: deletingAsset.name },
                    });
                  }
                  setAssets(prev => prev.filter(a => a.id !== deletingAsset.id));
                  setSelectedAsset(prev => prev && prev.id === deletingAsset.id ? null : prev);
                  setSelectedRowId(prev => prev === deletingAsset.id ? null : prev);
                  setDeletingAsset(null);
                } catch (e) {
                  console.error('Failed to delete:', e);
                  alert('Failed to delete item. See console for details.');
                } finally {
                  setDeleting(false);
                }
              }}>Delete</Button>
            </div>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* Details Modal */}
      <Modal isOpen={detailsDisclosure.isOpen} onOpenChange={detailsDisclosure.onOpenChange} size="2xl">
        <ModalContent className="max-h-[90vh]">
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
          <ModalBody className="space-y-4 overflow-y-auto max-h-[80vh]">
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
                  <p className="text-sm font-semibold text-foreground-500">Type</p>
                  <p className="text-sm">{selectedAsset?.type === 'statpack' ? 'Statpack' : 'Inventory Item'}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground-500">Status</p>
                  <Chip color={getStatusColor(selectedAsset?.status || '')} size="sm">
                    {selectedAsset?.status}
                  </Chip>
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground-500">Location</p>
                  <p className="text-sm">{selectedAsset?.currentLocation || 'Not specified'}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground-500">Asset Value</p>
                  <p className="text-sm">{selectedAsset?.assetValue ? `$${selectedAsset.assetValue.toFixed(2)}` : 'Not specified'}</p>
                </div>
                {selectedAsset?.type === 'inventory' && (selectedAsset.data as InventoryItem).statpackAssignment && (
                  <div className="col-span-2">
                    <p className="text-sm font-semibold text-foreground-500 mb-1">Assigned Statpack</p>
                    <AssetStatpackBadge
                      assignment={(selectedAsset.data as InventoryItem).statpackAssignment as any}
                    />
                  </div>
                )}
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
                        <div key={idx} className="p-2 border border-divider rounded-md bg-content2 text-sm">
                          <div className="flex justify-between items-start">
                            <div className="flex-1">
                              <p className="font-medium">{item.itemDetails?.name || item.itemId}</p>
                              <p className="text-xs text-foreground-500">
                                Qty: <span className="tabular-nums">{item.currentQuantity}/{item.requiredQuantity}</span>
                                {item.serialNumber && ` • Serial: ${item.serialNumber}`}
                                {item.lotNumber && ` • Lot: ${item.lotNumber}`}
                              </p>
                              {item.expirationDate && (
                                <p className="text-xs text-foreground-500">
                                  Exp: {item.expirationDate instanceof Date ? item.expirationDate.toLocaleDateString() : new Date(item.expirationDate).toLocaleDateString()}
                                </p>
                              )}
                            </div>
                            {item.itemValue && (
                              <p className="text-xs font-semibold tabular-nums">
                                ${(item.itemValue * item.currentQuantity).toFixed(2)}
                              </p>
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
              </>
            )}

            {/* Tabbed Activity and Maintenance sections */}
            <div>
              <Tabs 
                aria-label="Asset details tabs" 
                color="primary"
                variant="underlined"
                classNames={{
                  tabList: "gap-6 w-full relative rounded-none p-0 border-b border-divider",
                  cursor: "w-full bg-primary",
                  tab: "max-w-fit px-0 h-12",
                  tabContent: "group-data-[selected=true]:text-primary"
                }}
              >
                <Tab
                  key="activity"
                  title={
                    <div className="flex items-center gap-2">
                      <Clock size={16} />
                      <span>Activity</span>
                    </div>
                  }
                >
                  <div className="pt-4">
                    {selectedAsset?.id && (
                      <div>
                        {selectedAsset.type === 'statpack' ? (
                          <StatpackHistory statpackId={selectedAsset.id} maxRows={12} />
                        ) : (
                          <AssetHistory assetId={selectedAsset.id} maxRows={10} />
                        )}
                      </div>
                    )}
                  </div>
                </Tab>
                <Tab
                  key="maintenance"
                  title={
                    <div className="flex items-center gap-2">
                      <Wrench size={16} />
                      <span>Maintenance</span>
                    </div>
                  }
                >
                  <div className="pt-4">
                    {selectedAsset?.maintenance_logs && selectedAsset.maintenance_logs.length > 0 ? (
                      (() => {
                        const logs = (selectedAsset.maintenance_logs || []).map((l: any) => ({
                          ...l,
                          _ts: typeof l.timestamp === 'object' && typeof l.timestamp.toDate === 'function' ? l.timestamp.toDate() : l.timestamp instanceof Date ? l.timestamp : new Date(l.timestamp),
                        })).sort((a: any, b: any) => (b._ts?.getTime?.() || 0) - (a._ts?.getTime?.() || 0));

                        return (
                          <Card>
                            <CardHeader className="flex justify-between items-center bg-default-50 px-4 py-3 border-b border-default-200">
                              <h3 className="text-sm font-semibold">Maintenance History ({logs.length})</h3>
                            </CardHeader>
                            <CardBody className="p-0">
                              <Table hideHeader removeWrapper>
                                <TableHeader>
                                  <TableColumn>Action</TableColumn>
                                  <TableColumn>Technician</TableColumn>
                                  <TableColumn>Timestamp</TableColumn>
                                  <TableColumn>Status</TableColumn>
                                  <TableColumn>Notes</TableColumn>
                                </TableHeader>
                                <TableBody>
                                  {logs.map((log: any, idx: number) => (
                                    <TableRow key={log.id || idx} className={idx === 0 ? 'bg-content2' : ''}>
                                      <TableCell>
                                        <Chip size="sm" variant="solid" color={getMaintenanceColor(log.status)} className="capitalize">
                                          {log.serviceType}
                                        </Chip>
                                      </TableCell>
                                      <TableCell className="text-sm">{log.technician || 'Unknown'}</TableCell>
                                      <TableCell className="text-xs text-default-600 dark:text-default-300 whitespace-nowrap">{formatTimestampForTable(log._ts)}</TableCell>
                                      <TableCell>
                                        <Chip size="sm" variant="flat" color={getMaintenanceColor(log.status)}>
                                          {String(log.status || '').replace('-', ' ')}
                                        </Chip>
                                      </TableCell>
                                      <TableCell className="text-xs text-default-600 dark:text-default-300 max-w-xs">{log.notes || '—'}</TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </CardBody>
                          </Card>
                        );
                      })()
                    ) : (
                      <Card>
                        <CardBody>
                          <p className="text-foreground-500 text-sm text-center py-4">No maintenance records</p>
                        </CardBody>
                      </Card>
                    )}
                  </div>
                </Tab>
              </Tabs>
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

      {/* Statpack Editor Modal (admin) — full-featured editor */}
      <StatpackEditorModal
        pack={editingPack}
        isOpen={statpackDisclosure.isOpen}
        onClose={() => { statpackDisclosure.onClose(); setEditingPack(null); }}
        onSave={saveStatpackDraft}
        onDelete={deleteStatpackFromEditor}
        canDelete={userRole === 'admin'}
      />

      <AssetAttachModal
        isOpen={assetAttachDisclosure.isOpen}
        onOpenChange={assetAttachDisclosure.onOpenChange}
        onAttach={handleAssetAttachedToLoose}
        currentItemName={''}
      />

      {/* Asset Add/Edit Modal */}
      <AssetModal
        isOpen={assetModalDisclosure.isOpen}
        onOpenChange={assetModalDisclosure.onOpenChange}
        initial={editingAsset}
        onAdd={async (payload) => {
          try {
            const ref = await addDoc(collection(db, 'inventory'), removeUndefined({
              ...payload,
              isAsset: true,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            }));
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
            const rest = { ...(payload as any) };
            delete rest.assignedToId;

            await updateDoc(doc(db, 'inventory', id), removeUndefined({ ...rest, updatedAt: serverTimestamp() }));

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
                        className={`w-full transition-shadow ${isDone ? 'border-2 border-success bg-success-50 opacity-90' : 'hover:shadow-md'}`}
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
                                className="w-full h-12 rounded-md bg-primary text-primary-foreground flex items-center justify-center"
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

      {/* Checkout Barcode Scanner */}
      <BarcodeScanner
        isOpen={checkoutScannerOpen}
        onClose={() => setCheckoutScannerOpen(false)}
        onDetected={handleCheckoutScan}
      />

      {/* Quick Assign Barcode Scanner */}
      <BarcodeScanner
        isOpen={showQuickAssignScanner}
        onClose={() => setShowQuickAssignScanner(false)}
        onDetected={handleQuickScanDetected}
      />

      {/* Asset Checkout/Checkin Modal */}
      {selectedCheckoutAsset && (
        <AssetCheckoutModal
          isOpen={checkoutModalDisclosure.isOpen}
          onOpenChange={checkoutModalDisclosure.onOpenChange}
          asset={selectedCheckoutAsset}
          mode={checkoutMode}
          userId={user?.uid || ''}
          userName={user?.displayName || user?.email || 'Unknown'}
          onComplete={handleCheckoutComplete}
        />
      )}

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
                <div className="bg-primary-50 border border-primary-200 rounded p-3">
                  <p className="text-sm font-medium text-primary">Asset: {quickAssignAsset.name}</p>
                  <p className="text-sm text-primary mt-1">Scanned: <span className="font-mono">{scannedBarcodeQuick}</span></p>
                </div>

                {duplicateWarningQuick?.show && (
                  <div className="bg-warning-50 border border-warning-200 rounded p-3">
                    <p className="text-sm font-semibold text-warning mb-1 flex items-center gap-1"><AlertTriangle size={14} /> Duplicate Barcode</p>
                    <p className="text-sm text-warning-700 mb-2">
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

