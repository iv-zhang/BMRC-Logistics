'use client';

import React, { useState, useEffect, useMemo } from 'react';
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
  Divider,
  Tabs,
  Tab,
  Avatar,
} from '@heroui/react';
import {
  Pill,
  LogOut,
  LogIn,
  AlertTriangle,
  ClipboardList,
  ShieldAlert,
  Calendar,
  Hash,
  User as UserIcon,
  FileText,
  CheckCircle,
  XCircle,
  Clock,
  Package,
} from 'lucide-react';
import type { InventoryItem, MedicationLog } from '@/app/types';
import { addDoc, collection, query, where, orderBy, onSnapshot, serverTimestamp, Timestamp, getDocs, limit } from 'firebase/firestore';
import { db } from '@/firebase';

interface MedicationCabinetModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  medication: InventoryItem | null;
  userId: string;
  userName: string;
  onComplete?: () => void;
}

type MedAction = MedicationLog['action'];

const ACTION_LABELS: Record<MedAction, { label: string; color: 'primary' | 'success' | 'warning' | 'danger' | 'secondary'; icon: typeof LogOut }> = {
  check_out: { label: 'Check Out', color: 'primary', icon: LogOut },
  check_in: { label: 'Check In', color: 'success', icon: LogIn },
  administered: { label: 'Administered', color: 'warning', icon: Pill },
  wasted: { label: 'Wasted', color: 'danger', icon: XCircle },
  expired_disposal: { label: 'Expired Disposal', color: 'danger', icon: Calendar },
  inventory_count: { label: 'Inventory Count', color: 'secondary', icon: ClipboardList },
  received: { label: 'Received', color: 'success', icon: Package },
};

export default function MedicationCabinetModal({
  isOpen,
  onOpenChange,
  medication,
  userId,
  userName,
  onComplete,
}: MedicationCabinetModalProps) {
  const [activeTab, setActiveTab] = useState<string>('transaction');
  const [action, setAction] = useState<MedAction>('check_out');
  const [lotNumber, setLotNumber] = useState('');
  const [expirationDate, setExpirationDate] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [witnessName, setWitnessName] = useState('');
  const [witnessId, setWitnessId] = useState('');
  const [location, setLocation] = useState('');
  const [reason, setReason] = useState('');
  const [pcrNumber, setPcrNumber] = useState('');
  const [concentration, setConcentration] = useState('');
  const [route, setRoute] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Log history
  const [logs, setLogs] = useState<MedicationLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  // Pre-fill medication info
  useEffect(() => {
    if (isOpen && medication) {
      setConcentration(medication.medicationInfo?.concentration || '');
      setRoute(medication.medicationInfo?.route || '');
      setError(null);
      setSuccess(false);
      setAction('check_out');
      setLotNumber('');
      setExpirationDate('');
      setQuantity('1');
      setWitnessName('');
      setWitnessId('');
      setLocation('');
      setReason('');
      setPcrNumber('');
      setNotes('');
    }
  }, [isOpen, medication]);

  // Fetch log history
  useEffect(() => {
    if (!isOpen || !medication) return;
    setLogsLoading(true);
    const q = query(
      collection(db, 'medication_logs'),
      where('medicationId', '==', medication.id),
      orderBy('timestamp', 'desc'),
      limit(50)
    );
    const unsub = onSnapshot(q, (snap) => {
      const entries: MedicationLog[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          ...data,
          timestamp: data.timestamp instanceof Timestamp ? data.timestamp.toDate() : new Date(),
          expirationDate: data.expirationDate instanceof Timestamp ? data.expirationDate.toDate() : (data.expirationDate ? new Date(data.expirationDate) : new Date()),
        } as MedicationLog;
      });
      setLogs(entries);
      setLogsLoading(false);
    }, () => setLogsLoading(false));
    return () => unsub();
  }, [isOpen, medication]);

  // Compute running count from last log
  const lastRunningCount = useMemo(() => {
    if (logs.length === 0) return medication?.unopenedBoxes ?? 0;
    return logs[0].runningCount ?? 0;
  }, [logs, medication]);

  const requiresWitness = medication?.medicationInfo?.requiresWitness || medication?.medicationInfo?.isControlled;

  const handleSubmit = async () => {
    if (!medication) return;

    // Validation
    if (!lotNumber.trim()) {
      setError('Lot number is required for all medication transactions');
      return;
    }
    if (!expirationDate) {
      setError('Expiration date is required');
      return;
    }
    const qty = parseInt(quantity, 10);
    if (isNaN(qty) || qty < 1) {
      setError('Quantity must be at least 1');
      return;
    }
    if (requiresWitness && !witnessName.trim() && action !== 'inventory_count' && action !== 'received') {
      setError('A witness/cosigner is required for this controlled substance');
      return;
    }
    if ((action === 'administered' || action === 'wasted') && !reason.trim()) {
      setError('A reason is required for this action');
      return;
    }

    // Compute new running count
    let newRunningCount = lastRunningCount;
    if (action === 'check_out' || action === 'administered' || action === 'wasted' || action === 'expired_disposal') {
      newRunningCount -= qty;
    } else if (action === 'check_in' || action === 'received') {
      newRunningCount += qty;
    } else if (action === 'inventory_count') {
      newRunningCount = qty; // Manual count override
    }

    if (newRunningCount < 0 && action !== 'inventory_count') {
      setError(`Cannot ${ACTION_LABELS[action].label.toLowerCase()} ${qty} — only ${lastRunningCount} in stock`);
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const logEntry: Omit<MedicationLog, 'id'> = {
        medicationId: medication.id,
        medicationName: medication.name,
        action,
        lotNumber: lotNumber.trim(),
        expirationDate: new Date(expirationDate),
        quantity: qty,
        runningCount: newRunningCount,
        performedBy: { userId, userName },
        timestamp: serverTimestamp() as any,
      };

      if (witnessName.trim()) {
        logEntry.witness = { userId: witnessId || 'manual', userName: witnessName.trim() };
      }
      if (location.trim()) logEntry.location = location.trim();
      if (reason.trim()) logEntry.reason = reason.trim();
      if (pcrNumber.trim()) logEntry.pcrNumber = pcrNumber.trim();
      if (concentration.trim()) logEntry.concentration = concentration.trim();
      if (route.trim()) logEntry.route = route.trim();
      if (notes.trim()) logEntry.notes = notes.trim();

      await addDoc(collection(db, 'medication_logs'), logEntry);

      setSuccess(true);
      setTimeout(() => {
        setSuccess(false);
        setActiveTab('log');
        onComplete?.();
      }, 1500);
    } catch (e) {
      console.error('Medication log failed:', e);
      setError(e instanceof Error ? e.message : 'Failed to record transaction');
    } finally {
      setSubmitting(false);
    }
  };

  if (!medication) return null;

  const isControlled = medication.medicationInfo?.isControlled;
  const medInfo = medication.medicationInfo;

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="2xl" backdrop="blur" placement="center" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${isControlled ? 'bg-danger-100' : 'bg-primary-100'}`}>
            {isControlled ? <ShieldAlert size={20} className="text-danger" /> : <Pill size={20} className="text-primary" />}
          </div>
          <div>
            <p className="text-lg font-bold">{medication.name}</p>
            <div className="flex items-center gap-2">
              {isControlled && (
                <Chip size="sm" color="danger" variant="flat">
                  Schedule {medInfo?.deaSchedule || 'Controlled'}
                </Chip>
              )}
              {medInfo?.concentration && (
                <Chip size="sm" variant="flat" color="secondary">{medInfo.concentration}</Chip>
              )}
              <Chip size="sm" variant="flat" color="default">
                Stock: {lastRunningCount}
              </Chip>
            </div>
          </div>
        </ModalHeader>

        <ModalBody className="gap-3">
          <Tabs
            selectedKey={activeTab}
            onSelectionChange={(key) => setActiveTab(String(key))}
            color="primary"
            variant="solid"
            classNames={{ tabList: 'w-full' }}
          >
            {/* ── Transaction Tab ── */}
            <Tab key="transaction" title={<div className="flex items-center gap-2"><ClipboardList size={14} />New Transaction</div>}>
              <div className="space-y-4 mt-3 max-h-[55vh] overflow-y-auto px-1">
                {success && (
                  <Card className="bg-success-50">
                    <CardBody className="flex flex-row items-center gap-3 py-3">
                      <CheckCircle size={20} className="text-success" />
                      <p className="text-success font-semibold">Transaction recorded successfully!</p>
                    </CardBody>
                  </Card>
                )}

                {error && (
                  <Card className="bg-danger-50 border border-danger-200">
                    <CardBody className="py-2">
                      <div className="flex items-center gap-2">
                        <AlertTriangle size={14} className="text-danger flex-shrink-0" />
                        <p className="text-sm text-danger">{error}</p>
                      </div>
                    </CardBody>
                  </Card>
                )}

                {/* Action Select */}
                <Select
                  label="Transaction Type"
                  selectedKeys={[action]}
                  onChange={(e) => setAction(e.target.value as MedAction)}
                  isRequired
                  size="md"
                >
                  {Object.entries(ACTION_LABELS).map(([key, val]) => (
                    <SelectItem key={key}>{val.label}</SelectItem>
                  ))}
                </Select>

                {/* Lot Number + Expiration — ALWAYS required */}
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label="Lot Number"
                    placeholder="e.g., L2025-A123"
                    value={lotNumber}
                    onValueChange={setLotNumber}
                    isRequired
                    startContent={<Hash size={14} className="text-default-400" />}
                    size="md"
                  />
                  <Input
                    label="Expiration Date"
                    type="date"
                    value={expirationDate}
                    onValueChange={setExpirationDate}
                    isRequired
                    startContent={<Calendar size={14} className="text-default-400" />}
                    size="md"
                  />
                </div>

                {/* Expiration warning */}
                {expirationDate && new Date(expirationDate).getTime() < Date.now() && (
                  <Card className="bg-danger-50 border border-danger-200">
                    <CardBody className="py-2">
                      <div className="flex items-center gap-2">
                        <AlertTriangle size={14} className="text-danger" />
                        <p className="text-xs text-danger font-semibold">This medication is EXPIRED!</p>
                      </div>
                    </CardBody>
                  </Card>
                )}

                {expirationDate && (() => {
                  const daysUntil = Math.ceil((new Date(expirationDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                  if (daysUntil > 0 && daysUntil <= 90) {
                    return (
                      <Card className="bg-warning-50 border border-warning-200">
                        <CardBody className="py-2">
                          <div className="flex items-center gap-2">
                            <Clock size={14} className="text-warning" />
                            <p className="text-xs text-warning-700 font-medium">
                              Expiring in {daysUntil} day{daysUntil !== 1 ? 's' : ''}
                            </p>
                          </div>
                        </CardBody>
                      </Card>
                    );
                  }
                  return null;
                })()}

                {/* Quantity */}
                <Input
                  label={action === 'inventory_count' ? 'Counted Quantity (this becomes the new total)' : 'Quantity'}
                  type="number"
                  min="1"
                  value={quantity}
                  onValueChange={setQuantity}
                  inputMode="numeric"
                  isRequired
                  size="md"
                  description={action !== 'inventory_count' ? `Current stock: ${lastRunningCount}` : undefined}
                />

                {/* Concentration + Route confirmation */}
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    label="Concentration"
                    placeholder="e.g., 1mg/1mL"
                    value={concentration}
                    onValueChange={setConcentration}
                    size="sm"
                  />
                  <Input
                    label="Route"
                    placeholder="e.g., IM, IV, SQ"
                    value={route}
                    onValueChange={setRoute}
                    size="sm"
                  />
                </div>

                {/* Reason (required for administered/wasted) */}
                {(action === 'administered' || action === 'wasted' || action === 'expired_disposal') && (
                  <Textarea
                    label="Reason"
                    placeholder={action === 'administered' ? 'Patient complaint, protocol followed...' : 'Reason for waste/disposal...'}
                    value={reason}
                    onValueChange={setReason}
                    isRequired
                    minRows={2}
                    size="md"
                  />
                )}

                {/* PCR Number (for administered) */}
                {action === 'administered' && (
                  <Input
                    label="PCR / Incident Number"
                    placeholder="e.g., PCR-2025-001"
                    value={pcrNumber}
                    onValueChange={setPcrNumber}
                    startContent={<FileText size={14} className="text-default-400" />}
                    size="md"
                  />
                )}

                {/* Witness / Cosigner */}
                {requiresWitness && action !== 'inventory_count' && action !== 'received' && (
                  <Card className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200">
                    <CardBody className="gap-2">
                      <div className="flex items-center gap-2">
                        <ShieldAlert size={14} className="text-amber-700" />
                        <p className="text-xs font-semibold text-amber-800 dark:text-amber-200">
                          Witness Required — Controlled Substance
                        </p>
                      </div>
                      <Input
                        label="Witness Name"
                        placeholder="Full name of witness"
                        value={witnessName}
                        onValueChange={setWitnessName}
                        isRequired
                        startContent={<UserIcon size={14} className="text-default-400" />}
                        size="md"
                      />
                    </CardBody>
                  </Card>
                )}

                {/* Location */}
                <Input
                  label="Location"
                  placeholder="e.g., Ambulance 1, Med Cabinet A"
                  value={location}
                  onValueChange={setLocation}
                  size="sm"
                />

                {/* Notes */}
                <Textarea
                  label="Additional Notes"
                  placeholder="Any additional details..."
                  value={notes}
                  onValueChange={setNotes}
                  minRows={2}
                  size="sm"
                />

                {/* Performer info */}
                <Card className="bg-default-50">
                  <CardBody className="py-2">
                    <p className="text-xs text-default-500">
                      Recorded by: <strong>{userName}</strong> • {new Date().toLocaleString()}
                    </p>
                  </CardBody>
                </Card>
              </div>
            </Tab>

            {/* ── Log History Tab ── */}
            <Tab key="log" title={<div className="flex items-center gap-2"><ClipboardList size={14} />Narcotic Log</div>}>
              <div className="space-y-2 mt-3 max-h-[55vh] overflow-y-auto px-1">
                {medInfo?.storageRequirements && (
                  <Card className="bg-blue-50 dark:bg-blue-900/20">
                    <CardBody className="py-2">
                      <p className="text-xs text-blue-700 dark:text-blue-300">
                        <strong>Storage:</strong> {medInfo.storageRequirements}
                      </p>
                    </CardBody>
                  </Card>
                )}

                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold">Transaction History</p>
                  <Chip size="sm" variant="flat" color="default">
                    {logs.length} entries
                  </Chip>
                </div>

                {logsLoading ? (
                  <p className="text-sm text-default-500 text-center py-4">Loading...</p>
                ) : logs.length === 0 ? (
                  <Card className="bg-default-50">
                    <CardBody className="text-center py-6">
                      <p className="text-sm text-default-500">No transactions recorded yet</p>
                    </CardBody>
                  </Card>
                ) : (
                  <div className="space-y-2">
                    {/* Table header */}
                    <div className="grid grid-cols-12 gap-1 text-xs font-semibold text-default-500 px-2 py-1 bg-default-100 rounded">
                      <div className="col-span-2">Date</div>
                      <div className="col-span-2">Action</div>
                      <div className="col-span-2">Lot #</div>
                      <div className="col-span-1">Qty</div>
                      <div className="col-span-1">Count</div>
                      <div className="col-span-2">By</div>
                      <div className="col-span-2">Witness</div>
                    </div>
                    {logs.map((log) => {
                      const actionInfo = ACTION_LABELS[log.action] || { label: log.action, color: 'default' as const };
                      const ts = log.timestamp instanceof Date ? log.timestamp : new Date();
                      return (
                        <Card key={log.id} className="bg-default-50 hover:bg-default-100 transition-colors">
                          <CardBody className="py-2 px-2">
                            <div className="grid grid-cols-12 gap-1 items-center text-xs">
                              <div className="col-span-2 text-default-600">
                                {ts.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                                <br />
                                <span className="text-default-400">{ts.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
                              </div>
                              <div className="col-span-2">
                                <Chip size="sm" variant="flat" color={actionInfo.color}>
                                  {actionInfo.label}
                                </Chip>
                              </div>
                              <div className="col-span-2 font-mono text-default-600 truncate">{log.lotNumber}</div>
                              <div className="col-span-1 font-semibold">{log.quantity}</div>
                              <div className="col-span-1 font-bold text-primary">{log.runningCount}</div>
                              <div className="col-span-2 text-default-600 truncate">{log.performedBy?.userName || '—'}</div>
                              <div className="col-span-2 text-default-500 truncate">{log.witness?.userName || '—'}</div>
                            </div>
                            {(log.reason || log.notes || log.pcrNumber) && (
                              <div className="mt-1 pt-1 border-t border-default-200 text-xs text-default-500">
                                {log.reason && <p><strong>Reason:</strong> {log.reason}</p>}
                                {log.pcrNumber && <p><strong>PCR:</strong> {log.pcrNumber}</p>}
                                {log.notes && <p><strong>Notes:</strong> {log.notes}</p>}
                              </div>
                            )}
                          </CardBody>
                        </Card>
                      );
                    })}
                  </div>
                )}
              </div>
            </Tab>
          </Tabs>
        </ModalBody>

        <ModalFooter>
          <Button variant="light" onPress={() => onOpenChange(false)}>
            Close
          </Button>
          {activeTab === 'transaction' && !success && (
            <Button
              color={ACTION_LABELS[action]?.color || 'primary'}
              isLoading={submitting}
              onPress={handleSubmit}
              startContent={!submitting && (() => {
                const IconComp = ACTION_LABELS[action]?.icon || LogOut;
                return <IconComp size={16} />;
              })()}
            >
              Record {ACTION_LABELS[action]?.label || 'Transaction'}
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
