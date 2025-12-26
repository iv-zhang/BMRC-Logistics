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

// --- MASTER INVENTORY (The Supply Closet) ---

export type ItemCategory = 
  | 'Airway'       
  | 'Trauma'       
  | 'Vitals'       
  | 'Meds'         
  | 'PPE'          
  | 'Splinting'    
  | 'Hygiene'      
  | 'Other';

export type LocationType = 'HQ' | 'CPR Closet' | 'Shed';
export type HQRoom = 'Front' | 'Middle' | 'Back' | 'Office';

// --- VARIATION LOGIC ---
export interface InventoryVariant {
  id: string;           
  name: string;         // e.g. "Medium", "Large"
  quantityPerUnit: number; // e.g. 100 (if box has 100 gloves)
  stock: number;        // The number of units (e.g. 5 boxes)
}

export interface InventoryItem {
  id: string;
  name: string;
  category: ItemCategory;
  description?: string;
  
  // Location Tracking
  location: LocationType;
  room?: HQRoom;
  shelf: string;

  // Master Supply Levels
  totalStockQuantity: number; 
  unit: string;
  
  // --- VARIATION SUPPORT ---
  hasVariants: boolean;
  variants?: InventoryVariant[];

  // Restocking Logic
  reorderThreshold: number; 
  isDisposable: boolean;

  // Expiration Tracking
  tracksExpiration: boolean;
  expirationDate?: Date;
  
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
  expirationDate?: Date;
  lotNumber?: string;
}

export interface Statpack {
  id: string;
  name: string;
  type: 'Primary' | 'Secondary' | 'Event Bag';
  status: 'Ready' | 'Restock Needed' | 'Expired Items' | 'In Use';
  compartments: StatpackCompartment[];
  contents: StatpackItem[];
  isCheckedOut: boolean;
  assignedToUserId?: string;
  assignedToUserName?: string;
  checkedOutAt?: Date;
  lastCheckedBy?: string;
  lastCheckedAt?: Date;
  currentEvent?: string;
}

export interface StatpackLog {
  id?: string;
  statpackId: string;
  statpackName: string;
  action: 'checkout' | 'checkin' | 'maintenance' | 'update';
  userId: string;
  userName: string;
  timestamp: Timestamp | Date | FieldValue; 
  notes?: string;
}
