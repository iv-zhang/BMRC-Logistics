'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Input, Textarea, Card, CardBody, Chip, Select, SelectItem } from '@heroui/react';
import type { InventoryItem, User, AssetInstance } from '@/app/types';
import { checkoutAsset, checkinAsset } from '@/app/lib/inventory';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/firebase';

interface CheckoutModalProps {
  isOpen: boolean;
  onOpenChange: () => void;
  asset: InventoryItem | null;
  mode: 'checkout' | 'checkin' | null;
  serial?: string | null;
}

export default function CheckoutModal({ isOpen, onOpenChange, asset, mode, serial }: CheckoutModalProps) {
  const [user, setUser] = useState<User | null>(null);
  const [location, setLocation] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [selectedSerial, setSelectedSerial] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      if (!firebaseUser) return;
      try {
        const userRef = doc(db, 'users', firebaseUser.uid);
        const userSnap = await getDoc(userRef);
        const data = userSnap.exists() ? userSnap.data() : null;
        setUser({
          id: firebaseUser.uid,
          email: firebaseUser.email || data?.email || '',
          fullName: data?.fullName || data?.name || firebaseUser.displayName || firebaseUser.email?.split('@')[0] || '',
          role: data?.role || 'member',
          createdAt: data?.createdAt?.toDate?.() || new Date(),
          updatedAt: data?.updatedAt?.toDate?.() || new Date(),
        });
      } catch (e) {
        setUser({
          id: firebaseUser.uid,
          email: firebaseUser.email || '',
          fullName: firebaseUser.displayName || firebaseUser.email?.split('@')[0] || '',
          role: 'member',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (isOpen) {
      setLocation('');
      setNote('');
      setError(null);
      setSuccess(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    setSelectedSerial(serial ?? null);
  }, [isOpen, serial]);

  const instances = useMemo(() => (asset?.assets || []) as AssetInstance[], [asset]);
  const selectedInstance = useMemo(
    () => (selectedSerial ? instances.find(i => i.serial === selectedSerial) : undefined),
    [instances, selectedSerial]
  );
  const requiresSerial = instances.length > 0;
  const friendlyError = useMemo(() => {
    if (!error) return null;
    if (error.toLowerCase().includes('already checked out')) {
      return 'This asset is already checked out. If this is incorrect, ask an admin to check it in.';
    }
    if (error.toLowerCase().includes('not currently checked out')) {
      return 'This asset is not checked out. Please verify the serial and try again.';
    }
    if (error.toLowerCase().includes('requires a serial')) {
      return 'This asset is serialized. Please select an instance/serial to continue.';
    }
    if (error.toLowerCase().includes('serial') && error.toLowerCase().includes('not found')) {
      return 'Serial not found on this asset. Check the tag/label and try again.';
    }
    return error;
  }, [error]);

  const handleConfirm = async () => {
    if (!asset || !user || !mode) return;
    if (requiresSerial && !selectedSerial) {
      setError('Please select an asset instance/serial before continuing.');
      return;
    }
    
    setLoading(true);
    setError(null);
    
    try {
      if (mode === 'checkout') {
        await checkoutAsset({
          assetId: asset.id,
          user: { id: user.id, fullName: user.fullName },
          location: location || undefined,
          note: note || undefined,
          serial: selectedSerial || undefined,
        });
      } else {
        await checkinAsset({
          assetId: asset.id,
          user: { id: user.id, fullName: user.fullName },
          location: location || undefined,
          note: note || undefined,
          serial: selectedSerial || undefined,
        });
      }
      
      setSuccess(true);
      setTimeout(() => {
        onOpenChange();
      }, 1500);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to process request';
      setError(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  if (!asset) return null;

  const effectiveStatus = selectedInstance?.status ?? asset.assetStatus;
  const isCheckedOut = effectiveStatus === 'Checked Out';
  const buttonText = mode === 'checkout' ? 'Confirm Checkout' : 'Confirm Checkin';
  const cardTitle = mode === 'checkout' ? 'Checkout Asset' : 'Checkin Asset';

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="md">
      <ModalContent>
        <ModalHeader>{cardTitle}</ModalHeader>
        <ModalBody className="space-y-4">
          {success ? (
            <Card className="bg-green-50">
              <CardBody className="text-center py-6">
                <p className="text-green-700 font-semibold">
                  {mode === 'checkout' ? 'Asset checked out successfully!' : 'Asset checked in successfully!'}
                </p>
              </CardBody>
            </Card>
          ) : (
            <>
              <Card className="bg-slate-50">
                <CardBody className="space-y-2 py-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-semibold">{asset.name}</span>
                    <Chip size="sm" variant="flat" color={isCheckedOut ? 'warning' : 'success'}>
                      {asset.assetStatus || 'Unknown'}
                    </Chip>
                  </div>
                  {asset.assetCategory && (
                    <p className="text-xs text-gray-600">Category: {asset.assetCategory}</p>
                  )}
                  {(selectedInstance?.serial || asset.assetSerial) && (
                    <p className="text-xs text-gray-600">Serial: {selectedInstance?.serial || asset.assetSerial}</p>
                  )}
                </CardBody>
              </Card>

              {requiresSerial && (
                <div>
                  <label className="text-sm font-semibold block mb-1">Asset Instance</label>
                  <Select
                    selectedKeys={selectedSerial ? [selectedSerial] : []}
                    onChange={(e) => setSelectedSerial(e.target.value)}
                    placeholder="Select serial/tag"
                    description="Required for serialized assets"
                  >
                    {instances.map((instance) => (
                      <SelectItem key={instance.serial}>
                        {instance.assetTag || instance.id || instance.serial} {instance.status ? `• ${instance.status}` : ''}
                      </SelectItem>
                    ))}
                  </Select>
                </div>
              )}

              <div>
                <label className="text-sm font-semibold block mb-1">Member</label>
                <Input
                  isReadOnly
                  value={user?.fullName || 'Loading...'}
                  description={`(${user?.email})`}
                />
              </div>

              <div>
                <label className="text-sm font-semibold block mb-1">
                  {mode === 'checkout' ? 'Location (where will you use it)' : 'Return Location'}
                </label>
                <Input
                  placeholder={mode === 'checkout' ? 'e.g., Vehicle 1, Field Site A' : 'e.g., Back Room, Equipment Closet'}
                  value={location}
                  onValueChange={setLocation}
                />
              </div>

              <div>
                <label className="text-sm font-semibold block mb-1">Notes (optional)</label>
                <Textarea
                  placeholder={mode === 'checkout' ? 'e.g., Assigned to Shift A' : 'e.g., Returned in good condition'}
                  value={note}
                  onValueChange={setNote}
                  minRows={2}
                />
              </div>

              {friendlyError && (
                <Card className="bg-red-50">
                  <CardBody>
                    <p className="text-red-700 text-sm">{friendlyError}</p>
                  </CardBody>
                </Card>
              )}
            </>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={onOpenChange}>
            {success ? 'Done' : 'Cancel'}
          </Button>
          {!success && (
            <Button
              color="primary"
              isLoading={loading}
              onPress={handleConfirm}
              disabled={loading || !user}
            >
              {buttonText}
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
