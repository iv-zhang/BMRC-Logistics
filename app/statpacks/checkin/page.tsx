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
  Avatar,
} from '@heroui/react';
import { Package, ScanLine, Search, LogIn, ArrowLeft } from 'lucide-react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { collection, onSnapshot, query, where, orderBy, Timestamp, updateDoc, doc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '@/firebase';
import type { Statpack } from '@/app/types';
import StatpackCheckOffModal from '@/app/components/statpack-checkoff-modal';
import BarcodeScanner from '@/app/components/barcode-scanner';

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
        const packs: Statpack[] = snap.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            ...data,
            lastCheckedAt: data.lastCheckedAt instanceof Timestamp 
              ? data.lastCheckedAt.toDate() 
              : undefined,
            contents: Array.isArray(data.contents)
              ? data.contents.map((item: any) => ({
                  ...item,
                  expirationDate: item.expirationDate instanceof Timestamp
                    ? item.expirationDate.toDate()
                    : undefined,
                }))
              : [],
          } as Statpack;
        });
        setStatpacks(packs);
        setFilteredPacks(packs);
        setLoading(false);
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
      pack.id?.toLowerCase().includes(query) ||
      pack.assignedToUserName?.toLowerCase().includes(query)
    );
    setFilteredPacks(filtered);
  }, [searchQuery, statpacks]);

  const handleSelectPack = (pack: Statpack) => {
    setSelectedPack(pack);
    checkoffDisclosure.onOpen();
  };

  const handleScanDetected = (value: string) => {
    // Try to match scanned value to a statpack ID or name
    const foundPack = statpacks.find(p => 
      p.id === value || 
      p.name?.toLowerCase() === value.toLowerCase() ||
      p.id?.toLowerCase().includes(value.toLowerCase())
    );
    
    if (foundPack) {
      setSelectedPack(foundPack);
      scannerDisclosure.onClose();
      checkoffDisclosure.onOpen();
    } else {
      alert(`No statpack found matching: ${value}`);
      scannerDisclosure.onClose();
    }
  };

  const handleCheckOffComplete = async () => {
    // When a pack is checked in, mark it as available in Firestore
    try {
      if (selectedPack) {
        const packRef = doc(db, 'statpacks', selectedPack.id as string);
        await updateDoc(packRef, {
          isCheckedOut: false,
          assignedToUserId: null,
          assignedToUserName: null,
          checkedInAt: serverTimestamp(),
          status: 'Ready',
          updatedAt: serverTimestamp(),
        });
      }
    } catch (e) {
      console.error('Failed to mark statpack as checked in', e);
    }

    checkoffDisclosure.onClose();
    setSelectedPack(null);
    // Redirect to dashboard after successful check-in
    setTimeout(() => router.push('/dashboard'), 500);
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
                  Check In Statpack
                </h1>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Return a pack and verify its contents
              </p>
            </div>
          </div>

          <Divider />

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
        </div>
      </div>

      {/* Barcode Scanner Modal */}
      <BarcodeScanner
        isOpen={scannerDisclosure.isOpen}
        onClose={scannerDisclosure.onClose}
        onDetected={handleScanDetected}
      />

      {/* Check-Off Modal */}
      {selectedPack && user && (
        <StatpackCheckOffModal
          isOpen={checkoffDisclosure.isOpen}
          onOpenChange={checkoffDisclosure.onOpenChange}
          statpack={selectedPack}
          action="checkin"
          userId={user.uid}
          userName={user.displayName || user.email || 'Unknown User'}
          onCheckOffComplete={handleCheckOffComplete}
        />
      )}
    </>
  );
}
