'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card,
  CardBody,
  CardHeader,
  Button,
  Input,
  Divider,
  Spinner,
  Chip,
  useDisclosure,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  Tabs,
  Tab,
} from '@heroui/react';
import { ScanLine, Search, ArrowLeft, Radio, Layers } from 'lucide-react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { collection, query, where, getDocs, Timestamp, doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/firebase';
import type { InventoryItem, AssetInstance } from '@/app/types';
import BarcodeScanner from '@/app/components/barcode-scanner';
import CheckoutModal from '@/app/components/checkout-modal';
import BatchAssetCheckout, { type BatchItem, type BatchContext } from '@/app/components/batch-asset-checkout';
import { findAssetByCode, batchCheckoutAssets, batchCheckinAssets, type AssetScanMatch } from '@/app/lib/inventory';
import { useUserRole } from '@/app/hooks/useUserRole';

export default function AssetCheckoutPage() {
  const router = useRouter();
  const { user, role, fullName } = useUserRole();
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [assets, setAssets] = useState<InventoryItem[]>([]);
  const [filteredAssets, setFilteredAssets] = useState<InventoryItem[]>([]);
  const [activeTab, setActiveTab] = useState<string>('single');

  const [selectedAsset, setSelectedAsset] = useState<InventoryItem | null>(null);
  const [checkoutMode, setCheckoutMode] = useState<'checkout' | 'checkin' | null>(null);
  const [selectedSerial, setSelectedSerial] = useState<string | null>(null);
  
  const scannerDisclosure = useDisclosure();
  const checkoutDisclosure = useDisclosure();
  const multipleMatchDisclosure = useDisclosure();
  const [multipleMatches, setMultipleMatches] = useState<AssetScanMatch[]>([]);

  useEffect(() => {
    if (!user) return;

    setLoading(true);
    (async () => {
      try {
        const q = query(collection(db, 'inventory'), where('isAsset', '==', true));
        const snap = await getDocs(q);
        const items: InventoryItem[] = snap.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            ...data,
            checkedOutAt: data.checkedOutAt instanceof Timestamp ? data.checkedOutAt.toDate() : data.checkedOutAt,
            lastCheckedInAt: data.lastCheckedInAt instanceof Timestamp ? data.lastCheckedInAt.toDate() : data.lastCheckedInAt,
          } as InventoryItem;
        });
        setAssets(items);
      } catch (err) {
        console.error('Failed to load assets', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);

  useEffect(() => {
    if (!searchQuery) {
      setFilteredAssets(assets);
    } else {
      const q = searchQuery.toLowerCase();
      setFilteredAssets(
        assets.filter(
          (a) =>
            a.name?.toLowerCase().includes(q) ||
            a.assetSerial?.toLowerCase().includes(q) ||
            a.barcode?.toLowerCase().includes(q) ||
            a.qr?.toLowerCase().includes(q)
        )
      );
    }
  }, [searchQuery, assets]);

  const handleBarcodeScan = async (value: string) => {
    const matches = findAssetByCode(assets, value);

    if (matches.length === 0) {
      alert(`No asset found with code: ${value}`);
      scannerDisclosure.onOpen();
    } else if (matches.length === 1) {
      const match = matches[0];
      setSelectedAsset(match.asset);
      setSelectedSerial(match.serial ?? null);
      const status = match.instance?.status ?? match.asset.assetStatus;
      setCheckoutMode(status === 'Checked Out' ? 'checkin' : 'checkout');
      checkoutDisclosure.onOpen();
    } else {
      setMultipleMatches(matches);
      multipleMatchDisclosure.onOpen();
    }
  };

  const handleSelectAsset = (asset: InventoryItem, serial?: string | null, statusOverride?: string) => {
    setSelectedAsset(asset);
    setSelectedSerial(serial ?? null);
    const status = statusOverride ?? asset.assetStatus;
    setCheckoutMode(status === 'Checked Out' ? 'checkin' : 'checkout');
    multipleMatchDisclosure.onClose();
    checkoutDisclosure.onOpen();
  };

  const getStatusColor = (status?: string) => {
    if (status === 'Checked Out') return 'warning';
    if (status === 'Ready') return 'success';
    return 'default';
  };

  // Batch mode: lookup asset by barcode for batch component
  const lookupAssetForBatch = useCallback(async (barcode: string): Promise<Array<{ item: InventoryItem; instance?: AssetInstance }>> => {
    // First try local cache
    const localMatches = findAssetByCode(assets, barcode);
    if (localMatches.length > 0) {
      return localMatches.map(m => ({ item: m.asset, instance: m.instance }));
    }
    // Fallback: query Firestore for assets with matching barcode/serial/assignedBarcode
    try {
      const snap = await getDocs(query(collection(db, 'inventory'), where('isAsset', '==', true)));
      const allAssets = snap.docs.map(d => ({ id: d.id, ...d.data() } as InventoryItem));
      const matches = findAssetByCode(allAssets, barcode);
      return matches.map(m => ({ item: m.asset, instance: m.instance }));
    } catch {
      return [];
    }
  }, [assets]);

  // Batch checkout handler
  const handleBatchCheckout = useCallback(async (items: BatchItem[], context: BatchContext) => {
    if (!user) return;
    const assetList = items.map(i => ({
      itemId: i.item.id,
      instanceSerial: i.instance?.serial,
    }));
    await batchCheckoutAssets(assetList, context, user.uid, fullName || user.displayName || 'Unknown');
    // Refresh assets
    const q2 = query(collection(db, 'inventory'), where('isAsset', '==', true));
    const snap = await getDocs(q2);
    setAssets(snap.docs.map(d => ({ id: d.id, ...d.data() } as InventoryItem)));
    setActiveTab('single');
  }, [user, fullName]);

  // Batch checkin handler
  const handleBatchCheckin = useCallback(async (items: BatchItem[], context: BatchContext) => {
    if (!user) return;
    const assetList = items.map(i => ({
      itemId: i.item.id,
      instanceSerial: i.instance?.serial,
      condition: i.condition,
      notes: i.notes,
    }));
    await batchCheckinAssets(assetList, context, user.uid, fullName || user.displayName || 'Unknown');
    const q2 = query(collection(db, 'inventory'), where('isAsset', '==', true));
    const snap = await getDocs(q2);
    setAssets(snap.docs.map(d => ({ id: d.id, ...d.data() } as InventoryItem)));
    setActiveTab('single');
  }, [user, fullName]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Radio className="w-8 h-8 text-blue-600" />
          <h1 className="text-3xl font-bold">Asset Checkout / Checkin</h1>
        </div>
        <Button isIconOnly variant="light" onPress={() => router.back()}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
      </div>

      {/* Mode tabs: Single vs Batch */}
      <Tabs
        selectedKey={activeTab}
        onSelectionChange={(key) => setActiveTab(String(key))}
        color="primary"
        variant="solid"
      >
        <Tab key="single" title={<div className="flex items-center gap-2"><ScanLine size={16} />Single Asset</div>}>
          <div className="space-y-6 mt-4">
            <Card>
              <CardHeader className="flex gap-3">
                <div className="flex flex-col">
                  <p className="text-lg font-semibold">Quick Scan</p>
                  <p className="text-small text-default-500">Scan a barcode or QR code to checkout/checkin an asset</p>
                </div>
              </CardHeader>
              <Divider />
              <CardBody className="gap-3">
                <Button
                  color="primary"
                  startContent={<ScanLine className="w-5 h-5" />}
                  onPress={scannerDisclosure.onOpen}
                  size="lg"
                >
                  Open Scanner
                </Button>
              </CardBody>
            </Card>

            <Card>
              <CardHeader className="flex gap-3">
                <div className="flex flex-col flex-1">
                  <p className="text-lg font-semibold">Search Assets</p>
                  <p className="text-small text-default-500">Or search manually from the list below</p>
                </div>
              </CardHeader>
              <Divider />
              <CardBody className="gap-3">
                <Input
                  isClearable
                  placeholder="Search by name, serial, barcode, or QR code..."
                  startContent={<Search className="w-4 h-4" />}
                  value={searchQuery}
                  onValueChange={setSearchQuery}
                />
                {filteredAssets.length > 0 ? (
                  <div className="space-y-2 mt-4">
                    {filteredAssets.map((asset) => (
                      <div
                        key={asset.id}
                        className="flex items-center justify-between px-4 py-3 rounded-lg bg-default-50 hover:bg-default-100 transition-colors"
                      >
                        <div className="flex-1">
                          <p className="font-semibold text-sm">{asset.name}</p>
                          {asset.assetCategory && (
                            <p className="text-xs text-gray-500">{asset.assetCategory}</p>
                          )}
                          <p className="text-xs text-gray-400 font-mono">{asset.assetSerial || asset.assignedBarcode || '—'}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Chip size="sm" variant="flat" color={getStatusColor(asset.assetStatus)}>
                            {asset.assetStatus || 'Unknown'}
                          </Chip>
                          <Button
                            size="sm"
                            color={asset.assetStatus === 'Checked Out' ? 'success' : 'primary'}
                            onPress={() => handleSelectAsset(asset)}
                          >
                            {asset.assetStatus === 'Checked Out' ? 'Checkin' : 'Checkout'}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-center text-gray-500 py-8">
                    {searchQuery ? 'No assets found matching your search' : 'No assets available'}
                  </p>
                )}
              </CardBody>
            </Card>
          </div>
        </Tab>

        <Tab key="batch-checkout" title={<div className="flex items-center gap-2"><Layers size={16} />Batch Checkout</div>}>
          <div className="mt-4">
            <BatchAssetCheckout
              lookupAsset={lookupAssetForBatch}
              onCheckout={handleBatchCheckout}
              onCancel={() => setActiveTab('single')}
              mode="checkout"
              defaultContext={{ assignee: fullName || '' }}
            />
          </div>
        </Tab>

        <Tab key="batch-checkin" title={<div className="flex items-center gap-2"><Layers size={16} />Batch Check-in</div>}>
          <div className="mt-4">
            <BatchAssetCheckout
              lookupAsset={lookupAssetForBatch}
              onCheckout={handleBatchCheckin}
              onCancel={() => setActiveTab('single')}
              mode="checkin"
              defaultContext={{ assignee: fullName || '' }}
            />
          </div>
        </Tab>
      </Tabs>

      <BarcodeScanner
        isOpen={scannerDisclosure.isOpen}
        onClose={scannerDisclosure.onClose}
        onDetected={handleBarcodeScan}
      />

      {selectedAsset && (
        <CheckoutModal
          isOpen={checkoutDisclosure.isOpen}
          onOpenChange={checkoutDisclosure.onClose}
          asset={selectedAsset}
          mode={checkoutMode}
          serial={selectedSerial}
        />
      )}

      <Modal isOpen={multipleMatchDisclosure.isOpen} onOpenChange={multipleMatchDisclosure.onClose} size="md">
        <ModalContent>
          <ModalHeader>Multiple Assets Found</ModalHeader>
          <ModalBody>
            <p className="text-sm mb-4">
              Found {multipleMatches.length} assets matching the scanned code. Please select one:
            </p>
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {multipleMatches.map((match, idx) => (
                <Card
                  key={`${match.asset.id}-${match.serial ?? idx}`}
                  isPressable
                  onPress={() => handleSelectAsset(match.asset, match.serial, match.instance?.status ?? match.asset.assetStatus)}
                  className="cursor-pointer hover:bg-slate-100"
                >
                  <CardBody className="flex-row justify-between items-center py-2 px-3">
                    <div className="flex-1">
                      <p className="font-semibold">{match.asset.name}</p>
                      <p className="text-xs text-gray-600">{match.serial || match.asset.assetSerial || '—'}</p>
                    </div>
                    <Chip size="sm" variant="flat" color={getStatusColor(match.instance?.status ?? match.asset.assetStatus)}>
                      {match.instance?.status ?? match.asset.assetStatus}
                    </Chip>
                  </CardBody>
                </Card>
              ))}
            </div>
          </ModalBody>
        </ModalContent>
      </Modal>
    </div>
  );
}
