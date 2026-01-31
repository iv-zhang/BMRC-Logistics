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
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
} from '@heroui/react';
import { Package, ScanLine, Search, LogOut, ArrowLeft } from 'lucide-react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { collection, onSnapshot, query, where, orderBy, Timestamp, updateDoc, doc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '@/firebase';
import type { Statpack } from '@/app/types';
import StatpackCheckOffModal from '@/app/components/statpack-checkoff-modal';
import BarcodeScanner from '@/app/components/barcode-scanner';

export default function CheckoutPage() {
  const router = useRouter();
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

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsub();
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
      pack.id?.toLowerCase().includes(query)
    );
    setFilteredPacks(filtered);
  }, [searchQuery, statpacks]);

  const handleSelectPack = (pack: Statpack) => {
    setSelectedPack(pack);
    setSelectedPocketId(null);
    setCompletedPockets([]);
    pocketDisclosure.onOpen();
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
      setSelectedPocketId(null);
      setCompletedPockets([]);
      scannerDisclosure.onClose();
      pocketDisclosure.onOpen();
    } else {
      alert(`No statpack found matching: ${value}`);
      scannerDisclosure.onClose();
    }
  };

  const handleCheckOffComplete = async () => {
    // When a full pack checkout completes, mark the statpack document as checked out
    try {
      if (selectedPack && user) {
        const packRef = doc(db, 'statpacks', selectedPack.id as string);
        await updateDoc(packRef, {
          isCheckedOut: true,
          assignedToUserId: user.uid,
          assignedToUserName: user.displayName || user.email || 'Unknown',
          checkedOutAt: serverTimestamp(),
          status: 'In Use',
          updatedAt: serverTimestamp(),
        });
      }
    } catch (e) {
      console.error('Failed to mark statpack as checked out', e);
    }

    checkoffDisclosure.onClose();
    setSelectedPack(null);
    setSelectedPocketId(null);
    setCompletedPockets([]);
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
              className={`w-full ${isDone ? 'opacity-60' : 'hover:shadow-md'} transition-shadow`}
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
                  Check Out Statpack
                </h1>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Select a pack or scan its barcode to check it out
              </p>
            </div>
          </div>

          <Divider />

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
        </div>
      </div>

      {/* Barcode Scanner Modal */}
      <BarcodeScanner
        isOpen={scannerDisclosure.isOpen}
        onClose={scannerDisclosure.onClose}
        onDetected={handleScanDetected}
      />
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
          onCheckOffComplete={() => {
            // Mark this pocket (or compartment) as completed
            if (selectedPocketId) {
              setCompletedPockets(prev => [...prev, selectedPocketId]);
            } else if (selectedPack?.compartments && selectedPack.compartments.length === 0) {
              // full pack verified
              handleCheckOffComplete();
              return;
            }

            // Close checkoff modal and decide whether to reopen selector for remaining pockets
            checkoffDisclosure.onClose();
            const newCompleted = selectedPocketId ? [...completedPockets, selectedPocketId] : completedPockets;
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
              setTimeout(() => pocketDisclosure.onOpen(), 250);
            } else {
              handleCheckOffComplete();
            }
          }}
        />
      )}
    </>
  );
}
