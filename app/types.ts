import type { FieldValue, Timestamp } from 'firebase/firestore';

// --- USER & AUTH ---
export interface User {
  id: string;
  fullName: string;
  email: string;
  role: 'admin' | 'member' | 'FTO' | 'quartermaster';
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthResponse {
  success: boolean;
  message: string;
  user?: User;
  error?: string;
}

// --- MASTER INVENTORY ---
export type ItemCategory = 
  | 'Airway'       
  | 'Trauma'       
  | 'Vitals'       
  | 'Meds'         
  | 'PPE'          
  | 'Splinting'    
  | 'Hygiene'      
  | 'Other';

export type LocationType = 'HQ' | 'CPR Closet' | 'Shed' | 'Other';
// Clarify HQ rooms: Back Room is the authoritative inventory (audit target).
export type HQRoom = 'Front' | 'Forward Staging' | 'Back Room' | 'Office';

export interface InventoryVariant {
  id: string;
  name: string;
  quantityPerUnit: number;
  stock: number;
  lotNumber?: string;
  expirationDate?: Date;
  reorderThreshold?: number;
  // Optional per-variant batch tracking for expirations/lot-specific stock
  batches?: InventoryBatch[];
}

export interface InventoryBatch {
  id: string;
  lotNumber?: string;
  expirationDate?: Date;
  openDate?: Date; // For items like glucose strips that expire X days after opening
  // When an item has variants, a batch must belong to a specific variant
  variantId?: string;
  stock: number;
  // optional metadata for a batch (receivedAt, supplier, notes)
  receivedAt?: Date;
  notes?: string;
  requiresFIFO?: boolean; // Flag to enforce oldest-first picking
  // Optional per-location splits for the same batch (e.g., storage, statpacks)
  locations?: {
    id: string;
    name: string; // freeform location label (e.g., "Back storage", "Statpack 3", "Front desk")
    quantity: number;
    // Optional parsed UI fields (not required in stored documents)
    area?: LocationType;
    room?: HQRoom;
    shelf?: string;
  }[];
  // Optional: when true, this batch is tracked at unit-level and `serialNumbers` holds each unit's ID
  serialized?: boolean;
  // For serialized batches, explicit serial/asset IDs for each unit in the batch
  serialNumbers?: string[];
  // Optional richer per-unit asset instances (for devices like AEDs)
  assetInstances?: AssetInstance[];
}

export interface InventoryItem {
  id: string;
  name: string;
  category: ItemCategory;
  description?: string;
  
  // Stock Levels
  totalStockQuantity: number; 
  reorderThreshold: number;   
  
  // Locations
  location: LocationType;
  room?: HQRoom;
  shelf?: string;
  bin?: string;

  // UI / metadata
  unit?: string; // e.g., 'box' or 'count'
  isDisposable?: boolean;
  // Asset flag: when true this item is an individual asset (e.g., Blue Stat Pack 1)
  // Assets are tracked by status, not by quantity.
  isAsset?: boolean;
  // For tangible assets, optional serial number to uniquely identify this asset instance
  assetSerial?: string;
  // If this asset is a child of another asset (e.g., battery/pad assigned to AED parent), store parent asset id
  parentAssetId?: string;
  // If assigned to a statpack or other container, reference that entity
  assignedToId?: string;
  // Distinguish asset categories; 'AED' is a special asset type with additional checks
  assetCategory?: 'AED' | 'Generic' | string;
  // Model name or identifier for assets that have multiple models (e.g., 'Philips FRx')
  assetModel?: string;
  // If isAsset=true, use assetStatus/lastChecked/nextExpiration instead of quantities.
  assetStatus?: 'Ready' | 'Not Ready';
  assetLastChecked?: Date;
  assetNextExpiration?: Date;
  // Asset-specific quick-check fields (useful for AEDs)
  assetChecks?: {
    batteryStatus?: 'Good' | 'Low' | 'Unknown';
    padsSealed?: boolean;
    lastCheckNotes?: string;
  };
  // Optional top-level list of asset instances when the item represents multiple unique devices
  assets?: AssetInstance[];
  hasVariants?: boolean;
  variants?: InventoryVariant[];

  // Batch/lots tracking for different expirations (separate from sizing `variants`)
  batches?: InventoryBatch[];
  // Tracking
  tracksExpiration: boolean; 
  expirationDate?: Date;
  // Audit flag: whether this item must be included in semesterly audit counts
  isAuditRequired?: boolean;
  
  // Oxygen Specifics
  isOxygen?: boolean;
  oxygenPsi?: number;
  maxOxygenPsi?: number;

  // Box/Unit Logic
  tracksOpenStock?: boolean;
  quantityPerUnit?: number;
  unopenedQuantity?: number;
  openedQuantity?: number;
  hasSecondaryExpiration?: boolean; 
  secondaryExpirationDays?: number;
  openedAt?: Date;

  // Reagent-specific handling (Glucose, Control Solution, Eye Wash)
  isReagent?: boolean; // Items that degrade after opening
  daysValidAfterOpening?: number; // e.g., 90 for glucose strips

  // Audit tracking
  auditVerified?: boolean; // Semester audit verification flag
  // QC/Condition recorded during audit: Good (default), Damaged, or Expired
  auditCondition?: 'Good' | 'Damaged' | 'Expired';
  auditNotes?: string;
  lastAuditDate?: Date;
  isLegacyItem?: boolean; // Quick-added legacy/found items

  createdAt: Date;
  updatedAt: Date;
}

// --- STATPACKS ---
export type StatpackPocket = 'main' | 'front_aux' | 'side_left' | 'side_right';

export interface StatpackCompartment {
  id: string;
  name: string;
  parentPocket: StatpackPocket; 
  isSealed: boolean;
  sealNumber?: string;
  expirationDate?: Date;
}

export interface StatpackItem {
  itemId: string;
  itemDetails?: InventoryItem;
  variantId?: string;
  variantName?: string;
  requiredQuantity: number; 
  currentQuantity: number; 
  pocket?: StatpackPocket; 
  compartmentId?: string;
  // CRITICAL: StatpackItem must reference a specific batch (not just item)
  batchId: string; // REQUIRED - cannot add generic item, must specify batch
  // If this statpack contains a serialized asset/unit, record the specific serial
  serialNumber?: string;
  expirationDate?: Date; // Derived from batch for UI convenience
  lotNumber?: string; // Derived from batch for UI convenience
  effectiveExpiration?: Date; // Computed from batch.expirationDate or batch.openDate + daysValid
}

export interface Statpack {
  id: string;
  name: string;
  type: 'Primary' | 'Secondary' | 'Event Bag';
  status: 'Ready' | 'Restock Needed' | 'Expired Items' | 'CRITICAL - EXPIRED ITEMS' | 'In Use';
  compartments: StatpackCompartment[];
  contents: StatpackItem[];
  isCheckedOut: boolean;
  assignedToUserId?: string;
  assignedToUserName?: string;
  checkedOutAt?: Date;
  lastCheckedBy?: string;
  lastCheckedAt?: Date;
  currentEvent?: string; 
  
  createdAt: Date;
  updatedAt: Date;
}

// --- LOGGING & ISSUES ---

export interface IssueReport {
  itemId: string;
  itemName: string;
  issueType: 'missing' | 'expired' | 'damaged' | 'other';
  isReplaced: boolean;
  replacedQuantity: number;
  newExpirationDate?: string;
  notes: string;
}

export interface StatpackLog {
  id?: string;
  statpackId: string;
  statpackName: string;
  action: 'checkout' | 'checkin' | 'restock' | 'created' | 'maintenance';
  userId: string;
  userName: string;
  timestamp: Date | FieldValue;
  notes?: string;
  
  // Detailed Issue Tracking
  issues?: {
      sealChecks?: Record<string, boolean>;
      oxygenReadings?: Record<string, string>;
      issueReports?: Record<string, IssueReport>;
      verifiedCount?: number;
  };
  
  // Legacy/Simple tracking
  itemsUsed?: Record<string, number>; 
}

// Per-asset instance metadata for serialized items (e.g., AEDs)
export interface AssetInstance {
  serial: string;
  // Unique asset identifier (asset tag or barcode). May differ from manufacturer `serial`.
  id?: string;
  assetTag?: string;
  status?: 'Ready' | 'Not Ready' | 'Maintenance' | 'Unknown';
  // Consumable components attached to the device
  padExpiration?: Date;
  batteryExpiration?: Date;
  lastServiceDate?: Date;
  lastChecked?: Date;
  // Convenience flattened check fields (preferred for UI):
  batteryStatus?: 'Good' | 'Low' | 'Unknown';
  padsSealed?: boolean;
  lastCheckNotes?: string;
  // Optional fields for derived next expiration (pads/battery replacement window)
  nextExpiration?: Date;
  checks?: {
    batteryStatus?: 'Good' | 'Low' | 'Unknown';
    padsSealed?: boolean;
    notes?: string;
  };
  assignedToId?: string; // e.g., statpack id or location
  // Current human-friendly location or container id (e.g., 'Statpack-1' or 'Back Room')
  currentLocation?: string;
  createdAt?: Date;
  updatedAt?: Date;
}