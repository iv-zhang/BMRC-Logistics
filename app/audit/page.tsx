'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Divider,
  Input,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Progress,
  Select,
  SelectItem,
  Spinner,
  Tab,
  Tabs,
  Textarea,
} from '@heroui/react';
import {
  Search,
  ClipboardCheck,
  Package,
  Box,
  AlertTriangle,
  AlertOctagon,
  CheckCircle2,
  Shield,
  BarChart3,
  ScanLine,
  RefreshCw,
  Store,
  FastForward,
  Stethoscope,
  Warehouse,
  Building2,
  MapPin,
} from 'lucide-react';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import { db } from '@/firebase';
import type { InventoryItem } from '@/app/types';
import { useUserRole } from '@/app/hooks/useUserRole';
import {
  canUserAudit,
  generateAuditSnapshot,
  submitAuditEntries,
  analyzeRestockNeeds,
  auditLog,
  type AuditSnapshot,
  type AuditEntry,
  type DisposableSnapshot,
  type AssetSnapshot,
  type RestockDecision,
} from '@/app/lib/audit-helpers';
import { determineIsAsset } from '@/app/lib/inventory';
import {
  DisposableAuditCard,
  AssetAuditCard,
} from '@/app/components/audit-item-card';
import CountControl from '@/app/components/count-control';
import ConditionToggle, { type ConditionValue } from '@/app/components/condition-toggle';
import BarcodeScanner from '@/app/components/barcode-scanner';
import AuditPermissionModal from '@/app/components/audit-permission-modal';
import AuditDebugPanel from '@/app/components/audit-debug-panel';

// ─── Zones for quick filtering ────────────────────────────────────────────────
const AUDIT_ZONES = [
  { key: 'all', label: 'All Locations' },
  { key: 'Back Room', label: 'Back Room (Inventory)' },
  { key: 'Front', label: 'Front' },
  { key: 'Forward Staging', label: 'Forward Staging' },
  { key: 'CPR Closet', label: 'CPR Closet' },
  { key: 'Shed', label: 'Shed' },
  { key: 'Office', label: 'Office' },
];

export default function AuditPage() {
  const router = useRouter();
  const { loading: authLoading, user, userData, role } = useUserRole();

  // Core state
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [snapshot, setSnapshot] = useState<AuditSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Filter state
  const [selectedZone, setSelectedZone] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<string>('overview');
  const [showVerifiedOnly, setShowVerifiedOnly] = useState(false);

  // Audit mode state
  const [auditMode, setAuditMode] = useState(false);
  const [auditIndex, setAuditIndex] = useState(0);
  const [stagedEntries, setStagedEntries] = useState<Record<string, AuditEntry>>({});
  const [showReview, setShowReview] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Barcode scanner
  const [scannerOpen, setScannerOpen] = useState(false);

  // Permission modal
  const [permModalOpen, setPermModalOpen] = useState(false);

  // Restock analysis
  const [restockDecisions, setRestockDecisions] = useState<RestockDecision[]>([]);

  // ─── Auth & permission check ──────────────────────────────────────────────
  const hasAuditAccess = useMemo(
    () => canUserAudit(userData),
    [userData]
  );
  const isAdmin = role === 'admin' || role === 'quartermaster';

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.push('/login');
      return;
    }
  }, [authLoading, user, router]);

  // ─── Load inventory (real-time) ───────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'inventory'), orderBy('name'));
    const unsub = onSnapshot(q, (snap) => {
      const items = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as any),
      })) as InventoryItem[];
      setInventory(items);
      setLoading(false);
    });
    return () => unsub();
  }, [user]);

  // ─── Generate snapshot when inventory or zone changes ─────────────────────
  useEffect(() => {
    if (inventory.length === 0) return;
    refreshSnapshot();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inventory, selectedZone]);

  const refreshSnapshot = useCallback(async () => {
    setRefreshing(true);
    try {
      const zone = selectedZone === 'all' ? undefined : selectedZone;
      const snap = await generateAuditSnapshot(zone);
      setSnapshot(snap);
      setRestockDecisions(analyzeRestockNeeds(snap.disposables));
      auditLog.info('Snapshot refreshed', {
        zone,
        disposables: snap.totalDisposableTypes,
        assets: snap.totalAssetTypes,
      });
    } catch (e) {
      auditLog.error('Failed to generate snapshot', e);
    }
    setRefreshing(false);
  }, [selectedZone]);

  // ─── Filtered items ───────────────────────────────────────────────────────
  const filteredDisposables = useMemo(() => {
    if (!snapshot) return [];
    let items = snapshot.disposables;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      items = items.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.category.toLowerCase().includes(q)
      );
    }
    if (showVerifiedOnly) {
      items = items.filter((i) => !i.auditVerified);
    }
    return items;
  }, [snapshot, searchQuery, showVerifiedOnly]);

  const filteredAssets = useMemo(() => {
    if (!snapshot) return [];
    let items = snapshot.assets;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      items = items.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.category.toLowerCase().includes(q) ||
          (i.assetSerial || '').toLowerCase().includes(q)
      );
    }
    if (showVerifiedOnly) {
      items = items.filter((i) => !i.auditVerified);
    }
    return items;
  }, [snapshot, searchQuery, showVerifiedOnly]);

  // ─── Audit mode items (disposables only for box counting) ─────────────────
  const auditItems = useMemo(() => {
    return filteredDisposables;
  }, [filteredDisposables]);

  const currentAuditItem = auditItems[auditIndex];

  // ─── Audit mode handlers ──────────────────────────────────────────────────
  const startAudit = () => {
    setStagedEntries({});
    setAuditIndex(0);
    setAuditMode(true);
    auditLog.info('Audit mode started', { zone: selectedZone, itemCount: auditItems.length });
  };

  const updateEntry = (itemId: string, patch: Partial<AuditEntry>) => {
    setStagedEntries((prev) => ({
      ...prev,
      [itemId]: {
        ...(prev[itemId] || { itemId, condition: 'Good' as const }),
        ...patch,
      },
    }));
  };

  const nextItem = () => {
    if (auditIndex < auditItems.length - 1) setAuditIndex((i) => i + 1);
  };

  const prevItem = () => {
    if (auditIndex > 0) setAuditIndex((i) => i - 1);
  };

  const handleSubmitAudit = async () => {
    if (!user) return;
    setSubmitting(true);
    try {
      const entries = Object.values(stagedEntries);
      const result = await submitAuditEntries(
        entries,
        inventory,
        {
          uid: user.uid,
          email: user.email,
          displayName: userData?.fullName || user.displayName,
        },
        selectedZone === 'all' ? 'All' : selectedZone
      );
      auditLog.info('Audit submitted', result);
      alert(
        `Audit submitted!\n${result.itemsUpdated} items updated, ${result.variances} variance(s) found.`
      );
      setAuditMode(false);
      setShowReview(false);
      setStagedEntries({});
      await refreshSnapshot();
    } catch (e: any) {
      auditLog.error('Audit submission failed', e);
      alert('Failed to submit audit: ' + (e?.message || 'Unknown error'));
    }
    setSubmitting(false);
  };

  // ─── Touch handling for swipe in audit mode ───────────────────────────────
  const touchStartX = React.useRef<number | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current == null) return;
    const endX = e.changedTouches[0]?.clientX ?? 0;
    const delta = endX - touchStartX.current;
    if (delta > 60) prevItem();
    else if (delta < -60) nextItem();
    touchStartX.current = null;
  };

  // ─── Loading / auth states ────────────────────────────────────────────────
  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!hasAuditAccess) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardBody className="text-center py-8">
            <Shield size={48} className="mx-auto text-default-400 mb-4" />
            <h2 className="text-xl font-semibold mb-2">Audit Access Required</h2>
            <p className="text-default-500 text-sm">
              You don&apos;t have permission to perform inventory audits. Ask an admin to
              grant you audit access.
            </p>
          </CardBody>
        </Card>
      </div>
    );
  }

  // ─── Audit Mode UI ───────────────────────────────────────────────────────
  if (auditMode && currentAuditItem) {
    const entry = stagedEntries[currentAuditItem.id] || {
      itemId: currentAuditItem.id,
      condition: 'Good' as const,
    };
    const stagedCount = Object.keys(stagedEntries).length;
    const progress = auditItems.length > 0 ? (stagedCount / auditItems.length) * 100 : 0;

    return (
      <div
        className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-slate-900 dark:to-slate-800 p-4"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <div className="max-w-lg mx-auto space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold flex items-center gap-2"><ClipboardCheck size={20} /> Box Count Audit</h2>
              <div className="text-sm text-default-500">
                Item {auditIndex + 1} of {auditItems.length} · {stagedCount} verified
              </div>
            </div>
            <Button size="sm" variant="flat" color="danger" onPress={() => setAuditMode(false)}>
              Exit
            </Button>
          </div>

          <Progress value={progress} size="sm" color="primary" />

          {/* Current item card */}
          <Card>
            <CardBody className="p-4 space-y-4">
              <div>
                <div className="text-xl font-bold">{currentAuditItem.name}</div>
                <div className="text-sm text-default-500">
                  {currentAuditItem.category} · {currentAuditItem.location}
                  {currentAuditItem.room ? ` — ${currentAuditItem.room}` : ''}
                </div>
              </div>

              <Divider />

              {/* System info */}
              <div className="bg-default-100 rounded-lg p-3">
                <div className="text-sm font-medium mb-1">System Record:</div>
                <div className="text-sm flex items-center gap-1">
                  <Box size={14} className="text-default-500" /> <strong>{currentAuditItem.unopenedBoxes}</strong> unopened box{currentAuditItem.unopenedBoxes !== 1 ? 'es' : ''} in back
                </div>
                {currentAuditItem.itemsPerBox > 1 && (
                  <div className="text-xs text-default-400">
                    ({currentAuditItem.itemsPerBox} items per box)
                  </div>
                )}
                {currentAuditItem.openBatchUnits > 0 && (
                  <div className="text-xs text-default-500 mt-1 flex items-center gap-1">
                    <Store size={12} /> {currentAuditItem.openBatchUnits} loose units in front (not counted)
                  </div>
                )}
              </div>

              {/* Box count input */}
              <div>
                <label className="text-sm font-medium block mb-2">
                  Count unopened boxes/bags in the back:
                </label>
                <CountControl
                  value={entry.countedBoxes ?? currentAuditItem.unopenedBoxes}
                  onChange={(v) => updateEntry(currentAuditItem.id, { countedBoxes: v })}
                  label="Boxes"
                  presets={[1, 5, 10]}
                />
                {entry.countedBoxes !== undefined &&
                  entry.countedBoxes !== currentAuditItem.unopenedBoxes && (
                    <div className="mt-1 text-xs text-warning font-medium flex items-center gap-1">
                      <AlertTriangle size={12} /> Variance:{' '}
                      {entry.countedBoxes - currentAuditItem.unopenedBoxes > 0 ? '+' : ''}
                      {entry.countedBoxes - currentAuditItem.unopenedBoxes} boxes
                    </div>
                  )}
              </div>

              {/* Condition */}
              <ConditionToggle
                value={(entry.condition as ConditionValue) || 'Good'}
                onChange={(v) => updateEntry(currentAuditItem.id, { condition: v })}
                label="Condition"
              />

              {/* Notes */}
              <Textarea
                label="Notes (optional)"
                placeholder="Any observations..."
                value={entry.notes || ''}
                onValueChange={(v) => updateEntry(currentAuditItem.id, { notes: v })}
                size="sm"
                minRows={2}
              />

              {/* Scan barcode */}
              <Button
                size="sm"
                variant="flat"
                startContent={<ScanLine size={16} />}
                onPress={() => setScannerOpen(true)}
              >
                Scan QR/Barcode
              </Button>
            </CardBody>
          </Card>

          {/* Navigation */}
          <div className="flex items-center gap-2">
            <Button
              className="flex-1"
              onPress={prevItem}
              isDisabled={auditIndex === 0}
            >
              ← Previous
            </Button>
            <Button
              className="flex-1"
              color="primary"
              onPress={() => {
                // Auto-save current if not staged
                if (!stagedEntries[currentAuditItem.id]) {
                  updateEntry(currentAuditItem.id, {
                    countedBoxes:
                      entry.countedBoxes ?? currentAuditItem.unopenedBoxes,
                    condition: entry.condition || 'Good',
                  });
                }
                if (auditIndex < auditItems.length - 1) {
                  nextItem();
                } else {
                  setShowReview(true);
                }
              }}
            >
              {auditIndex >= auditItems.length - 1 ? 'Review & Submit' : 'Next →'}
            </Button>
          </div>

          {/* Skip to review */}
          {stagedCount > 0 && (
            <Button
              variant="flat"
              color="secondary"
              fullWidth
              onPress={() => setShowReview(true)}
            >
              Review {stagedCount} Entries
            </Button>
          )}
        </div>

        {/* Review Modal */}
        <Modal isOpen={showReview} onOpenChange={setShowReview} size="full" scrollBehavior="inside">
          <ModalContent>
            <ModalHeader>Review Audit Entries</ModalHeader>
            <ModalBody>
              <div className="space-y-3">
                {Object.entries(stagedEntries).map(([id, entry]) => {
                  const item = auditItems.find((x) => x.id === id);
                  if (!item) return null;
                  const variance = (entry.countedBoxes ?? 0) - item.unopenedBoxes;
                  return (
                    <Card
                      key={id}
                      className={
                        variance !== 0 ? 'border-2 border-warning' : ''
                      }
                    >
                      <CardBody className="p-3">
                        <div className="font-semibold text-sm">{item.name}</div>
                        <div className="text-xs text-default-500 mt-1">
                          System: {item.unopenedBoxes} boxes → You counted:{' '}
                          {entry.countedBoxes ?? item.unopenedBoxes} boxes
                          {variance !== 0 && (
                            <span className="text-warning font-medium ml-1">
                              (Δ {variance > 0 ? '+' : ''}
                              {variance})
                            </span>
                          )}
                        </div>
                        <div className="text-xs mt-1">
                          Condition: {entry.condition || 'Good'}
                          {entry.notes && ` · ${entry.notes}`}
                        </div>
                      </CardBody>
                    </Card>
                  );
                })}
                {Object.keys(stagedEntries).length === 0 && (
                  <div className="text-center text-default-500 py-4">
                    No entries to review. Go back and count some items.
                  </div>
                )}
              </div>
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={() => setShowReview(false)}>
                Back to Audit
              </Button>
              <Button
                color="primary"
                onPress={handleSubmitAudit}
                isLoading={submitting}
                isDisabled={Object.keys(stagedEntries).length === 0}
              >
                Submit Audit ({Object.keys(stagedEntries).length} items)
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>

        {/* Barcode Scanner */}
        <BarcodeScanner
          isOpen={scannerOpen}
          onClose={() => setScannerOpen(false)}
          onDetected={(val) => {
            if (currentAuditItem) {
              updateEntry(currentAuditItem.id, { scannedBarcode: val });
            }
            setScannerOpen(false);
          }}
        />
      </div>
    );
  }

  // ─── Main Dashboard UI ───────────────────────────────────────────────────
  const verifiedDisposables = snapshot
    ? snapshot.disposables.filter((d) => d.auditVerified).length
    : 0;
  const verifiedAssets = snapshot
    ? snapshot.assets.filter((a) => a.auditVerified).length
    : 0;
  const totalItems =
    (snapshot?.totalDisposableTypes ?? 0) + (snapshot?.totalAssetTypes ?? 0);
  const totalVerified = verifiedDisposables + verifiedAssets;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-slate-900 dark:to-slate-800">
      <div className="max-w-7xl mx-auto p-4 md:p-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <ClipboardCheck size={28} /> Supply Audit
            </h1>
            <p className="text-sm text-default-500 mt-1">
              Box-based inventory audit · Disposables are counted as unopened boxes in the back
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              variant="flat"
              startContent={<RefreshCw size={14} />}
              onPress={refreshSnapshot}
              isLoading={refreshing}
            >
              Refresh
            </Button>
            {isAdmin && (
              <Button
                size="sm"
                variant="flat"
                startContent={<Shield size={14} />}
                onPress={() => setPermModalOpen(true)}
              >
                Permissions
              </Button>
            )}
            <Button
              color="primary"
              startContent={<ClipboardCheck size={16} />}
              onPress={startAudit}
              isDisabled={auditItems.length === 0}
            >
              Start Box Audit
            </Button>
          </div>
        </div>

        {/* Summary cards */}
        {snapshot && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card>
              <CardBody className="p-3 text-center">
                <div className="text-2xl font-bold text-primary">
                  {snapshot.totalDisposableTypes}
                </div>
                <div className="text-xs text-default-500">Disposable Types</div>
              </CardBody>
            </Card>
            <Card>
              <CardBody className="p-3 text-center">
                <div className="text-2xl font-bold text-secondary">
                  {snapshot.totalAssetTypes}
                </div>
                <div className="text-xs text-default-500">Asset Types</div>
              </CardBody>
            </Card>
            <Card>
              <CardBody className="p-3 text-center">
                <div className="text-2xl font-bold text-warning">
                  {snapshot.lowStockCount}
                </div>
                <div className="text-xs text-default-500">Low Stock</div>
              </CardBody>
            </Card>
            <Card>
              <CardBody className="p-3 text-center">
                <div className="text-2xl font-bold text-success">
                  {totalVerified}/{totalItems}
                </div>
                <div className="text-xs text-default-500">Verified</div>
              </CardBody>
            </Card>
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <Select
            label="Zone"
            selectedKeys={[selectedZone]}
            onSelectionChange={(keys) => {
              const v = Array.from(keys)[0] as string;
              setSelectedZone(v || 'all');
            }}
            size="sm"
            className="sm:max-w-[240px]"
          >
            {AUDIT_ZONES.map((z) => (
              <SelectItem key={z.key}>{z.label}</SelectItem>
            ))}
          </Select>
          <Input
            placeholder="Search items..."
            value={searchQuery}
            onValueChange={setSearchQuery}
            startContent={<Search size={16} />}
            size="sm"
            className="flex-1"
            isClearable
            onClear={() => setSearchQuery('')}
          />
          <Button
            size="sm"
            variant={showVerifiedOnly ? 'solid' : 'flat'}
            color={showVerifiedOnly ? 'warning' : 'default'}
            onPress={() => setShowVerifiedOnly(!showVerifiedOnly)}
          >
            {showVerifiedOnly ? 'Showing Unverified' : 'Show Unverified Only'}
          </Button>
        </div>

        {/* Tabs */}
        <Tabs
          selectedKey={activeTab}
          onSelectionChange={(key) => setActiveTab(key as string)}
          variant="underlined"
        >
          <Tab key="overview" title={<span className="flex items-center gap-1"><Box size={14} /> Disposables ({filteredDisposables.length})</span>}>
            <div className="space-y-3 mt-4">
              {filteredDisposables.length === 0 ? (
                <div className="text-center text-default-500 py-8">
                  No disposable items found
                  {searchQuery && ' matching your search'}
                  {selectedZone !== 'all' && ` in ${selectedZone}`}
                </div>
              ) : (
                filteredDisposables.map((item) => (
                  <DisposableAuditCard
                    key={item.id}
                    item={item}
                    onAudit={(d) => {
                      const idx = auditItems.findIndex((x) => x.id === d.id);
                      if (idx >= 0) {
                        setAuditIndex(idx);
                        setAuditMode(true);
                      }
                    }}
                  />
                ))
              )}
            </div>
          </Tab>

          <Tab key="assets" title={<span className="flex items-center gap-1"><Package size={14} /> Assets ({filteredAssets.length})</span>}>
            <div className="space-y-3 mt-4">
              {filteredAssets.length === 0 ? (
                <div className="text-center text-default-500 py-8">
                  No assets found
                  {searchQuery && ' matching your search'}
                </div>
              ) : (
                filteredAssets.map((item) => (
                  <AssetAuditCard key={item.id} item={item} />
                ))
              )}
            </div>
          </Tab>

          <Tab key="restock" title={<span className="flex items-center gap-1"><AlertTriangle size={14} /> Restock Needed ({restockDecisions.length})</span>}>
            <div className="space-y-3 mt-4">
              {restockDecisions.length === 0 ? (
                <div className="text-center py-8">
                  <CheckCircle2 size={48} className="mx-auto text-success mb-3" />
                  <div className="text-default-500">All stock levels are adequate!</div>
                </div>
              ) : (
                restockDecisions.map((d) => (
                  <Card
                    key={d.itemId}
                    className={
                      d.urgency === 'critical'
                        ? 'border-2 border-danger'
                        : 'border border-warning'
                    }
                  >
                    <CardBody className="p-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="font-semibold">{d.itemName}</div>
                          <div className="text-sm text-default-500 flex items-center gap-1">
                            <Box size={14} /> {d.unopenedBoxes} boxes · Par: {d.reorderThreshold} · Deficit: {d.deficit}
                          </div>
                        </div>
                        <Chip
                          size="sm"
                          color={d.urgency === 'critical' ? 'danger' : 'warning'}
                          startContent={d.urgency === 'critical' ? <AlertOctagon size={12} /> : <AlertTriangle size={12} />}
                        >
                          {d.urgency === 'critical' ? 'Critical' : 'Low'}
                        </Chip>
                      </div>
                      <div className="text-xs text-default-400 mt-1">
                        {d.recommendation}
                      </div>
                    </CardBody>
                  </Card>
                ))
              )}
            </div>
          </Tab>

          <Tab key="history" title={<span className="flex items-center gap-1"><BarChart3 size={14} /> History</span>}>
            <div className="mt-4">
              <Card>
                <CardBody className="text-center py-8">
                  <p className="text-default-500">
                    View the full audit ledger at{' '}
                    <Button
                      size="sm"
                      variant="flat"
                      onPress={() => router.push('/audit/events')}
                    >
                      Audit Events →
                    </Button>
                  </p>
                </CardBody>
              </Card>
            </div>
          </Tab>
        </Tabs>
      </div>

      {/* Permission modal */}
      {isAdmin && userData && (
        <AuditPermissionModal
          isOpen={permModalOpen}
          onClose={() => setPermModalOpen(false)}
          adminUser={{ id: user!.uid, name: userData.fullName }}
        />
      )}

      {/* Barcode Scanner */}
      <BarcodeScanner
        isOpen={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDetected={(val) => {
          setScannerOpen(false);
          setSearchQuery(val);
        }}
      />

      {/* Debug panel (admin only — toggle with ⌘+Shift+D) */}
      {isAdmin && (
        <AuditDebugPanel
          inventory={inventory}
          snapshot={snapshot}
          userRole={role ?? 'unknown'}
          canAudit={hasAuditAccess}
        />
      )}
    </div>
  );
}
