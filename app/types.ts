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

export type LocationType = 'HQ' | 'CPR Closet' | 'Shed';
export type HQRoom = 'Front' | 'Middle' | 'Back' | 'Office';

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

  // Tracking
  tracksExpiration: boolean; 
  expirationDate?: Date;
  
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
  id: string;
  statpackId: string;
  statpackName: string;
  action: 'checkout' | 'checkin' | 'restock' | 'created';
  userId: string;
  userName: string;
  timestamp: Date;
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