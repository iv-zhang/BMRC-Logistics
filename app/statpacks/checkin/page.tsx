'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card,
  CardBody,
  Button,
  Input,
  Divider,
  Spinner,
  Chip,
  useDisclosure,
  Avatar,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Tabs,
  Tab,
} from '@heroui/react';
import { Package, ScanLine, Search, LogIn, ArrowLeft, Radio, Monitor } from 'lucide-react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { collection, onSnapshot, query, where, orderBy, Timestamp, getDocs, documentId } from 'firebase/firestore';
import { auth, db } from '@/firebase';
import type { InventoryItem, Statpack, StatpackItem } from '@/app/types';
import StatpackCheckOffModal from '@/app/components/statpack-checkoff-modal';
import BarcodeScanner from '@/app/components/barcode-scanner';
import { logStatpackCheckOff, findAssetByCode } from '@/app/lib/inventory';
import CheckoutModal from '@/app/components/checkout-modal';

const chunkArray = <T,>(items: T[], size: number) => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

const fetchInventoryMap = async (itemIds: string[]) => {
  const map = new Map<string, InventoryItem>();
  const uniqueIds = Array.from(new Set(itemIds)).filter(Boolean);
  if (uniqueIds.length === 0) return map;

  const chunks = chunkArray(uniqueIds, 10);
  for (const chunk of chunks) {
    const q = query(collection(db, 'inventory'), where(documentId(), 'in', chunk));
    const snap = await getDocs(q);
    snap.forEach((docSnap) => {
      map.set(docSnap.id, { id: docSnap.id, ...docSnap.data() } as InventoryItem);
    });
  }
  return map;
};

export default function CheckinPage() {
  const router = useRouter();
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [statpacks, setStatpacks] = useState<Statpack[]>([]);
  const [filteredPacks, setFilteredPacks] = useState<Statpack[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  const [selectedPack, setSelectedPack] = useState<Statpack | null>(null);
  const checkoffDisclosure = useDisclosure();
  const scannerDisclosure = useDisclosure();
  const pocketDisclosure = useDisclosure();
  const [selectedPocketId, setSelectedPocketId] = useState<string | null>(null);
  const [completedPockets, setCompletedPockets] = useState<string[]>([]);

  // Collect check entries from all pockets before final logging
  const [allPocketCheckData, setAllPocketCheckData] = useState<Array<{
    checkEntries: Parameters<typeof logStatpackCheckOff>[0]['checkEntries'];
    sealChecks?: Record<string, { sealed: boolean; sealNumber?: string }>;
    oxygenReadings?: Record<string, string>;
    notes?: string;
  }>>([]); 

  // Error, review, and confirmation state
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showReview, setShowReview] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [quickConfirmPack, setQuickConfirmPack] = useState<Statpack | null>(null);

  // Asset check-in state
  const [activeTab, setActiveTab] = useState<string>('statpacks');
  const [assetItems, setAssetItems] = useState<InventoryItem[]>([]);
  const [assetSearchQuery, setAssetSearchQuery] = useState('');
  const [filteredAssetItems, setFilteredAssetItems] = useState<InventoryItem[]>([]);
  const [assetLoading, setAssetLoading] = useState(true);
  const assetScannerDisclosure = useDisclosure();
  const assetCheckinDisclosure = useDisclosure();
  const [selectedAsset, setSelectedAsset] = useState<InventoryItem | null>(null);
  const [selectedAssetSerial, setSelectedAssetSerial] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!user) return;
    
    setLoading(true);
    // Only show "In Use" statpacks for check-in
    const q = query(
      collection(db, 'statpacks'),
      where('status', '==', 'In Use'),
      orderBy('name')
    );
    
    const unsub = onSnapshot(
      q,
      (snap) => {
        (async () => {
          try {
            const packs: Statpack[] = snap.docs.map((d) => {
              const data = d.data();
              return {
                id: d.id,
                ...data,
                lastCheckedAt: data.lastCheckedAt instanceof Timestamp
                  ? data.lastCheckedAt.toDate()
                  : undefined,
                contents: Array.isArray(data.contents)
                  ? data.contents.map((item: StatpackItem & { expirationDate?: Timestamp | Date }) => ({
                      ...item,
                      expirationDate: item.expirationDate instanceof Timestamp
                        ? item.expirationDate.toDate()
                        : item.expirationDate,
                    }))
                  : [],
              } as Statpack;
            });

            // Enrich with inventory details for proper verification UI
            const itemIds = packs
              .flatMap((p) => (p.contents || []).flatMap((i) => [i.itemId, i.assetInstanceId]))
              .filter((id): id is string => Boolean(id));
            const inventoryMap = await fetchInventoryMap(itemIds);

            const enriched = packs.map((p) => ({
              ...p,
              contents: (p.contents || []).map((item) => {
                const lookupId = item.assetInstanceId || item.itemId;
                let inv = lookupId ? inventoryMap.get(lookupId) : undefined;

                if (!inv) {
                  const serial = item.serialNumber || item.assetInstanceId || undefined;
                  if (serial) {
                    inv = Array.from(inventoryMap.values()).find((iv) => {
                      if (!iv) return false;
                      if ((iv as any).assetSerial && String((iv as any).assetSerial) === String(serial)) return true;
                      const instances = (iv.assets || []) as any[];
                      if (instances.some((a: any) => a.serial === serial || a.id === serial || a.assetTag === serial)) return true;
                      return false;
                    });
                  }
                }

                if (!inv) {
                  const name = item.itemDetails?.name;
                  if (name) {
                    const lower = String(name).toLowerCase();
                    inv = Array.from(inventoryMap.values()).find((iv) => String(iv.name || '').toLowerCase() === lower);
                  }
                }

                return {
                  ...item,
                  itemDetails: inv ? { ...(item.itemDetails || {}), ...inv } : item.itemDetails,
                };
              }),
            }));

            setStatpacks(enriched);
            setFilteredPacks(enriched);
          } catch (err) {
            console.error('Failed to load statpacks:', err);
          } finally {
            setLoading(false);
          }
        })();
      },
      (err) => {
        console.error('Failed to load statpacks:', err);
        setLoading(false);
      }
    );
    return () => unsub();
  }, [user]);

  useEffect(() => {
    if (!searchQuery.trim()) {
      // Sort packs: current user's packs first, then others
      const sorted = [...statpacks].sort((a, b) => {
        const aIsUsers = a.assignedToUserId === user?.uid ? 0 : 1;
        const bIsUsers = b.assignedToUserId === user?.uid ? 0 : 1;
        return aIsUsers - bIsUsers;
      });
      setFilteredPacks(sorted);
      return;
    }
    
    const q = searchQuery.toLowerCase();
    const filtered = statpacks.filter(pack => 
      pack.name?.toLowerCase().includes(q) ||
      pack.type?.toLowerCase().includes(q) ||
      pack.id?.toLowerCase().includes(q) ||
      pack.assignedToUserName?.toLowerCase().includes(q)
    );
    setFilteredPacks(filtered);
  }, [searchQuery, statpacks, user]);

  // Fetch asset items
  useEffect(() => {
    if (!user) return;
    setAssetLoading(true);
    const q2 = query(collection(db, 'inventory'), where('isAsset', '==', true));
    const unsub = onSnapshot(q2, (snap) => {
      const items = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          ...data,
          createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate() : data.createdAt,
          updatedAt: data.updatedAt instanceof Timestamp ? data.updatedAt.toDate() : data.updatedAt,
        } as InventoryItem;
      });
      // For check-in, show only checked-out assets
      const checkedOut = items.filter(i => i.assetStatus === 'Checked Out');
      setAssetItems(checkedOut);
      setFilteredAssetItems(checkedOut);
      setAssetLoading(false);
    });
    return () => unsub();
  }, [user]);

  // Filter asset items by search
  useEffect(() => {
    if (!assetSearchQuery.trim()) {
      setFilteredAssetItems(assetItems);
      return;
    }
    const q2 = assetSearchQuery.toLowerCase();
    setFilteredAssetItems(assetItems.filter(item =>
      item.name?.toLowerCase().includes(q2) ||
      (item as any).assetSerial?.toLowerCase().includes(q2) ||
      item.assignedBarcode?.toLowerCase().includes(q2) ||
      (item as any).qr?.toLowerCase().includes(q2) ||
      item.category?.toLowerCase().includes(q2)
    ));
  }, [assetSearchQuery, assetItems]);

  const handleAssetBarcodeScan = (code: string) => {
    assetScannerDisclosure.onClose();
    const matches = findAssetByCode(assetItems, code);
    if (matches.length === 0) {
      alert(`No asset found with code: ${code}`);
      return;
    }
    const match = matches[0];
    setSelectedAsset(match.asset);
    setSelectedAssetSerial(match.serial ?? null);
    assetCheckinDisclosure.onOpen();
  };

  const handleSelectAssetItem = (asset: InventoryItem) => {
    setSelectedAsset(asset);
    setSelectedAssetSerial(null);
    assetCheckinDisclosure.onOpen();
  };

  const handleSelectPack = useCallback((pack: Statpack) => {
    // Warn if pack is assigned to someone else
    if (pack.assignedToUserId && pack.assignedToUserId !== user?.uid) {
      const assignee = pack.assignedToUserName || 'another member';
      if (!confirm(`This pack is assigned to ${assignee}. Only they (or an admin) can check it in. Continue anyway?`)) {
        return;
      }
    }
    setSelectedPack(pack);
    setSelectedPocketId(null);
    setCompletedPockets([]);
    setAllPocketCheckData([]);
    setErrorMessage(null);
    setShowReview(false);
    pocketDisclosure.onOpen();
  }, [pocketDisclosure, user]);

  const handleScanDetected = (value: string) => {
    // Try to match scanned value to a statpack ID or name
    const foundPack = statpacks.find(p => 
      p.id === value || 
      p.name?.toLowerCase() === value.toLowerCase() ||
      p.id?.toLowerCase().includes(value.toLowerCase())
    );
    
    if (foundPack) {
      scannerDisclosure.onClose();
      handleSelectPack(foundPack);
    } else {
      alert(`No statpack found matching: ${value}`);
      scannerDisclosure.onClose();
    }
  };

  // Quick check-in: require confirmation, then create a proper log entry for audit trail
  async function confirmQuickCheckIn() {
    const pack = quickConfirmPack;
    if (!pack || !user) return;
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      // Build minimal check entries from the pack's contents
      const quickEntries = (pack.contents || []).map(item => ({
        itemId: item.itemId,
        itemName: item.itemDetails?.name || 'Unknown',
        batchId: item.batchId,
        compartmentId: item.compartmentId,
        pocket: item.pocket,
        requiredQuantity: item.requiredQuantity,
        countedQuantity: item.requiredQuantity, // Assume all items present
        ok: true,
        serialNumber: item.serialNumber,
        expirationDate: item.expirationDate,
        notes: 'quick-checkin: user reported no items used',
      }));

      await logStatpackCheckOff({
        statpackId: pack.id,
        statpackName: pack.name,
        action: 'checkin',
        userId: user.uid,
        userName: user.displayName || user.email || 'Unknown',
        checkEntries: quickEntries,
        notes: 'Quick check-in: member reported no items used or replaced',
        quickCheckin: true,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Failed to complete quick check-in', e);
      setIsSubmitting(false);
      setErrorMessage(msg);
      return;
    }

    setIsSubmitting(false);
    setQuickConfirmPack(null);
    checkoffDisclosure.onClose();
    pocketDisclosure.onClose();
    setSelectedPack(null);
    setSelectedPocketId(null);
    setCompletedPockets([]);
    setAllPocketCheckData([]);
    setTimeout(() => router.push('/dashboard'), 500);
  }

  // When all pockets are done, show review instead of auto-submitting
  const handleAllPocketsComplete = () => {
    setShowReview(true);
  };

  // Full check-in with all pocket data collected
  const handleCheckOffComplete = async () => {
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      if (selectedPack && user) {
        // Combine all pocket check entries into a single log entry
        const allCheckEntries: typeof allPocketCheckData[0]['checkEntries'] = [];
        let allSealChecks: Record<string, { sealed: boolean; sealNumber?: string }> = {};
        let allOxygenReadings: Record<string, string> = {};
        const allNotes: string[] = [];

        for (const pocketData of allPocketCheckData) {
          allCheckEntries.push(...pocketData.checkEntries);
          if (pocketData.sealChecks) {
            allSealChecks = { ...allSealChecks, ...pocketData.sealChecks };
          }
          if (pocketData.oxygenReadings) {
            allOxygenReadings = { ...allOxygenReadings, ...pocketData.oxygenReadings };
          }
          if (pocketData.notes) {
            allNotes.push(pocketData.notes);
          }
        }

        // Log the complete checkin with all items — logStatpackCheckOff handles
        // BOTH the statpack_logs entry AND the statpack document update
        // inside a single Firestore transaction. No separate updateDoc needed.
        await logStatpackCheckOff({
          statpackId: selectedPack.id,
          statpackName: selectedPack.name,
          action: 'checkin',
          userId: user.uid,
          userName: user.displayName || user.email || 'Unknown',
          checkEntries: allCheckEntries,
          sealChecks: Object.keys(allSealChecks).length > 0 ? allSealChecks : undefined,
          oxygenReadings: Object.keys(allOxygenReadings).length > 0 ? allOxygenReadings : undefined,
          notes: allNotes.length > 0 ? allNotes.join(' | ') : undefined,
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Failed to complete check-in', e);
      setIsSubmitting(false);
      setErrorMessage(msg);
      return; // Don't redirect on error
    }

    setIsSubmitting(false);

    checkoffDisclosure.onClose();
    setSelectedPack(null);
    setSelectedPocketId(null);
    setCompletedPockets([]);
    setAllPocketCheckData([]);
    // Redirect to dashboard after successful check-in
    setTimeout(() => router.push('/dashboard'), 500);
  };

  // Pocket list component (mirrors checkout page for consistent UX)
  const PocketList = () => {
    if (!selectedPack) return null;
    const pockets = [
      { id: 'main', name: 'Center Pocket' },
      { id: 'front_aux', name: 'Front Pocket' },
      { id: 'side_left', name: 'Left Side Pocket' },
      { id: 'side_right', name: 'Right Side Pocket' },
    ];

    const pocketsWithContent = pockets.filter(p => {
      const hasCompartments = (selectedPack.compartments || []).some((c: any) => c.parentPocket === p.id);
      const hasLooseItems = (selectedPack.contents || []).some((i: any) => i.pocket === p.id && !i.compartmentId);
      return hasCompartments || hasLooseItems;
    });

    if (pocketsWithContent.length === 0) {
      return (
        <Card>
          <CardBody className="text-center">
            <p className="text-sm text-default-500">No pockets defined — verify entire pack.</p>
            <div className="mt-3">
              <Button onPress={() => {
                setSelectedPocketId(null);
                pocketDisclosure.onClose();
                checkoffDisclosure.onOpen();
              }}>Verify Full Pack</Button>
            </div>
          </CardBody>
        </Card>
      );
    }

    return (
      <div className="flex flex-col gap-3 py-1">
        {pocketsWithContent.map((p) => {
          const compForPocket = (selectedPack.compartments || []).filter((c: any) => c.parentPocket === p.id);
          const compItemsCount = compForPocket.flatMap((c: any) => (selectedPack.contents || []).filter((i: any) => i.compartmentId === c.id)).length;
          const looseCount = (selectedPack.contents || []).filter((i: any) => i.pocket === p.id && !i.compartmentId).length;
          const count = compItemsCount + looseCount;
          const isDone = completedPockets.includes(p.id);

          return (
            <Card
              key={p.id}
              isPressable={!isDone}
              onPress={() => {
                if (isDone) return;
                setSelectedPocketId(p.id);
                pocketDisclosure.onClose();
                checkoffDisclosure.onOpen();
              }}
              className={`w-full transition-shadow ${isDone ? 'border-2 ring-1 ring-primary/10 bg-default-100 opacity-95' : 'hover:shadow-md'}`}
            >
              <CardBody className="flex flex-col items-center text-center gap-3 py-6">
                <div className="space-y-1">
                  <p className="font-semibold text-base">{p.name}</p>
                  <p className="text-xs text-default-500">{count} items</p>
                </div>
                {isDone ? (
                  <div className="w-full flex justify-center">
                    <Chip size="sm" variant="flat" color="success">Verified</Chip>
                  </div>
                ) : (
                  <div className="w-full px-4">
                    <div
                      role="button"
                      tabIndex={0}
                      className="w-full h-12 rounded-md bg-green-600 text-white flex items-center justify-center"
                      aria-label={`Start check for ${p.name}`}
                    >
                      Tap to verify
                    </div>
                  </div>
                )}
              </CardBody>
            </Card>
          );
        })}
      </div>
    );
  };

  if (!user) {
    return (
      <div className="h-screen flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <>
      <div className="min-h-screen p-4 md:p-6 bg-gradient-to-br from-green-50 to-emerald-50 dark:from-slate-900 dark:to-slate-800">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Header */}
          <div className="flex items-center gap-3">
            <Button
              isIconOnly
              variant="light"
              onPress={() => router.back()}
            >
              <ArrowLeft size={20} />
            </Button>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <LogIn className="text-green-600" size={24} />
                <h1 className="text-2xl md:text-3xl font-bold text-gray-900 dark:text-white">
                  Check In
                </h1>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Return a statpack or scan an asset barcode to check in
              </p>
            </div>
          </div>

          <Divider />

          <Tabs
            selectedKey={activeTab}
            onSelectionChange={(key) => setActiveTab(key as string)}
            color="success"
            variant="solid"
            classNames={{ tabList: 'w-full' }}
          >
            <Tab key="statpacks" title={<div className="flex items-center gap-2"><Package size={16} />Statpacks</div>}>
              <div className="space-y-6 mt-4">

          {/* Search and Scan Section */}
          <Card>
            <CardBody className="gap-4">
              <div className="flex flex-col md:flex-row gap-3">
                <Input
                  placeholder="Search by name, type, ID, or assignee..."
                  value={searchQuery}
                  onValueChange={setSearchQuery}
                  startContent={<Search size={18} />}
                  className="flex-1"
                  isClearable
                  onClear={() => setSearchQuery('')}
                />
                <Button
                  color="success"
                  variant="flat"
                  startContent={<ScanLine size={18} />}
                  onPress={scannerDisclosure.onOpen}
                  className="md:w-auto"
                >
                  Scan Barcode
                </Button>
              </div>
              
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <Chip size="sm" variant="flat" color="warning">
                  {filteredPacks.length} In Use
                </Chip>
              </div>
            </CardBody>
          </Card>

          {/* Statpacks List */}
          <div className="space-y-3">
            {filteredPacks.length === 0 ? (
              <Card>
                <CardBody className="text-center py-12">
                  <Package size={48} className="mx-auto mb-3 text-gray-400" />
                  <p className="text-gray-600 dark:text-gray-400">
                    {searchQuery ? 'No statpacks match your search' : 'No statpacks currently in use'}
                  </p>
                  <p className="text-sm text-gray-500 mt-2">
                    All statpacks have been checked in
                  </p>
                </CardBody>
              </Card>
            ) : (
              filteredPacks.map((pack) => {
                const isYours = !pack.assignedToUserId || pack.assignedToUserId === user?.uid;
                return (
                <Card
                  key={pack.id}
                  isPressable
                  onPress={() => handleSelectPack(pack)}
                  className={`hover:shadow-lg transition-shadow ${!isYours ? 'opacity-60' : ''}`}
                >
                  <CardBody className="p-4">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <Avatar
                          icon={<Package />}
                          className="bg-green-100 dark:bg-green-900"
                        />
                        <div className="flex-1 min-w-0">
                          <h3 className="font-semibold text-lg text-gray-900 dark:text-white truncate">
                            {pack.name}
                          </h3>
                          <p className="text-sm text-gray-600 dark:text-gray-400">
                            {pack.type}
                          </p>
                          {pack.assignedToUserName && (
                            <p className="text-xs text-gray-500 dark:text-gray-500 mt-1">
                              Assigned to: {pack.assignedToUserName}
                            </p>
                          )}
                          {pack.currentLocation && (
                            <p className="text-xs text-gray-500 dark:text-gray-500 flex items-center gap-1">
                              <Package size={12} />
                              {pack.currentLocation}
                            </p>
                          )}
                        </div>
                      </div>
                      
                      <div className="flex flex-col items-end gap-2">
                        <Chip
                          color="warning"
                          size="sm"
                          variant="flat"
                        >
                          {pack.status}
                        </Chip>
                        {!isYours && (
                          <Chip size="sm" color="danger" variant="flat">Not your pack</Chip>
                        )}
                        {pack.contents && (
                          <span className="text-xs text-gray-500">
                            {pack.contents.length} items
                          </span>
                        )}
                      </div>
                    </div>
                  </CardBody>
                </Card>
              );
              })
            )}
          </div>
              </div>{/* end statpacks tab content */}
            </Tab>

            <Tab key="assets" title={<div className="flex items-center gap-2"><Radio size={16} />Assets</div>}>
              <div className="space-y-6 mt-4">
                {/* Asset Scan & Search */}
                <Card>
                  <CardBody className="gap-4">
                    <div className="flex flex-col md:flex-row gap-3">
                      <Input
                        placeholder="Search by name, serial, barcode..."
                        value={assetSearchQuery}
                        onValueChange={setAssetSearchQuery}
                        startContent={<Search size={18} />}
                        className="flex-1"
                        isClearable
                        onClear={() => setAssetSearchQuery('')}
                      />
                      <Button
                        color="success"
                        variant="flat"
                        startContent={<ScanLine size={18} />}
                        onPress={assetScannerDisclosure.onOpen}
                        className="md:w-auto"
                      >
                        Scan Asset
                      </Button>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-gray-600">
                      <Chip size="sm" variant="flat" color="warning">
                        {filteredAssetItems.length} Checked Out
                      </Chip>
                    </div>
                  </CardBody>
                </Card>

                {/* Asset List */}
                <div className="space-y-2">
                  {assetLoading ? (
                    <div className="flex justify-center py-8"><Spinner /></div>
                  ) : filteredAssetItems.length === 0 ? (
                    <Card>
                      <CardBody className="text-center py-8 text-gray-500">
                        {assetSearchQuery ? 'No assets match your search' : 'No assets currently checked out'}
                      </CardBody>
                    </Card>
                  ) : (
                    filteredAssetItems.map((asset) => (
                      <Card
                        key={asset.id}
                        isPressable
                        onPress={() => handleSelectAssetItem(asset)}
                        className="hover:shadow-lg transition-shadow"
                      >
                        <CardBody className="p-4">
                          <div className="flex items-center justify-between gap-4">
                            <div className="flex items-center gap-3 flex-1 min-w-0">
                              <Avatar
                                icon={<Monitor />}
                                className="bg-emerald-100 dark:bg-emerald-900"
                              />
                              <div className="flex-1 min-w-0">
                                <h3 className="font-semibold text-lg text-gray-900 dark:text-white truncate">
                                  {asset.name}
                                </h3>
                                {(asset as any).assetCategory && (
                                  <p className="text-sm text-gray-600 dark:text-gray-400">
                                    {(asset as any).assetCategory}
                                  </p>
                                )}
                                <p className="text-xs text-gray-500 font-mono mt-1">
                                  {(asset as any).assetSerial || asset.assignedBarcode || '—'}
                                </p>
                              </div>
                            </div>
                            <div className="flex flex-col items-end gap-2">
                              <Chip size="sm" variant="flat" color="warning">
                                Checked Out
                              </Chip>
                              <Button
                                size="sm"
                                color="success"
                                variant="flat"
                                onPress={() => handleSelectAssetItem(asset)}
                              >
                                Check In
                              </Button>
                            </div>
                          </div>
                        </CardBody>
                      </Card>
                    ))
                  )}
                </div>
              </div>
            </Tab>
          </Tabs>
        </div>
      </div>

      {/* Barcode Scanner Modal */}
      <BarcodeScanner
        isOpen={scannerDisclosure.isOpen}
        onClose={scannerDisclosure.onClose}
        onDetected={handleScanDetected}
      />

      {/* Asset Barcode Scanner */}
      <BarcodeScanner
        isOpen={assetScannerDisclosure.isOpen}
        onClose={assetScannerDisclosure.onClose}
        onDetected={handleAssetBarcodeScan}
      />

      {/* Asset Check-In Modal */}
      {selectedAsset && (
        <CheckoutModal
          isOpen={assetCheckinDisclosure.isOpen}
          onOpenChange={assetCheckinDisclosure.onClose}
          asset={selectedAsset}
          mode="checkin"
          serial={selectedAssetSerial}
        />
      )}
      <Modal isOpen={pocketDisclosure.isOpen} onOpenChange={pocketDisclosure.onOpenChange} backdrop="blur" size="lg" placement="center">
        <ModalContent>
          <ModalHeader>Verify Pockets for Check-In</ModalHeader>
          <ModalBody className="gap-4 max-h-[70vh] overflow-y-auto">
            {selectedPack ? (
              <div className="space-y-3">
                <Card className="bg-default-100">
                  <CardBody>
                    <p className="font-semibold">{selectedPack.name}</p>
                    <p className="text-sm text-default-500">Verify each pocket&apos;s contents before returning this pack.</p>
                    {selectedPack.assignedToUserName && (
                      <p className="text-xs text-default-400 mt-1">Checked out by: {selectedPack.assignedToUserName}</p>
                    )}
                  </CardBody>
                </Card>

                {/* Quick Check-In — pinned at top for fastest access */}
                <Card className="bg-emerald-50 dark:bg-emerald-900/20 border-2 border-emerald-300 dark:border-emerald-700">
                  <CardBody className="text-center py-4">
                    <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-200 mb-1">Didn&apos;t use anything?</p>
                    <p className="text-xs text-emerald-700 dark:text-emerald-300 mb-3">
                      If no items were used during the event, skip verification.
                    </p>
                    <Button
                      color="success"
                      variant="solid"
                      size="lg"
                      className="w-full font-semibold"
                      onPress={() => selectedPack && setQuickConfirmPack(selectedPack)}
                    >
                      Quick Check-In (nothing used)
                    </Button>
                    <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-2">
                      This will be flagged for admin review
                    </p>
                  </CardBody>
                </Card>

                <Divider />
                <p className="text-xs text-default-500 text-center font-medium">— OR verify each pocket below —</p>

                <PocketList />
              </div>
            ) : (
              <div>No pack selected.</div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button color="default" onPress={() => { pocketDisclosure.onClose(); setSelectedPack(null); }}>Cancel</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* Check-Off Modal (pocket-level) */}
      {selectedPack && user && (
        <StatpackCheckOffModal
          isOpen={checkoffDisclosure.isOpen}
          onOpenChange={checkoffDisclosure.onOpenChange}
          statpack={(() => {
            if (!selectedPack) return null;
            if (!selectedPocketId) return selectedPack;

            const pocketComp = (selectedPack.compartments || []).filter(c => c.parentPocket === selectedPocketId);
            let pocketContents: any[] = [];
            if (pocketComp.length > 0) {
              pocketContents = pocketComp.flatMap(c => (selectedPack.contents || []).filter(i => i.compartmentId === c.id));
            }
            const loose = (selectedPack.contents || []).filter(i => i.pocket === selectedPocketId && !i.compartmentId);
            pocketContents = [...pocketContents, ...loose];

            if (pocketComp.length === 0 && pocketContents.length === 0) {
              pocketContents = (selectedPack.contents || []).filter(i => i.compartmentId === selectedPocketId);
              const directComp = (selectedPack.compartments || []).filter(c => c.id === selectedPocketId);
              return ({ ...selectedPack, contents: pocketContents, compartments: directComp } as Statpack);
            }

            return ({ ...selectedPack, contents: pocketContents, compartments: pocketComp } as Statpack);
          })()}
          action="checkin"
          userId={user.uid}
          userName={user.displayName || user.email || 'Unknown User'}
          skipLogging={true}
          onDataCollected={async (data) => {
            setAllPocketCheckData(prev => [...prev, data]);
          }}
          onCheckOffComplete={() => {
            if (!selectedPocketId && selectedPack?.compartments && selectedPack.compartments.length === 0) {
              handleCheckOffComplete();
              return;
            }

            const newCompleted = selectedPocketId ? [...completedPockets, selectedPocketId] : [...completedPockets];
            setCompletedPockets(newCompleted);

            checkoffDisclosure.onClose();
            setSelectedPocketId(null);

            const allPockets = ['main', 'front_aux', 'side_left', 'side_right'];
            const pocketsWithContent = allPockets.filter(p => {
              const hasCompartments = (selectedPack?.compartments || []).some((c: any) => c.parentPocket === p);
              const hasLooseItems = (selectedPack?.contents || []).some((i: any) => i.pocket === p && !i.compartmentId);
              return hasCompartments || hasLooseItems;
            });

            const remaining = pocketsWithContent.filter(p => !newCompleted.includes(p));
            if (pocketsWithContent.length > 0 && remaining.length > 0) {
              pocketDisclosure.onOpen();
            } else {
              handleAllPocketsComplete();
            }
          }}
        />
      )}

      {/* Quick Check-In Confirmation Modal */}
      <Modal isOpen={!!quickConfirmPack} onOpenChange={(open) => !open && setQuickConfirmPack(null)} backdrop="blur" size="md" placement="center">
        <ModalContent>
          <ModalHeader>Confirm Quick Check-In</ModalHeader>
          <ModalBody className="gap-3">
            {errorMessage && (
              <Card className="bg-danger-50 border border-danger-200">
                <CardBody>
                  <p className="text-danger text-sm font-medium">{errorMessage}</p>
                </CardBody>
              </Card>
            )}

            <Card className="bg-amber-50 dark:bg-amber-900/20">
              <CardBody className="gap-2">
                <p className="font-semibold">⚠ Are you sure?</p>
                <p className="text-sm">You are confirming that <strong>no items were used</strong> from <strong>{quickConfirmPack?.name}</strong>.</p>
                <p className="text-xs text-amber-700 dark:text-amber-300">This will be flagged for admin review. If items are missing later, this check-in will be investigated.</p>
              </CardBody>
            </Card>

            {quickConfirmPack && (
              <div className="text-xs text-default-500">
                <p><strong>Pack:</strong> {quickConfirmPack.name}</p>
                <p><strong>Items:</strong> {quickConfirmPack.contents?.length || 0} items</p>
              </div>
            )}
          </ModalBody>
          <ModalFooter className="flex justify-between">
            <Button variant="light" onPress={() => { setQuickConfirmPack(null); setErrorMessage(null); }}>Cancel</Button>
            <Button color="warning" isLoading={isSubmitting} onPress={confirmQuickCheckIn}>
              Confirm Quick Check-In
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* Final Review Modal for Full Check-In */}
      <Modal isOpen={showReview} onOpenChange={setShowReview} backdrop="blur" size="lg" placement="center">
        <ModalContent>
          <ModalHeader>Confirm Check-In</ModalHeader>
          <ModalBody className="gap-3">
            {errorMessage && (
              <Card className="bg-danger-50 border border-danger-200">
                <CardBody>
                  <p className="text-danger text-sm font-medium">{errorMessage}</p>
                </CardBody>
              </Card>
            )}

            <Card className="bg-default-100">
              <CardBody className="gap-2">
                <p className="font-semibold text-lg">{selectedPack?.name}</p>
                <p className="text-sm text-default-600">Checked in by: {user?.displayName || user?.email}</p>
              </CardBody>
            </Card>

            {/* Summary of verification */}
            {(() => {
              const allEntries = allPocketCheckData.flatMap(p => p.checkEntries);
              const totalItems = allEntries.length;
              const okItems = allEntries.filter(e => e.ok).length;
              const mismatchItems = allEntries.filter(e => !e.ok).length;
              const expiredItems = allEntries.filter(e => {
                if (!e.expirationDate) return false;
                return new Date(e.expirationDate).getTime() < Date.now();
              }).length;
              const restockedItems = allEntries.filter(e => (e as Record<string, unknown>).restockStatus === 'restocked').length;
              const shelfEmptyItems = allEntries.filter(e => (e as Record<string, unknown>).restockStatus === 'shelf_empty').length;

              return (
                <>
                <div className="grid grid-cols-2 gap-3">
                  <Card className="bg-success-50">
                    <CardBody className="text-center py-3">
                      <p className="text-2xl font-bold text-success">{okItems}</p>
                      <p className="text-xs text-success-600">Items OK</p>
                    </CardBody>
                  </Card>
                  <Card className="bg-default-50">
                    <CardBody className="text-center py-3">
                      <p className="text-2xl font-bold">{totalItems}</p>
                      <p className="text-xs text-default-600">Total Items</p>
                    </CardBody>
                  </Card>
                  {mismatchItems > 0 && (
                    <Card className="bg-warning-50">
                      <CardBody className="text-center py-3">
                        <p className="text-2xl font-bold text-warning">{mismatchItems}</p>
                        <p className="text-xs text-warning-600">Count Mismatches</p>
                      </CardBody>
                    </Card>
                  )}
                  {expiredItems > 0 && (
                    <Card className="bg-danger-50">
                      <CardBody className="text-center py-3">
                        <p className="text-2xl font-bold text-danger">{expiredItems}</p>
                        <p className="text-xs text-danger-600">Expired Items</p>
                      </CardBody>
                    </Card>
                  )}
                  {restockedItems > 0 && (
                    <Card className="bg-blue-50">
                      <CardBody className="text-center py-3">
                        <p className="text-2xl font-bold text-blue-600">{restockedItems}</p>
                        <p className="text-xs text-blue-600">Restocked</p>
                      </CardBody>
                    </Card>
                  )}
                  {shelfEmptyItems > 0 && (
                    <Card className="bg-red-50 border border-red-200">
                      <CardBody className="text-center py-3">
                        <p className="text-2xl font-bold text-red-600">{shelfEmptyItems}</p>
                        <p className="text-xs text-red-600">Shelf Empty</p>
                      </CardBody>
                    </Card>
                  )}
                </div>
                {shelfEmptyItems > 0 && (
                  <Card className="bg-red-50 dark:bg-red-900/20 border border-red-200">
                    <CardBody className="py-2">
                      <p className="text-xs text-red-700 dark:text-red-300 font-medium">
                        ⚠ {shelfEmptyItems} item(s) could not be restocked — admin will be notified to refill the restock shelf.
                      </p>
                    </CardBody>
                  </Card>
                )}
                </>
              );
            })()}

            <p className="text-xs text-default-500 text-center">
              By confirming, you verify the contents of this statpack have been checked.
            </p>
          </ModalBody>
          <ModalFooter className="flex justify-between">
            <Button variant="light" onPress={() => setShowReview(false)}>Go Back</Button>
            <Button color="success" isLoading={isSubmitting} onPress={handleCheckOffComplete}>
              Confirm Check-In
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
