'use client';

import React, { useState, useEffect } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Card,
  CardBody,
  Input,
  Textarea,
  Chip,
  Select,
  SelectItem,
} from '@heroui/react';
import { LogOut, LogIn, MapPin, FileText, AlertCircle, Package } from 'lucide-react';
import type { InventoryItem } from '@/app/types';
import { addDoc, collection, updateDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from '@/firebase';
import { recordAuditEvent } from '@/app/lib/audit';

interface AssetCheckoutModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  asset: InventoryItem | null;
  mode: 'checkout' | 'checkin';
  userId: string;
  userName: string;
  onComplete?: () => void;
}

export default function AssetCheckoutModal({
  isOpen,
  onOpenChange,
  asset,
  mode,
  userId,
  userName,
  onComplete,
}: AssetCheckoutModalProps) {
  const [reason, setReason] = useState('');
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when modal opens with new asset
  useEffect(() => {
    if (isOpen && asset) {
      setReason('');
      setLocation(asset.currentLocation || '');
      setNotes('');
      setError(null);
    }
  }, [isOpen, asset]);

  const handleSubmit = async () => {
    if (!asset) return;
    
    // Validation
    if (mode === 'checkout' && !reason.trim()) {
      setError('Please provide a reason for checkout');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const action = mode === 'checkout' ? 'asset_checkout' : 'asset_checkin';
      const timestamp = new Date();

      // Create log entry
      const logEntry: any = {
        itemId: asset.id,
        itemName: asset.name,
        action,
        userId,
        userName,
        timestamp: serverTimestamp(),
        location: location || asset.currentLocation || 'Unknown',
        serialNumber: asset.assetSerial,
        notes: notes || undefined,
      };

      if (mode === 'checkout') {
        logEntry.reason = reason;
      }

      await addDoc(collection(db, 'inventory_logs'), logEntry);

      // Update asset status
      const assetRef = doc(db, 'inventory', asset.id);
      const statusUpdate: any = {
        assetStatus: mode === 'checkout' ? 'In Use' : 'Ready',
        updatedAt: serverTimestamp(),
      };

      if (mode === 'checkout') {
        statusUpdate.checkedOutBy = userId;
        statusUpdate.checkedOutAt = serverTimestamp();
        statusUpdate.checkoutReason = reason;
      } else {
        statusUpdate.lastCheckedInBy = userId;
        statusUpdate.lastCheckedInAt = serverTimestamp();
        statusUpdate.checkedOutBy = null;
        statusUpdate.checkedOutAt = null;
        statusUpdate.checkoutReason = null;
      }

      if (location) {
        statusUpdate.currentLocation = location;
      }

      await updateDoc(assetRef, statusUpdate);

      // Record audit event
      await recordAuditEvent({
        eventType: action,
        source: 'inventory',
        sourceId: asset.id,
        actor: {
          userId,
          userName,
        },
        targets: [{ collection: 'inventory', docId: asset.id }],
        details: {
          reason: mode === 'checkout' ? reason : undefined,
          location,
          notes,
          serialNumber: asset.assetSerial,
        },
      });

      // Success - close modal and refresh
      onComplete?.();
      onOpenChange(false);
    } catch (e) {
      console.error('Failed to log asset checkout/checkin:', e);
      setError(e instanceof Error ? e.message : 'Failed to complete action. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!asset) return null;

  const isCheckout = mode === 'checkout';
  const Icon = isCheckout ? LogOut : LogIn;
  const colorScheme = isCheckout ? 'primary' : 'success';

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="lg" backdrop="blur">
      <ModalContent>
        <ModalHeader className="flex items-center gap-2">
          <Icon size={20} className={isCheckout ? 'text-primary' : 'text-success'} />
          <span>{isCheckout ? 'Asset Checkout' : 'Asset Check-In'}</span>
        </ModalHeader>

        <ModalBody className="gap-4">
          {error && (
            <Card className="bg-danger-50 border border-danger-200">
              <CardBody className="py-2">
                <div className="flex items-center gap-2">
                  <AlertCircle size={16} className="text-danger" />
                  <p className="text-sm text-danger">{error}</p>
                </div>
              </CardBody>
            </Card>
          )}

          {/* Asset Info Card */}
          <Card className="bg-default-100">
            <CardBody className="gap-2">
              <div className="flex items-center gap-2">
                <Package size={18} className="text-primary" />
                <h3 className="font-semibold text-lg">{asset.name}</h3>
              </div>
              <div className="flex flex-wrap gap-2 text-sm text-default-600">
                {asset.assetSerial && (
                  <Chip size="sm" variant="flat" color="default">
                    Serial: {asset.assetSerial}
                  </Chip>
                )}
                {asset.assetCategory && (
                  <Chip size="sm" variant="flat" color="secondary">
                    {asset.assetCategory}
                  </Chip>
                )}
                {asset.assetStatus && (
                  <Chip
                    size="sm"
                    variant="flat"
                    color={
                      asset.assetStatus === 'Ready'
                        ? 'success'
                        : asset.assetStatus === 'In Use'
                        ? 'primary'
                        : 'warning'
                    }
                  >
                    {asset.assetStatus}
                  </Chip>
                )}
              </div>
              {asset.currentLocation && (
                <div className="flex items-center gap-2 text-sm text-default-500">
                  <MapPin size={14} />
                  <span>Current Location: {asset.currentLocation}</span>
                </div>
              )}
            </CardBody>
          </Card>

          {/* Checkout Reason (required for checkout) */}
          {isCheckout && (
            <Select
              label="Reason for Checkout"
              placeholder="Select a reason"
              selectedKeys={reason ? [reason] : []}
              onChange={(e) => setReason(e.target.value)}
              isRequired
              description="Why are you checking out this asset?"
              startContent={<FileText size={16} />}
            >
              <SelectItem key="event">Event/Operation</SelectItem>
              <SelectItem key="training">Training Exercise</SelectItem>
              <SelectItem key="maintenance">Maintenance/Testing</SelectItem>
              <SelectItem key="inspection">Routine Inspection</SelectItem>
              <SelectItem key="repair">Repair/Service</SelectItem>
              <SelectItem key="transfer">Transfer to Another Location</SelectItem>
              <SelectItem key="other">Other</SelectItem>
            </Select>
          )}

          {/* Location */}
          <Input
            label="Location"
            placeholder={isCheckout ? 'Where are you taking it?' : 'Where is it now?'}
            value={location}
            onValueChange={setLocation}
            startContent={<MapPin size={16} />}
            description={
              isCheckout
                ? 'Optional: Specify where this asset will be used'
                : 'Update location if it has changed'
            }
          />

          {/* Additional Notes */}
          <Textarea
            label="Additional Notes"
            placeholder={
              isCheckout
                ? 'Any special conditions or details...'
                : 'Condition notes, issues found, etc...'
            }
            value={notes}
            onValueChange={setNotes}
            minRows={3}
            description="Optional: Add any relevant details"
          />

          {/* User Info */}
          <Card className="bg-blue-50 dark:bg-blue-900/20">
            <CardBody className="py-2">
              <p className="text-xs text-blue-700 dark:text-blue-300">
                {isCheckout ? 'Checked out by' : 'Checked in by'}: <strong>{userName}</strong>
              </p>
              <p className="text-xs text-blue-600 dark:text-blue-400">
                You are accountable for this {isCheckout ? 'checkout' : 'check-in'}
              </p>
            </CardBody>
          </Card>
        </ModalBody>

        <ModalFooter>
          <Button variant="light" onPress={() => onOpenChange(false)} isDisabled={submitting}>
            Cancel
          </Button>
          <Button
            color={colorScheme}
            onPress={handleSubmit}
            isLoading={submitting}
            isDisabled={isCheckout && !reason.trim()}
            startContent={!submitting && <Icon size={16} />}
          >
            {isCheckout ? 'Check Out Asset' : 'Check In Asset'}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
