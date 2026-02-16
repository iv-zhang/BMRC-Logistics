'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card,
  CardBody,
  CardHeader,
  Button,
  Input,
  SelectItem,
  Textarea,
  Spinner,
  Radio,
  RadioGroup,
  Divider,
} from '@heroui/react';
import {
  collection,
  onSnapshot,
  addDoc,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore';
import { db, auth } from '@/firebase';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { useUserRole } from '@/app/hooks/useUserRole';
import { ArrowLeft } from 'lucide-react';

interface InventoryItem {
  id: string;
  name: string;
  totalStockQuantity: number;
  reorderThreshold?: number;
  expirationDate?: Date;
  tracksExpiration?: boolean;
  batches?: Array<{ expirationDate?: Date }>;
}

interface DocumentData {
  name?: string;
  totalStockQuantity?: number;
  reorderThreshold?: number;
  expirationDate?: Timestamp;
  tracksExpiration?: boolean;
  batches?: Array<{ expirationDate?: Timestamp }>;
}

export default function MemberReportPage() {
  const router = useRouter();
  const { userData } = useUserRole();
  const [user, setUser] = useState<FirebaseUser | null>(null);

  // Form state
  const [reportType, setReportType] = useState<'low_stock' | 'expiration' | 'oxygen' | 'open_box' | 'damaged'>('low_stock');
  const [itemId, setItemId] = useState('');
  const [location, setLocation] = useState<'HQ/Storage' | 'Statpack' | 'Other'>('HQ/Storage');
  const [locationDetail, setLocationDetail] = useState('');
  const [frontRoom, setFrontRoom] = useState('');
  const [frontShelf, setFrontShelf] = useState('');
  const [frontLevel, setFrontLevel] = useState('');
  const [statpackName, setStatpackName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [expirationDate, setExpirationDate] = useState('');
  const [oxygenLevel, setOxygenLevel] = useState('');
  const [notes, setNotes] = useState('');

  // Data
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  // Auth check
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      if (!u) router.push('/login');
      setUser(u);
    });
    return () => unsubscribe();
  }, [router]);

  // Fetch inventory for selection
  useEffect(() => {
    const unsubscribe = onSnapshot(collection(db, 'inventory'), (snapshot) => {
      const items: InventoryItem[] = snapshot.docs.map((doc) => {
        const data = doc.data() as DocumentData;
        return {
          id: doc.id,
          name: data.name || 'Unknown Item',
          totalStockQuantity: Number(data.totalStockQuantity ?? 0),
          reorderThreshold: data.reorderThreshold,
          tracksExpiration: data.tracksExpiration,
          expirationDate: data.expirationDate instanceof Timestamp ? data.expirationDate.toDate() : undefined,
          batches: Array.isArray(data.batches)
            ? data.batches.map((b: { expirationDate?: Timestamp }) => ({
                expirationDate: b.expirationDate instanceof Timestamp ? b.expirationDate.toDate() : undefined,
              }))
            : undefined,
        };
      });
      setInventory(items);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const getItemDetails = () => {
    return inventory.find((item) => item.id === itemId);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !userData) return;

    // Validation
    if (reportType !== 'open_box' && !itemId) {
      alert('Please select an item to report.');
      return;
    }

    setSubmitting(true);
    try {
      const item = getItemDetails();
      const reportData: Record<string, unknown> = {
        type: reportType === 'low_stock' ? 'open_box_low' : reportType,
        itemId: itemId || null,
        itemName: item?.name || (reportType === 'open_box' ? 'Untracked/Open Box' : 'Unknown Item'),
        location,
        locationDetail: locationDetail || null,
        frontRoom: frontRoom || null,
        frontShelf: frontShelf || null,
        frontLevel: frontLevel ? Number(frontLevel) : null,
        userId: user.uid,
        userName: userData.fullName,
        createdAt: serverTimestamp(),
        source: 'member_report_page',
        // Flag to distinguish open box (front room) from sealed box (back room inventory)
        isOpenBoxReport: reportType === 'low_stock' || reportType === 'open_box',
      };

      // Add type-specific fields
      if (reportType === 'low_stock' && quantity) {
        reportData.quantityLeft = Number(quantity);
      }
      if ((reportType === 'expiration' || reportType === 'damaged') && expirationDate) {
        reportData.reportedExpiration = new Date(expirationDate);
      }
      if (reportType === 'oxygen' && oxygenLevel) {
        reportData.oxygenPsiLevel = Number(oxygenLevel);
      }
      if (location === 'Statpack' && statpackName) {
        reportData.statpackName = statpackName;
      }
      if (notes) {
        reportData.notes = notes;
      }

      // Add metadata
      if (item) {
        reportData.reorderThreshold = item.reorderThreshold ?? null;
        reportData.totalStockQuantity = item.totalStockQuantity ?? null;
        reportData.severity =
          reportType === 'low_stock' && item.reorderThreshold !== undefined
            ? item.totalStockQuantity <= item.reorderThreshold
              ? 'critical'
              : 'attention'
            : null;
      }

      // Normalize items array for admin UI
      const itemsArr: Array<Record<string, unknown>> = [];
      if (item) {
        itemsArr.push({
          itemId: item.id,
          name: item.name,
          observedQuantity: quantity ? Number(quantity) : null,
          requiredQuantity: item.reorderThreshold ?? null,
          note: notes || null,
        });
      }

      // Write to the shared reports collection so admins can see member reports
      reportData.items = itemsArr;
      reportData.reporter = userData.fullName || user.displayName || null;
      reportData.reporterId = user.uid;
      reportData.createdAt = serverTimestamp();
      reportData.resolved = false;
      await addDoc(collection(db, 'restock_reports'), reportData);
      setSuccess(true);
      setTimeout(() => {
        router.push('/dashboard');
      }, 1500);
    } catch (error) {
      console.error('Failed to submit report', error);
      alert('Could not submit report. Please try again.');
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-900">
        <Spinner size="lg" />
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-900">
        <Card className="max-w-md w-full mx-4">
          <CardBody className="text-center py-8 space-y-4">
            <div className="text-5xl">✓</div>
            <h2 className="text-2xl font-bold text-green-600">Report Submitted</h2>
            <p className="text-gray-600 dark:text-gray-400">Thank you for helping keep our inventory safe.</p>
            <p className="text-sm text-gray-500">Redirecting you back to the dashboard...</p>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-900 pb-20">
      {/* Header */}
      <div className="bg-white dark:bg-slate-800 sticky top-0 z-20 border-b border-gray-200 dark:border-slate-700 shadow-sm">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center gap-3">
          <Button isIconOnly size="sm" variant="light" onPress={() => router.back()}>
            <ArrowLeft size={20} />
          </Button>
          <div>
            <h1 className="text-xl font-bold">Report an Issue</h1>
            <p className="text-xs text-gray-500">Help us keep everyone safe</p>
          </div>
        </div>
      </div>

      {/* Form */}
      <div className="max-w-2xl mx-auto p-4 space-y-6">
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold">What do you want to report?</h2>
          </CardHeader>
          <Divider />
          <CardBody className="space-y-4">
            <RadioGroup value={reportType} onValueChange={(val: string) => setReportType(val as 'low_stock' | 'expiration' | 'oxygen' | 'open_box' | 'damaged')}>
              <Radio value="low_stock" className="mb-3">
                <div className="ml-2">
                  <div className="font-medium">Open Box Running Low</div>
                  <div className="text-xs text-gray-500">Front room open box needs refill from sealed box</div>
                </div>
              </Radio>
              <Radio value="expiration" className="mb-3">
                <div className="ml-2">
                  <div className="font-medium">Expiration</div>
                  <div className="text-xs text-gray-500">Item is expired or expiring soon</div>
                </div>
              </Radio>
              <Radio value="oxygen" className="mb-3">
                <div className="ml-2">
                  <div className="font-medium">Oxygen Level</div>
                  <div className="text-xs text-gray-500">Report oxygen tank PSI level</div>
                </div>
              </Radio>
              <Radio value="damaged" className="mb-3">
                <div className="ml-2">
                  <div className="font-medium">Damaged/Defective</div>
                  <div className="text-xs text-gray-500">Item is damaged or not working</div>
                </div>
              </Radio>
              <Radio value="open_box" className="mb-0">
                <div className="ml-2">
                  <div className="font-medium">Untracked/Open Box</div>
                  <div className="text-xs text-gray-500">Found items on open shelves</div>
                </div>
              </Radio>
            </RadioGroup>
          </CardBody>
        </Card>

        {/* Item Selection */}
        {reportType !== 'open_box' && (
          <Card>
            <CardHeader>
              <h3 className="text-lg font-semibold">Select Item</h3>
            </CardHeader>
            <Divider />
            <CardBody className="space-y-3">
                <div className="space-y-2">
                  <Input
                    label="Item (front room restock)"
                    placeholder="Start typing to filter items"
                    value={searchTerm}
                    onValueChange={(v) => {
                      setSearchTerm(v);
                      // Clear selection when typing a new search
                      if (v !== getItemDetails()?.name) setItemId('');
                    }}
                    onFocus={() => {}}
                  />

                  <div className="flex items-center gap-2">
                    <Button size="sm" variant={lowStockOnly ? 'solid' : 'flat'} onPress={() => setLowStockOnly((s) => !s)}>
                      {lowStockOnly ? 'Showing: Low stock only' : 'Show low stock only'}
                    </Button>
                    <div className="text-sm text-gray-500">Filter list for easier selection</div>
                  </div>

                  {/* Filtered item dropdown with dynamic height */}
                  {searchTerm && (() => {
                    const filtered = inventory
                      .filter((it) => it.name.toLowerCase().includes(searchTerm.trim().toLowerCase()))
                      .filter((it) => (lowStockOnly ? (it.reorderThreshold !== undefined ? it.totalStockQuantity <= (it.reorderThreshold ?? 0) : false) : true));

                    if (filtered.length === 0) return null;

                    const itemHeight = 56;
                    const maxVisible = Math.min(filtered.length, 8);
                    const maxH = maxVisible * itemHeight;

                    return (
                      <div style={{ maxHeight: maxH, overflowY: 'auto' }} className="border rounded-md bg-white dark:bg-slate-800 shadow-md">
                        {filtered.map((item) => (
                          <button
                            key={item.id}
                            onClick={() => {
                              setItemId(item.id);
                              setSearchTerm(item.name);
                            }}
                            className={`w-full flex flex-col p-3 border-b last:border-b-0 text-left transition-colors ${
                              itemId === item.id 
                                ? 'bg-blue-100 dark:bg-blue-900' 
                                : 'hover:bg-gray-50 dark:hover:bg-slate-700'
                            }`}
                          >
                            <span className="font-medium text-gray-900 dark:text-white">{item.name}</span>
                            <span className="text-xs text-gray-500">Stock: {item.totalStockQuantity} {item.reorderThreshold ? `/ Par: ${item.reorderThreshold}` : ''}</span>
                          </button>
                        ))}
                      </div>
                    );
                    })()}

                </div>

              {getItemDetails() && (
                <div className="bg-blue-50 dark:bg-blue-950 p-3 rounded-lg text-sm space-y-1">
                  <p>
                    <strong>Current Stock:</strong> {getItemDetails()?.totalStockQuantity}
                  </p>
                  {getItemDetails()?.reorderThreshold && (
                    <p>
                      <strong>Par Level:</strong> {getItemDetails()?.reorderThreshold}
                    </p>
                  )}
                </div>
              )}
            </CardBody>
          </Card>
        )}

        {/* Type-Specific Fields */}
        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold">Details</h3>
          </CardHeader>
          <Divider />
          <CardBody className="space-y-4">
            {reportType === 'damaged' && (
              <Input
                label="Quantity observed"
                type="number"
                placeholder="How many are left?"
                value={quantity}
                onValueChange={setQuantity}
              />
            )}



            {(reportType === 'expiration' || reportType === 'damaged') && (
              <Input
                label="Expiration date"
                type="date"
                value={expirationDate}
                onValueChange={setExpirationDate}
              />
            )}

            {reportType === 'oxygen' && (
              <Input
                label="Oxygen PSI level"
                type="number"
                placeholder="e.g. 1500"
                value={oxygenLevel}
                onValueChange={setOxygenLevel}
              />
            )}

            <div className="space-y-3">
              <label className="text-sm font-medium">Location</label>
              <div className="flex gap-2 flex-wrap">
                {(['HQ/Storage', 'Statpack', 'Other'] as const).map((loc) => (
                  <Button
                    key={loc}
                    size="sm"
                    variant={location === loc ? 'solid' : 'bordered'}
                    color={location === loc ? 'primary' : 'default'}
                    onPress={() => setLocation(loc)}
                  >
                    {loc}
                  </Button>
                ))}
              </div>
            </div>

            {location === 'Statpack' && (
              <Input
                label="Statpack name/ID"
                placeholder="e.g., Blue ALS Pack"
                value={statpackName}
                onValueChange={setStatpackName}
              />
            )}

            {location !== 'Statpack' && (
              <Input
                label="Location detail"
                placeholder="e.g., Back room shelf C, or Near main desk"
                value={locationDetail}
                onValueChange={setLocationDetail}
              />
            )}

            {/* Precise front location (room / shelf / level) */}
            {location === 'HQ/Storage' && (
              <div className="grid grid-cols-3 gap-3 bg-amber-50 dark:bg-amber-900/10 p-3 rounded-lg border border-amber-100">
                <Input
                  label="Room"
                  placeholder="e.g., Reception"
                  size="sm"
                  value={frontRoom}
                  onValueChange={setFrontRoom}
                />
                <Input
                  label="Shelf"
                  placeholder="e.g., Wall Shelf A"
                  size="sm"
                  value={frontShelf}
                  onValueChange={setFrontShelf}
                />
                <Input
                  label="Level"
                  type="number"
                  placeholder="e.g., 2"
                  size="sm"
                  value={frontLevel}
                  onValueChange={setFrontLevel}
                />
              </div>
            )}

            {location === 'Statpack' && locationDetail && (
              <Input
                label="Additional location info"
                placeholder="e.g., driver's side cabinet"
                value={locationDetail}
                onValueChange={setLocationDetail}
              />
            )}
          </CardBody>
        </Card>

        {/* Notes */}
        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold">Additional Notes</h3>
          </CardHeader>
          <Divider />
          <CardBody>
            <Textarea
              placeholder="Any other details that would be helpful?"
              value={notes}
              onValueChange={setNotes}
              minRows={4}
            />
          </CardBody>
        </Card>

        {/* Submit Button */}
        <div className="flex gap-3">
          <Button variant="light" fullWidth onPress={() => router.back()}>
            Cancel
          </Button>
          <Button
            color="primary"
            fullWidth
            size="lg"
            isLoading={submitting}
            onPress={() => handleSubmit(new Event('submit') as never)}
            isDisabled={reportType !== 'open_box' && !itemId}
          >
            Submit Report
          </Button>
        </div>
      </div>
    </div>
  );
}
