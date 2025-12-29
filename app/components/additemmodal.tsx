'use client';
import React, { useState, useEffect, useRef } from 'react';
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, 
  Input, Select, SelectItem, Switch, Textarea, Divider, Slider
} from '@heroui/react';
import { Trash2, Plus, Info, Box, Wind, CalendarClock, GripVertical } from 'lucide-react';

import { InventoryItem, ItemCategory, LocationType, HQRoom, InventoryVariant, InventoryBatch } from '@/app/types'; 

// Constants for Dropdowns
const CATEGORIES: ItemCategory[] = ['Airway', 'Trauma', 'Vitals', 'Meds', 'PPE', 'Splinting', 'Hygiene', 'Other'];
const LOCATIONS: LocationType[] = ['HQ', 'CPR Closet', 'Shed'];
const HQ_ROOMS: HQRoom[] = ['Front', 'Middle', 'Back', 'Office'];

interface InventoryModalProps {
  isOpen: boolean;
  onOpenChange: () => void;
  onAddItem: (item: Partial<InventoryItem>) => void;
  onUpdateItem: (id: string, item: Partial<InventoryItem>) => void;
  initialData?: InventoryItem | null;
  canToggleExpiration?: boolean;
}

// Extend state to hold new fields
type InventoryFormState = Partial<Omit<InventoryItem, 'totalStockQuantity' | 'reorderThreshold'>> & {
  totalStockQuantity?: number | string;
  reorderThreshold?: number | string;
  variants: InventoryVariant[];
  batches?: InventoryBatch[];
  // New State Fields
  unopenedQuantity?: number | string;
  openedQuantity?: number | string;
  quantityPerUnit?: number | string;
  oxygenPsi?: number;
  maxOxygenPsi?: number;
};

const DEFAULT_STATE: InventoryFormState = {
  name: '',
  category: 'Other',
  location: 'HQ',
  room: 'Middle',
  shelf: '',
  totalStockQuantity: 0,
  unit: 'count',
  reorderThreshold: 5,
  isDisposable: true,
  description: '',
  hasVariants: false,
  variants: [],
  // New Defaults
  tracksOpenStock: false,
  unopenedQuantity: 0,
  openedQuantity: 0,
  quantityPerUnit: 1, // Default 1 item per unit
  isOxygen: false,
  oxygenPsi: 2000,
  maxOxygenPsi: 2000,
  // expiration tracking removed at top-level; batch expirations are authoritative
  openedAt: undefined
  ,
  batches: []
};

export default function InventoryModal({ 
  isOpen, 
  onOpenChange, 
  onAddItem, 
  onUpdateItem,
  initialData,
  canToggleExpiration = false
}: InventoryModalProps) {
  // Helper for stable unique IDs (prefers crypto.randomUUID when available)
  const uniqueId = () => (typeof crypto !== 'undefined' && (crypto as any).randomUUID ? (crypto as any).randomUUID() : `${Date.now().toString()}-${Math.random().toString(36).slice(2,9)}`);
  
  const getInitialFormData = (data?: InventoryItem | null): InventoryFormState => {
    if (!data) return DEFAULT_STATE;
    const variants = data.variants || [];
    const batches = data.batches || [];
    return {
      ...DEFAULT_STATE,
      ...data,
      // do not infer top-level expiration; batches hold expirations
      variants,
      hasVariants: data.hasVariants || variants.length > 0,
      // Map new fields or fallback to defaults
      tracksOpenStock: data.tracksOpenStock || false,
      unopenedQuantity: data.unopenedQuantity ?? data.totalStockQuantity,
      openedQuantity: data.openedQuantity ?? 0,
      quantityPerUnit: data.quantityPerUnit ?? 1,
      isOxygen: data.isOxygen || false,
      oxygenPsi: data.oxygenPsi ?? 2000,
      maxOxygenPsi: data.maxOxygenPsi ?? 2000,
      // secondary expiration (per-item) removed
      openedAt: data.openedAt ? new Date(data.openedAt) : undefined,
      batches,
    };
  };

  const [formData, setFormData] = useState<InventoryFormState>(() => getInitialFormData(initialData));

  // Reset or update form when modal opens/closes or initialData changes
  useEffect(() => {
    if (isOpen) {
        setFormData(getInitialFormData(initialData));
    }
  }, [isOpen, initialData]);

  const handleValueChange = (field: keyof InventoryFormState) => (value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  // --- VARIANT LOGIC ---
  const addVariant = () => {
    const newVariant: InventoryVariant = {
      id: uniqueId(),
      name: '',
      quantityPerUnit: 1, 
      stock: 0,
      reorderThreshold: 0
    };
    setFormData(prev => ({
      ...prev,
      variants: [...prev.variants, newVariant]
    }));
  };

  const removeVariant = (id: string) => {
    setFormData(prev => ({
      ...prev,
      variants: prev.variants.filter(v => v.id !== id)
    }));
  };

  const updateVariant = (id: string, field: keyof InventoryVariant, value: string | number) => {
    setFormData(prev => ({
      ...prev,
      variants: prev.variants.map(v => {
        if (v.id === id) {
          return { ...v, [field]: value };
        }
        return v;
      })
    }));
  };

  // --- BATCH / LOT LOGIC ---
  const addBatch = () => {
    const newBatch: InventoryBatch = {
      id: uniqueId(),
      lotNumber: '',
      expirationDate: undefined,
      stock: 0,
      locations: [],
    } as InventoryBatch;
    setFormData(prev => ({ ...prev, batches: [...(prev.batches || []), newBatch] }));
  };

  const removeBatch = (id: string) => {
    setFormData(prev => ({ ...prev, batches: (prev.batches || []).filter(b => b.id !== id) }));
  };

  const updateBatch = (id: string, field: keyof InventoryBatch, value: any) => {
    setFormData(prev => ({
      ...prev,
      batches: (prev.batches || []).map(b => b.id === id ? ({ ...b, [field]: value }) : b)
    }));
  };

  const addBatchLocation = (batchId: string) => {
    setFormData(prev => ({
      ...prev,
      batches: (prev.batches || []).map(b => {
        if (b.id !== batchId) return b;
        const locations = b.locations || [];
        return {
          ...b,
          locations: [...locations, { id: uniqueId(), name: '', quantity: 0 }]
        };
      })
    }));
  };

  const updateBatchLocation = (batchId: string, locId: string, field: 'name' | 'quantity', value: any) => {
    setFormData(prev => ({
      ...prev,
      batches: (prev.batches || []).map(b => {
        if (b.id !== batchId) return b;
        const locations = (b.locations || []).map(l => l.id === locId ? ({ ...l, [field]: field === 'quantity' ? Number(value) : value }) : l);
        return { ...b, locations };
      })
    }));
  };

  const removeBatchLocation = (batchId: string, locId: string) => {
    setFormData(prev => ({
      ...prev,
      batches: (prev.batches || []).map(b => {
        if (b.id !== batchId) return b;
        return { ...b, locations: (b.locations || []).filter(l => l.id !== locId) };
      })
    }));
  };

  // --- DRAG & DROP FOR REORDERING VARIANTS ---
  const dragIndex = useRef<number | null>(null);
  const dragOverIndex = useRef<number | null>(null);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const handleDragStart = (e: React.DragEvent, index: number) => {
    dragIndex.current = index;
    setDraggingIdx(index);
    setDragOverIdx(null);
    try { e.dataTransfer?.setData('text/plain', String(index)); } catch {}
    e.dataTransfer!.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    dragOverIndex.current = index;
    setDragOverIdx(index);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const from = dragIndex.current ?? Number(e.dataTransfer?.getData('text/plain'));
    const to = dragOverIndex.current ?? from;
    if (from == null || to == null) {
      dragIndex.current = null;
      dragOverIndex.current = null;
      setDraggingIdx(null);
      setDragOverIdx(null);
      return;
    }

    setFormData(prev => {
      const arr = [...prev.variants];
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      return { ...prev, variants: arr };
    });

    dragIndex.current = null;
    dragOverIndex.current = null;
    setDraggingIdx(null);
    setDragOverIdx(null);
  };

  const handleDragEnd = () => {
    dragIndex.current = null;
    dragOverIndex.current = null;
    setDraggingIdx(null);
    setDragOverIdx(null);
  };

  // --- OPEN/CONSUME BOX HELPERS ---
  const [consumeCount, setConsumeCount] = useState<number>(1);

  const computeTotalItems = (sealedBoxes: number, openItems: number, qtyPerBox: number) => {
    return (sealedBoxes || 0) * (qtyPerBox || 1) + (openItems || 0);
  };

  const openBoxAction = () => {
    setFormData(prev => {
      const sealed = Number(prev.unopenedQuantity ?? 0);
      if (sealed <= 0) return prev;
      const qty = Number(prev.quantityPerUnit ?? 1);
      return {
        ...prev,
        unopenedQuantity: sealed - 1,
        openedQuantity: Number(prev.openedQuantity ?? 0) + qty,
        openedAt: prev.openedAt ?? new Date()
      };
    });
  };

  const consumeItemsAction = (count: number) => {
    setFormData(prev => {
      let sealed = Number(prev.unopenedQuantity ?? 0);
      let open = Number(prev.openedQuantity ?? 0);
      const qtyPer = Number(prev.quantityPerUnit ?? 1);
      let toConsume = Math.max(0, Math.floor(count));

      // consume from open items first
      const usedFromOpen = Math.min(open, toConsume);
      open -= usedFromOpen;
      toConsume -= usedFromOpen;

      // open boxes as needed to satisfy remainder
      while (toConsume > 0 && sealed > 0) {
        sealed -= 1;
        open += qtyPer;
        const used = Math.min(open, toConsume);
        open -= used;
        toConsume -= used;
      }

      const openedAt = open > 0 ? (prev.openedAt ?? new Date()) : undefined;
      return {
        ...prev,
        unopenedQuantity: sealed,
        openedQuantity: open,
        openedAt,
      };
    });
  };

  // --- SUBMIT ---
  const handleSubmit = (onClose: () => void) => {
    if (!formData.name) return;
    
    // If batches exist, derive total from batches; otherwise use existing logic.
    const batchTotal = (formData.batches || []).reduce((acc, b) => acc + Number((b as any).stock ?? 0), 0);
    let finalStock = batchTotal > 0 ? batchTotal : Number(formData.totalStockQuantity ?? 0);
    
    // Logic 1: Variants override manual stock
    if (formData.hasVariants) {
       finalStock = formData.variants.reduce((acc, curr) => acc + Number(curr.stock || 0), 0);
    } 
    // Logic 2: Open/Unopened Tracking overrides manual stock
    else if (formData.tracksOpenStock) {
       // Total stock is typically Unopened Boxes + (1 if there is an opened box)
       // Or you might count total individual items. 
       // For this system, let's treat TotalStock as "Full Units Available" roughly.
       // We'll store exact counts in the new fields.
       const full = Number(formData.unopenedQuantity ?? 0);
       const partial = Number(formData.openedQuantity ?? 0) > 0 ? 1 : 0; // Count open box as 1 unit for simplicity or 0
       finalStock = full + partial;
    }
    // Logic 3: Oxygen tank acts as 1 unit usually, but relies on manual entry
    
    const payload = {
      ...formData,
      totalStockQuantity: finalStock,
      unopenedQuantity: Number(formData.unopenedQuantity ?? 0),
      openedQuantity: Number(formData.openedQuantity ?? 0),
      quantityPerUnit: Number(formData.quantityPerUnit ?? 1),
      reorderThreshold: Number(formData.reorderThreshold ?? 0),
      room: formData.location === 'HQ' ? formData.room : undefined,
      

      // Oxygen Data
      oxygenPsi: Number(formData.oxygenPsi),
      maxOxygenPsi: Number(formData.maxOxygenPsi),
      
      // openedAt retained for open-box tracking; expiration fields are only per-batch now
      openedAt: formData.openedAt ? new Date(formData.openedAt) : undefined,

      variants: formData.hasVariants ? formData.variants.map(v => ({
        ...v,
        quantityPerUnit: Number(v.quantityPerUnit),
        stock: Number(v.stock),
        reorderThreshold: Number(v.reorderThreshold ?? formData.reorderThreshold ?? 0)
      })) : [],
      // include batches if any (convert dates/numbers client-side)
      batches: (formData.batches || []).map(b => ({
        ...b,
        stock: Number((b as any).stock ?? 0),
        expirationDate: b.expirationDate ? new Date(b.expirationDate) : undefined,
        receivedAt: b.receivedAt ? new Date(b.receivedAt) : undefined,
        locations: (b.locations || []).map(loc => ({
          ...loc,
          quantity: Number(loc.quantity ?? 0),
          name: loc.name ?? ''
        }))
      }))
    };

    if (initialData && initialData.id) {
      onUpdateItem(initialData.id, payload);
    } else {
      onAddItem(payload);
    }
    
    onClose();
  };

  const getDateString = (date?: Date) => {
    if (!date) return '';
    const d = new Date(date); 
    if (isNaN(d.getTime())) return '';
    return d.toISOString().split('T')[0];
  };

  const isEditMode = !!initialData;

  return (
    <Modal 
      isOpen={isOpen} 
      onOpenChange={onOpenChange}
      placement="center"
      backdrop="blur"
      size="4xl"
      scrollBehavior="inside"
      classNames={{
        base: "dark:bg-slate-800",
        header: "border-b-[1px] border-gray-200 dark:border-slate-700",
        footer: "border-t-[1px] border-gray-200 dark:border-slate-700",
      }}
    >
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader className="flex flex-col gap-1">
              <h2 className="text-xl font-bold">
                {isEditMode ? 'Edit Inventory Item' : 'Add New Inventory Item'}
              </h2>
              <p className="text-sm text-gray-500 font-normal">
                Manage stock, variations, and tracking details.
              </p>
            </ModalHeader>
            <ModalBody className="py-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                
                {/* --- BASIC INFO --- */}
                <h3 className="md:col-span-2 text-sm font-bold text-gray-500 uppercase mt-2">Item Details</h3>
                
                <Input 
                  label="Item Name" 
                  placeholder="e.g., Nitrile Gloves" 
                  variant="bordered"
                  value={formData.name}
                  onValueChange={handleValueChange('name')}
                  className="md:col-span-2"
                />

                <Select 
                  label="Category" 
                  variant="bordered"
                  selectedKeys={formData.category ? [formData.category] : []}
                  onSelectionChange={(keys) => setFormData({...formData, category: Array.from(keys)[0] as ItemCategory})}
                >
                  {CATEGORIES.map((cat) => (
                    <SelectItem key={cat}>{cat}</SelectItem>
                  ))}
                </Select>

                <div className="flex items-center justify-between p-3 border-2 border-default-200 rounded-xl">
                    <span className="text-sm text-gray-600 dark:text-gray-400">Disposable?</span>
                    <Switch 
                        isSelected={formData.isDisposable} 
                        onValueChange={(val) => setFormData({...formData, isDisposable: val})}
                    >
                        {formData.isDisposable ? "Yes" : "Asset"}
                    </Switch>
                </div>

                {/* --- LOCATION --- */}
                <h3 className="md:col-span-2 text-sm font-bold text-gray-500 uppercase mt-4">Location</h3>
                
                <Select 
                  label="Building / Area" 
                  variant="bordered"
                  selectedKeys={formData.location ? [formData.location] : []}
                  onSelectionChange={(keys) => setFormData({...formData, location: Array.from(keys)[0] as LocationType})}
                >
                  {LOCATIONS.map((loc) => (
                    <SelectItem key={loc}>{loc}</SelectItem>
                  ))}
                </Select>

                {formData.location === 'HQ' ? (
                  <Select 
                    label="HQ Room" 
                    variant="bordered"
                    selectedKeys={formData.room ? [formData.room] : []}
                    onSelectionChange={(keys) => setFormData({...formData, room: Array.from(keys)[0] as HQRoom})}
                  >
                    {HQ_ROOMS.map((room) => (
                      <SelectItem key={room}>{room}</SelectItem>
                    ))}
                  </Select>
                ) : <div className="hidden md:block"></div>}

                <Input 
                  label="Shelf / Bin" 
                  placeholder="e.g., Top Shelf, Bin 4" 
                  variant="bordered"
                  value={formData.shelf}
                  onValueChange={handleValueChange('shelf')}
                  className="md:col-span-2"
                />

                {/* --- SPECIAL TRACKING: OXYGEN & BOXES --- */}
                <Divider className="md:col-span-2 my-2" />
                
                <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Oxygen Switch */}
                  <div className={`p-3 border-2 rounded-xl transition-all ${formData.isOxygen ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-default-200'}`}>
                      <div className="flex justify-between items-center mb-2">
                        <div className="flex items-center gap-2">
                          <Wind size={18} className={formData.isOxygen ? "text-blue-600" : "text-gray-400"} />
                          <span className="text-sm font-bold">Oxygen Tank?</span>
                        </div>
                        <Switch isSelected={formData.isOxygen} onValueChange={(val) => setFormData({...formData, isOxygen: val, tracksOpenStock: false, hasVariants: false})} />
                      </div>
                      {formData.isOxygen && (
                        <div className="space-y-4 pt-2">
                           <div>
                              <div className="flex justify-between text-xs mb-1">
                                <span>Current Pressure</span>
                                <span className="font-bold">{formData.oxygenPsi} PSI</span>
                              </div>
                              <Slider 
                                size="sm"
                                color="primary"
                                step={50}
                                minValue={0}
                                maxValue={Number(formData.maxOxygenPsi || 2000)} 
                                value={formData.oxygenPsi} 
                                onChange={(val) => setFormData({...formData, oxygenPsi: Number(val)})}
                              />
                           </div>
                           <Input 
                              type="number"
                              label="Max Capacity (PSI)"
                              size="sm"
                              variant="flat"
                              value={formData.maxOxygenPsi?.toString()}
                              onValueChange={(v) => setFormData({...formData, maxOxygenPsi: Number(v)})}
                           />
                        </div>
                      )}
                  </div>

                  {/* Open/Unopened Box Tracking Switch */}
                  <div className={`p-3 border-2 rounded-xl transition-all ${formData.tracksOpenStock ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20' : 'border-default-200'}`}>
                      <div className="flex justify-between items-center mb-2">
                        <div className="flex items-center gap-2">
                          <Box size={18} className={formData.tracksOpenStock ? "text-purple-600" : "text-gray-400"} />
                          <span className="text-sm font-bold">Track Open Box?</span>
                        </div>
                        <Switch isSelected={formData.tracksOpenStock} onValueChange={(val) => setFormData({...formData, tracksOpenStock: val, isOxygen: false, hasVariants: false})} />
                      </div>
                      <p className="text-xs text-gray-500">Enable for items like Gloves or Glucose strips where you have sealed boxes + one open box.</p>
                  </div>
                </div>

                {/* --- STOCK INPUTS --- */}
                <h3 className="md:col-span-2 text-sm font-bold text-gray-500 uppercase mt-4">Stock Levels</h3>

                {/* Scenario A: Oxygen */}
                {formData.isOxygen && (
                   <div className="md:col-span-2 p-4 bg-blue-50 dark:bg-blue-900/10 rounded-xl border border-blue-100 text-center">
                      <p className="text-sm text-blue-800 dark:text-blue-200">
                        Tracking as Single Tank unit. Add multiple items for multiple tanks.
                      </p>
                   </div>
                )}

                {/* Scenario B: Open/Sealed Tracking */}
                {formData.tracksOpenStock && (
                  <div className="md:col-span-2 grid grid-cols-2 gap-4 bg-purple-50 dark:bg-purple-900/10 p-4 rounded-xl border border-purple-100">
                      <Input 
                        type="number" 
                        label="Sealed Boxes" 
                        placeholder="0" 
                        value={formData.unopenedQuantity?.toString()}
                        onValueChange={(v) => setFormData({...formData, unopenedQuantity: Number(v)})}
                      />
                      <Input 
                        type="number" 
                        label="Qty in Open Box" 
                        placeholder="0" 
                        value={formData.openedQuantity?.toString()}
                        onValueChange={(v) => setFormData({...formData, openedQuantity: Number(v)})}
                        endContent={<span className="text-xs text-gray-400">items</span>}
                      />
                      <Input 
                        type="number" 
                        label="Items per Full Box" 
                        placeholder="100" 
                        className="col-span-2"
                        value={formData.quantityPerUnit?.toString()}
                        onValueChange={(v) => setFormData({...formData, quantityPerUnit: Number(v)})}
                      />
                      <div className="col-span-2 flex items-center gap-2">
                        <Button size="sm" color="primary" variant="flat" onPress={openBoxAction}>Open Box</Button>
                        <Button size="sm" color="warning" variant="flat" onPress={() => consumeItemsAction(1)}>Consume 1</Button>
                        <div className="flex items-center gap-2">
                          <Input size="sm" type="number" value={String(consumeCount)} onValueChange={(v) => setConsumeCount(Number(v ?? 1))} className="w-20" />
                          <Button size="sm" color="danger" variant="flat" onPress={() => consumeItemsAction(consumeCount)}>Consume</Button>
                        </div>
                      </div>
                  </div>
                )}

                {/* Scenario C: Standard Stock (Only if not oxygen and not tracking open stock) */}
                {!formData.isOxygen && !formData.tracksOpenStock && (
                  <>
                    <div className="md:col-span-2 flex items-center justify-between p-3 border-2 border-default-200 rounded-xl mb-2 bg-gray-50 dark:bg-slate-700/50">
                        <div className="flex flex-col">
                            <span className="text-sm font-bold text-gray-700 dark:text-gray-200">Has Variations?</span>
                            <span className="text-xs text-gray-500">Enable for different sizes (S, M, L).</span>
                        </div>
                        <Switch 
                            isSelected={formData.hasVariants} 
                            onValueChange={(val) => setFormData({...formData, hasVariants: val})}
                        />
                    </div>

                    {formData.hasVariants ? (
                        <div className="md:col-span-2 space-y-3 mt-2 border rounded-xl p-4 border-dashed border-gray-300 dark:border-slate-600 bg-gray-50/50 dark:bg-slate-800/50">
                           {/* ... Same Variant Logic as before ... */}
                           <div className="flex justify-between items-center mb-2">
                              <label className="text-sm font-semibold text-gray-600 dark:text-gray-300">Variations</label>
                              <Button size="sm" color="primary" variant="flat" onPress={addVariant} startContent={<Plus size={14} />}>Add Row</Button>
                           </div>
                           <div className="space-y-2">
                             <div className="grid items-center gap-2 text-xs text-gray-500 font-semibold mb-1" style={{gridTemplateColumns: '40px 1fr 80px 80px 140px 40px'}}>
                               <div />
                               <div>Name</div>
                               <div>Qty / Unit</div>
                               <div>Stock</div>
                               <div>Reorder Threshold</div>
                               <div />
                             </div>
                             {formData.variants.map((v) => (
                               <div key={v.id} className="grid items-center gap-2" style={{gridTemplateColumns: '40px 1fr 80px 80px 140px 40px'}}>
                                 <div className="flex items-center justify-center cursor-grab"><GripVertical size={14} className="text-gray-400"/></div>
                                 <div className="text-sm">{v.name}</div>
                                 <div className="text-sm">{v.quantityPerUnit}</div>
                                 <div className="text-sm">{v.stock}</div>
                                 <div className="text-sm">{v.reorderThreshold ?? formData.reorderThreshold ?? 0}</div>
                                 <div className="flex justify-end"><Button isIconOnly size="sm" color="danger" variant="light" onPress={() => removeVariant(v.id)}><Trash2 size={16} /></Button></div>
                               </div>
                             ))}
                           </div>
                        </div>
                    ) : (
                        <Input 
                          type="number" 
                          label="Current Stock" 
                          placeholder="0" 
                          variant="bordered"
                          className="md:col-span-2"
                          value={formData.totalStockQuantity?.toString() ?? ''}
                          onValueChange={handleValueChange('totalStockQuantity')}
                        />
                    )}
                  </>
                )}
                
                <div className="md:col-span-1">
                  <Input 
                    label="Unit Type" 
                    placeholder="e.g., box, count" 
                    variant="bordered"
                    value={formData.unit}
                    onValueChange={handleValueChange('unit')}
                  />
                </div>
                <div className="md:col-span-1">
                   <Input 
                    type="number" 
                    label="Reorder Threshold" 
                    placeholder="5" 
                    variant="bordered"
                    value={formData.reorderThreshold?.toString() ?? ''}
                    onValueChange={handleValueChange('reorderThreshold')}
                  />
                </div>

                <Divider className="md:col-span-2 my-2" />
                <div className="flex flex-col gap-4 md:col-span-2 border-2 border-default-200 rounded-xl p-4">
                    {/* --- BATCH / LOTS --- */}
                    <Divider className="my-2" />
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex flex-col">
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Batches / Lots</span>
                          <span className="text-xs text-gray-400">Track lot numbers, expirations and per-lot stock.</span>
                        </div>
                        <Button size="sm" color="primary" variant="flat" onPress={addBatch} startContent={<Plus size={12} />}>Add Batch</Button>
                      </div>
                      {(formData.batches || []).length === 0 && (
                        <p className="text-xs text-gray-400">No batches added. Add a batch for lot-specific tracking.</p>
                      )}
                      <div className="space-y-2 mt-2">
                        {(formData.batches || []).map((b, bidx) => (
                          <div key={`${b.id}-${bidx}`} className="space-y-2 p-2 border rounded-md bg-gray-50 dark:bg-slate-800/40">
                            <div className="grid grid-cols-1 md:grid-cols-6 gap-2 items-end">
                              <Input size="sm" label="Lot # (optional)" value={b.lotNumber || ''} onValueChange={(v) => updateBatch(b.id, 'lotNumber', v)} />
                              <Input size="sm" type="date" label="Expiration" value={getDateString(b.expirationDate as Date)} onValueChange={(v) => updateBatch(b.id, 'expirationDate', v ? new Date(v) : undefined)} />
                              <Input size="sm" type="number" label="Qty Total" value={String((b as any).stock ?? 0)} onValueChange={(v) => updateBatch(b.id, 'stock', Number(v))} />
                              <Input size="sm" type="date" label="Received" value={getDateString((b.receivedAt as Date) ?? undefined)} onValueChange={(v) => updateBatch(b.id, 'receivedAt', v ? new Date(v) : undefined)} />
                              <Input size="sm" label="Notes" value={(b as any).notes ?? ''} onValueChange={(v) => updateBatch(b.id, 'notes', v)} />
                              <div className="flex items-center justify-end"><Button size="sm" color="danger" variant="light" onPress={() => removeBatch(b.id)}><Trash2 size={14} /></Button></div>
                            </div>
                            <div className="bg-white dark:bg-slate-900/40 rounded-md p-2 border border-dashed border-gray-200 dark:border-slate-700">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-xs font-semibold text-gray-600 dark:text-gray-300">Locations for this batch</span>
                                <Button size="sm" variant="flat" color="secondary" onPress={() => addBatchLocation(b.id)} startContent={<Plus size={12} />}>Add Location</Button>
                              </div>
                              {(b.locations && b.locations.length > 0) ? (
                                <div className="space-y-2">
                                  {b.locations.map((loc, lidx) => (
                                    <div key={`${loc.id}-${lidx}`} className="grid grid-cols-1 md:grid-cols-6 gap-2 items-end">
                                      <Input size="sm" label="Location name" placeholder="Back storage / Statpack / Front desk" value={loc.name} onValueChange={(v) => updateBatchLocation(b.id, loc.id, 'name', v)} className="md:col-span-4" />
                                      <Input size="sm" type="number" label="Qty here" value={String(loc.quantity ?? 0)} onValueChange={(v) => updateBatchLocation(b.id, loc.id, 'quantity', Number(v))} />
                                      <div className="flex items-center justify-end"><Button size="sm" color="danger" variant="light" onPress={() => removeBatchLocation(b.id, loc.id)}><Trash2 size={14} /></Button></div>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <p className="text-[11px] text-gray-500">Use location rows to split this batch across spots (e.g., 3 in back storage, 2 in Statpack).</p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                </div>

                <div className="md:col-span-2 mt-2">
                     <Textarea
                        label="Description (Optional)"
                        placeholder="Details..."
                        variant="bordered"
                        value={formData.description}
                        onValueChange={handleValueChange('description')}
                    />
                </div>
              </div>
            </ModalBody>
            <ModalFooter>
              <Button color="danger" variant="light" onPress={onClose}>
                Cancel
              </Button>
              <Button color="primary" onPress={() => handleSubmit(onClose)} className="font-semibold shadow-lg">
                {isEditMode ? 'Save Changes' : 'Add Item'}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}