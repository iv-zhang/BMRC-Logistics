/**
 * Representative BMRC seed data for the Firestore emulator.
 *
 * Faithful to the real schema in app/types.ts where the concept exists. Where
 * the data model has NO first-class concept (see MODEL.md / invariants.md
 * BLOCKERS) the seed still records the fact in a representative shape so tests
 * have something concrete to assert against — each such field/collection is
 * flagged `REPRESENTATIVE:` below. These are read by the tests, not (yet) by the
 * app.
 *
 * Import order matters: importing this module does NOT touch Firestore; call
 * seedAll(db)/clearAll(db) explicitly. The guard runs via ./harness.
 */
import {
  collection,
  doc,
  getDocs,
  writeBatch,
} from 'firebase/firestore';
import type { Firestore } from 'firebase/firestore';

const DAY = 24 * 60 * 60 * 1000;
const now = () => new Date();
const days = (n: number, from = now()) => new Date(from.getTime() + n * DAY);

/** Deterministic doc ids so tests can reference seeded entities directly. */
export const IDS = {
  epi: 'epi',
  glucose: 'glucose-strips',
  gauze: 'gauze-2x2',
  gauzeReserve: 'gauze-2x2-reserve',
  glucometer: 'glucometer',
  aed: 'aed',
  glovesField: 'gloves-field',
  glovesClass: 'gloves-class',
  packMRC1: 'MRC1',
  packMRC2: 'MRC2',
  lafEpi: 'laf-epi',
  epiLotA: 'epi-lot-A',
  epiLotB: 'epi-lot-B',
  glucoseLot: 'glu-lot-1',
} as const;

/** Every collection the seed writes — also the wipe list for clearAll(). */
export const SEED_COLLECTIONS = [
  'inventory',
  'statpacks',
  'laf_records',
  'pools',
  'users',
  'org_settings',
  // downstream collections the app/tests write into — cleared for isolation:
  'inventory_logs',
  'inventory_alerts',
  'statpack_logs',
  'auditEvents',
  'issue_reports',
  'buyList',
  'medication_logs',
  'reconciliation_exceptions',
] as const;

/**
 * Build the seed payload relative to a fixed "now". Returned as plain objects;
 * JS Dates are stored by the client SDK as Firestore Timestamps.
 */
export function buildSeedData(t0 = now()) {
  const d = (n: number) => days(n, t0);

  // ── INVENTORY ──────────────────────────────────────────────────────────────
  const inventory: Record<string, Record<string, unknown>> = {
    // Epinephrine — TWO lots from Bound Tree, different exp dates (INV-3/5/7).
    // Bag-tracked so each lot carries its own on-hand stock (itemsPerBag=1 ⇒
    // stock == units). Lot B expires EARLIER, so FEFO must draw B before A.
    [IDS.epi]: {
      name: 'Epinephrine 1mg/mL (1:1000)',
      category: 'Meds',
      unit: 'each',
      isMedication: true,
      medicationInfo: {
        isControlled: false,
        concentration: '1mg/1mL',
        route: 'IM',
        parLevel: 8,
        requiresWitness: false,
        // REPRESENTATIVE: epi is LAF-gated even though not DEA-controlled.
        requiresLAF: true,
      },
      tracksExpiration: true,
      requiresExpirationCheck: true,
      reorderThreshold: 8,
      location: 'HQ',
      room: 'Back Room',
      // REPRESENTATIVE: stock pool axis (app has no pool concept — B-2).
      pool: 'hq_reserve',
      batches: [
        {
          id: IDS.epiLotA,
          lotNumber: 'BT-EPI-A',
          supplier: 'Bound Tree',
          expirationDate: d(240), // ~2027-03
          stock: 10,
          bagCount: 10,
          itemsPerBag: 1,
          looseItems: 0,
          status: 'sealed',
          receivedAt: d(-30),
        },
        {
          id: IDS.epiLotB,
          lotNumber: 'BT-EPI-B',
          supplier: 'Bound Tree',
          expirationDate: d(120), // earlier ⇒ FEFO-first
          stock: 6,
          bagCount: 6,
          itemsPerBag: 1,
          looseItems: 0,
          status: 'sealed',
          receivedAt: d(-10),
        },
      ],
      createdAt: d(-60),
      updatedAt: d(-10),
    },

    // Glucose strips — ONE lot expiring in 20 days (inside the 90-day warning).
    [IDS.glucose]: {
      name: 'Glucose Test Strips',
      category: 'Vitals',
      unit: 'each',
      isReagent: true,
      daysValidAfterOpening: 90,
      tracksExpiration: true,
      requiresExpirationCheck: true,
      reorderThreshold: 25,
      location: 'HQ',
      room: 'Back Room',
      pool: 'field',
      batches: [
        {
          id: IDS.glucoseLot,
          lotNumber: 'GLU-2026-05',
          expirationDate: d(20),
          stock: 50,
          bagCount: 1,
          itemsPerBag: 50,
          looseItems: 0,
          status: 'sealed',
          receivedAt: d(-15),
        },
      ],
      createdAt: d(-40),
      updatedAt: d(-15),
    },

    // 2x2 gauze — received as 3 boxes; box size 200 so we can test unit vs box.
    [IDS.gauze]: {
      name: '2x2 Gauze',
      category: 'Trauma',
      unit: 'box',
      unopenedBoxes: 3,
      itemsPerBox: 200,
      looseUnits: 0,
      tracksExpiration: true,
      reorderThreshold: 100, // units
      location: 'HQ',
      room: 'Back Room',
      pool: 'field',
      batches: [],
      createdAt: d(-50),
      updatedAt: d(-20),
    },

    // HQ reserve gauze — same SKU, different pool (INV-10 field-vs-reserve).
    [IDS.gauzeReserve]: {
      name: '2x2 Gauze (HQ Reserve)',
      category: 'Trauma',
      unit: 'box',
      unopenedBoxes: 10,
      itemsPerBox: 200,
      looseUnits: 0,
      tracksExpiration: true,
      reorderThreshold: 400,
      location: 'HQ',
      room: 'Back Room',
      pool: 'hq_reserve',
      batches: [],
      createdAt: d(-50),
      updatedAt: d(-20),
    },

    // Glucometer — asset; last PASSING control test was 45 days ago (HR-4/INV-8).
    [IDS.glucometer]: {
      name: 'Glucometer (Contour Next)',
      category: 'Vitals',
      isAsset: true,
      assetCategory: 'Glucometer',
      assetStatus: 'Ready',
      assetSerial: 'GLUCO-001',
      location: 'HQ',
      room: 'Back Room',
      currentLocation: 'MRC1',
      // REPRESENTATIVE: control-test currency (app has no such field — HR-4).
      controlTest: {
        lastPassedAt: d(-45),
        intervalDays: 30, // 45 > 30 ⇒ LAPSED
        lastResult: 'pass',
      },
      createdAt: d(-120),
      updatedAt: d(-45),
    },

    // AED — good battery, pads expiring soon (within the 90-day window).
    [IDS.aed]: {
      name: 'AED (Philips FRx)',
      category: 'Vitals',
      isAsset: true,
      assetCategory: 'AED',
      assetStatus: 'Ready',
      assetSerial: 'AED-001',
      location: 'HQ',
      room: 'Back Room',
      currentLocation: 'MRC1',
      assetChecks: { batteryStatus: 'Good', padsSealed: true },
      batteryExpiration: d(400),
      padExpiration: d(25), // expiring soon
      assets: [
        {
          serial: 'AED-001',
          status: 'Ready',
          batteryStatus: 'Good',
          batteryExpiration: d(400),
          padsSealed: true,
          padExpiration: d(25),
          lastChecked: d(-5),
        },
      ],
      createdAt: d(-200),
      updatedAt: d(-5),
    },

    // Field/event glove pool and class glove pool — same real SKU, two pools.
    [IDS.glovesField]: {
      name: 'Nitrile Gloves — Field/Event',
      category: 'PPE',
      unit: 'box',
      unopenedBoxes: 5,
      itemsPerBox: 100,
      looseUnits: 0,
      tracksExpiration: false,
      reorderThreshold: 200,
      location: 'HQ',
      room: 'Back Room',
      pool: 'field',
      batches: [],
      createdAt: d(-40),
      updatedAt: d(-10),
    },
    [IDS.glovesClass]: {
      name: 'Nitrile Gloves — Class',
      category: 'PPE',
      unit: 'box',
      unopenedBoxes: 4,
      itemsPerBox: 100,
      looseUnits: 0,
      tracksExpiration: false,
      reorderThreshold: 100,
      location: 'HQ',
      room: 'Office',
      pool: 'class',
      batches: [],
      createdAt: d(-40),
      updatedAt: d(-10),
    },
  };

  // ── STATPACKS ──────────────────────────────────────────────────────────────
  // Both MRC1 and MRC2 carry epi LOT A, the glucometer, and the AED, so a recall
  // of epi-lot-A must cascade to both packs (INV-7).
  const packContents = (extra: Record<string, unknown>[] = []) => [
    {
      itemId: IDS.epi,
      batchId: IDS.epiLotA,
      lotNumber: 'BT-EPI-A',
      requiredQuantity: 2,
      currentQuantity: 2,
      pocket: 'main',
      expirationDate: d(240),
      requiresExpirationCheck: true,
    },
    {
      itemId: IDS.glucometer,
      batchId: '',
      serialNumber: 'GLUCO-001',
      assetInstanceId: 'GLUCO-001',
      requiredQuantity: 1,
      currentQuantity: 1,
      pocket: 'main',
    },
    {
      itemId: IDS.aed,
      batchId: '',
      serialNumber: 'AED-001',
      assetInstanceId: 'AED-001',
      requiredQuantity: 1,
      currentQuantity: 1,
      pocket: 'main',
    },
    {
      itemId: IDS.gauze,
      batchId: '',
      requiredQuantity: 20,
      currentQuantity: 20,
      pocket: 'main',
    },
    {
      itemId: IDS.glucose,
      batchId: IDS.glucoseLot,
      requiredQuantity: 25,
      currentQuantity: 25,
      pocket: 'main',
      expirationDate: d(20),
    },
    ...extra,
  ];

  const statpacks: Record<string, Record<string, unknown>> = {
    [IDS.packMRC1]: {
      name: 'MRC1 Primary',
      type: 'Primary',
      status: 'Ready',
      isCheckedOut: false,
      currentLocation: 'MRC1',
      compartments: [{ id: 'main', name: 'Main', parentPocket: 'main', isSealed: false }],
      contents: packContents(),
      sharpsContainer: { status: 'ok', lastCheckedAt: d(-2) },
      lastAuditAt: d(-3),
      createdAt: d(-200),
      updatedAt: d(-2),
    },
    [IDS.packMRC2]: {
      name: 'MRC2 Primary',
      type: 'Primary',
      status: 'Ready',
      isCheckedOut: false,
      currentLocation: 'MRC2',
      compartments: [{ id: 'main', name: 'Main', parentPocket: 'main', isSealed: false }],
      contents: packContents(),
      sharpsContainer: { status: 'ok', lastCheckedAt: d(-2) },
      lastAuditAt: d(-3),
      createdAt: d(-200),
      updatedAt: d(-2),
    },
  };

  // ── REPRESENTATIVE: LAF records (no app concept — INV-11 / B-3) ─────────────
  const laf_records: Record<string, Record<string, unknown>> = {
    [IDS.lafEpi]: {
      itemId: IDS.epi,
      medicationName: 'Epinephrine 1mg/mL (1:1000)',
      controlled: false,
      requiresLAF: true,
      onFile: true,
      signedBy: 'Medical Director',
      signedAt: d(-200),
      expiresAt: d(165),
      documentRef: 'LAF-2026-EPI-001',
    },
  };

  // ── REPRESENTATIVE: stock pools (no app concept — INV-10 / B-2) ─────────────
  const pools: Record<string, Record<string, unknown>> = {
    field: { name: 'Field / Event', description: 'Deployable event stock' },
    hq_reserve: { name: 'HQ Reserve', description: 'Back-room reserve; not for classes' },
    class: { name: 'Class Consumables', description: 'Training use only; must not draw field stock' },
  };

  const users: Record<string, Record<string, unknown>> = {
    'admin-1': { fullName: 'Quinn Quartermaster', email: 'qm@bmrc.test', role: 'quartermaster', createdAt: d(-300), updatedAt: d(-1) },
    'member-1': { fullName: 'Morgan Member', email: 'member@bmrc.test', role: 'member', createdAt: d(-300), updatedAt: d(-1) },
    'fto-1': { fullName: 'Frankie FTO', email: 'fto@bmrc.test', role: 'FTO', createdAt: d(-300), updatedAt: d(-1) },
  };

  const org_settings: Record<string, Record<string, unknown>> = {
    current: {
      thresholds: {
        assetValueThreshold: 500,
        expirationWarningDays: 90,
        o2PsiMin: 1800,
        statpackAuditIntervalDays: 14,
      },
      updatedAt: d(0),
      updatedBy: 'seed',
    },
  };

  return { inventory, statpacks, laf_records, pools, users, org_settings };
}

/** Delete every doc in the seed collections (bounded, known-collection wipe). */
export async function clearAll(db: Firestore): Promise<void> {
  for (const name of SEED_COLLECTIONS) {
    const snap = await getDocs(collection(db, name));
    if (snap.empty) continue;
    // Chunk deletes into batches of 400 (well under the 500 write cap).
    let batch = writeBatch(db);
    let n = 0;
    for (const docSnap of snap.docs) {
      batch.delete(docSnap.ref);
      if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(db); }
    }
    await batch.commit();
  }
}

/** Write the full representative dataset. Clears first for idempotency. */
export async function seedAll(db: Firestore, t0 = now()): Promise<void> {
  await clearAll(db);
  const data = buildSeedData(t0);
  const batch = writeBatch(db);
  for (const [colName, docs] of Object.entries(data)) {
    for (const [id, payload] of Object.entries(docs)) {
      batch.set(doc(db, colName, id), payload);
    }
  }
  await batch.commit();
}
