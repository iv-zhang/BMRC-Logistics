'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Input, Textarea, Card, CardBody, Chip, Select, SelectItem, Divider, Avatar, Progress } from '@heroui/react';
import type { InventoryItem, User, AssetInstance, StatpackItem, ValidationWarning } from '@/app/types';
import { checkoutAsset, checkinAsset, verifyAssetAgainstRules, findAssetByCode } from '@/app/lib/inventory';
import { parseGs1Barcode } from '@/app/lib/gs1';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/firebase';
import BarcodeScanner from './barcode-scanner';
import { ScanLine, CheckCircle2, AlertTriangle, XCircle, LogOut, LogIn, MapPin, Package, FileText, User as UserIcon, CheckCircle } from 'lucide-react';

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
  const isCheckoutMode = mode === 'checkout';
  const buttonText = isCheckoutMode ? 'Confirm Checkout' : 'Confirm Check-In';
  const ActionIcon = isCheckoutMode ? LogOut : LogIn;
  const accentColor = isCheckoutMode ? 'primary' : 'success';

  return (
    <Modal 
      isOpen={isOpen} 
      onOpenChange={onOpenChange} 
      size="lg"
      backdrop="blur"
      scrollBehavior="inside"
      placement="center"
    >
      <ModalContent>
        <ModalHeader className="flex items-center gap-3">
          <ActionIcon size={22} className={isCheckoutMode ? 'text-primary' : 'text-success'} />
          <span>{isCheckoutMode ? 'Asset Checkout' : 'Asset Check-In'}</span>
        </ModalHeader>
        <ModalBody className="gap-4 max-h-[70vh] overflow-y-auto">
          {success ? (
            <div className="flex flex-col items-center py-10 gap-4">
              <div className={`w-20 h-20 rounded-full flex items-center justify-center ${isCheckoutMode ? 'bg-primary-100' : 'bg-success-100'} animate-[scale-in_0.3s_ease-out]`}>
                <CheckCircle size={40} className={isCheckoutMode ? 'text-primary' : 'text-success'} />
              </div>
              <p className="text-lg font-semibold text-default-800">
                {isCheckoutMode ? 'Checked Out Successfully!' : 'Checked In Successfully!'}
              </p>
              <p className="text-sm text-default-500">Redirecting...</p>
            </div>
          ) : (
            <>
              {/* Asset Info Card — matching statpack card style */}
              <Card className={`${isCheckoutMode ? 'bg-blue-50/50 dark:bg-blue-900/10' : 'bg-green-50/50 dark:bg-green-900/10'}`}>
                <CardBody className="gap-3">
                  <div className="flex items-center gap-3">
                    <Avatar
                      icon={<Package />}
                      className={isCheckoutMode ? 'bg-blue-100 dark:bg-blue-900' : 'bg-green-100 dark:bg-green-900'}
                    />
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-lg text-default-800 truncate">{asset.name}</h3>
                      {asset.assetCategory && (
                        <p className="text-xs text-default-500">{asset.assetCategory}</p>
                      )}
                    </div>
                    <Chip size="sm" variant="flat" color={isCheckedOut ? 'warning' : 'success'}>
                      {asset.assetStatus || 'Unknown'}
                    </Chip>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(selectedInstance?.serial || asset.assetSerial) && (
                      <Chip size="sm" variant="flat" color="default" startContent={<ScanLine size={12} />}>
                        {selectedInstance?.serial || asset.assetSerial}
                      </Chip>
                    )}
                    {asset.currentLocation && (
                      <Chip size="sm" variant="flat" color="secondary" startContent={<MapPin size={12} />}>
                        {asset.currentLocation}
                      </Chip>
                    )}
                  </div>
                </CardBody>
              </Card>

              {requiresSerial && (
                <div>
                  <label className="text-sm font-semibold block mb-1">Asset Instance</label>
                  <div className="flex gap-2">
                    <Select
                      className="flex-1"
                      size="md"
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
                        size="md"
                        onPress={() => setShowScanner(true)}
                        title="Scan asset tag"
                      >
                        <ScanLine size={20} />
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {hasVerificationRules && (
                <>
                  <Divider />
                  <div className="space-y-3 w-full">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                      <span className="text-sm font-semibold">Asset Verification</span>
                      <div className="flex gap-2">
                        {!requiresSerial && (
                          <Button
                            size="sm"
                            variant="flat"
                            startContent={<ScanLine size={16} />}
                            onPress={() => setShowScanner(true)}
                            className="flex-1 sm:flex-none"
                          >
                            Scan Tag
                          </Button>
                        )}
                      </div>
                    </div>
                    
                    {scannedCode && (
                      <Card className="bg-blue-50 w-full">
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

                    {/* Manual barcode input for when scanning isn't possible */}
                    <div>
                      <label className="text-sm font-medium block mb-1">Barcode/Serial (if not scanning)</label>
                      <Input
                        size="md"
                        placeholder="Enter barcode or serial number"
                        value={scannedCode || ''}
                        onValueChange={(value) => {
                          setScannedCode(value);
                          // Try to parse GS1 for expiration if it's a GS1 barcode
                          if (value) {
                            const gs1Data = parseGs1Barcode(value);
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
                                const matches = findAssetByCode([asset], value);
                                if (matches.length > 0 && matches[0].instance) {
                                  setSelectedSerial(matches[0].instance.serial);
                                }
                              } catch (e) {
                                console.warn('Asset match failed', e);
                              }
                            }
                          }
                        }}
                        startContent={<ScanLine size={16} className="text-gray-400" />}
                      />
                    </div>

                    {/* If admin requires expiration confirmation, allow user to confirm or edit the date here */}
                    {hasVerificationRules && (statpackItem?.verificationRules?.requireExpirationConfirmation || asset?.verificationPolicy?.requireExpirationConfirmation) && (
                      <div className="w-full">
                        <label className="text-sm font-medium block mb-1">Confirm Expiration Date</label>
                        <Input
                          size="md"
                          type="date"
                          placeholder="MM/YYYY"
                          value={confirmedExpiration ? confirmedExpiration.toISOString().slice(0,10) : (scannedExpiration ? scannedExpiration.toISOString().slice(0,10) : '')}
                          onValueChange={(v) => setConfirmedExpiration(v ? new Date(v) : null)}
                          className="w-full"
                        />
                      </div>
                    )}
                    
                    {statpackItem?.verificationRules?.requireO2PsiMin !== undefined && statpackItem.verificationRules.requireO2PsiMin > 0 && (
                      <div className="w-full">
                        <label className="text-sm font-medium block mb-1">
                          O₂ PSI Reading (min: {statpackItem.verificationRules.requireO2PsiMin})
                        </label>
                        <Input
                          size="md"
                          type="number"
                          placeholder="Enter PSI reading"
                          value={manualO2Psi}
                          onValueChange={setManualO2Psi}
                          className="w-full"
                          inputMode="numeric"
                        />
                      </div>
                    )}
                    
                    {verificationWarnings.length > 0 && (
                      <div className="space-y-2 w-full">
                        {verificationWarnings.map((warning, idx) => {
                          const Icon = warning.severity === 'critical' ? XCircle : AlertTriangle;
                          const colorClass = warning.severity === 'critical' ? 'bg-red-50' : 'bg-yellow-50';
                          const textClass = warning.severity === 'critical' ? 'text-red-700' : 'text-yellow-700';
                          
                          return (
                            <Card key={idx} className={colorClass + ' w-full'}>
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

              {/* Member Info */}
              <Card className={`${isCheckoutMode ? 'bg-blue-50 dark:bg-blue-900/20' : 'bg-green-50 dark:bg-green-900/20'}`}>
                <CardBody className="py-3">
                  <div className="flex items-center gap-2">
                    <UserIcon size={14} className="text-default-500" />
                    <div>
                      <p className="text-xs text-default-500">
                        {isCheckoutMode ? 'Checking out as' : 'Checking in as'}
                      </p>
                      <p className="text-sm font-semibold">{user?.fullName || 'Loading...'}</p>
                    </div>
                  </div>
                </CardBody>
              </Card>

              {/* Location */}
              <Input
                label={isCheckoutMode ? 'Location — where will you use it?' : 'Return Location'}
                placeholder={isCheckoutMode ? 'e.g., Vehicle 1, Field Site A' : 'e.g., Back Room, Equipment Closet'}
                value={location}
                onValueChange={setLocation}
                startContent={<MapPin size={16} className="text-default-400" />}
                size="md"
              />

              {/* Notes */}
              <Textarea
                label="Notes (optional)"
                placeholder={isCheckoutMode ? 'e.g., Assigned to Shift A' : 'e.g., Returned in good condition'}
                value={note}
                onValueChange={setNote}
                minRows={2}
                startContent={<FileText size={16} className="text-default-400" />}
              />

              {friendlyError && (
                <Card className="bg-danger-50 border border-danger-200 w-full">
                  <CardBody className="py-2">
                    <div className="flex items-center gap-2">
                      <XCircle size={16} className="text-danger flex-shrink-0" />
                      <p className="text-danger text-sm">{friendlyError}</p>
                    </div>
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
              color={accentColor}
              isLoading={loading}
              onPress={handleConfirm}
              isDisabled={loading || !user}
              startContent={!loading && <ActionIcon size={16} />}
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
