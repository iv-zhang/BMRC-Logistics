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
  orderDate?: Timestamp | Date;
  invoiceRef?: string;
  receivedAt?: Timestamp | Date;
  notes?: string;
}

// --- PROCUREMENT: LOG PURCHASE -> RECEIVE (two-phase) ---
/** One line item within a `Purchase` order. */
export interface PurchaseLine {
  lineId: string;
  kind: 'inventory' | 'asset';
  itemName: string;
  /** Existing item, or the placeholder doc created for a new SKU */
  linkedInventoryId?: string;
  /** Set when a placeholder inventory doc was created for this line */
  createdInventoryId?: string;
  /** Vendor catalog/SKU # to verify on arrival */
  itemNumber?: string;
  category?: string;
  /** Number of packages ordered */
  orderedQty: number;
  /** 'box' | 'bag' | 'case' | 'each' */
  unit?: string;
  unitsPerPackage?: number;
  /** Goods subtotal for this line (pre ship/tax) */
  lineCost?: number;
  // --- receipt (filled at Receive) ---
  received: boolean;
  receivedQty?: number;
  lotNumber?: string;
  /** 'YYYY-MM' */
  expirationMonth?: string;
  receivedAt?: Timestamp | Date;
  receivedBy?: string;
}

/** Order-level source of truth for cost (`purchases` collection). */
export interface Purchase {
  id?: string;
  vendor: string;
  vendorId?: string;
  orderDate: Timestamp | Date;
  status: 'ordered' | 'partially_received' | 'received' | 'cancelled';
  currency?: string; // Default: 'USD'
  /** Goods, pre-shipping & pre-tax */
  subtotal?: number;
  shipping?: number;
  tax?: number;
  discount?: number;
  /** Grand total (subtotal - discount + shipping + tax) */
  total?: number;
  poNumber?: string;
  invoiceRef?: string;
  notes?: string;
  lines: PurchaseLine[];
  createdBy: string;
  createdByName?: string;
  createdAt: Timestamp | Date | FieldValue;
  updatedAt?: Timestamp | Date | FieldValue;
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
  /** When true, this member can perform inventory audits even if not admin/quartermaster */
  canAudit?: boolean;
  /** When true, this member is on the Logistics Committee (sees the Committee Board) even if not admin/quartermaster */
  isCommitteeMember?: boolean;
  /** Whether the user has completed the onboarding tutorial */
  tutorialCompleted?: boolean;
  tutorialCompletedAt?: Date;
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
  | 'First Aid'
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

// --- BATCH STATUS ---
export type BatchStatus = 'sealed' | 'open' | 'depleted' | 'expired' | 'quarantined';

// --- STORAGE LOCATION REFERENCE ---
/** Structured reference to a storage zone/shelf/level/container from Storage Management */
export interface StorageLocationRef {
  zoneId?: string;
  zoneName?: string;       // denormalized for display
  shelfId?: string;
  shelfName?: string;      // denormalized
  level?: number;          // which level on the shelf
  containerId?: string;
  containerName?: string;  // denormalized
}

export interface InventoryBatch {
  id: string;
  lotNumber?: string;
  expirationDate?: Date;
  openDate?: Date; // For items like glucose strips that expire X days after opening
  // When an item has variants, a batch must belong to a specific variant
  variantId?: string;
  stock: number;

  // --- BAG / SUBDIVISION TRACKING ---
  /** How many items are in each bag/box for THIS specific batch (supplier may vary between orders) */
  itemsPerBag?: number;
  /** Number of sealed bags in this batch (source-of-truth count) */
  bagCount?: number;
  /** Loose individual items not in a complete bag (e.g., partially used bag) */
  looseItems?: number;
  /** Lifecycle status of this batch */
  status?: BatchStatus;
  /** When the first bag in this batch was opened */
  openedAt?: Date;
  /** User ID of person who opened this batch */
  openedBy?: string;

  // optional metadata for a batch (receivedAt, supplier, notes)
  receivedAt?: Date;
  supplier?: string;
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
  /** Loose individual units not in a complete box (e.g., partial box after subdivision) */
  looseUnits?: number;
  reorderThreshold: number;
  /** Maximum desired stock level. Progress bar shows current/maxUnits. Overstocking is allowed. */
  maxUnits?: number;
  // Par levels per location (optional): { locationId: minimumQuantity }
  parByLocation?: Record<string, number>;
  
  // DEPRECATED: Legacy fields kept for migration compatibility
  totalStockQuantity?: number;
  
  // Locations
  location: LocationType;
  room?: HQRoom;
  shelf?: string;
  bin?: string;
  /** Back-room shelf identifier (e.g., "Shelf A") */
  backShelf?: string;
  /** Back-room shelf level/row number (e.g., 1 = top, 2 = second, etc.) */
  backLevel?: number;

  /** Structured storage location from Storage Management (zone → shelf → level → container) */
  storageLocation?: StorageLocationRef;

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
  /**
   * Control-test currency for reagent-based diagnostic assets (e.g. a glucometer):
   * a fresh passing control test must be on file within `intervalDays`, otherwise
   * the asset (and any pack holding it) is treated as not service-ready.
   */
  controlTest?: {
    lastPassedAt?: Date;
    intervalDays?: number;
    lastResult?: 'pass' | 'fail' | string;
  };
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
  expirationPrecision?: 'day' | 'month'; // Precision for expiration date tracking (day = full date, month = month/year only)
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

  // Medication-specific tracking (for EMS medical cabinet compliance)
  isMedication?: boolean;
  medicationInfo?: MedicationInfo;

  // Audit tracking
  auditVerified?: boolean; // Semester audit verification flag
  // QC/Condition recorded during audit: Good (default), Damaged, or Expired
  auditCondition?: 'Good' | 'Damaged' | 'Expired';
  auditNotes?: string;
  lastAuditDate?: Date;
  isLegacyItem?: boolean; // Quick-added legacy/found items
  /** Training / non-deployable gear (trainer AEDs, manikins) — still tracked as an asset but must not be dispatched */
  isTrainer?: boolean;

  createdAt: Date;
  updatedAt: Date;

  // --- PROCUREMENT: ON-ORDER TRACKING ---
  /** Present on a placeholder row for a brand-new SKU with 0 real stock, logged via Log Purchase */
  orderStatus?: 'on_order';
  /** Pending purchase-order lines for this item; on-order is NOT on-hand (never feeds stock math) */
  incomingOrders?: {
    purchaseId: string;
    lineId: string;
    qty: number;
    unitsPerPackage?: number;
    unit?: string;
    orderDate: Timestamp | Date;
    vendor?: string;
  }[];

  // --- STATPACK ASSIGNMENT (bidirectional link) ---
  /** Structured assignment linking this asset to a specific statpack and pocket */
  statpackAssignment?: {
    statpackId: string;
    statpackName: string;
    pocket: StatpackPocket;
    compartmentLabel?: string;
    positionIndex?: number;
    assignedAt: Date | FieldValue;
    assignedBy: string;
  };

  // --- VERIFICATION TRACKING ---
  /** Results from the last verification/checkout scan */
  lastVerification?: {
    verifiedAt: Date;
    verifiedBy: string;
    verifiedByName: string;
    barcodeMatched?: boolean;
    fieldValues?: Record<string, unknown>;
    warnings?: Array<{ fieldId: string; message: string; severity: string }>;
    passed: boolean;
  };

  // Asset-specific fields (for non-disposable high-value items: O2 tanks, AEDs, bikes, radios, etc.)
  assetValue?: number; // Monetary value in dollars
  currentLocation?: string; // Where the asset is currently (GPS or room location)
  /** Per-unit dollar value for consumables (mirrors `assetValue` for assets). Stamped from purchase unit cost. */
  itemValue?: number;
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

// Custom admin-configurable warning for statpack items (shown during checkout)
export interface StatpackWarning {
  id: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
  /** When true, the person checking out must acknowledge this warning before proceeding */
  requiresAcknowledgment?: boolean;
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
  // Admin-configurable custom warnings shown during checkout (e.g., "Verify glucose strips match glucometer brand")
  customWarnings?: StatpackWarning[];
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
  /** Last full audit (biweekly cadence) — set only by mode=audit check-offs */
  lastAuditAt?: Date;
  lastAuditBy?: string;
  /** Last admin edit of expected contents; drives the "contents changed since last audit" indicator */
  contentsUpdatedAt?: Date;
  currentEvent?: string;
  /** Pack-level sharps container safety check, stamped on each check-off */
  sharpsContainer?: {
    status: 'ok' | 'full' | 'na';
    lastCheckedAt?: Date;
    lastCheckedBy?: string;
  };
  
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

/** Issue recorded for a specific item during statpack checkout/checkin (NOT the global IssueReport) */
export interface StatpackItemIssue {
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
  action: 'checkout' | 'checkin' | 'restock' | 'created' | 'maintenance' | 'audit' | 'content_edit';
  pairId?: string; // Explicit pairing between checkout + checkin
  quickCheckin?: boolean; // True when member used quick check-in (no items used)
  userId: string;
  userName: string;
  timestamp: Date | FieldValue;
  clientTimestamp?: Date; // Client-side time for immediate display
  notes?: string;
  mismatchResolutions?: MismatchResolution[];
  validationWarnings?: ValidationWarning[];
  
  // Summary statistics for admin audit review
  summary?: {
    totalItems: number;
    verifiedCount: number;
    mismatchCount: number;
    expiredCount: number;
    restockedCount?: number; // Items that were restocked during check-in
    shelfEmptyCount?: number; // Items where restock shelf was empty
    reportedCount?: number; // Items the member filed an issue report on
  };

  // Pack-level sharps container safety check submitted with this check-off
  sharpsCheck?: { status: 'ok' | 'full' | 'na'; notes?: string };
  
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
    /** Freshly entered/confirmed expiration persisted onto the pack content */
    newExpirationDate?: Date | FieldValue;
    /** Oxygen tank PSI reading recorded during the check */
    oxygenPsi?: number;
    /** Regulator visual check passed */
    regulatorOk?: boolean;
    /** Member acknowledged a short/expired item and chose to proceed */
    acknowledged?: boolean;
    acknowledgeReason?: string;
    /** Member reported a problem with this item (spawns an issue_report) */
    issue?: { type: 'missing' | 'broken' | 'expired'; quantity?: number; notes?: string };
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
    // Restock tracking during check-in: what the member did when an item was short
    restockStatus?: 'restocked' | 'shelf_empty' | 'not_needed';
    restockNotes?: string; // Free-text note about restock attempt
  }[];
  
  // Detailed Issue Tracking
  issues?: {
      sealChecks?: Record<string, { sealed: boolean; sealNumber?: string; expiration?: Date }>;
      oxygenReadings?: Record<string, string>;
      issueReports?: Record<string, StatpackItemIssue>;
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
  /** Training / non-deployable gear (trainer AEDs, manikins) — still tracked as an asset but must not be dispatched */
  isTrainer?: boolean;
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
  /** Building floor this zone is on: upper = entrance level, lower = main HQ */
  level?: 'upper' | 'lower';
  createdAt?: Date;
  updatedAt?: Date;
}

export interface Shelf {
  id: string;
  name: string;
  zoneId?: string | null;
  capacity?: number | null;
  barcode?: string | null;
  /** Number of levels/rows on this shelf (e.g., 4 for a 4-tier shelf) */
  numberOfLevels?: number;
  /** Optional label per level (e.g., ["Top", "Middle", "Bottom"]) */
  levelLabels?: string[];
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

// --- BUY LIST (Admin Shopping List) ---
export interface BuyListItem {
  id?: string;
  itemName: string;
  quantity?: number;
  unit?: string; // 'boxes', 'each', 'cases', etc.
  category?: ItemCategory | string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  notes?: string;
  /** Optional link to existing inventory item */
  linkedInventoryId?: string;
  status: 'pending' | 'ordered' | 'received';
  addedBy: string; // userId
  addedByName?: string;
  addedAt: Date | FieldValue;
  orderedAt?: Date | FieldValue;
  receivedAt?: Date | FieldValue;
  completedBy?: string;
  completedByName?: string;
}

// --- BUG REPORTS & ISSUE TRACKING ---

// --- LOGISTICS TASK LIST ---
export type TaskCategory = 'buy' | 'fix' | 'restock' | 'admin' | 'other';
export interface TaskItem {
  id?: string;
  title: string;
  description?: string;
  /** Acceptance criteria — what must be true for this task to count as done */
  definitionOfDone?: string;
  category: TaskCategory;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  /** Legacy docs may contain 'todo'; readers normalize it to 'backlog' (see app/tasks/page.tsx) */
  status: 'backlog' | 'this_cycle' | 'in_progress' | 'blocked' | 'done';
  /** For buy-type tasks: quantity and unit */
  quantity?: number;
  unit?: string;
  /** Optional link to inventory item */
  linkedInventoryId?: string;
  /** Optional link to buy list item */
  linkedBuyListId?: string;
  /** Who created it */
  createdBy: string;
  createdByName?: string;
  assignedTo?: string;
  assignedToName?: string;
  dueDate?: Date | null;
  completedAt?: Date | FieldValue | null;
  completedBy?: string;
  completedByName?: string;
  createdAt: Date | FieldValue;
  updatedAt?: Date | FieldValue;
  notes?: string;
}

// --- TEAM TASK BOARD (Logistics Committee) ---
export type TeamTaskStatus =
  | 'backlog' | 'this_cycle' | 'in_progress' | 'blocked' | 'done';

/** One owner of a team task (owners are admins/quartermasters). */
export interface TeamTaskOwner {
  id: string;                     // users/{uid}
  name: string;                   // denormalized fullName
}

/** A progress note appended to a task's timeline. */
export interface TeamTaskUpdate {
  id: string;
  text: string;
  authorId: string;
  authorName: string;
  // Timestamp.now() on write — serverTimestamp() is rejected inside array elements.
  createdAt: Date | Timestamp;
}

/** A checklist item within a task. */
export interface TeamSubtask {
  id: string;
  text: string;
  done: boolean;
}

export interface TeamTask {
  id?: string;
  title: string;
  owners: TeamTaskOwner[];        // one or more admins/quartermasters
  /** @deprecated legacy single-owner fields — read-only, kept for back-compat */
  ownerId?: string;
  ownerName?: string;
  status: TeamTaskStatus;
  definitionOfDone: string;
  dueDate?: Date | null;
  /** Progress notes, oldest→newest */
  updates?: TeamTaskUpdate[];
  /** Checklist / todo items within the task */
  subtasks?: TeamSubtask[];
  createdBy: string;
  createdByName: string;
  createdAt: Date | FieldValue;   // serverTimestamp() on write
  /** Stamped when the card enters 'done'; cleared if it leaves */
  completedAt?: Date | FieldValue | null;
  completedBy?: string;
  completedByName?: string;
}

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

// --- MEDICATION CABINET TRACKING ---
// Mirrors a 911 EMS agency medical cabinet with strict chain-of-custody

export interface MedicationLog {
  id?: string;
  medicationId: string; // Reference to InventoryItem.id
  medicationName: string;
  action: 'check_out' | 'check_in' | 'administered' | 'wasted' | 'expired_disposal' | 'inventory_count' | 'received';
  /** Lot number of the specific unit transacted */
  lotNumber: string;
  /** Expiration date of the specific unit */
  expirationDate: Date;
  /** Quantity transacted (e.g., 1 vial, 2 ampules) */
  quantity: number;
  /** Running count after this transaction (like a paper narcotic log) */
  runningCount: number;
  /** Who performed the action */
  performedBy: {
    userId: string;
    userName: string;
  };
  /** Witness/cosigner for controlled substances */
  witness?: {
    userId: string;
    userName: string;
  };
  /** Where the medication was taken from or returned to */
  location?: string;
  /** Reason for wasting / administering */
  reason?: string;
  /** Patient care report number (if administered) */
  pcrNumber?: string;
  /** General notes */
  notes?: string;
  /** Concentration / dosage info confirmed during transaction */
  concentration?: string;
  /** Route confirmed (IM, IV, SQ, etc.) */
  route?: string;
  timestamp: Date | FieldValue;
}

// --- VEHICLES ---
// Individual fleet vehicles (roster docs in `vehicles`). Vehicle TYPES stay in
// org config (`VehicleDef` in app/config/org-config.ts); `Vehicle.typeId`
// references a VehicleDef.id.

export type VehicleStatus = 'active' | 'retired';

export interface Vehicle {
  id?: string;
  /** "Ambulance 2", "UTV-1" */
  name: string;
  /** VehicleDef.id from org config ('ambulance' | 'utv' | 'ebike' | …) */
  typeId: string;
  status: VehicleStatus;
  notes?: string;
  /** Live checkout state — AUTHORITATIVE; the open vehicle_logs doc mirrors it
   *  (both written in one transaction, statpack pattern). */
  isCheckedOut: boolean;
  /** Open vehicle_logs doc id while checked out; O(1) check-in lookup */
  activeLogId?: string | null;
  assignedToUserId?: string | null;
  assignedToUserName?: string | null;
  checkedOutAt?: Date | FieldValue | null;
  /** Last known readings, denormalized FROM the latest closed log */
  lastMileage?: number | null;
  /** 0 | 25 | 50 | 75 | 100 (E / ¼ / ½ / ¾ / F) */
  lastFuelLevel?: number | null;
  /** 0–100 % */
  lastBatteryLevel?: number | null;
  createdAt?: Date | FieldValue;
  createdBy?: string;
  updatedAt?: Date | FieldValue;
  retiredAt?: Date | FieldValue | null;
  retiredBy?: string | null;
}

/** Pre- or post-shift readings; which fields apply comes from the vehicle
 *  type's reading fields (getReadingFieldsForVehicleType in org-config). */
export interface VehicleShiftReadings {
  mileage?: number;
  /** 0 | 25 | 50 | 75 | 100 (E / ¼ / ½ / ¾ / F) */
  fuelLevel?: number;
  /** 0–100 % */
  batteryLevel?: number;
}

export type VehicleLogStatus = 'open' | 'closed' | 'force_closed';

/** One document per shift in `vehicle_logs`: created 'open' at checkout with
 *  pre-readings, completed at check-in with post-readings. Abandoned shifts
 *  stay visibly 'open' until an admin force-closes them. */
export interface VehicleLog {
  id?: string;
  vehicleId: string;
  /** Snapshot at checkout — history stays readable after rename/retire */
  vehicleName: string;
  /** Snapshot at checkout */
  vehicleTypeId: string;
  status: VehicleLogStatus;
  driverUserId: string;
  driverName: string;
  /** Free-text team member names */
  crewNames?: string[];
  checkoutAt: Date | FieldValue;
  /** Client-side time for immediate display (StatpackLog.clientTimestamp pattern) */
  checkoutClientAt?: Date;
  checkinAt?: Date | FieldValue | null;
  checkinClientAt?: Date | null;
  /** Who closed the log (driver or admin) */
  checkinUserId?: string | null;
  checkinUserName?: string | null;
  preReadings?: VehicleShiftReadings;
  postReadings?: VehicleShiftReadings;
  /** NEW damage noted at checkout (free text; also files an issue report) */
  preDamage?: string | null;
  /** NEW damage noted at check-in (free text; also files an issue report) */
  postDamage?: string | null;
  /** Required note when checkout mileage ≠ vehicle.lastMileage */
  mileageMismatchAck?: string | null;
  notes?: string;
  /** Set with status 'force_closed' by an admin */
  forceCloseReason?: string | null;
}

/** Medication-specific fields added to InventoryItem when isMedication is true */
export interface MedicationInfo {
  /** Whether this is a controlled substance */
  isControlled?: boolean;
  /** DEA schedule (II, III, IV, V) if controlled */
  deaSchedule?: 'II' | 'III' | 'IV' | 'V';
  /** Drug concentration (e.g., "1mg/1mL", "0.3mg auto-injector") */
  concentration?: string;
  /** Administration route (IM, IV, SQ, PO, IN, etc.) */
  route?: string;
  /** Storage requirements (e.g., "Room temp", "Refrigerate 2-8°C", "Protect from light") */
  storageRequirements?: string;
  /** Whether a witness/cosigner is required for all transactions */
  requiresWitness?: boolean;
  /** Minimum stock level for this medication (triggers alert) */
  parLevel?: number;
  /** National Drug Code */
  ndcNumber?: string;
}