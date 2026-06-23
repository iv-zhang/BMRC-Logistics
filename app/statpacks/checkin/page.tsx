'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card,
  CardBody,
  Button,
  Input,
  Divider,
  Spinner,
  Chip,
  Avatar,
  Tabs,
  Tab,
} from '@heroui/react';
import { Package, ScanLine, Search, LogIn, ArrowLeft, Radio, Monitor } from 'lucide-react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { collection, onSnapshot, query, where, orderBy, Timestamp } from 'firebase/firestore';
import { auth, db } from '@/firebase';
import type { InventoryItem, Statpack, StatpackItem } from '@/app/types';
import BarcodeScanner from '@/app/components/barcode-scanner';
import { findAssetByCode } from '@/app/lib/inventory';
import CheckoutModal from '@/app/components/checkout-modal';

export default function CheckinPage() {
  const router = useRouter();
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [statpacks, setStatpacks] = useState<Statpack[]>([]);
  const [filteredPacks, setFilteredPacks] = useState<Statpack[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  const [scannerOpen, setScannerOpen] = useState(false);

  // Asset check-in state
  const [activeTab, setActiveTab] = useState<string>('statpacks');
  const [assetItems, setAssetItems] = useState<InventoryItem[]>([]);
  const [assetSearchQuery, setAssetSearchQuery] = useState('');
  const [filteredAssetItems, setFilteredAssetItems] = useState<InventoryItem[]>([]);
  const [assetLoading, setAssetLoading] = useState(true);
  const [assetScannerOpen, setAssetScannerOpen] = useState(false);
  const [assetCheckinOpen, setAssetCheckinOpen] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<InventoryItem | null>(null);
  const [selectedAssetSerial, setSelectedAssetSerial] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    const q = query(
      collection(db, 'statpacks'),
      where('status', '==', 'In Use'),
      orderBy('name'),
    );
    const unsub = onSnapshot(q, (snap) => {
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
    }, (err) => { console.error(err); setLoading(false); });
    return () => unsub();
  }, [user]);

  useEffect(() => {
    if (!searchQuery.trim()) {
      const sorted = [...statpacks].sort((a, b) => {
        const aIsUsers = a.assignedToUserId === user?.uid ? 0 : 1;
        const bIsUsers = b.assignedToUserId === user?.uid ? 0 : 1;
        return aIsUsers - bIsUsers;
      });
      setFilteredPacks(sorted);
      return;
    }
    const q = searchQuery.toLowerCase();
    setFilteredPacks(statpacks.filter(p =>
      p.name?.toLowerCase().includes(q) ||
      p.type?.toLowerCase().includes(q) ||
      p.id?.toLowerCase().includes(q) ||
      p.assignedToUserName?.toLowerCase().includes(q)
    ));
  }, [searchQuery, statpacks, user]);

  // Asset items (checked-out only for check-in)
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
      const checkedOut = items.filter(i => i.assetStatus === 'Checked Out');
      setAssetItems(checkedOut);
      setFilteredAssetItems(checkedOut);
      setAssetLoading(false);
    });
    return () => unsub();
  }, [user]);

  useEffect(() => {
    if (!assetSearchQuery.trim()) { setFilteredAssetItems(assetItems); return; }
    const q2 = assetSearchQuery.toLowerCase();
    setFilteredAssetItems(assetItems.filter(item =>
      item.name?.toLowerCase().includes(q2) ||
      (item.assetSerial as string | undefined)?.toLowerCase().includes(q2) ||
      item.assignedBarcode?.toLowerCase().includes(q2) ||
      (item.qr as string | undefined)?.toLowerCase().includes(q2) ||
      item.category?.toLowerCase().includes(q2)
    ));
  }, [assetSearchQuery, assetItems]);

  // Navigate to checkoff page on pack selection
  const handleSelectPack = useCallback((pack: Statpack) => {
    if (pack.assignedToUserId && pack.assignedToUserId !== user?.uid) {
      const assignee = pack.assignedToUserName || 'another member';
      if (!confirm(`This pack is assigned to ${assignee}. Only they (or an admin) can check it in. Continue anyway?`)) {
        return;
      }
    }
    router.push(`/statpacks/check-off?id=${pack.id}&mode=checkin`);
  }, [router, user]);

  const handleScanDetected = (value: string) => {
    setScannerOpen(false);
    const found = statpacks.find(p =>
      p.id === value ||
      p.name?.toLowerCase() === value.toLowerCase() ||
      p.id?.toLowerCase().includes(value.toLowerCase())
    );
    if (found) {
      handleSelectPack(found);
    } else {
      alert(`No statpack found matching: ${value}`);
    }
  };

  const handleAssetBarcodeScan = (code: string) => {
    setAssetScannerOpen(false);
    const matches = findAssetByCode(assetItems, code);
    if (matches.length === 0) { alert(`No asset found with code: ${code}`); return; }
    const match = matches[0];
    setSelectedAsset(match.asset);
    setSelectedAssetSerial(match.serial ?? null);
    setAssetCheckinOpen(true);
  };

  const handleSelectAssetItem = (asset: InventoryItem) => {
    setSelectedAsset(asset);
    setSelectedAssetSerial(null);
    setAssetCheckinOpen(true);
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
      <div className="min-h-screen p-4 md:p-6 bg-gradient-to-br from-green-50 to-emerald-50 dark:from-slate-900 dark:to-slate-800">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Header */}
          <div className="flex items-center gap-3">
            <Button isIconOnly variant="light" onPress={() => router.back()}>
              <ArrowLeft size={20} />
            </Button>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <LogIn className="text-success" size={24} />
                <h1 className="text-2xl md:text-3xl font-semibold">Check In</h1>
              </div>
              <p className="text-sm text-foreground-500">
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
                        onPress={() => setScannerOpen(true)}
                        className="md:w-auto"
                      >
                        Scan Barcode
                      </Button>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-foreground-500">
                      <Chip size="sm" variant="flat" color="warning">
                        {filteredPacks.length} In Use
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
                          {searchQuery ? 'No statpacks match your search' : 'No statpacks currently in use'}
                        </p>
                        <p className="text-sm text-foreground-400 mt-2">All statpacks have been checked in</p>
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
                                <Avatar icon={<Package />} className="bg-success-100 dark:bg-success-900" />
                                <div className="flex-1 min-w-0">
                                  <h3 className="font-semibold text-lg truncate">{pack.name}</h3>
                                  <p className="text-sm text-foreground-500">{pack.type}</p>
                                  {pack.assignedToUserName && (
                                    <p className="text-xs text-foreground-400 mt-1">
                                      Assigned to: {pack.assignedToUserName}
                                    </p>
                                  )}
                                  {pack.currentLocation && (
                                    <p className="text-xs text-foreground-400 flex items-center gap-1">
                                      <Package size={12} />{pack.currentLocation}
                                    </p>
                                  )}
                                </div>
                              </div>
                              <div className="flex flex-col items-end gap-2">
                                <Chip color="warning" size="sm" variant="flat">{pack.status}</Chip>
                                {!isYours && <Chip size="sm" color="danger" variant="flat">Not your pack</Chip>}
                                {pack.contents && (
                                  <span className="text-xs text-foreground-500 tabular-nums">
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
                        color="success"
                        variant="flat"
                        startContent={<ScanLine size={18} />}
                        onPress={() => setAssetScannerOpen(true)}
                        className="md:w-auto"
                      >
                        Scan Asset
                      </Button>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-foreground-500">
                      <Chip size="sm" variant="flat" color="warning">{filteredAssetItems.length} Checked Out</Chip>
                    </div>
                  </CardBody>
                </Card>

                <div className="space-y-2">
                  {assetLoading ? (
                    <div className="flex justify-center py-8"><Spinner /></div>
                  ) : filteredAssetItems.length === 0 ? (
                    <Card>
                      <CardBody className="text-center py-8 text-foreground-500">
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
                              <Avatar icon={<Monitor />} className="bg-emerald-100 dark:bg-emerald-900" />
                              <div className="flex-1 min-w-0">
                                <h3 className="font-semibold text-lg truncate">{asset.name}</h3>
                                {(asset.assetCategory as string | undefined) && (
                                  <p className="text-sm text-foreground-500">{asset.assetCategory as string}</p>
                                )}
                                <p className="text-xs text-foreground-400 font-mono mt-1">
                                  {(asset.assetSerial as string | undefined) || asset.assignedBarcode || '—'}
                                </p>
                              </div>
                            </div>
                            <div className="flex flex-col items-end gap-2">
                              <Chip size="sm" variant="flat" color="warning">Checked Out</Chip>
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
          isOpen={assetCheckinOpen}
          onOpenChange={() => setAssetCheckinOpen(false)}
          asset={selectedAsset}
          mode="checkin"
          serial={selectedAssetSerial}
        />
      )}
    </>
  );
}
