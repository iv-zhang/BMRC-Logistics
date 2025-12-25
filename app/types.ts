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

// BLS-Specific Categories
export type ItemCategory = 
  | 'Airway'       
  | 'Trauma'       
  | 'Vitals'       
  | 'Meds'         
  | 'PPE'          
  | 'Splinting'    
  | 'Hygiene'      
  | 'Other';

// --- NEW: Location Types ---
export type LocationType = 'HQ' | 'CPR Closet' | 'Shed';
export type HQRoom = 'Front' | 'Middle' | 'Back' | 'Office';

export interface InventoryItem {
  id: string;
  name: string;
  category: ItemCategory;
  description?: string;
  
  // --- NEW: Location Tracking ---
  location: LocationType;
  room?: HQRoom;   // Only required if location === 'HQ'
  shelf: string;   // User defined string (e.g., "Top Rack", "Bin 4")

  // Master Supply Levels
  totalStockQuantity: number; 
  unit: string;
  
  // Restocking Logic
  reorderThreshold: number; 
  isDisposable: boolean;

  // --- NEW: Expiration Tracking ---
  expirationDate?: Date;
  
  createdAt: Date;
  updatedAt: Date;
}

export type StatpackPocket = 'main' | 'front_aux' | 'side_left' | 'side_right';

export interface StatpackItem {
  itemId: string;
  itemDetails?: InventoryItem;
  requiredQuantity: number; 
  currentQuantity: number; 
  pocket?: StatpackPocket; 
  expirationDate?: Date;
  lotNumber?: string;
}

export interface Statpack {
  id: string;
  name: string;
  type: 'Primary' | 'Secondary' | 'Event Bag';
  status: 'Ready' | 'Restock Needed' | 'Expired Items' | 'In Use';
  contents: StatpackItem[];
  isCheckedOut: boolean;
  assignedToUserId?: string;
  assignedToUserName?: string;
  checkedOutAt?: Date;
  lastCheckedBy?: string;
  lastCheckedAt?: Date;
}

export interface StatpackLog {
  id?: string;
  statpackId: string;
  statpackName: string;
  action: 'checkout' | 'checkin' | 'maintenance' | 'update';
  userId: string;
  userName: string;
  timestamp: any; 
  notes?: string;
}