'use client';
import React, { useState } from 'react';
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, 
  Input, Select, SelectItem, Switch, Textarea, Divider
} from '@heroui/react';
import { Trash2, Plus, Info } from 'lucide-react';

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

// Extend state to hold variants
type InventoryFormState = Partial<Omit<InventoryItem, 'totalStockQuantity' | 'reorderThreshold'>> & {
  totalStockQuantity?: number | string;
  reorderThreshold?: number | string;
  variants: InventoryVariant[];
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
  variants: []
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
      hasVariants: data.hasVariants || variants.length > 0
    };
  };

  // InventoryPage remounts this modal on open/close and item changes via key prop.
  const [formData, setFormData] = useState<InventoryFormState>(() => getInitialFormData(initialData));

  const handleValueChange = (field: keyof InventoryFormState) => (value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  // --- VARIANT LOGIC ---
  const addVariant = () => {
    const newVariant: InventoryVariant = {
      id: Date.now().toString(),
      name: '',
      quantityPerUnit: 1, // Default 1 item per unit
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
    
    // Calculate total stock. 
    // If hasVariants, sum the variants' stock. 
    let finalStock = Number(formData.totalStockQuantity ?? 0);
    
    if (formData.hasVariants) {
       finalStock = formData.variants.reduce((acc, curr) => acc + Number(curr.stock || 0), 0);
    }

    const payload = {
      ...formData,
      totalStockQuantity: finalStock,
      reorderThreshold: Number(formData.reorderThreshold ?? 0),
      room: formData.location === 'HQ' ? formData.room : undefined,
      tracksExpiration: formData.tracksExpiration,
      expirationDate: formData.tracksExpiration && formData.expirationDate 
        ? new Date(formData.expirationDate) 
        : undefined,
      // Ensure variants are cleaned and numbers are actually numbers
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
                Manage stock, variations (sizes/types), and location.
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

                {/* --- STOCK & VARIATIONS --- */}
                <h3 className="md:col-span-2 text-sm font-bold text-gray-500 uppercase mt-4 flex items-center justify-between">
                  <span>Stock & Variations</span>
                </h3>

                <div className="md:col-span-2 flex items-center justify-between p-3 border-2 border-default-200 rounded-xl mb-2 bg-gray-50 dark:bg-slate-700/50">
                    <div className="flex flex-col">
                        <span className="text-sm font-bold text-gray-700 dark:text-gray-200">Has Variations?</span>
                        <span className="text-xs text-gray-500">Enable for different sizes (S, M, L) or pack sizes.</span>
                    </div>
                    <Switch 
                        isSelected={formData.hasVariants} 
                        onValueChange={(val) => setFormData({...formData, hasVariants: val})}
                    />
                </div>

                <Input 
                  label="Unit Type" 
                  placeholder="e.g., box, count" 
                  variant="bordered"
                  value={formData.unit}
                  onValueChange={handleValueChange('unit')}
                />
                
                <Input 
                  type="number" 
                  label="Reorder Threshold (Total)" 
                  placeholder="5" 
                  variant="bordered"
                  value={formData.reorderThreshold?.toString() ?? ''}
                  onValueChange={handleValueChange('reorderThreshold')}
                />

                {/* DYNAMIC VARIATION FIELDS */}
                {formData.hasVariants ? (
                  <div className="md:col-span-2 space-y-3 mt-2 border rounded-xl p-4 border-dashed border-gray-300 dark:border-slate-600 bg-gray-50/50 dark:bg-slate-800/50">
                     <div className="flex justify-between items-center mb-2">
                        <label className="text-sm font-semibold text-gray-600 dark:text-gray-300">Variations</label>
                        <Button size="sm" color="primary" variant="flat" onPress={addVariant} startContent={<Plus size={14} />}>
                          Add Row
                        </Button>
                     </div>
                     
                     {formData.variants.length === 0 && (
                       <p className="text-xs text-center text-gray-400 italic py-4">No variations added. Click above to add sizes.</p>
                     )}

                     {/* HEADER ROW FOR CLARITY */}
                     {formData.variants.length > 0 && (
                        <div className="grid grid-cols-12 gap-2 text-xs font-bold text-gray-500 uppercase tracking-wide mb-1 px-1">
                            <div className="col-span-5">Name (e.g. Medium)</div>
                            <div className="col-span-3">Capacity (Qty/Box)</div>
                            <div className="col-span-3">Stock (Count)</div>
                            <div className="col-span-1"></div>
                        </div>
                     )}

                     <div className="space-y-2">
                     {formData.variants.map((v) => (
                       <div key={v.id} className="grid grid-cols-12 gap-2 items-start">
                          <div className="col-span-5">
                            <Input 
                                size="sm" 
                                placeholder="Name" 
                                aria-label="Variant Name"
                                value={v.name} 
                                onValueChange={(val) => updateVariant(v.id, 'name', val)}
                            />
                          </div>
                          <div className="col-span-3">
                            <Input 
                                size="sm" 
                                type="number"
                                placeholder="Qty"
                                aria-label="Items per unit"
                                startContent={<span className="text-xs text-gray-400">x</span>}
                                title="How many items are in one unit? (e.g. 100 gloves in 1 box)"
                                value={v.quantityPerUnit.toString()}
                                onValueChange={(val) => updateVariant(v.id, 'quantityPerUnit', Number(val))}
                            />
                          </div>
                          <div className="col-span-3">
                            <Input 
                                size="sm" 
                                type="number"
                                placeholder="Stock"
                                aria-label="Stock Count"
                                color="success"
                                value={v.stock.toString()}
                                onValueChange={(val) => updateVariant(v.id, 'stock', Number(val))}
                            />
                          </div>
                          <div className="col-span-1 flex justify-end">
                            <Button isIconOnly size="sm" color="danger" variant="light" onPress={() => removeVariant(v.id)}>
                                <Trash2 size={16} />
                            </Button>
                          </div>
                       </div>
                     ))}
                     </div>
                     
                     <div className="flex items-center gap-2 mt-3 pt-2 border-t border-gray-200 dark:border-slate-700">
                       <Info size={14} className="text-blue-500" />
                       <span className="text-xs text-gray-500">
                          Total calculated stock: <span className="font-bold text-gray-800 dark:text-white">{formData.variants.reduce((a,b) => a + Number(b.stock || 0), 0)}</span> {formData.unit}s
                       </span>
                     </div>
                  </div>
                ) : (
                  // STANDARD STOCK INPUT
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

                {/* --- EXPIRATION --- */}
                <Divider className="md:col-span-2 my-2" />
                
                <div className="flex items-center justify-between p-3 border-2 border-default-200 rounded-xl md:col-span-1">
                    <div className="flex flex-col">
                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Tracks Expiration?</span>
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
                    label="Expiration Date"
                    variant="bordered"
                    value={getDateString(formData.expirationDate)}
                    onValueChange={(value) => setFormData(prev => ({
                        ...prev,
                        expirationDate: value ? new Date(value) : undefined
                    }))}
                    className="md:col-span-1"
                    />
                )}

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
