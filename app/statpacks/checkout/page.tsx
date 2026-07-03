'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card,
  CardBody,
  Button,
  Input,
  Spinner,
  Chip,
  Avatar,
  Tabs,
  Tab,
} from '@heroui/react';
import { Package, ScanLine, Search, LogOut, ArrowLeft, Radio, Monitor, Toolbox, BatteryCharging, Thermometer, HardDrive, Box } from 'lucide-react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { collection, onSnapshot, query, where, orderBy, Timestamp, doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/firebase';
import type { InventoryItem, Statpack, StatpackItem } from '@/app/types';
import BarcodeScanner from '@/app/components/barcode-scanner';
import { findAssetByCode } from '@/app/lib/inventory';
import CheckoutModal from '@/app/components/checkout-modal';


export default function CheckoutPage() {
  const router = useRouter();
  const [initialPackQuery, setInitialPackQuery] = useState<string | null>(null);
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [statpacks, setStatpacks] = useState<Statpack[]>([]);
  const [filteredPacks, setFilteredPacks] = useState<Statpack[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const autoOpenedPackId = React.useRef<string | null>(null);

  const [scannerOpen, setScannerOpen] = useState(false);

  // Asset checkout
  const [activeTab, setActiveTab] = useState<string>('statpacks');
  const [assetItems, setAssetItems] = useState<InventoryItem[]>([]);
  const [assetSearchQuery, setAssetSearchQuery] = useState('');
  const [filteredAssetItems, setFilteredAssetItems] = useState<InventoryItem[]>([]);
  const [assetLoading, setAssetLoading] = useState(true);
  const [assetScannerOpen, setAssetScannerOpen] = useState(false);
  const [assetCheckoutOpen, setAssetCheckoutOpen] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<InventoryItem | null>(null);
  const [assetCheckoutMode, setAssetCheckoutMode] = useState<'checkout' | 'checkin' | null>(null);
  const [selectedAssetSerial, setSelectedAssetSerial] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsub();
  }, []);

  // Read QR query param
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('pack') || params.get('packId') || params.get('id');
    if (raw) setInitialPackQuery(raw);
  }, []);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    const q = query(
      collection(db, 'statpacks'),
      where('status', 'in', ['Ready', 'In Maintenance']),
      orderBy('name'),
    );
    const unsub = onSnapshot(q, (snap) => {
      (async () => {
        try {
          const packs: Statpack[] = snap.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              ...data,
              lastCheckedAt: data.lastCheckedAt instanceof Timestamp ? data.lastCheckedAt.toDate() : undefined,
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
          setStatpacks(packs);
          setFilteredPacks(packs);
        } catch (err) {
          console.error('Failed to load statpacks:', err);
        } finally {
          setLoading(false);
        }
      })();
    }, (err) => { console.error(err); setLoading(false); });
    return () => unsub();
  }, [user]);

  useEffect(() => {
    if (!searchQuery.trim()) { setFilteredPacks(statpacks); return; }
    const q = searchQuery.toLowerCase();
    setFilteredPacks(statpacks.filter(p =>
      p.name?.toLowerCase().includes(q) ||
      p.type?.toLowerCase().includes(q) ||
      p.id?.toLowerCase().includes(q)
    ));
  }, [searchQuery, statpacks]);

  // Asset items
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

  useEffect(() => {
    if (!assetSearchQuery.trim()) { setFilteredAssetItems(assetItems); return; }
    const q3 = assetSearchQuery.toLowerCase();
    setFilteredAssetItems(assetItems.filter(a =>
      a.name?.toLowerCase().includes(q3) ||
      a.assetSerial?.toLowerCase().includes(q3) ||
      a.barcode?.toLowerCase().includes(q3) ||
      a.qr?.toLowerCase().includes(q3) ||
      (a.assetCategory as string)?.toLowerCase().includes(q3)
    ));
  }, [assetSearchQuery, assetItems]);

  // Navigate to checkoff page when pack is selected
  const handleSelectPack = useCallback((pack: Statpack) => {
    router.push(`/statpacks/check-off?id=${pack.id}&mode=checkout`);
  }, [router]);

  // QR auto-open: navigate directly if pack is found
  useEffect(() => {
    const raw = initialPackQuery;
    if (!raw || autoOpenedPackId.current === raw) return;
    if (!user) {
      router.push(`/login?next=${encodeURIComponent(window.location.href)}`);
      return;
    }
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'statpacks', raw));
        if (snap.exists()) {
          autoOpenedPackId.current = raw;
          router.push(`/statpacks/check-off?id=${raw}&mode=checkout`);
          return;
        }
      } catch { /* fall through to list match */ }
      const found = statpacks.find(p =>
        (p.id && p.id.toLowerCase() === raw.toLowerCase()) ||
        (p.name && p.name.toLowerCase() === raw.toLowerCase())
      );
      if (found) {
        autoOpenedPackId.current = raw;
        router.push(`/statpacks/check-off?id=${found.id}&mode=checkout`);
      }
    })();
  }, [statpacks, initialPackQuery, user, router]);

  const handleScanDetected = (value: string) => {
    setScannerOpen(false);
    const found = statpacks.find(p =>
      p.id === value ||
      p.name?.toLowerCase() === value.toLowerCase() ||
      p.id?.toLowerCase().includes(value.toLowerCase())
    );
    if (found) {
      router.push(`/statpacks/check-off?id=${found.id}&mode=checkout`);
    } else {
      alert(`No statpack found matching: ${value}`);
    }
  };

  const handleAssetBarcodeScan = (value: string) => {
    setAssetScannerOpen(false);
    const matches = findAssetByCode(assetItems, value);
    if (matches.length === 0) { alert(`No asset found with code: ${value}`); return; }
    const match = matches[0];
    setSelectedAsset(match.asset);
    setSelectedAssetSerial(match.serial ?? null);
    const status = match.instance?.status ?? match.asset.assetStatus;
    setAssetCheckoutMode(status === 'Checked Out' ? 'checkin' : 'checkout');
    setAssetCheckoutOpen(true);
  };

  const handleSelectAssetItem = (asset: InventoryItem) => {
    setSelectedAsset(asset);
    setSelectedAssetSerial(null);
    setAssetCheckoutMode(asset.assetStatus === 'Checked Out' ? 'checkin' : 'checkout');
    setAssetCheckoutOpen(true);
  };

  const getAssetStatusColor = (status?: string) => {
    if (status === 'Checked Out') return 'warning';
    if (status === 'Ready') return 'success';
    if (status === 'In Use') return 'warning';
    return 'default';
  };

  if (!user || loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  return (
    <>
      <div className="min-h-screen p-4 md:p-6 bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Header */}
          <div className="flex items-center gap-3">
            <Button isIconOnly variant="light" onPress={() => router.back()}>
              <ArrowLeft size={20} />
            </Button>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <LogOut className="text-primary" size={24} />
                <h1 className="text-2xl md:text-3xl font-semibold">Check Out</h1>
              </div>
              <p className="text-sm text-foreground-500">
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
                        onPress={() => setScannerOpen(true)}
                        className="md:w-auto"
                      >
                        Scan Barcode
                      </Button>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-foreground-500">
                      <Chip size="sm" variant="flat" color="success">
                        {filteredPacks.length} Available
                      </Chip>
                    </div>
                  </CardBody>
                </Card>

                <div className="space-y-3">
                  {filteredPacks.length === 0 ? (
                    <Card>
                      <CardBody className="text-center py-12">
                        <Package size={48} className="mx-auto mb-3 text-foreground-400" />
                        <p className="text-foreground-500">
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
                              <Avatar icon={<Package />} className="bg-primary-100" />
                              <div className="flex-1 min-w-0">
                                <h3 className="font-semibold text-lg truncate">{pack.name}</h3>
                                <p className="text-sm text-foreground-500">{pack.type}</p>
                                {pack.currentLocation && (
                                  <p className="text-xs text-foreground-400 flex items-center gap-1 mt-1">
                                    <Package size={12} />{pack.currentLocation}
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
                                <span className="text-xs text-foreground-500 tabular-nums">
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
              </div>
            </Tab>

            <Tab key="assets" title={<div className="flex items-center gap-2"><Radio size={16} />Assets</div>}>
              <div className="space-y-6 mt-4">
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
                        onPress={() => setAssetScannerOpen(true)}
                        className="md:w-auto"
                      >
                        Scan Asset
                      </Button>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-foreground-500">
                      <Chip size="sm" variant="flat" color="success">{filteredAssetItems.length} Assets</Chip>
                    </div>
                  </CardBody>
                </Card>

                <div className="space-y-2">
                  {assetLoading ? (
                    <div className="flex justify-center py-8"><Spinner /></div>
                  ) : filteredAssetItems.length === 0 ? (
                    <Card>
                      <CardBody className="text-center py-8 text-foreground-500">
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
                                className="bg-primary-100"
                              />
                              <div className="flex-1 min-w-0">
                                <h3 className="font-semibold text-lg truncate">{asset.name}</h3>
                                {asset.assetCategory && (
                                  <p className="text-sm text-foreground-500">{asset.assetCategory as string}</p>
                                )}
                                <p className="text-xs text-foreground-400 font-mono mt-1">
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

      <BarcodeScanner
        isOpen={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDetected={handleScanDetected}
      />
      <BarcodeScanner
        isOpen={assetScannerOpen}
        onClose={() => setAssetScannerOpen(false)}
        onDetected={handleAssetBarcodeScan}
      />
      {selectedAsset && (
        <CheckoutModal
          isOpen={assetCheckoutOpen}
          onOpenChange={() => setAssetCheckoutOpen(false)}
          asset={selectedAsset}
          mode={assetCheckoutMode}
          serial={selectedAssetSerial}
        />
      )}
    </>
  );
}
