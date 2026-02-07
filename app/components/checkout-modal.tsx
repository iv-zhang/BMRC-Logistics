'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Input, Textarea, Card, CardBody, Chip, Select, SelectItem, Divider } from '@heroui/react';
import type { InventoryItem, User, AssetInstance, StatpackItem, ValidationWarning } from '@/app/types';
import { checkoutAsset, checkinAsset, verifyAssetAgainstRules, findAssetByCode } from '@/app/lib/inventory';
import { parseGs1Barcode } from '@/app/lib/gs1';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/firebase';
import BarcodeScanner from './barcode-scanner';
import { ScanLine, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';

interface CheckoutModalProps {
  isOpen: boolean;
  onOpenChange: () => void;
  asset: InventoryItem | null;
  mode: 'checkout' | 'checkin' | null;
  serial?: string | null;
  statpackItem?: StatpackItem | null; // Optional: for verification rules
}

export default function CheckoutModal({ isOpen, onOpenChange, asset, mode, serial, statpackItem }: CheckoutModalProps) {
  const [user, setUser] = useState<User | null>(null);
  const [location, setLocation] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [selectedSerial, setSelectedSerial] = useState<string | null>(null);
  const [showScanner, setShowScanner] = useState(false);
  const [scannedCode, setScannedCode] = useState<string | null>(null);
  const [scannedExpiration, setScannedExpiration] = useState<Date | null>(null);
  const [confirmedExpiration, setConfirmedExpiration] = useState<Date | null>(null);
  const [manualO2Psi, setManualO2Psi] = useState<string>('');
  const [verificationWarnings, setVerificationWarnings] = useState<ValidationWarning[]>([]);

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
      setScannedCode(null);
      setScannedExpiration(null);
      setConfirmedExpiration(null);
      setManualO2Psi('');
      setVerificationWarnings([]);
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
  
  const hasVerificationRules = useMemo(() => {
    const rules = statpackItem?.verificationRules ?? asset?.verificationPolicy;
    if (!rules) return false;
    return rules.requireSerial || rules.requireExpirationConfirmation || (rules.requireO2PsiMin !== undefined && rules.requireO2PsiMin > 0);
  }, [statpackItem, asset]);

  const handleScanComplete = async (code: string) => {
    setScannedCode(code);
    setShowScanner(false);
    
    // Parse GS1 for expiration
    const gs1Data = parseGs1Barcode(code);
    if (gs1Data.expiration) {
      try {
        setScannedExpiration(new Date(gs1Data.expiration));
        setConfirmedExpiration(new Date(gs1Data.expiration));
      } catch (e) {
        console.warn('Failed to parse GS1 expiration', e);
      }
    }
    
    // Try to match asset instance
    if (asset) {
      try {
        const matches = findAssetByCode([asset], code);
        if (matches.length > 0 && matches[0].instance) {
          setSelectedSerial(matches[0].instance.serial);
        }
      } catch (e) {
        console.warn('Asset match failed', e);
      }
    }
    
    // Run verification if rules present (prefer statpackItem rules, fall back to inventory item policy)
    if (hasVerificationRules) {
      const rulesSource = statpackItem?.verificationRules ? statpackItem : (asset ? ({ itemId: asset.id, itemDetails: asset, verificationRules: asset.verificationPolicy } as any) : null);
      if (rulesSource) {
        const warnings = await verifyAssetAgainstRules({
          statpackItem: rulesSource,
          scannedCode: code,
          scannedExpiration: gs1Data.expiration ? new Date(gs1Data.expiration) : undefined,
          scannedO2Psi: manualO2Psi ? Number(manualO2Psi) : undefined,
          inventoryItem: asset || undefined,
        });
        setVerificationWarnings(warnings);
      }
    }
  };

  const runVerification = async () => {
    if (!hasVerificationRules) return;
    const rulesSource = statpackItem?.verificationRules ? statpackItem : (asset ? ({ itemId: asset.id, itemDetails: asset, verificationRules: asset.verificationPolicy } as any) : null);
    if (!rulesSource) return;

    const warnings = await verifyAssetAgainstRules({
      statpackItem: rulesSource,
      scannedCode: scannedCode || undefined,
      scannedExpiration: scannedExpiration || undefined,
      scannedO2Psi: manualO2Psi ? Number(manualO2Psi) : undefined,
      inventoryItem: asset || undefined,
    });
    setVerificationWarnings(warnings);
  };

  useEffect(() => {
    if (hasVerificationRules && (scannedCode || scannedExpiration || manualO2Psi)) {
      runVerification();
    }
  }, [manualO2Psi]); // Re-verify when O2 PSI changes
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
    
    // Check for critical warnings (non-advisory)
    const criticalWarnings = verificationWarnings.filter(w => w.severity === 'critical');
    if (criticalWarnings.length > 0 && !confirm(`${criticalWarnings.length} critical verification issue(s) found. Proceed anyway?`)) {
      return;
    }
    
    // If expiration confirmation is required, ensure user provided/confirmed a date
    const rulesSource = statpackItem?.verificationRules ? statpackItem : (asset ? ({ itemId: asset.id, itemDetails: asset, verificationRules: asset.verificationPolicy } as any) : null);
    const requireExpiration = !!(rulesSource?.verificationRules?.requireExpirationConfirmation || rulesSource?.verificationRules?.requireExpirationConfirmation === true);
    if (requireExpiration && !confirmedExpiration && !scannedExpiration) {
      setError('Please confirm the item expiration date before continuing.');
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
          expirationDate: confirmedExpiration ?? scannedExpiration ?? undefined,
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
            <Card className="bg-default-100">
              <CardBody className="text-center py-6">
                <p className="text-default-700 font-semibold">
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
                  <div className="flex gap-2">
                    <Select
                      className="flex-1"
                      selectedKeys={selectedSerial ? [selectedSerial] : []}
                      onChange={(e) => setSelectedSerial(e.target.value)}
                      placeholder="Select serial/tag"
                    >
                      {instances.map((instance) => (
                        <SelectItem key={instance.serial}>
                          {instance.assetTag || instance.id || instance.serial} {instance.status ? `• ${instance.status}` : ''}
                        </SelectItem>
                      ))}
                    </Select>
                    {hasVerificationRules && (
                      <Button
                        isIconOnly
                        variant="flat"
                        onPress={() => setShowScanner(true)}
                        title="Scan asset tag"
                      >
                        <ScanLine size={18} />
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {hasVerificationRules && (
                <>
                  <Divider />
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">Asset Verification</span>
                      {!requiresSerial && (
                        <Button
                          size="sm"
                          variant="flat"
                          startContent={<ScanLine size={14} />}
                          onPress={() => setShowScanner(true)}
                        >
                          Scan Tag
                        </Button>
                      )}
                    </div>
                    
                    {scannedCode && (
                      <Card className="bg-blue-50">
                        <CardBody className="py-2">
                          <div className="flex items-center gap-2 text-xs">
                            <CheckCircle2 size={14} className="text-blue-700" />
                            <span className="text-blue-900">Scanned: {scannedCode}</span>
                          </div>
                          {scannedExpiration && (
                            <div className="ml-5 space-y-1">
                              <p className="text-xs text-blue-700">Exp: {scannedExpiration.toLocaleDateString('en-US', { month: '2-digit', year: 'numeric' })}</p>
                            </div>
                          )}
                        </CardBody>
                      </Card>
                    )}
                          {/* If admin requires expiration confirmation, allow user to confirm or edit the date here */}
                          {hasVerificationRules && (statpackItem?.verificationRules?.requireExpirationConfirmation || asset?.verificationPolicy?.requireExpirationConfirmation) && (
                            <div className="mt-2">
                              <label className="text-xs font-medium block mb-1">Confirm Expiration</label>
                              <Input
                                size="sm"
                                type="date"
                                value={confirmedExpiration ? confirmedExpiration.toISOString().slice(0,10) : (scannedExpiration ? scannedExpiration.toISOString().slice(0,10) : '')}
                                onValueChange={(v) => setConfirmedExpiration(v ? new Date(v) : null)}
                              />
                            </div>
                          )}
                    
                    {statpackItem?.verificationRules?.requireO2PsiMin !== undefined && statpackItem.verificationRules.requireO2PsiMin > 0 && (
                      <div>
                        <label className="text-xs font-medium block mb-1">
                          O₂ PSI Reading (min: {statpackItem.verificationRules.requireO2PsiMin})
                        </label>
                        <Input
                          size="sm"
                          type="number"
                          placeholder="Enter PSI"
                          value={manualO2Psi}
                          onValueChange={setManualO2Psi}
                        />
                      </div>
                    )}
                    
                    {verificationWarnings.length > 0 && (
                      <div className="space-y-2">
                        {verificationWarnings.map((warning, idx) => {
                          const Icon = warning.severity === 'critical' ? XCircle : AlertTriangle;
                          const colorClass = warning.severity === 'critical' ? 'bg-red-50' : 'bg-yellow-50';
                          const textClass = warning.severity === 'critical' ? 'text-red-700' : 'text-yellow-700';
                          
                          return (
                            <Card key={idx} className={colorClass}>
                              <CardBody className="py-2">
                                <div className="flex items-start gap-2">
                                  <Icon size={14} className={`${textClass} mt-0.5`} />
                                  <div className="flex-1">
                                    <p className={`text-xs ${textClass} font-medium`}>
                                      {warning.severity === 'critical' ? 'Critical' : 'Warning'}
                                    </p>
                                    <p className="text-xs text-gray-700">{warning.message}</p>
                                  </div>
                                  <Chip size="sm" variant="flat" color={warning.severity === 'critical' ? 'danger' : 'warning'}>
                                    {statpackItem?.verificationRules?.advisoryOnly ? 'Advisory' : 'Required'}
                                  </Chip>
                                </div>
                              </CardBody>
                            </Card>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <Divider />
                </>
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
              isLoading={loading}
              onPress={handleConfirm}
              disabled={loading || !user}
            >
              {buttonText}
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
      
      {showScanner && (
        <BarcodeScanner
          isOpen={showScanner}
          onDetected={handleScanComplete}
          onClose={() => setShowScanner(false)}
        />
      )}
    </Modal>
  );
}
