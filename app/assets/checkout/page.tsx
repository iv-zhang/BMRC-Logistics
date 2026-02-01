'use client';

import React, { useEffect, useState } from 'react';
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
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
} from '@heroui/react';
import { ScanLine, Search, ArrowLeft, Radio } from 'lucide-react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { collection, query, where, getDocs, Timestamp } from 'firebase/firestore';
import { auth, db } from '@/firebase';
import type { InventoryItem } from '@/app/types';
import BarcodeScanner from '@/app/components/barcode-scanner';
import CheckoutModal from '@/app/components/checkout-modal';
import { findAssetByCode, type AssetScanMatch } from '@/app/lib/inventory';

export default function AssetCheckoutPage() {
  const router = useRouter();
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [assets, setAssets] = useState<InventoryItem[]>([]);
  const [filteredAssets, setFilteredAssets] = useState<InventoryItem[]>([]);

  const [selectedAsset, setSelectedAsset] = useState<InventoryItem | null>(null);
  const [checkoutMode, setCheckoutMode] = useState<'checkout' | 'checkin' | null>(null);
  const [selectedSerial, setSelectedSerial] = useState<string | null>(null);
  
  const scannerDisclosure = useDisclosure();
  const checkoutDisclosure = useDisclosure();
  const multipleMatchDisclosure = useDisclosure();
  const [multipleMatches, setMultipleMatches] = useState<AssetScanMatch[]>([]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (!u) router.push('/login');
    });
    return () => unsub();
  }, [router]);

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
            <Table hideHeader removeWrapper className="mt-4">
              <TableHeader>
                <TableColumn>Name</TableColumn>
                <TableColumn>Serial</TableColumn>
                <TableColumn>Status</TableColumn>
                <TableColumn>Checked Out By</TableColumn>
                <TableColumn>Action</TableColumn>
              </TableHeader>
              <TableBody>
                {filteredAssets.map((asset) => (
                  <TableRow key={asset.id}>
                    <TableCell className="text-sm">
                      <div>
                        <p className="font-semibold">{asset.name}</p>
                        {asset.assetCategory && (
                          <p className="text-xs text-gray-500">{asset.assetCategory}</p>
                        )}
                        {Array.isArray(asset.assets) && asset.assets.length > 0 && (
                          <p className="text-xs text-gray-500">{asset.assets.length} serialized units</p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-gray-600">{asset.assetSerial || '—'}</TableCell>
                    <TableCell>
                      <Chip
                        size="sm"
                        variant="flat"
                        color={getStatusColor(asset.assetStatus)}
                      >
                        {asset.assetStatus || 'Unknown'}
                      </Chip>
                    </TableCell>
                    <TableCell className="text-xs">
                      {asset.assetStatus === 'Checked Out' ? asset.checkedOutBy || '—' : '—'}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        color={asset.assetStatus === 'Checked Out' ? 'success' : 'primary'}
                        onPress={() => handleSelectAsset(asset)}
                      >
                        {asset.assetStatus === 'Checked Out' ? 'Checkin' : 'Checkout'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-center text-gray-500 py-8">
              {searchQuery ? 'No assets found matching your search' : 'No assets available'}
            </p>
          )}
        </CardBody>
      </Card>

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

// Custom table row component for type safety
const TableRow = ({
  children,
  ...props
}: {
  children: React.ReactNode;
  [key: string]: unknown;
}) => {
  return <tr {...props}>{children}</tr>;
};
