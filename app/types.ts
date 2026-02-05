import type { FieldValue, Timestamp } from 'firebase/firestore';

// --- PURCHASE TRACKING ---
export interface PurchaseInfo {
  supplierName?: string;
  supplierId?: string;
  pricePerUnit?: number;
  currency?: string; // Default: 'USD'
  quantityReceived?: number;
  unitOfMeasure?: string; // 'box', 'each', 'case', etc.
  purchaseOrderId?: string;
  invoiceRef?: string;
  receivedAt?: Timestamp | Date;
  notes?: string;
}

// --- ASSET MANAGEMENT CONSTANTS ---
// Default dollar threshold for automatic asset classification
// Items over this value should be tracked as individual assets with serial numbers
export const ASSET_VALUE_THRESHOLD = 500; // USD

// High-value equipment categories that should always be treated as assets
export const ASSET_CATEGORIES = ['AED', 'Radio', 'Oxygen Tank', 'Generator', 'Monitor'] as const;
export type AssetCategoryType = typeof ASSET_CATEGORIES[number];

// --- USER & AUTH ---
export interface User {
  id: string;
  fullName: string;
  email: string;
  role: 'admin' | 'member' | 'FTO' | 'quartermaster' | 'inventory_helper';
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
  // When true, this specific variant must always have its expiration checked before use
  requiresExpirationCheck?: boolean;
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
  // Purchase/vendor tracking for this batch
  purchase?: PurchaseInfo;
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
  
  // Stock Levels - Box-Based Tracking
  unopenedBoxes: number; // Number of unopened boxes
  itemsPerBox?: number;  // Optional: how many items in one box
  reorderThreshold: number;   
  // Par levels per location (optional): { locationId: minimumQuantity }
  parByLocation?: Record<string, number>;
  
  // DEPRECATED: Legacy fields kept for migration compatibility
  totalStockQuantity?: number;
  
  // Locations
  location: LocationType;
  room?: HQRoom;
  shelf?: string;
  bin?: string;

  // UI / metadata
  unit?: string; // e.g., 'box' or 'count'
  // Asset flag: when true this item is an individual asset (e.g., Blue Stat Pack 1)
  // Assets are tracked by status, not by quantity.
  isAsset?: boolean;
  // For tangible assets, optional serial number to uniquely identify this asset instance
  assetSerial?: string;
  // Barcode and QR code for scanning asset checkout/checkin (either or both)
  barcode?: string; // UPC, code128, or other barcode format
  qr?: string; // QR code content (often same as serial or barcode)
  // External barcode assigned from purchased asset tags (can replace or supplement generated codes)
  assignedBarcode?: string | null;
  // History of all barcode assignments/reassignments for audit trail (append-only)
  barcodeHistory?: Array<{
    value: string;
    assignedAt: Date | FieldValue;
    assignedBy?: { id?: string; name?: string };
  }>;
  // If this asset is a child of another asset (e.g., battery/pad assigned to AED parent), store parent asset id
  parentAssetId?: string;
  // If assigned to a statpack or other container, reference that entity
  assignedToId?: string;
  // Distinguish asset categories; 'AED' is a special asset type with additional checks
  assetCategory?: 'AED' | 'Generic' | string;
  // Model name or identifier for assets that have multiple models (e.g., 'Philips FRx')
  assetModel?: string;
  // If isAsset=true, use assetStatus/lastChecked/nextExpiration instead of quantities.
  assetStatus?: 'Ready' | 'Not Ready' | 'In Use' | 'Checked Out';
  assetLastChecked?: Date;
  assetNextExpiration?: Date;
  // Checkout tracking fields (when asset is checked out by a member)
  checkedOutAt?: Date | FieldValue; // When the asset was checked out
  checkedOutBy?: string; // User ID of member who checked it out
  lastCheckedInAt?: Date | FieldValue; // When asset was last checked in
  lastCheckedInBy?: string; // User ID of member who checked it in
  lastKnownReturnLocation?: string; // Where the member reported returning it
  // Asset-specific quick-check fields (useful for AEDs)
  assetChecks?: {
    batteryStatus?: 'Good' | 'Low' | 'Unknown';
    padsSealed?: boolean;
    lastCheckNotes?: string;
  };
  // Per-item expiry fields for consumable components (convenience for single-instance assets)
  batteryExpiration?: Date;
  padExpiration?: Date;
  // Optional top-level list of asset instances when the item represents multiple unique devices
  assets?: AssetInstance[];
  // Optional per-asset verification policy (admin-configurable)
  // Controls which checks are performed at checkout/checkin for this inventory item
  verificationPolicy?: AssetVerificationRules;
  hasVariants?: boolean;
  variants?: InventoryVariant[];

  // Batch/lots tracking for different expirations (separate from sizing `variants`)
  batches?: InventoryBatch[];
  // When true, this item must always have its expiration date checked before use (UI/enforcement can honor this)
  requiresExpirationCheck?: boolean;
  // Tracking
  tracksExpiration: boolean; 
  expirationDate?: Date;
  // Audit flag: whether this item must be included in semesterly audit counts
  
  
  // Oxygen Specifics
  isOxygen?: boolean;
  oxygenPsi?: number;
  maxOxygenPsi?: number;
  // Optional model/name for oxygen tanks
  oxygenModel?: string;

  // Box/Unit Logic - DEPRECATED (replaced by unopenedBoxes/itemsPerBox)
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
  
  // Asset-specific fields (for non-disposable high-value items: O2 tanks, AEDs, bikes, radios, etc.)
  assetValue?: number; // Monetary value in dollars
  currentLocation?: string; // Where the asset is currently (GPS or room location)
  maintenance_logs?: Array<{
    id?: string;
    timestamp?: Date;
    serviceType: string; // 'routine', 'repair', 'inspection', 'replacement'
    reason: string; // Why is it being serviced
    technician?: string; // Who did the work
    notes?: string;
    status: 'pending' | 'in-progress' | 'completed'; // Current status
    completedAt?: Date;
  }>;
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

// Asset verification rules for statpack items (admin-configurable, optional)
export interface AssetVerificationRules {
  // Require scanning/entering serial number during checkin/checkout
  requireSerial?: boolean;
  // Require confirming expiration date matches during verification (month/year format)
  requireExpirationConfirmation?: boolean;
  // Minimum O2 PSI required for oxygen tanks
  requireO2PsiMin?: number;
  // If true, violations are advisory warnings only (not blocking)
  advisoryOnly?: boolean;
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
  // For serialized items (AEDs, oxygen tanks, etc.), this is the unique identifier
  // that links to InventoryItem.assetSerial or InventoryItem.assets[].serial
  serialNumber?: string;
  // Optional: link to a specific asset instance ID for direct asset assignment at the statpack item level
  assetInstanceId?: string;
  expirationDate?: Date; // Derived from batch for UI convenience
  lotNumber?: string; // Derived from batch for UI convenience
  effectiveExpiration?: Date; // Computed from batch.expirationDate or batch.openDate + daysValid
  // Convenience flag copied from linked `InventoryItem`/variant to indicate expirations must be confirmed
  requiresExpirationCheck?: boolean;
  // Per-item value for computing total statpack asset value
  itemValue?: number;
  // Optional verification rules for this specific statpack item (admin-configurable)
  verificationRules?: AssetVerificationRules;
}

export interface Statpack {
  id: string;
  name: string;
  type: 'Primary' | 'Secondary' | 'Event Bag';
  status: 'Ready' | 'Restock Needed' | 'Expired Items' | 'CRITICAL - EXPIRED ITEMS' | 'In Use' | 'Pending Initial Check';
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
  
  // Statpacks are ALWAYS treated as high-value assets in EMS logistics
  // This field represents the total value of the statpack container + all contents
  // Should be computed/updated whenever contents change
  assetValue?: number; // Computed: sum of contents' itemValue * quantity
  currentLocation?: string; // Physical location (e.g., "Vehicle 1", "Storage Room A")
  assetSerial?: string; // Unique serial/tag for the statpack container itself
  
  maintenance_logs?: Array<{
    id?: string;
    timestamp?: Date;
    serviceType: string;
    reason?: string;
    technician?: string;
    notes?: string;
    status: 'pending' | 'in-progress' | 'completed';
    completedAt?: Date;
  }>;
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
  mismatchResolutions?: MismatchResolution[];
  validationWarnings?: ValidationWarning[];
  
  // Digital Check-Off: structured per-item check entries
  checkEntries?: {
    itemId: string;
    itemName?: string;
    batchId?: string;
    compartmentId?: string;
    pocket?: StatpackPocket;
    requiredQuantity: number;
    countedQuantity: number; // Actual count during check
    ok: boolean; // true if countedQuantity >= requiredQuantity
    serialNumber?: string; // For asset items
    notes?: string;
    expirationDate?: Date | FieldValue;
    checkedAt?: Date | FieldValue;
    checkedBy?: string;
    // Per-asset condition tracking (only for serialized/asset items)
    assetCondition?: 'Good' | 'Minor Issue' | 'Major Issue' | 'Needs Maintenance';
    assetCheckResult?: {
      batteryStatus?: 'Good' | 'Low' | 'Unknown';
      batteryPct?: number;
      padsSealed?: boolean;
      oxygenPsi?: number;
      notes?: string;
    };
  }[];
  
  // Detailed Issue Tracking
  issues?: {
      sealChecks?: Record<string, { sealed: boolean; sealNumber?: string; expiration?: Date }>;
      oxygenReadings?: Record<string, string>;
      issueReports?: Record<string, IssueReport>;
      verifiedCount?: number;
  };
  
  // Legacy/Simple tracking
  itemsUsed?: Record<string, number>; 
}

export interface MismatchResolution {
  key: string; // item id or AED field key
  entered?: string;
  system?: string;
  acknowledged: boolean;
  resolvedBy?: string;
  resolvedAt?: Date | FieldValue;
  note?: string;
}

export interface ValidationWarning {
  warningType:
    | 'missing_asset'
    | 'unassigned_asset'
    | 'assigned_mismatch'
    | 'asset_status'
    | 'asset_expired'
    | 'other';
  severity?: 'critical' | 'warning' | 'info'; // critical = blocks submission, warning/info = informational only
  itemId?: string;
  itemName?: string;
  serialNumber?: string;
  currentAssignedTo?: string | null;
  message: string;
}

export interface AssetCheckResult {
  itemId: string;
  itemName: string;
  serialNumber?: string;
  measuredBatteryPct?: number; // 0-100
  measuredO2Psi?: number;
  condition: 'Good' | 'Minor Issue' | 'Major Issue' | 'Needs Maintenance';
  expirationWarnings: ValidationWarning[];
  checkedAt: Date;
  checkedBy: string;
  checkedByName: string;
  notes?: string;
  dueNextDate?: Date;
  actionRequired: boolean;
}

export interface StatpackAuditResult {
  statpackId: string;
  statpackName: string;
  contentChecks: Array<{
    itemId: string;
    itemName: string;
    serialNumber?: string;
    requiredQuantity: number;
    foundQuantity: number;
    inCorrectPocket: boolean;
    conditionOk: boolean;
    expirationOk: boolean;
    notes?: string;
  }>;
  validationWarnings: ValidationWarning[];
  condition: 'Ready' | 'Issues Found';
  checkedAt: Date;
  checkedBy: string;
  checkedByName: string;
  overallNotes?: string;
  actionRequired: boolean;
}

// Per-asset instance metadata for serialized items (e.g., AEDs)
export interface AssetInstance {
  serial: string;
  // Unique asset identifier (asset tag or barcode). May differ from manufacturer `serial`.
  id?: string;
  assetTag?: string;
  // Barcode and QR code for scanning asset checkout/checkin (either or both)
  barcode?: string;
  qr?: string;
  // External barcode assigned from purchased asset tags (can replace or supplement generated codes)
  assignedBarcode?: string | null;
  // History of all barcode assignments/reassignments for audit trail (append-only)
  barcodeHistory?: Array<{
    value: string;
    assignedAt: Date | FieldValue;
    assignedBy?: { id?: string; name?: string };
  }>;
  status?: 'Ready' | 'Not Ready' | 'Maintenance' | 'In Use' | 'Checked Out' | 'Unknown';
  // Consumable components attached to the device
  padExpiration?: Date;
  batteryExpiration?: Date;
  lastServiceDate?: Date;
  lastChecked?: Date;
  // Convenience flattened check fields (preferred for UI):
  batteryStatus?: 'Good' | 'Low' | 'Unknown';
  padsSealed?: boolean;
  lastCheckNotes?: string;
  // For oxygen tanks: measured PSI at last check
  oxygenPsi?: number;
  // Optional fields for derived next expiration (pads/battery replacement window)
  nextExpiration?: Date;
  // Per-instance expiration date (useful for disposables stored as instances, e.g., EpiPens)
  expirationDate?: Date;
  // Checkout tracking
  checkedOutAt?: Date | FieldValue;
  checkedOutBy?: string; // User ID of member who checked out this asset
  lastCheckedInAt?: Date | FieldValue;
  lastCheckedInBy?: string; // User ID of member who checked in this asset
  checks?: {
    batteryStatus?: 'Good' | 'Low' | 'Unknown';
    padsSealed?: boolean;
    notes?: string;
  };
  // Container or statpack this asset instance is assigned to.
  // Tracks the "home" location for accountability (e.g., 'statpack-primary-1' or 'vehicle-3').
  // When checking in/out, verify this matches the expected statpack/container.
  assignedToId?: string;
  // Current human-friendly location or container id (e.g., 'Statpack-1' or 'Back Room')
  currentLocation?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// --- STORAGE / CONTAINERS ---
export interface StorageZone {
  id: string;
  name: string;
  locationType: LocationType;
  room?: HQRoom;
  description?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface Shelf {
  id: string;
  name: string;
  zoneId?: string | null;
  capacity?: number | null;
  barcode?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface Container {
  id: string;
  name: string;
  shelfId?: string | null;
  barcode?: string | null;
  // Sealed Box / Container Logic (for student workflow accountability)
  isBox?: boolean; // When true, treat as a sealed box with fixed contents
  isSealed?: boolean;
  sealNumber?: string; // Tamper-evident seal id or sticker number
  sealedAt?: Date;
  sealedBy?: string; // userId of person who sealed
  sealedByName?: string;
  // Contents of the sealed box: itemId + batchId + quantity (assumes unchanged until unopened)
  boxContents?: {
    itemId: string;
    batchId: string;
    quantity: number;
    serialNumber?: string; // For serialized/asset items
  }[];
  // Purchase tracking for sealed boxes (when received)
  purchase?: PurchaseInfo;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface BoxLog {
  id?: string;
  boxId: string;
  action: 'sealed' | 'unsealed' | 'inventory_check' | 'break_seal';
  userId: string;
  userName?: string;
  timestamp: Date | FieldValue;
  sealIntact?: boolean; // true if seal was verified intact, false if broken
  notes?: string;
  itemsCounted?: Record<string, number>; // If seal was broken, what was counted
}

// Inventory log events (e.g., asset checkout/checkin, box consumption, restocking)
export interface InventoryLog {
  id?: string;
  itemId?: string; // The inventory item this log refers to
  itemName?: string;
  action: string; // 'asset_checkout', 'asset_checkin', 'consume_box', 'create_open_batch', etc.
  serialNumber?: string; // For single-serial events
  serials?: string[]; // For multi-serial events
  batchId?: string;
  quantity?: number;
  boxCount?: number;
  unitsAdded?: number;
  beforeUnopenedBoxes?: number;
  afterUnopenedBoxes?: number;
  userId?: string;
  userName?: string;
  timestamp: Date | FieldValue; // Server timestamp of the event
  location?: string; // Where the action took place or asset was located
  notes?: string; // Additional context/reason
  newStatus?: string; // For status change events
  details?: Record<string, any>; // Catch-all for additional event data
}

// --- BUG REPORTS & ISSUE TRACKING ---
export interface IssueReport {
  id?: string;
  reporter: {
    userId: string | null;
    userName?: string | null;
    userEmail?: string | null;
    isAnonymous?: boolean;
  };
  target?: {
    collection?: string; // 'inventory', 'statpack', etc.
    docId?: string;
  };
  type: 'bug' | 'feedback' | 'improvement' | 'question';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'open' | 'triaged' | 'in_progress' | 'resolved' | 'closed';
  title: string;
  description: string;
  reproductionSteps?: string[];
  pagePath?: string; // Route or UI area where issue was reported
  component?: string; // Component name or ID
  assignedTo?: {
    userId?: string;
    userName?: string;
  } | null;
  comments?: Array<{
    commentId?: string;
    by: {
      userId: string;
      userName?: string;
    };
    message: string;
    timestamp: Date | FieldValue;
  }>;
  attachments?: Array<{
    name: string;
    url: string;
  }>;
  linkedAuditId?: string; // Reference to an auditEvents doc
  createdAt: Date | FieldValue;
  updatedAt: Date | FieldValue;
}