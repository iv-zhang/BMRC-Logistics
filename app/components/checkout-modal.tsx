'use client';
import React, { useEffect, useState } from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Input, Textarea, Card, CardBody, Chip } from '@heroui/react';
import type { InventoryItem, User } from '@/app/types';
import { checkoutAsset, checkinAsset } from '@/app/lib/inventory';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '@/firebase';

interface CheckoutModalProps {
  isOpen: boolean;
  onOpenChange: () => void;
  asset: InventoryItem | null;
  mode: 'checkout' | 'checkin' | null;
}

export default function CheckoutModal({ isOpen, onOpenChange, asset, mode }: CheckoutModalProps) {
  const [user, setUser] = useState<User | null>(null);
  const [location, setLocation] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        // In a real app, fetch full user doc from Firestore
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

  const handleConfirm = async () => {
    if (!asset || !user || !mode) return;
    
    setLoading(true);
    setError(null);
    
    try {
      if (mode === 'checkout') {
        await checkoutAsset({
          assetId: asset.id,
          user: { id: user.id, fullName: user.fullName },
          location: location || undefined,
          note: note || undefined,
        });
      } else {
        await checkinAsset({
          assetId: asset.id,
          user: { id: user.id, fullName: user.fullName },
          location: location || undefined,
          note: note || undefined,
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

  const isCheckedOut = asset.assetStatus === 'Checked Out';
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
                  {asset.assetSerial && (
                    <p className="text-xs text-gray-600">Serial: {asset.assetSerial}</p>
                  )}
                </CardBody>
              </Card>

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

              {error && (
                <Card className="bg-red-50">
                  <CardBody>
                    <p className="text-red-700 text-sm">{error}</p>
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
