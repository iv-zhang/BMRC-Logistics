'use client';
import React, { useState } from 'react';
import {
  Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, 
  Input, Select, SelectItem, Switch, Textarea
} from '@heroui/react';

import { InventoryItem, ItemCategory, LocationType, HQRoom } from '@/app/types'; 

// Constants for Dropdowns
const CATEGORIES: ItemCategory[] = ['Airway', 'Trauma', 'Vitals', 'Meds', 'PPE', 'Splinting', 'Hygiene', 'Other'];
const LOCATIONS: LocationType[] = ['HQ', 'CPR Closet', 'Shed'];
const HQ_ROOMS: HQRoom[] = ['Front', 'Middle', 'Back', 'Office'];

interface InventoryModalProps {
  isOpen: boolean;
  onOpenChange: () => void;
  onAddItem: (item: Partial<InventoryItem>) => void;
  onUpdateItem: (id: string, item: Partial<InventoryItem>) => void;
  initialData?: InventoryItem | null; // If present, we are in EDIT mode
}

type InventoryFormState = Partial<Omit<InventoryItem, 'totalStockQuantity' | 'reorderThreshold'>> & {
  totalStockQuantity?: number | string;
  reorderThreshold?: number | string;
};

type InventoryFormField =
  | 'name'
  | 'shelf'
  | 'unit'
  | 'description'
  | 'totalStockQuantity'
  | 'reorderThreshold';

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
  expirationDate: undefined
};

export default function InventoryModal({ 
  isOpen, 
  onOpenChange, 
  onAddItem, 
  onUpdateItem,
  initialData 
}: InventoryModalProps) {
  const [formData, setFormData] = useState<InventoryFormState>(() => (
    initialData ? { ...initialData } : DEFAULT_STATE
  ));

  const handleValueChange = (field: InventoryFormField) => (value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSubmit = (onClose: () => void) => {
    if (!formData.name) return; // Basic validation
    
    // Ensure numbers are numbers and clean up data
    const payload = {
      ...formData,
      totalStockQuantity: Number(formData.totalStockQuantity ?? 0),
      reorderThreshold: Number(formData.reorderThreshold ?? 0),
      // Clean up room if location isn't HQ
      room: formData.location === 'HQ' ? formData.room : undefined,
      // Ensure expiration date is a Date object (if present)
      expirationDate: formData.expirationDate ? new Date(formData.expirationDate) : undefined
    };

    if (initialData && initialData.id) {
      // Edit Mode
      onUpdateItem(initialData.id, payload);
    } else {
      // Add Mode
      onAddItem(payload);
    }
    
    onClose();
  };

  // Helper to format Date object to YYYY-MM-DD string for input
  const getDateString = (date?: Date) => {
    if (!date) return '';
    // Handle both Firestore Timestamp (if leaked here) or JS Date
    const d = new Date(date); 
    return d.toISOString().split('T')[0];
  };

  const isEditMode = !!initialData;

  return (
    <Modal 
      isOpen={isOpen} 
      onOpenChange={onOpenChange}
      placement="center"
      backdrop="blur"
      size="2xl"
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
                {isEditMode ? 'Update details, stock levels, or location.' : 'Enter details for the new item in the supply closet.'}
              </p>
            </ModalHeader>
            <ModalBody className="py-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                
                {/* --- BASIC INFO --- */}
                <h3 className="md:col-span-2 text-sm font-bold text-gray-500 uppercase mt-2">Item Details</h3>
                
                <Input 
                  label="Item Name" 
                  placeholder="e.g., Non-Rebreather Mask" 
                  variant="bordered"
                  name="name"
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

                {/* --- LOCATION SETTINGS --- */}
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
                ) : (
                  <div className="hidden md:block"></div> 
                )}

                <Input 
                  label="Shelf / Bin / Rack" 
                  placeholder="e.g., Top Shelf, Bin 4" 
                  variant="bordered"
                  name="shelf"
                  value={formData.shelf}
                  onValueChange={handleValueChange('shelf')}
                  className="md:col-span-2"
                />

                {/* --- STOCK & DATES --- */}
                <h3 className="md:col-span-2 text-sm font-bold text-gray-500 uppercase mt-4">Stock & Expiration</h3>

                <Input 
                  label="Unit Type" 
                  placeholder="e.g., box, count" 
                  variant="bordered"
                  name="unit"
                  value={formData.unit}
                  onValueChange={handleValueChange('unit')}
                />

                <Input 
                  type="date"
                  label="Expiration Date (Optional)"
                  placeholder="Select date"
                  variant="bordered"
                  name="expirationDate"
                  value={getDateString(formData.expirationDate)}
                  onValueChange={(value) => setFormData(prev => ({
                    ...prev,
                    expirationDate: value ? new Date(value) : undefined
                  }))}
                />

                <Input 
                  type="number" 
                  label="Current Stock" 
                  placeholder="0" 
                  variant="bordered"
                  name="totalStockQuantity"
                  value={formData.totalStockQuantity?.toString() ?? ''}
                  onValueChange={handleValueChange('totalStockQuantity')}
                />

                <Input 
                  type="number" 
                  label="Reorder Threshold" 
                  placeholder="5" 
                  variant="bordered"
                  name="reorderThreshold"
                  value={formData.reorderThreshold?.toString() ?? ''}
                  onValueChange={handleValueChange('reorderThreshold')}
                />

                <div className="md:col-span-2">
                     <Textarea
                        label="Description (Optional)"
                        placeholder="Details..."
                        variant="bordered"
                        name="description"
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
              <Button color="primary" onPress={() => handleSubmit(onClose)} className="font-semibold shadow-lg shadow-indigo-500/30">
                {isEditMode ? 'Save Changes' : 'Add Item'}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
