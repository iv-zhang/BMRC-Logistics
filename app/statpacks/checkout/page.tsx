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
import { Package, ScanLine, Search, LogOut, ArrowLeft, Radio, Monitor, Toolbox, BatteryCharging, Thermometer, HardDrive, Box } from 'lucide-react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { collection, onSnapshot, query, where, orderBy, Timestamp, doc, getDocs, documentId, getDoc } from 'firebase/firestore';
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

export default function CheckoutPage() {
  const router = useRouter();
  const [initialPackQuery, setInitialPackQuery] = useState<string | null>(null);
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [statpacks, setStatpacks] = useState<Statpack[]>([]);
  const [filteredPacks, setFilteredPacks] = useState<Statpack[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  const [selectedPack, setSelectedPack] = useState<Statpack | null>(null);
  const scannerDisclosure = useDisclosure();
  const checkoffDisclosure = useDisclosure();
  const pocketDisclosure = useDisclosure();
  const [selectedPocketId, setSelectedPocketId] = useState<string | null>(null);
  const [completedPockets, setCompletedPockets] = useState<string[]>([]);
  const autoOpenedPackId = React.useRef<string | null>(null);

  // Collect check entries from all pockets before final logging
  const [allPocketCheckData, setAllPocketCheckData] = useState<Array<{
    checkEntries: Parameters<typeof logStatpackCheckOff>[0]['checkEntries'];
    sealChecks?: Record<string, { sealed: boolean; sealNumber?: string }>;
    oxygenReadings?: Record<string, string>;
    notes?: string;
  }>>([]);

  // Error and review state
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showReview, setShowReview] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Tab and asset checkout state
  const [activeTab, setActiveTab] = useState<string>('statpacks');
  const [assetItems, setAssetItems] = useState<InventoryItem[]>([]);
  const [assetSearchQuery, setAssetSearchQuery] = useState('');
  const [filteredAssetItems, setFilteredAssetItems] = useState<InventoryItem[]>([]);
  const [assetLoading, setAssetLoading] = useState(true);
  const assetScannerDisclosure = useDisclosure();
  const assetCheckoutDisclosure = useDisclosure();
  const [selectedAsset, setSelectedAsset] = useState<InventoryItem | null>(null);
  const [assetCheckoutMode, setAssetCheckoutMode] = useState<'checkout' | 'checkin' | null>(null);
  const [selectedAssetSerial, setSelectedAssetSerial] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsub();
  }, []);

  // Read query params from the URL on the client to support direct QR links.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('pack') || params.get('packId') || params.get('id');
    if (raw) setInitialPackQuery(raw);
  }, []);

  useEffect(() => {
    if (!user) return;
    
    setLoading(true);
    // Only show Ready or In Maintenance statpacks for checkout
    const q = query(
      collection(db, 'statpacks'),
      where('status', 'in', ['Ready', 'In Maintenance']),
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

            const itemIds = packs
              .flatMap((p) => (p.contents || []).flatMap((i) => [i.itemId, i.assetInstanceId]))
              .filter((id): id is string => Boolean(id));
            const inventoryMap = await fetchInventoryMap(itemIds);

            const enriched = packs.map((p) => ({
              ...p,
              contents: (p.contents || []).map((item) => {
                const lookupId = item.assetInstanceId || item.itemId;
                let inv = lookupId ? inventoryMap.get(lookupId) : undefined;

                // Fallbacks when direct id lookup fails:
                // - match by serialNumber against inventory.assetSerial
                // - match by serialNumber against inventory.assets[].serial
                // - match by assetInstanceId against any asset instance id
                // - finally, match by inventory name
                if (!inv) {
                  const serial = item.serialNumber || item.assetInstanceId || undefined;
                  if (serial) {
                    inv = Array.from(inventoryMap.values()).find((iv) => {
                      if (!iv) return false;
                      if ((iv as any).assetSerial && String((iv as any).assetSerial) === String(serial)) return true;
                      const instances = (iv.assets || []) as any[];
                      if (instances.some((a) => a.serial === serial || a.id === serial || a.assetTag === serial)) return true;
                      return false;
                    });
                  }
                }

                if (!inv) {
                  // Match by name as a last resort (case-insensitive)
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
      setFilteredPacks(statpacks);
      return;
    }
    
    const query = searchQuery.toLowerCase();
    const filtered = statpacks.filter(pack => 
      pack.name?.toLowerCase().includes(query) ||
      pack.type?.toLowerCase().includes(query) ||
      pack.id?.toLowerCase().includes(query)
    );
    setFilteredPacks(filtered);
  }, [searchQuery, statpacks]);

  // Fetch asset items for asset tab
  useEffect(() => {
    if (!user) return;
    setAssetLoading(true);
    const q2 = query(collection(db, 'inventory'), where('isAsset', '==', true));
    const unsub = onSnapshot(q2, (snap) => {
      const items: InventoryItem[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          ...data,
          checkedOutAt: data.checkedOutAt instanceof Timestamp ? data.checkedOutAt.toDate() : data.checkedOutAt,
          lastCheckedInAt: data.lastCheckedInAt instanceof Timestamp ? data.lastCheckedInAt.toDate() : data.lastCheckedInAt,
        } as InventoryItem;
      });
      setAssetItems(items);
      setFilteredAssetItems(items);
      setAssetLoading(false);
    }, () => setAssetLoading(false));
    return () => unsub();
  }, [user]);

  // Filter assets by search
  useEffect(() => {
    if (!assetSearchQuery.trim()) {
      setFilteredAssetItems(assetItems);
      return;
    }
    const q3 = assetSearchQuery.toLowerCase();
    setFilteredAssetItems(
      assetItems.filter((a) =>
        a.name?.toLowerCase().includes(q3) ||
        a.assetSerial?.toLowerCase().includes(q3) ||
        a.barcode?.toLowerCase().includes(q3) ||
        a.qr?.toLowerCase().includes(q3) ||
        (a.assetCategory as string)?.toLowerCase().includes(q3)
      )
    );
  }, [assetSearchQuery, assetItems]);

  // Handle asset barcode scan
  const handleAssetBarcodeScan = (value: string) => {
    assetScannerDisclosure.onClose();
    const matches = findAssetByCode(assetItems, value);
    if (matches.length === 0) {
      alert(`No asset found with code: ${value}`);
      return;
    }
    const match = matches[0];
    setSelectedAsset(match.asset);
    setSelectedAssetSerial(match.serial ?? null);
    const status = match.instance?.status ?? match.asset.assetStatus;
    setAssetCheckoutMode(status === 'Checked Out' ? 'checkin' : 'checkout');
    assetCheckoutDisclosure.onOpen();
  };

  // Handle asset selection from list
  const handleSelectAssetItem = (asset: InventoryItem) => {
    setSelectedAsset(asset);
    setSelectedAssetSerial(null);
    setAssetCheckoutMode(asset.assetStatus === 'Checked Out' ? 'checkin' : 'checkout');
    assetCheckoutDisclosure.onOpen();
  };

  const getAssetStatusColor = (status?: string) => {
    if (status === 'Checked Out') return 'warning';
    if (status === 'Ready') return 'success';
    if (status === 'In Use') return 'warning';
    return 'default';
  };

  const handleSelectPack = useCallback((pack: Statpack) => {
    setSelectedPack(pack);
    setSelectedPocketId(null);
    setCompletedPockets([]);
    setAllPocketCheckData([]); // Clear stale data from previous pack
    setErrorMessage(null);
    setShowReview(false);
    pocketDisclosure.onOpen();
  }, [pocketDisclosure]);

  // Open a specific pack if an initial pack query param was captured (e.g., from QR)
  useEffect(() => {
    const raw = initialPackQuery;
    if (!raw) return;

    // Skip if we already auto-opened this exact pack
    if (autoOpenedPackId.current === raw) return;

    // If user is not signed in, redirect to login and preserve the requested URL
    if (!user) {
      const redirect = window.location.href;
      router.push(`/login?next=${encodeURIComponent(redirect)}`);
      return;
    }

    // Try direct fetch by id first to avoid waiting for the full statpacks list
    (async () => {
      try {
        const docRef = doc(db, 'statpacks', raw);
        const snap = await getDoc(docRef);
        if (snap.exists()) {
          const data = snap.data();
          // sanitize pack shape to avoid passing unexpected objects into React
          const contents = Array.isArray(data.contents)
            ? data.contents.map((item: any) => ({
                itemId: String(item.itemId || item.id || ''),
                itemDetails: item.itemDetails || {},
                requiredQuantity: Number(item.requiredQuantity || 0),
                currentQuantity: Number(item.currentQuantity || 0),
                pocket: item.pocket || 'main',
                compartmentId: item.compartmentId || undefined,
                assetInstanceId: item.assetInstanceId || undefined,
                serialNumber: item.serialNumber || undefined,
                expirationDate: item.expirationDate instanceof Timestamp ? item.expirationDate.toDate() : (item.expirationDate instanceof Date ? item.expirationDate : undefined),
              }))
            : [];

          const pack: Statpack = {
            id: snap.id,
            name: String(data.name || ''),
            type: String(data.type || ''),
            status: String(data.status || 'Ready'),
            currentLocation: data.currentLocation || undefined,
            assetValue: typeof data.assetValue === 'number' ? data.assetValue : undefined,
            lastCheckedAt: data.lastCheckedAt instanceof Timestamp ? data.lastCheckedAt.toDate() : undefined,
            compartments: Array.isArray(data.compartments) ? data.compartments : [],
            contents,
          } as Statpack;

          autoOpenedPackId.current = raw;
          setTimeout(() => {
            handleSelectPack(pack);
          }, 100);
          return;
        }
      } catch (e) {
        console.warn('Direct statpack fetch failed, falling back to list match', e);
      }

      // Fallback: match against loaded statpacks by id or name
      const key = String(raw).toLowerCase();
      const foundPack = statpacks.find(p =>
        (p.id && p.id.toLowerCase() === key) ||
        (p.name && p.name.toLowerCase() === key)
      );
      if (foundPack) {
        autoOpenedPackId.current = raw;
        setTimeout(() => handleSelectPack(foundPack), 100);
      }
    })();
  }, [statpacks, initialPackQuery, handleSelectPack, user, router]);

  const handleScanDetected = (value: string) => {
    // Try to match scanned value to a statpack ID or name
    const foundPack = statpacks.find(p => 
      p.id === value || 
      p.name?.toLowerCase() === value.toLowerCase() ||
      p.id?.toLowerCase().includes(value.toLowerCase())
    );
    
    if (foundPack) {
      setSelectedPack(foundPack);
      setSelectedPocketId(null);
      setCompletedPockets([]);
      scannerDisclosure.onClose();
      pocketDisclosure.onOpen();
    } else {
      alert(`No statpack found matching: ${value}`);
      scannerDisclosure.onClose();
    }
  };

  // When all pockets are done, show review instead of auto-submitting
  const handleAllPocketsComplete = () => {
    setShowReview(true);
  };

  const handleCheckOffComplete = async () => {
    // When a full pack checkout completes, combine all pocket check entries and log once
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

        // Log the complete checkout once with all items from all pockets.
        // logStatpackCheckOff handles BOTH logging and statpack document update
        // inside a single Firestore transaction — no separate updateDoc needed.
        await logStatpackCheckOff({
          statpackId: selectedPack.id,
          statpackName: selectedPack.name,
          action: 'checkout',
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
      console.error('Failed to complete checkout', e);
      setIsSubmitting(false);
      setErrorMessage(msg);
      return; // Don't redirect on error
    }

    setIsSubmitting(false);

    checkoffDisclosure.onClose();
    setSelectedPack(null);
    setSelectedPocketId(null);
    setCompletedPockets([]);
    setAllPocketCheckData([]); // Clear collected pocket data
    // Redirect to dashboard after successful checkout
    setTimeout(() => router.push('/dashboard'), 500);
  };

  // Pocket list component to keep JSX clean and avoid in-place IIFEs
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
                    <Chip size="sm" variant="flat" color="success">Completed</Chip>
                  </div>
                ) : (
                  <div className="w-full px-4">
                    <div
                      role="button"
                      tabIndex={0}
                      className="w-full h-12 rounded-md bg-blue-600 text-white flex items-center justify-center"
                      aria-label={`Start check for ${p.name}`}
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
      <div className="min-h-screen p-4 md:p-6 bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-slate-900 dark:to-slate-800">
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
                <LogOut className="text-blue-600" size={24} />
                <h1 className="text-2xl md:text-3xl font-bold text-gray-900 dark:text-white">
                  Check Out
                </h1>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Select a statpack or scan an asset barcode to check out
              </p>
            </div>
          </div>

          <Tabs
            selectedKey={activeTab}
            onSelectionChange={(key) => setActiveTab(String(key))}
            color="primary"
            variant="solid"
            className="w-full"
          >
            <Tab key="statpacks" title={<div className="flex items-center gap-2"><Package size={16} />Statpacks</div>}>
              <div className="space-y-6 mt-4">

          {/* Search and Scan Section */}
          <Card>
            <CardBody className="gap-4">
              <div className="flex flex-col md:flex-row gap-3">
                <Input
                  placeholder="Search by name, type, or ID..."
                  value={searchQuery}
                  onValueChange={setSearchQuery}
                  startContent={<Search size={18} />}
                  className="flex-1"
                  isClearable
                  onClear={() => setSearchQuery('')}
                />
                <Button
                  color="primary"
                  variant="flat"
                  startContent={<ScanLine size={18} />}
                  onPress={scannerDisclosure.onOpen}
                  className="md:w-auto"
                >
                  Scan Barcode
                </Button>
              </div>
              
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <Chip size="sm" variant="flat" color="success">
                  {filteredPacks.length} Available
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
                    {searchQuery ? 'No statpacks match your search' : 'No statpacks available for checkout'}
                  </p>
                </CardBody>
              </Card>
            ) : (
              filteredPacks.map((pack) => (
                <Card
                  key={pack.id}
                  isPressable
                  onPress={() => handleSelectPack(pack)}
                  className="hover:shadow-lg transition-shadow"
                >
                  <CardBody className="p-4">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <Avatar
                          icon={<Package />}
                          className="bg-blue-100 dark:bg-blue-900"
                        />
                        <div className="flex-1 min-w-0">
                          <h3 className="font-semibold text-lg text-gray-900 dark:text-white truncate">
                            {pack.name}
                          </h3>
                          <p className="text-sm text-gray-600 dark:text-gray-400">
                            {pack.type}
                          </p>
                          {pack.currentLocation && (
                            <p className="text-xs text-gray-500 dark:text-gray-500 flex items-center gap-1 mt-1">
                              <Package size={12} />
                              {pack.currentLocation}
                            </p>
                          )}
                        </div>
                      </div>
                      
                      <div className="flex flex-col items-end gap-2">
                        <Chip
                          color={pack.status === 'Ready' ? 'success' : 'warning'}
                          size="sm"
                          variant="flat"
                        >
                          {pack.status}
                        </Chip>
                        {pack.contents && (
                          <span className="text-xs text-gray-500">
                            {pack.contents.length} items
                          </span>
                        )}
                      </div>
                    </div>
                  </CardBody>
                </Card>
              ))
            )}
          </div>
              </div>{/* end statpacks tab content */}
            </Tab>

            <Tab key="assets" title={<div className="flex items-center gap-2"><Radio size={16} />Assets</div>}>
              <div className="space-y-6 mt-4">
                {/* Asset Quick Scan */}
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
                        color="primary"
                        variant="flat"
                        startContent={<ScanLine size={18} />}
                        onPress={assetScannerDisclosure.onOpen}
                        className="md:w-auto"
                      >
                        Scan Asset
                      </Button>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-gray-600">
                      <Chip size="sm" variant="flat" color="success">
                        {filteredAssetItems.length} Assets
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
                        {assetSearchQuery ? 'No assets match your search' : 'No assets available'}
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
                                icon={(() => {
                                  const cat = (asset.assetCategory || '').toString().toLowerCase();
                                  if (cat.includes('radio')) return <Radio />;
                                  if (cat.includes('monitor')) return <Monitor />;
                                  if (cat.includes('battery')) return <BatteryCharging />;
                                  if (cat.includes('therm') || cat.includes('temp')) return <Thermometer />;
                                  if (cat.includes('tool') || cat.includes('defib') || cat.includes('pump')) return <Toolbox />;
                                  if (cat.includes('drive') || cat.includes('hard')) return <HardDrive />;
                                  if (cat.includes('box') || cat.includes('case') || cat.includes('supply')) return <Box />;
                                  return <Package />;
                                })()}
                                className="bg-indigo-100 dark:bg-indigo-900"
                              />
                              <div className="flex-1 min-w-0">
                                <h3 className="font-semibold text-lg text-gray-900 dark:text-white truncate">
                                  {asset.name}
                                </h3>
                                {asset.assetCategory && (
                                  <p className="text-sm text-gray-600 dark:text-gray-400">
                                    {asset.assetCategory as string}
                                  </p>
                                )}
                                <p className="text-xs text-gray-500 font-mono mt-1">
                                  {asset.assetSerial || asset.assignedBarcode || '—'}
                                </p>
                              </div>
                            </div>
                            <div className="flex flex-col items-end gap-2">
                              <Chip size="sm" variant="flat" color={getAssetStatusColor(asset.assetStatus)}>
                                {asset.assetStatus || 'Unknown'}
                              </Chip>
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

      {/* Asset Checkout Modal */}
      {selectedAsset && (
        <CheckoutModal
          isOpen={assetCheckoutDisclosure.isOpen}
          onOpenChange={assetCheckoutDisclosure.onClose}
          asset={selectedAsset}
          mode={assetCheckoutMode}
          serial={selectedAssetSerial}
        />
      )}
      {/* Pocket Selection Modal */}
      <Modal isOpen={pocketDisclosure.isOpen} onOpenChange={pocketDisclosure.onOpenChange} backdrop="blur" size="lg" placement="center">
        <ModalContent>
          <ModalHeader>Choose Pocket to Verify</ModalHeader>
          <ModalBody className="gap-4 max-h-[70vh] overflow-y-auto">
            {selectedPack ? (
              <div className="space-y-3">
                <Card className="bg-default-100">
                  <CardBody>
                    <p className="font-semibold">{selectedPack.name}</p>
                    <p className="text-sm text-default-500">Select a pocket to verify contents pocket-by-pocket.</p>
                  </CardBody>
                </Card>

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

            // If selectedPocketId matches a parentPocket (pocket id), gather all compartments and loose items
            const pocketComp = (selectedPack.compartments || []).filter(c => c.parentPocket === selectedPocketId);
            let pocketContents: any[] = [];
            if (pocketComp.length > 0) {
              pocketContents = pocketComp.flatMap(c => (selectedPack.contents || []).filter(i => i.compartmentId === c.id));
            }
            const loose = (selectedPack.contents || []).filter(i => i.pocket === selectedPocketId && !i.compartmentId);
            pocketContents = [...pocketContents, ...loose];

            // If no compartments matched, fall back to matching compartment id directly (for legacy behavior)
            if (pocketComp.length === 0 && pocketContents.length === 0) {
              // treat selectedPocketId as a compartment id
              pocketContents = (selectedPack.contents || []).filter(i => i.compartmentId === selectedPocketId);
              const directComp = (selectedPack.compartments || []).filter(c => c.id === selectedPocketId);
              return ({ ...selectedPack, contents: pocketContents, compartments: directComp } as Statpack);
            }

            return ({ ...selectedPack, contents: pocketContents, compartments: pocketComp } as Statpack);
          })()}
          action="checkout"
          userId={user.uid}
          userName={user.displayName || user.email || 'Unknown User'}
          skipLogging={true}
          onDataCollected={async (data) => {
            // Collect check data from this pocket for later logging
            setAllPocketCheckData(prev => [...prev, data]);
          }}
          onCheckOffComplete={() => {
            // If this was a full-pack verification and there are no compartments, finish the checkout
            if (!selectedPocketId && selectedPack?.compartments && selectedPack.compartments.length === 0) {
              handleCheckOffComplete();
              return;
            }

            // Build the new completed list synchronously and update state
            const newCompleted = selectedPocketId ? [...completedPockets, selectedPocketId] : [...completedPockets];
            setCompletedPockets(newCompleted);

            // Close checkoff modal and reset selected pocket
            checkoffDisclosure.onClose();
            setSelectedPocketId(null);

            // Determine pockets with content (same list used for selection)
            const pockets = ['main', 'front_aux', 'side_left', 'side_right'];
            const pocketsWithContent = pockets.filter(p => {
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

      {/* Final Review Modal */}
      <Modal isOpen={showReview} onOpenChange={setShowReview} backdrop="blur" size="lg" placement="center">
        <ModalContent>
          <ModalHeader>Confirm Checkout</ModalHeader>
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
                <p className="text-sm text-default-600">Checked by: {user?.displayName || user?.email}</p>
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

              return (
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
                </div>
              );
            })()}

            <p className="text-xs text-default-500 text-center">
              By confirming, you take responsibility for this statpack and its contents.
            </p>
          </ModalBody>
          <ModalFooter className="flex justify-between">
            <Button variant="light" onPress={() => setShowReview(false)}>Go Back</Button>
            <Button color="primary" isLoading={isSubmitting} onPress={handleCheckOffComplete}>
              Confirm Checkout
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
