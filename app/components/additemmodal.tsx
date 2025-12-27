'use client';
import React, { useState, useEffect } from 'react';
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, 
  Input, Select, SelectItem, Switch, Textarea, Divider, Slider
} from '@heroui/react';
import { Trash2, Plus, Info, Box, Wind, CalendarClock } from 'lucide-react';

import { InventoryItem, ItemCategory, LocationType, HQRoom, InventoryVariant } from '@/app/types'; 

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
  // New State Fields
  unopenedQuantity?: number | string;
  openedQuantity?: number | string;
  quantityPerUnit?: number | string;
  oxygenPsi?: number;
  maxOxygenPsi?: number;
  secondaryExpirationDays?: number | string;
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
  tracksExpiration: false,
  expirationDate: undefined,
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
  hasSecondaryExpiration: false,
  secondaryExpirationDays: 90,
  openedAt: undefined
};

export default function InventoryModal({ 
  isOpen, 
  onOpenChange, 
  onAddItem, 
  onUpdateItem,
  initialData,
  canToggleExpiration = false
}: InventoryModalProps) {
  
  const getInitialFormData = (data?: InventoryItem | null): InventoryFormState => {
    if (!data) return DEFAULT_STATE;
    const variants = data.variants || [];
    return {
      ...DEFAULT_STATE,
      ...data,
      tracksExpiration: !!data.expirationDate || data.tracksExpiration || false,
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
      hasSecondaryExpiration: data.hasSecondaryExpiration || false,
      secondaryExpirationDays: data.secondaryExpirationDays ?? 90,
      openedAt: data.openedAt ? new Date(data.openedAt) : undefined,
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
      id: Date.now().toString(),
      name: '',
      quantityPerUnit: 1, 
      stock: 0
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

  // --- SUBMIT ---
  const handleSubmit = (onClose: () => void) => {
    if (!formData.name) return;
    
    let finalStock = Number(formData.totalStockQuantity ?? 0);
    
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
      
      tracksExpiration: formData.tracksExpiration,
      expirationDate: formData.tracksExpiration && formData.expirationDate 
        ? new Date(formData.expirationDate) 
        : undefined,

      // Oxygen Data
      oxygenPsi: Number(formData.oxygenPsi),
      maxOxygenPsi: Number(formData.maxOxygenPsi),
      
      // Secondary Expiration
      secondaryExpirationDays: Number(formData.secondaryExpirationDays),
      openedAt: formData.openedAt ? new Date(formData.openedAt) : undefined,

      variants: formData.hasVariants ? formData.variants.map(v => ({
        ...v, 
        quantityPerUnit: Number(v.quantityPerUnit),
        stock: Number(v.stock)
      })) : []
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
      size="3xl"
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
                        onValueChange={(v) => setFormData({...formData, unopenedQuantity: v})}
                      />
                      <Input 
                        type="number" 
                        label="Qty in Open Box" 
                        placeholder="0" 
                        value={formData.openedQuantity?.toString()}
                        onValueChange={(v) => setFormData({...formData, openedQuantity: v})}
                        endContent={<span className="text-xs text-gray-400">items</span>}
                      />
                      <Input 
                        type="number" 
                        label="Items per Full Box" 
                        placeholder="100" 
                        className="col-span-2"
                        value={formData.quantityPerUnit?.toString()}
                        onValueChange={(v) => setFormData({...formData, quantityPerUnit: v})}
                      />
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
                             {formData.variants.map((v) => (
                               <div key={v.id} className="grid grid-cols-12 gap-2 items-start">
                                  <div className="col-span-5"><Input size="sm" placeholder="Name" value={v.name} onValueChange={(val) => updateVariant(v.id, 'name', val)} /></div>
                                  <div className="col-span-3"><Input size="sm" type="number" placeholder="Qty/Unit" value={v.quantityPerUnit.toString()} onValueChange={(val) => updateVariant(v.id, 'quantityPerUnit', Number(val))} /></div>
                                  <div className="col-span-3"><Input size="sm" type="number" placeholder="Stock" color="success" value={v.stock.toString()} onValueChange={(val) => updateVariant(v.id, 'stock', Number(val))} /></div>
                                  <div className="col-span-1 flex justify-end"><Button isIconOnly size="sm" color="danger" variant="light" onPress={() => removeVariant(v.id)}><Trash2 size={16} /></Button></div>
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

                {/* --- EXPIRATION & SECONDARY EXPIRATION --- */}
                <Divider className="md:col-span-2 my-2" />
                
                <div className="flex flex-col gap-4 md:col-span-2 border-2 border-default-200 rounded-xl p-4">
                    {/* Primary Expiration */}
                    <div className="flex items-center justify-between">
                        <div className="flex flex-col">
                            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Tracks Expiration?</span>
                            <span className="text-xs text-gray-400">Manufacturer expiration date</span>
                        </div>
                        <Switch 
                            isSelected={formData.tracksExpiration ?? false} 
                            onValueChange={(val) => setFormData({...formData, tracksExpiration: val})}
                            color="warning"
                            isDisabled={!canToggleExpiration}
                        />
                    </div>
                    
                    {formData.tracksExpiration && (
                        <Input 
                        type="date"
                        label="Manufacturer Expiration"
                        variant="bordered"
                        value={getDateString(formData.expirationDate)}
                        onValueChange={(value) => setFormData(prev => ({
                            ...prev,
                            expirationDate: value ? new Date(value) : undefined
                        }))}
                        />
                    )}

                    <Divider className="my-1" />
                    
                    {/* Secondary Expiration */}
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <CalendarClock size={18} className={formData.hasSecondaryExpiration ? "text-orange-600" : "text-gray-400"} />
                            <div className="flex flex-col">
                                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Exp. Changes when Opened?</span>
                                <span className="text-xs text-gray-400">e.g. Glucose strips expire 90 days after opening</span>
                            </div>
                        </div>
                        <Switch 
                            isSelected={formData.hasSecondaryExpiration ?? false} 
                            onValueChange={(val) => setFormData({...formData, hasSecondaryExpiration: val})}
                        />
                    </div>

                    {formData.hasSecondaryExpiration && (
                        <div className="grid grid-cols-2 gap-4 mt-2">
                             <Input 
                                type="number"
                                label="Valid Days After Opening"
                                placeholder="90"
                                value={formData.secondaryExpirationDays?.toString()}
                                onValueChange={(v) => setFormData({...formData, secondaryExpirationDays: v})}
                             />
                             <Input 
                                type="date"
                                label="Date Opened"
                                description="Set this when you open a fresh box."
                                value={getDateString(formData.openedAt)}
                                onValueChange={(value) => setFormData(prev => ({
                                    ...prev,
                                    openedAt: value ? new Date(value) : undefined
                                }))}
                             />
                        </div>
                    )}
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