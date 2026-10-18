/**
 * Emulator test for the per-role production rules, `firestore.prod.rules`
 * (plan §2, packet R4). Supersedes `rules-stopgap.test.ts`: every stopgap case that
 * is still true is folded in here (the two it asserted as a "known limitation" are
 * now inverted).
 *
 * The suite loads the PRODUCTION rules (not the open emulator file) into the Firestore
 * emulator and checks, per role:
 *   - every legitimate member/helper/FTO flow still passes ("flow:" tests),
 *   - every tightened collection allows the right roles and denies the others,
 *   - anonymous callers are locked out everywhere,
 *   - `private/*` docs honour org_settings.privateFinanceRoles (incl. the default).
 *
 * Run:  npm run test:rules
 *
 * Fixtures use fake names only. No real project is ever contacted: demo-* project id,
 * emulator host required.
 */
import { after, before, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';

const PROJECT_ID = 'demo-bmrc-logistics';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('rules: FIRESTORE_EMULATOR_HOST not set; run via `npm run test:rules`.');
  process.exit(1);
}

type RoleKey =
  | 'admin'
  | 'quartermaster'
  | 'treasurer'
  | 'inventory_helper'
  | 'FTO'
  | 'fto_intern'
  | 'medops'
  | 'member';

const ROLE_KEYS: RoleKey[] = [
  'admin',
  'quartermaster',
  'treasurer',
  'inventory_helper',
  'FTO',
  'fto_intern',
  'medops',
  'member',
];

const UID: Record<RoleKey, string> = {
  admin: 'uid_admin_ada',
  quartermaster: 'uid_qm_quinn',
  treasurer: 'uid_treasurer_tess',
  inventory_helper: 'uid_helper_hana',
  FTO: 'uid_fto_finn',
  fto_intern: 'uid_intern_ivy',
  medops: 'uid_medops_max',
  member: 'uid_member_morgan',
};
const ADMIN = UID.admin;
const QM = UID.quartermaster;
const MEDOPS = UID.medops;
const MEMBER = UID.member;
const FTO = UID.FTO;
const OTHER_MEMBER = 'uid_member_riley';
const AUDITOR = 'uid_member_auditor'; // role member, canAudit: true
const NEWBIE = 'uid_newbie_sam'; // authenticated, no users doc yet

// Roles groupings used by the expectations below.
const MANAGERS: RoleKey[] = ['admin', 'quartermaster']; // canManageLogistics
const EVENT_MANAGERS: RoleKey[] = ['admin', 'quartermaster', 'medops']; // canManageEvents
const OPERATORS: RoleKey[] = ['admin', 'quartermaster', 'inventory_helper']; // + canAudit members
const EVERYONE = ROLE_KEYS;

let env: RulesTestEnvironment;

before(async () => {
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST!.split(':');
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host,
      port: Number(port),
      rules: readFileSync(join(process.cwd(), 'firestore.prod.rules'), 'utf8'),
    },
  });
});

after(async () => {
  await env?.cleanup();
});

// ── fixtures ────────────────────────────────────────────────────────────────

interface SeedOptions {
  /** Put `privateFinanceRoles` on org_settings/current (default: field absent). */
  privateFinanceRoles?: string[];
}

async function seed(opts: SeedOptions = {}) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const base = { createdAt: new Date(), updatedAt: new Date() };
    const b = writeBatch(db);
    for (const role of ROLE_KEYS) {
      b.set(doc(db, 'users', UID[role]), {
        id: UID[role], fullName: `Fake ${role}`, email: `${role}@example.test`, role, ...base,
      });
    }
    b.set(doc(db, 'users', OTHER_MEMBER), { id: OTHER_MEMBER, fullName: 'Riley Member', role: 'member', ...base });
    b.set(doc(db, 'users', AUDITOR), { id: AUDITOR, fullName: 'Aud Itor', role: 'member', canAudit: true, ...base });

    b.set(doc(db, 'org_settings', 'current'), {
      org: { name: 'Fake Org' },
      ...(opts.privateFinanceRoles ? { privateFinanceRoles: opts.privateFinanceRoles } : {}),
    });

    // consumable + asset inventory
    b.set(doc(db, 'inventory', 'item1'), { id: 'item1', name: 'Gauze', unopenedBoxes: 3, isAsset: false });
    b.set(doc(db, 'inventory', 'asset1'), { id: 'asset1', name: 'Fake AED', isAsset: true, assetStatus: 'Ready' });
    b.set(doc(db, 'statpacks', 'pack1'), { id: 'pack1', name: 'Pack One', isCheckedOut: false, status: 'Ready' });
    b.set(doc(db, 'inventory_logs', 'log1'), { itemId: 'item1' });
    b.set(doc(db, 'statpack_logs', 'slog1'), { statpackId: 'pack1' });
    b.set(doc(db, 'auditEvents', 'ae1'), { eventType: 'x' });
    b.set(doc(db, 'medication_logs', 'ml1'), { itemId: 'item1' });
    b.set(doc(db, 'storage_zones', 'zone1'), { name: 'Zone' });
    b.set(doc(db, 'shelves', 'shelf1'), { name: 'Shelf' });
    b.set(doc(db, 'containers', 'cont1'), { name: 'Bin' });
    b.set(doc(db, 'barcode_index', 'CODE1'), { itemId: 'item1' });
    b.set(doc(db, 'audit_locks', 'zoneA'), { lockedBy: AUDITOR });

    // events + staffing
    b.set(doc(db, 'events', 'ev1'), {
      name: 'Fake Game', status: 'open',
      teams: [{ id: 't1', name: 'Team 1', ftoSlot: { userId: FTO }, emtSlots: [{ userId: MEMBER, requestId: 'req_approved' }] }],
    });
    b.set(doc(db, 'shift_requests', 'req_pending'), { userId: MEMBER, eventId: 'ev1', teamId: 't1', status: 'pending' });
    b.set(doc(db, 'shift_requests', 'req_approved'), {
      userId: MEMBER, eventId: 'ev1', teamId: 't1', status: 'approved',
      attendance: { checkedInAt: new Date() },
    });
    b.set(doc(db, 'shift_requests', 'req_other'), { userId: OTHER_MEMBER, eventId: 'ev1', teamId: 't1', status: 'pending' });
    b.set(doc(db, 'notifications', 'n_member'), { userId: MEMBER, read: false, title: 'hi' });
    b.set(doc(db, 'notifications', 'n_other'), { userId: OTHER_MEMBER, read: false, title: 'hi' });

    // vehicles / bags
    b.set(doc(db, 'vehicles', 'veh1'), { name: 'Fake Van', isCheckedOut: false });
    b.set(doc(db, 'vehicle_logs', 'vl1'), { vehicleId: 'veh1', status: 'open' });
    b.set(doc(db, 'exchange_bags', 'bag1'), { name: 'Bag', fullCount: 2, emptyCount: 0 });

    // reports / tasks / purchasing
    b.set(doc(db, 'issue_reports', 'ir1'), { reporter: { userId: MEMBER }, title: 'x' });
    b.set(doc(db, 'restock_reports', 'rr1'), { itemId: 'item1' });
    b.set(doc(db, 'team_tasks', 'task1'), { title: 'Restock', status: 'backlog', owners: [] });
    b.set(doc(db, 'buyList', 'buy1'), { itemName: 'Gauze', quantity: 2, status: 'pending' });
    b.set(doc(db, 'purchases', 'p1'), { vendor: 'Fake Vendor', status: 'ordered', lines: [], createdBy: ADMIN });
    b.set(doc(db, 'purchases', 'p1', 'private', 'payment'), { payee: 'Fake Payee', zelle: 'fake@example.test' });
    b.set(doc(db, 'vendors', 'v1'), { name: 'Fake Vendor' });
    b.set(doc(db, 'tasks', 't1'), { title: 'old task' });
    b.set(doc(db, 'restock_categories', 'rc1'), { name: 'Cat', itemRestocks: {} });

    // apparel + provisional uniform collections
    b.set(doc(db, 'apparel_items', 'ap1'), { name: 'Jacket', status: 'available' });
    b.set(doc(db, 'apparel_categories', 'ac1'), { name: 'Jackets' });
    b.set(doc(db, 'uniform_orders', 'uo_member'), { userId: MEMBER, total: 1 });
    b.set(doc(db, 'uniform_orders', 'uo_other'), { userId: OTHER_MEMBER, total: 1 });
    b.set(doc(db, 'loaner_checkouts', 'lo_member'), { userId: MEMBER });
    b.set(doc(db, 'loaner_checkouts', 'lo_other'), { userId: OTHER_MEMBER });
    b.set(doc(db, 'uniform_rounds', 'round1'), { name: 'Fall' });

    // dashboards
    b.set(doc(db, 'dashboards', 'published__staffing'), { published: true, tiles: [] });
    b.set(doc(db, 'dashboards', `${MEMBER}__staffing`), { ownerUid: MEMBER, tiles: [] });

    // one pre-existing row in each append-only ledger
    for (const name of ['inventory_logs', 'statpack_logs', 'auditEvents', 'medication_logs', 'box_logs', 'exchange_bag_events', 'apparel_claims', 'inventory_alerts']) {
      b.set(doc(db, name, 'row1'), { x: 1 });
    }

    // a collection the rules do not know about
    b.set(doc(db, 'mystery', 'm1'), { x: 1 });
    await b.commit();
  });
}

const as = (uid: string): Firestore => env.authenticatedContext(uid).firestore() as unknown as Firestore;
const anon = (): Firestore => env.unauthenticatedContext().firestore() as unknown as Firestore;

type Op = (db: Firestore, uid: string) => Promise<unknown>;

/**
 * Run `op` once as each role (fresh data each time) and require success exactly for
 * `allowed`. `auditor` additionally controls the canAudit==true member.
 */
async function matrix(allowed: RoleKey[], op: Op, extra: { auditor?: boolean } = {}) {
  for (const role of ROLE_KEYS) {
    await seed();
    const result = op(as(UID[role]), UID[role]);
    if (allowed.includes(role)) await assertSucceeds(result);
    else await assertFails(result);
  }
  if (extra.auditor !== undefined) {
    await seed();
    const result = op(as(AUDITOR), AUDITOR);
    if (extra.auditor) await assertSucceeds(result);
    else await assertFails(result);
  }
}

// ── anonymous ───────────────────────────────────────────────────────────────

const COLLECTIONS = [
  'users', 'org_settings', 'dashboards', 'events', 'shift_requests', 'notifications',
  'inventory', 'inventory_logs', 'statpack_logs', 'auditEvents', 'box_logs', 'medication_logs',
  'exchange_bag_events', 'apparel_claims', 'inventory_alerts', 'barcode_index', 'audit_locks',
  'storage_zones', 'shelves', 'containers', 'statpacks', 'vehicles', 'vehicle_logs', 'exchange_bags',
  'restock_categories', 'restock_shelf_events', 'restock_actions', 'issue_reports', 'restock_reports',
  'team_tasks', 'tasks', 'buyList', 'purchases', 'purchase_history', 'purchase_requests', 'vendors',
  'laf_records', 'apparel_items', 'apparel_categories', 'uniform_orders', 'uniform_rounds',
  'loaner_checkouts', 'mystery',
];

describe('anonymous access is denied everywhere', () => {
  it('cannot read or list any collection, nor a private doc', async () => {
    await seed();
    for (const name of COLLECTIONS) {
      await assertFails(getDocs(collection(anon(), name)));
      await assertFails(getDoc(doc(anon(), name, 'anything')));
    }
    await assertFails(getDoc(doc(anon(), 'purchases', 'p1', 'private', 'payment')));
  });
  it('cannot create, update or delete anything', async () => {
    await seed();
    for (const name of COLLECTIONS) {
      await assertFails(setDoc(doc(anon(), name, 'new_doc'), { name: 'x' }));
      await assertFails(updateDoc(doc(anon(), name, 'item1'), { name: 'x' }));
      await assertFails(deleteDoc(doc(anon(), name, 'item1')));
    }
    await assertFails(setDoc(doc(anon(), 'purchases', 'p1', 'private', 'payment'), { payee: 'x' }));
    await assertFails(updateDoc(doc(anon(), 'users', MEMBER), { role: 'admin' }));
    await assertFails(setDoc(doc(anon(), 'users', 'uid_evil'), { id: 'uid_evil', role: 'member' }));
  });
});

// ── users (stopgap cases, folded in) ────────────────────────────────────────

describe('users', () => {
  it('register/page.tsx payload is allowed (self, role member)', async () => {
    await seed();
    await assertSucceeds(
      setDoc(doc(as(NEWBIE), 'users', NEWBIE), {
        id: NEWBIE, fullName: 'Sam Newbie', email: 'sam@example.test', role: 'member',
        tutorialCompleted: false, createdAt: new Date(), updatedAt: new Date(),
      }),
    );
  });
  it('app-sidebar self-heal payload is allowed (serverTimestamp, no tutorialCompleted)', async () => {
    await seed();
    await assertSucceeds(
      setDoc(doc(as(NEWBIE), 'users', NEWBIE), {
        id: NEWBIE, email: 'sam@example.test', fullName: 'Sam Newbie', role: 'member',
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      }),
    );
  });
  it('self-create with a privileged role is denied; creating for another uid is denied', async () => {
    await seed();
    for (const role of ['admin', 'quartermaster', 'treasurer', 'medops', 'FTO']) {
      await assertFails(setDoc(doc(as(NEWBIE), 'users', NEWBIE), { id: NEWBIE, role }));
    }
    await assertFails(setDoc(doc(as(NEWBIE), 'users', 'uid_someone_else'), { id: 'uid_someone_else', role: 'member' }));
  });
  it('nobody changes their own role (members, medops, admin, treasurer)', async () => {
    await seed();
    await assertFails(updateDoc(doc(as(MEMBER), 'users', MEMBER), { role: 'admin' }));
    await assertFails(setDoc(doc(as(MEMBER), 'users', MEMBER), { role: 'admin' }, { merge: true }));
    await assertFails(updateDoc(doc(as(MEDOPS), 'users', MEDOPS), { role: 'admin' }));
    await assertFails(updateDoc(doc(as(UID.treasurer), 'users', UID.treasurer), { role: 'admin' }));
    await assertFails(updateDoc(doc(as(ADMIN), 'users', ADMIN), { role: 'member' }));
  });
  it('self non-role updates are allowed (onboarding tour stamp)', async () => {
    await seed();
    await assertSucceeds(updateDoc(doc(as(MEMBER), 'users', MEMBER), { tutorialCompleted: true, tutorialCompletedAt: serverTimestamp() }));
    await assertSucceeds(setDoc(doc(as(MEMBER), 'users', MEMBER), { tutorialCompleted: true }, { merge: true }));
    await assertSucceeds(updateDoc(doc(as(ADMIN), 'users', ADMIN), { tutorialCompleted: true }));
  });
  it('flow: member updates own certifications', async () => {
    await seed();
    await assertSucceeds(updateDoc(doc(as(MEMBER), 'users', MEMBER), { 'certifications.cpr.expiresOn': new Date(), updatedAt: serverTimestamp() }));
  });
  it('a member, helper, FTO or treasurer cannot update another user', async () => {
    await seed();
    for (const role of ['member', 'inventory_helper', 'FTO', 'treasurer'] as RoleKey[]) {
      await assertFails(updateDoc(doc(as(UID[role]), 'users', OTHER_MEMBER), { memberStatus: 'new' }));
    }
    await assertFails(updateDoc(doc(as(MEMBER), 'users', ADMIN), { role: 'member' }));
  });
  it('medops roster edits work (role, memberStatus, joinedTerm, canAudit, isCommitteeMember, certs)', async () => {
    await seed();
    const target = doc(as(MEDOPS), 'users', MEMBER);
    await assertSucceeds(updateDoc(target, { role: 'FTO' }));
    await assertSucceeds(updateDoc(target, { memberStatus: 'probationary' }));
    await assertSucceeds(updateDoc(target, { joinedTerm: 'Fall 2026' }));
    await assertSucceeds(updateDoc(target, { canAudit: true }));
    await assertSucceeds(updateDoc(target, { isCommitteeMember: true }));
    await assertSucceeds(updateDoc(target, { 'certifications.emt.verifiedBy': 'Max', updatedAt: serverTimestamp() }));
  });
  it('medops cannot escalate (admin/QM/treasurer/medops promotion, demoting an admin, creating admin docs)', async () => {
    await seed();
    const db = as(MEDOPS);
    for (const role of ['admin', 'quartermaster', 'treasurer', 'medops', 'inventory_helper']) {
      await assertFails(updateDoc(doc(db, 'users', MEMBER), { role }));
    }
    await assertFails(updateDoc(doc(db, 'users', ADMIN), { role: 'member' }));
    await assertFails(setDoc(doc(db, 'users', '__test_admin'), { id: '__test_admin', role: 'admin' }, { merge: true }));
    await assertSucceeds(updateDoc(doc(db, 'users', ADMIN), { memberStatus: 'general' }));
    await assertSucceeds(updateDoc(doc(db, 'users', MEMBER), { role: 'fto_intern' }));
  });
  it('admin and quartermaster may edit other users, incl. the setAuditPermission batch', async () => {
    await seed();
    await assertSucceeds(updateDoc(doc(as(ADMIN), 'users', MEMBER), { role: 'treasurer' }));
    const db = as(QM);
    const batch = writeBatch(db);
    batch.update(doc(db, 'users', OTHER_MEMBER), { canAudit: true, updatedAt: serverTimestamp() });
    batch.set(doc(collection(db, 'auditEvents')), { eventType: 'audit_permission_granted' });
    await assertSucceeds(batch.commit());
  });
  it('admin/QM seed __test_* identity docs (merge setDoc); a plain member cannot', async () => {
    await seed();
    for (const uid of [ADMIN, QM]) {
      const db = as(uid);
      for (const [id, role] of [['__test_member', 'member'], ['__test_fto', 'FTO'], ['__test_medops', 'medops'], ['__test_admin', 'admin']]) {
        await assertSucceeds(setDoc(doc(db, 'users', id), { id, role, isTestUser: true, fullName: 'Test', createdAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true }));
        await assertSucceeds(setDoc(doc(db, 'users', id), { id, role, isTestUser: true, updatedAt: serverTimestamp() }, { merge: true }));
      }
    }
    await assertFails(setDoc(doc(as(MEMBER), 'users', '__test_admin'), { id: '__test_admin', role: 'admin' }, { merge: true }));
  });
  it('delete: admin/QM only', async () => {
    await matrix(MANAGERS, (db) => deleteDoc(doc(db, 'users', OTHER_MEMBER)));
  });
  it('read: any signed-in user (incl. the by-role recipient queries); a user with no doc yet reads cleanly', async () => {
    await seed();
    await assertSucceeds(getDoc(doc(as(MEMBER), 'users', ADMIN)));
    await assertSucceeds(getDocs(collection(as(MEMBER), 'users')));
    await assertSucceeds(getDocs(query(collection(as(MEMBER), 'users'), where('role', 'in', ['admin', 'quartermaster', 'medops']))));
    await assertSucceeds(getDoc(doc(as(NEWBIE), 'users', NEWBIE)));
  });
});

// ── member / helper / FTO flows (must keep working) ─────────────────────────

describe('flows every non-manager legitimately performs', () => {
  it('flow: statpack check-off transaction (statpack update + statpack_logs) for every role', async () => {
    await matrix(EVERYONE, (db, uid) =>
      runTransaction(db, async (tx) => {
        const packRef = doc(db, 'statpacks', 'pack1');
        const snap = await tx.get(packRef);
        if (!snap.exists()) throw new Error('missing pack');
        tx.update(packRef, { isCheckedOut: true, assignedToUserId: uid, status: 'In Use', currentEventId: 'ev1' });
        tx.set(doc(collection(db, 'statpack_logs')), { statpackId: 'pack1', userId: uid, action: 'checkout', timestamp: serverTimestamp() });
      }),
      { auditor: true },
    );
  });
  it('flow: after check-in, auto end-shift sweep stamps attendance.shiftEndAt on OTHER members', async () => {
    await matrix(EVERYONE, (db) => {
      const b = writeBatch(db);
      b.update(doc(db, 'shift_requests', 'req_approved'), { 'attendance.shiftEndAt': serverTimestamp() });
      return b.commit();
    }, { auditor: true });
  });
  it('flow: after check-in, restock flag creates/refreshes a team_tasks card and notifies admins', async () => {
    await matrix(EVERYONE, async (db, uid) => {
      await getDocs(query(collection(db, 'team_tasks'), where('linkedStatpackId', '==', 'pack1'), where('status', 'in', ['backlog', 'in_progress'])));
      await getDocs(query(collection(db, 'users'), where('role', 'in', ['admin', 'quartermaster'])));
      await updateDoc(doc(db, 'team_tasks', 'task1'), { subtasks: [{ id: 'a', text: 'x', done: false }] });
      await addDoc(collection(db, 'team_tasks'), { title: 'Restock Pack', owners: [], status: 'backlog', createdBy: uid, createdAt: serverTimestamp() });
      const b = writeBatch(db);
      b.set(doc(collection(db, 'notifications')), { userId: ADMIN, type: 'broadcast', read: false, createdAt: serverTimestamp() });
      b.set(doc(collection(db, 'notifications')), { userId: QM, type: 'broadcast', read: false, createdAt: serverTimestamp() });
      await b.commit();
      await addDoc(collection(db, 'issue_reports'), { reporter: { userId: uid }, target: 'statpacks/pack1', createdAt: serverTimestamp() });
      await addDoc(collection(db, 'inventory_logs'), { itemId: 'item1', action: 'validation_warning' });
    }, { auditor: true });
  });
  it('flow: exchange bag swap at check-off (bag update + event row)', async () => {
    await matrix(EVERYONE, (db) => {
      const b = writeBatch(db);
      b.update(doc(db, 'exchange_bags', 'bag1'), { fullCount: increment(-1), emptyCount: increment(1), updatedAt: serverTimestamp() });
      b.set(doc(collection(db, 'exchange_bag_events')), { bagId: 'bag1', action: 'swap', createdAt: serverTimestamp() });
      return b.commit();
    }, { auditor: true });
  });
  it('flow: shift request (own) + manager notification broadcast; fto_intern included', async () => {
    await matrix(EVERYONE, async (db, uid) => {
      await addDoc(collection(db, 'shift_requests'), { userId: uid, eventId: 'ev1', teamId: 't1', status: 'pending', requestedAt: serverTimestamp() });
      await addDoc(collection(db, 'notifications'), { userId: ADMIN, broadcast: true, type: 'broadcast', read: false, createdAt: serverTimestamp() });
    }, { auditor: true });
  });
  it('flow: cancel own pending request; cancel own approved request frees the event slot', async () => {
    await seed();
    const db = as(MEMBER);
    await assertSucceeds(updateDoc(doc(db, 'shift_requests', 'req_pending'), { status: 'cancelled', decidedAt: serverTimestamp() }));
    await assertSucceeds(
      runTransaction(db, async (tx) => {
        const eventRef = doc(db, 'events', 'ev1');
        const reqRef = doc(db, 'shift_requests', 'req_approved');
        await tx.get(eventRef);
        tx.update(eventRef, { teams: [{ id: 't1', name: 'Team 1', ftoSlot: { userId: FTO }, emtSlots: [{}] }], updatedAt: serverTimestamp() });
        tx.update(reqRef, { status: 'cancelled', decidedAt: serverTimestamp() });
      }),
    );
  });
  it('flow: FTO live attendance on a team member row (check in / check out stamp)', async () => {
    await seed();
    await assertSucceeds(updateDoc(doc(as(FTO), 'shift_requests', 'req_other'), {
      attendance: { checkedInAt: new Date(), minutesLate: 0, recordedBy: FTO, recordedAt: serverTimestamp() },
    }));
  });
  it('flow: issue report and restock report by any role', async () => {
    await matrix(EVERYONE, async (db, uid) => {
      await addDoc(collection(db, 'issue_reports'), { reporter: { userId: uid }, target: 'statpacks/pack1', createdAt: serverTimestamp() });
      await addDoc(collection(db, 'restock_reports'), { itemId: 'item1', reportedBy: uid, createdAt: serverTimestamp() });
    }, { auditor: true });
  });
  it('flow: vehicle checkout and checkin transactions (vehicle + vehicle_logs create/update)', async () => {
    await matrix(EVERYONE, (db, uid) =>
      runTransaction(db, async (tx) => {
        await tx.get(doc(db, 'vehicles', 'veh1'));
        const logRef = doc(collection(db, 'vehicle_logs'));
        tx.set(logRef, { vehicleId: 'veh1', driverUserId: uid, status: 'open' });
        tx.update(doc(db, 'vehicles', 'veh1'), { isCheckedOut: true, currentLogId: logRef.id });
        tx.update(doc(db, 'vehicle_logs', 'vl1'), { checkinUserId: uid, status: 'closed' });
      }),
      { auditor: true },
    );
  });
  it('flow: asset checkout / checkin (inventory asset fields + inventory_logs), single and batch', async () => {
    await matrix(EVERYONE, async (db, uid) => {
      await runTransaction(db, async (tx) => {
        await tx.get(doc(db, 'inventory', 'asset1'));
        tx.update(doc(db, 'inventory', 'asset1'), {
          assetStatus: 'Checked Out', checkedOutAt: serverTimestamp(), checkedOutBy: uid, currentLocation: 'Field', updatedAt: serverTimestamp(),
          assets: [{ serial: 'S1', status: 'Checked Out' }],
        });
      });
      await addDoc(collection(db, 'inventory_logs'), { itemId: 'asset1', action: 'asset_checkout', userId: uid });
      const b = writeBatch(db);
      b.update(doc(db, 'inventory', 'asset1'), {
        assetStatus: 'Ready', lastCheckedInAt: serverTimestamp(), lastCheckedInBy: uid, lastKnownReturnLocation: 'HQ', updatedAt: serverTimestamp(),
      });
      await b.commit();
      await updateDoc(doc(db, 'inventory', 'asset1'), {
        assetStatus: 'In Use', checkedOutBy: uid, checkedOutAt: serverTimestamp(), checkoutReason: 'event', updatedAt: serverTimestamp(),
      });
    }, { auditor: true });
  });
  it('flow: medication log row', async () => {
    await matrix(EVERYONE, (db, uid) => addDoc(collection(db, 'medication_logs'), { itemId: 'item1', userId: uid, timestamp: serverTimestamp() }), { auditor: true });
  });
  it('flow: notifications read + mark read (own)', async () => {
    await seed();
    const db = as(MEMBER);
    await assertSucceeds(getDocs(query(collection(db, 'notifications'), where('userId', '==', MEMBER))));
    await assertSucceeds(updateDoc(doc(db, 'notifications', 'n_member'), { read: true }));
    const b = writeBatch(db);
    b.update(doc(db, 'notifications', 'n_member'), { read: true });
    await assertSucceeds(b.commit());
  });
  it('flow: personal dashboard layout (read/write/reset)', async () => {
    await matrix(EVERYONE, async (db, uid) => {
      await setDoc(doc(db, 'dashboards', `${uid}__usage`), { ownerUid: uid, published: false, tiles: [] }, { merge: true });
      await getDoc(doc(db, 'dashboards', 'published__staffing'));
      await deleteDoc(doc(db, 'dashboards', `${uid}__usage`));
    }, { auditor: true });
  });
  it('flow: uniform exchange (member lists, claims, waitlists a garment)', async () => {
    await matrix(EVERYONE, async (db, uid) => {
      await addDoc(collection(db, 'apparel_items'), { name: 'Jacket', listedBy: uid, status: 'available' });
      await runTransaction(db, async (tx) => {
        await tx.get(doc(db, 'apparel_items', 'ap1'));
        tx.set(doc(collection(db, 'apparel_claims')), { itemId: 'ap1', userId: uid, action: 'claim' });
        tx.update(doc(db, 'apparel_items', 'ap1'), { status: 'claimed', claimedBy: uid });
      });
      await getDocs(collection(db, 'apparel_categories'));
    }, { auditor: true });
  });
  it('flow: committee-board card edit by a flagged committee member (any role)', async () => {
    await matrix(EVERYONE, async (db) => {
      await updateDoc(doc(db, 'team_tasks', 'task1'), { status: 'in_progress' });
    }, { auditor: true });
  });
  it('flow: org config + inventory reads for every signed-in role', async () => {
    await matrix(EVERYONE, async (db) => {
      await getDoc(doc(db, 'org_settings', 'current'));
      await getDocs(collection(db, 'inventory'));
      await getDocs(collection(db, 'statpacks'));
      await getDocs(collection(db, 'events'));
      await getDocs(collection(db, 'shift_requests'));
      await getDoc(doc(db, 'barcode_index', 'CODE1'));
      await getDocs(collection(db, 'buyList'));
    }, { auditor: true });
  });
  it('flow: audit user (helper / admin / QM / canAudit member): count, move, shipment, report, lock', async () => {
    await matrix(OPERATORS, async (db, uid) => {
      await runTransaction(db, async (tx) => {
        await tx.get(doc(db, 'inventory', 'item1'));
        tx.update(doc(db, 'inventory', 'item1'), { unopenedBoxes: 5, lastAuditDate: serverTimestamp() });
      });
      const b = writeBatch(db);
      b.update(doc(db, 'inventory', 'item1'), { 'storageLocation.zoneId': 'zone1', location: 'HQ' });
      b.set(doc(collection(db, 'inventory_logs')), { itemId: 'item1', action: 'audit_count' });
      b.set(doc(collection(db, 'auditEvents')), { eventType: 'audit_count' });
      await b.commit();
      await addDoc(collection(db, 'inventory'), { name: 'New thing', isAsset: false });
      await setDoc(doc(db, 'audit_locks', 'zoneB'), { lockedBy: uid });
      await deleteDoc(doc(db, 'audit_locks', 'zoneB'));
      await addDoc(collection(db, 'storage_zones'), { name: 'Inline zone' });
      await addDoc(collection(db, 'shelves'), { name: 'Inline shelf' });
      await addDoc(collection(db, 'containers'), { name: 'Inline bin' });
      await setDoc(doc(db, 'barcode_index', 'CODE2'), { itemId: 'item1' });
    }, { auditor: true });
  });
});

// ── tightened collections: who may, who may not ─────────────────────────────

describe('inventory', () => {
  it('create: admin/QM/helper/canAudit member only', async () => {
    await matrix(OPERATORS, (db) => addDoc(collection(db, 'inventory'), { name: 'New', isAsset: false }), { auditor: true });
  });
  it('update of a consumable: operators only (medops/treasurer/FTO/members denied)', async () => {
    await matrix(OPERATORS, (db) => updateDoc(doc(db, 'inventory', 'item1'), { unopenedBoxes: 0 }), { auditor: true });
  });
  it('a plain member cannot smuggle a non-checkout field through an asset update', async () => {
    await seed();
    await assertFails(updateDoc(doc(as(MEMBER), 'inventory', 'asset1'), { assetStatus: 'Ready', name: 'renamed' }));
    await assertFails(updateDoc(doc(as(MEMBER), 'inventory', 'asset1'), { isAsset: false }));
    await assertFails(updateDoc(doc(as(MEDOPS), 'inventory', 'asset1'), { unopenedBoxes: 99 }));
  });
  it('delete: admin/QM only', async () => {
    await matrix(MANAGERS, (db) => deleteDoc(doc(db, 'inventory', 'item1')), { auditor: false });
  });
});

describe('append-only ledgers', () => {
  for (const name of ['inventory_logs', 'statpack_logs', 'auditEvents', 'medication_logs', 'box_logs', 'exchange_bag_events', 'apparel_claims', 'inventory_alerts']) {
    it(`${name}: anyone creates; only admin/QM rewrite or delete`, async () => {
      await matrix(EVERYONE, (db) => addDoc(collection(db, name), { x: 1 }), { auditor: true });
      await matrix(MANAGERS, (db) => updateDoc(doc(db, name, 'row1'), { x: 2 }), { auditor: false });
      await matrix(MANAGERS, (db) => deleteDoc(doc(db, name, 'row1')), { auditor: false });
    });
  }
});

describe('storage layout', () => {
  for (const name of ['storage_zones', 'shelves', 'containers']) {
    const id = name === 'storage_zones' ? 'zone1' : name === 'shelves' ? 'shelf1' : 'cont1';
    it(`${name}: create = operators; edit/delete = admin/QM`, async () => {
      await matrix(OPERATORS, (db) => addDoc(collection(db, name), { name: 'n' }), { auditor: true });
      await matrix(MANAGERS, (db) => updateDoc(doc(db, name, id), { name: 'renamed' }), { auditor: false });
      await matrix(MANAGERS, (db) => deleteDoc(doc(db, name, id)), { auditor: false });
    });
  }
  it('barcode_index and audit_locks: operators write, everyone reads', async () => {
    await matrix(OPERATORS, (db) => setDoc(doc(db, 'barcode_index', 'CODE9'), { itemId: 'item1' }), { auditor: true });
    await matrix(OPERATORS, (db) => deleteDoc(doc(db, 'audit_locks', 'zoneA')), { auditor: true });
  });
});

describe('inventory merge (open to anyone on the inventory page) repoints references', () => {
  it('flow: operator merge batch (inventory archive + statpack/bag/container/purchase/buyList/tasks/restock repoints + log + ledger)', async () => {
    await matrix(OPERATORS, async (db) => {
      const b = writeBatch(db);
      b.update(doc(db, 'inventory', 'item1'), { existence: 'archived', mergedInto: 'asset1', updatedAt: serverTimestamp() });
      b.update(doc(db, 'statpacks', 'pack1'), { contents: [], updatedAt: serverTimestamp() });
      b.update(doc(db, 'exchange_bags', 'bag1'), { lines: [], updatedAt: serverTimestamp() });
      b.update(doc(db, 'containers', 'cont1'), { boxContents: [], updatedAt: serverTimestamp() });
      b.update(doc(db, 'purchases', 'p1'), { lines: [], updatedAt: serverTimestamp() });
      b.update(doc(db, 'buyList', 'buy1'), { linkedInventoryId: 'asset1' });
      b.update(doc(db, 'tasks', 't1'), { linkedInventoryId: 'asset1' });
      b.update(doc(db, 'restock_categories', 'rc1'), { 'itemRestocks.asset1': 3, updatedAt: serverTimestamp() });
      b.set(doc(collection(db, 'inventory_logs')), { itemId: 'asset1', action: 'merge' });
      b.set(doc(collection(db, 'auditEvents')), { eventType: 'inventory_merge' });
      await b.commit();
    }, { auditor: false });
  });
  it('the carve-outs are field-limited: an operator cannot rename a container, rewrite a buyList entry or a restock category', async () => {
    await seed();
    const db = as(UID.inventory_helper);
    await assertFails(updateDoc(doc(db, 'containers', 'cont1'), { name: 'renamed' }));
    await assertFails(updateDoc(doc(db, 'buyList', 'buy1'), { status: 'ordered' }));
    await assertFails(updateDoc(doc(db, 'restock_categories', 'rc1'), { name: 'renamed' }));
    await assertFails(updateDoc(doc(as(MEMBER), 'containers', 'cont1'), { boxContents: [] }));
    await assertFails(updateDoc(doc(as(MEMBER), 'buyList', 'buy1'), { linkedInventoryId: 'x' }));
  });
});

describe('statpacks, vehicles, exchange bags', () => {
  it('statpacks create/delete: admin/QM only', async () => {
    await matrix(MANAGERS, (db) => setDoc(doc(db, 'statpacks', 'pack_new'), { name: 'Dup', status: 'Pending Initial Check' }), { auditor: false });
    await matrix(MANAGERS, (db) => deleteDoc(doc(db, 'statpacks', 'pack1')), { auditor: false });
  });
  it('vehicles create/delete: admin/QM only', async () => {
    await matrix(MANAGERS, (db) => addDoc(collection(db, 'vehicles'), { name: 'New Van' }), { auditor: false });
    await matrix(MANAGERS, (db) => deleteDoc(doc(db, 'vehicles', 'veh1')), { auditor: false });
    await matrix(MANAGERS, (db) => deleteDoc(doc(db, 'vehicle_logs', 'vl1')), { auditor: false });
  });
  it('exchange bag create/delete: admin/QM only', async () => {
    await matrix(MANAGERS, (db) => addDoc(collection(db, 'exchange_bags'), { name: 'New bag' }), { auditor: false });
    await matrix(MANAGERS, (db) => deleteDoc(doc(db, 'exchange_bags', 'bag1')), { auditor: false });
  });
});

describe('restock, reports, tasks, vendors, apparel categories', () => {
  it('restock_categories / restock_shelf_events / restock_actions: admin/QM write', async () => {
    for (const name of ['restock_categories', 'restock_shelf_events', 'restock_actions']) {
      await matrix(MANAGERS, (db) => addDoc(collection(db, name), { name: 'x' }), { auditor: false });
    }
  });
  it('issue_reports / restock_reports: triage (update/delete) is admin/QM only', async () => {
    await matrix(MANAGERS, (db) => updateDoc(doc(db, 'issue_reports', 'ir1'), { status: 'resolved' }), { auditor: false });
    await matrix(MANAGERS, (db) => deleteDoc(doc(db, 'issue_reports', 'ir1')), { auditor: false });
    await matrix(MANAGERS, (db) => updateDoc(doc(db, 'restock_reports', 'rr1'), { resolved: true }), { auditor: false });
    await matrix(MANAGERS, (db) => deleteDoc(doc(db, 'restock_reports', 'rr1')), { auditor: false });
  });
  it('team_tasks delete: admin/QM only', async () => {
    await matrix(MANAGERS, (db) => deleteDoc(doc(db, 'team_tasks', 'task1')), { auditor: false });
  });
  it('vendors, apparel_categories, laf_records, purchase_history, tasks: admin/QM write', async () => {
    await matrix(MANAGERS, (db) => addDoc(collection(db, 'vendors'), { name: 'New Vendor' }), { auditor: false });
    await matrix(MANAGERS, (db) => updateDoc(doc(db, 'apparel_categories', 'ac1'), { archived: true }), { auditor: false });
    await matrix(MANAGERS, (db) => addDoc(collection(db, 'laf_records'), { itemId: 'item1' }), { auditor: false });
    await matrix(MANAGERS, (db) => addDoc(collection(db, 'purchase_history'), { itemId: 'item1' }), { auditor: false });
    await matrix(MANAGERS, (db) => addDoc(collection(db, 'tasks'), { title: 't' }), { auditor: false });
  });
  it('purchase_requests: admin/QM only, read and write', async () => {
    await matrix(MANAGERS, (db) => addDoc(collection(db, 'purchase_requests'), { itemId: 'item1' }), { auditor: false });
    await matrix(MANAGERS, (db) => getDocs(collection(db, 'purchase_requests')), { auditor: false });
  });
});

describe('org_settings', () => {
  it('write: admin/QM only; read: everyone', async () => {
    await matrix(MANAGERS, (db) => setDoc(doc(db, 'org_settings', 'current'), { org: { name: 'Fake Org 2' }, updatedAt: serverTimestamp() }, { merge: true }), { auditor: false });
    await matrix(EVERYONE, (db) => getDoc(doc(db, 'org_settings', 'current')), { auditor: true });
  });
  it('settings save with the unchanged privateFinanceRoles in the payload still works for a QM', async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users', QM), { id: QM, role: 'quartermaster' });
      await setDoc(doc(ctx.firestore(), 'org_settings', 'current'), { org: { name: 'Fake' }, privateFinanceRoles: ['admin', 'treasurer'] });
    });
    await assertSucceeds(setDoc(doc(as(QM), 'org_settings', 'current'), { org: { name: 'Fake 2' }, privateFinanceRoles: ['admin', 'treasurer'] }, { merge: true }));
  });
  it('privateFinanceRoles can be changed by an admin but not a quartermaster', async () => {
    await seed();
    await assertFails(setDoc(doc(as(QM), 'org_settings', 'current'), { privateFinanceRoles: ['admin', 'quartermaster'] }, { merge: true }));
    await assertFails(updateDoc(doc(as(QM), 'org_settings', 'current'), { privateFinanceRoles: ['quartermaster'] }));
    await assertSucceeds(setDoc(doc(as(ADMIN), 'org_settings', 'current'), { privateFinanceRoles: ['admin', 'treasurer'] }, { merge: true }));
  });
  it('first-run seed by a QM must carry the default privateFinanceRoles (or none)', async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users', QM), { id: QM, role: 'quartermaster' });
    });
    await assertFails(setDoc(doc(as(QM), 'org_settings', 'current'), { org: {}, privateFinanceRoles: ['admin', 'quartermaster'] }));
    await assertSucceeds(setDoc(doc(as(QM), 'org_settings', 'current'), { org: {}, privateFinanceRoles: ['admin'] }));
  });
});

describe('dashboards', () => {
  it('published__* layouts: admin/QM only', async () => {
    await matrix(MANAGERS, (db) => setDoc(doc(db, 'dashboards', 'published__usage'), { published: true, tiles: [] }, { merge: true }), { auditor: false });
    await matrix(MANAGERS, (db) => deleteDoc(doc(db, 'dashboards', 'published__staffing')), { auditor: false });
  });
  it('personal <uid>__* layouts: owner only (admin/QM excepted); nobody edits another member\'s', async () => {
    await seed();
    await assertSucceeds(setDoc(doc(as(MEMBER), 'dashboards', `${MEMBER}__usage`), { tiles: [] }, { merge: true }));
    await assertFails(setDoc(doc(as(OTHER_MEMBER), 'dashboards', `${MEMBER}__usage`), { tiles: [] }, { merge: true }));
    await assertFails(deleteDoc(doc(as(OTHER_MEMBER), 'dashboards', `${MEMBER}__staffing`)));
    await assertFails(setDoc(doc(as(MEDOPS), 'dashboards', `${MEMBER}__usage`), { tiles: [] }, { merge: true }));
    await assertSucceeds(setDoc(doc(as(ADMIN), 'dashboards', `${MEMBER}__usage`), { tiles: [] }, { merge: true })); // test-identity view
  });
  it('a member cannot publish by prefixing their own uid onto a published id', async () => {
    await seed();
    await assertFails(setDoc(doc(as(MEMBER), 'dashboards', 'published__staffing'), { tiles: [] }));
  });
});

describe('events', () => {
  it('create/delete: admin/QM/medops only', async () => {
    await matrix(EVENT_MANAGERS, (db) => addDoc(collection(db, 'events'), { name: 'New game', teams: [] }), { auditor: false });
    await matrix(EVENT_MANAGERS, (db) => deleteDoc(doc(db, 'events', 'ev1')), { auditor: false });
  });
  it('full edit (name/status/venue): event managers only', async () => {
    await matrix(EVENT_MANAGERS, (db) => updateDoc(doc(db, 'events', 'ev1'), { name: 'Renamed', status: 'closed', updatedAt: serverTimestamp() }), { auditor: false });
  });
  it('non-managers may update only teams + updatedAt (cancel-request path)', async () => {
    await seed();
    await assertSucceeds(updateDoc(doc(as(MEMBER), 'events', 'ev1'), { teams: [], updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(as(MEMBER), 'events', 'ev1'), { teams: [], status: 'closed' }));
    await assertFails(updateDoc(doc(as(FTO), 'events', 'ev1'), { venue: 'Elsewhere' }));
  });
});

describe('shift_requests', () => {
  it('approve / reject / retro attendance edit: event managers', async () => {
    await matrix(EVENT_MANAGERS, (db, uid) => updateDoc(doc(db, 'shift_requests', 'req_pending'), { status: 'approved', assignedSlot: 'emt:0', decidedBy: uid, decidedAt: serverTimestamp() }), { auditor: false });
  });
  it('a member cannot approve their own request or touch someone else\'s', async () => {
    await seed();
    await assertFails(updateDoc(doc(as(MEMBER), 'shift_requests', 'req_pending'), { status: 'approved' }));
    await assertFails(updateDoc(doc(as(MEMBER), 'shift_requests', 'req_pending'), { status: 'cancelled', userId: OTHER_MEMBER }));
    await assertFails(updateDoc(doc(as(MEMBER), 'shift_requests', 'req_other'), { status: 'cancelled', decidedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(as(UID.treasurer), 'shift_requests', 'req_other'), { status: 'rejected' }));
  });
  it('create: only for yourself (or a manager)', async () => {
    await seed();
    await assertFails(addDoc(collection(as(MEMBER), 'shift_requests'), { userId: OTHER_MEMBER, eventId: 'ev1', status: 'pending' }));
    await assertSucceeds(addDoc(collection(as(MEDOPS), 'shift_requests'), { userId: OTHER_MEMBER, eventId: 'ev1', status: 'approved' }));
  });
  it('delete: admin/QM only', async () => {
    await matrix(MANAGERS, (db) => deleteDoc(doc(db, 'shift_requests', 'req_other')), { auditor: false });
  });
});

describe('notifications', () => {
  it('read: the recipient and admin/QM (test identities); not other members or medops', async () => {
    await seed();
    await assertSucceeds(getDoc(doc(as(MEMBER), 'notifications', 'n_member')));
    await assertFails(getDoc(doc(as(MEMBER), 'notifications', 'n_other')));
    await assertFails(getDocs(collection(as(MEMBER), 'notifications')));
    await assertFails(getDoc(doc(as(MEDOPS), 'notifications', 'n_member')));
    await assertSucceeds(getDoc(doc(as(ADMIN), 'notifications', 'n_member')));
    await assertSucceeds(getDoc(doc(as(QM), 'notifications', 'n_other')));
  });
  it('mark read: recipient only, and only the read flag', async () => {
    await seed();
    await assertFails(updateDoc(doc(as(MEMBER), 'notifications', 'n_other'), { read: true }));
    await assertFails(updateDoc(doc(as(MEMBER), 'notifications', 'n_member'), { read: true, title: 'tampered' }));
    await assertFails(updateDoc(doc(as(MEMBER), 'notifications', 'n_member'), { userId: OTHER_MEMBER }));
  });
  it('delete: admin/QM only (test-identity cleanup)', async () => {
    await matrix(MANAGERS, (db) => deleteDoc(doc(db, 'notifications', 'n_member')), { auditor: false });
  });
});

describe('buyList and purchases', () => {
  it('buyList create: admin/QM/medops (supply requests)', async () => {
    await matrix(['admin', 'quartermaster', 'medops'], (db, uid) => addDoc(collection(db, 'buyList'), { itemName: 'Tape', status: 'pending', addedBy: uid }), { auditor: false });
  });
  it('buyList edit/delete: admin/QM; medops may only bump quantity', async () => {
    await matrix(MANAGERS, (db) => updateDoc(doc(db, 'buyList', 'buy1'), { status: 'ordered' }), { auditor: false });
    await matrix(MANAGERS, (db) => deleteDoc(doc(db, 'buyList', 'buy1')), { auditor: false });
    await seed();
    await assertSucceeds(updateDoc(doc(as(MEDOPS), 'buyList', 'buy1'), { quantity: 5 }));
    await assertFails(updateDoc(doc(as(MEDOPS), 'buyList', 'buy1'), { status: 'ordered' }));
    await assertFails(deleteDoc(doc(as(MEDOPS), 'buyList', 'buy1')));
  });
  it('purchases read: admin/QM/treasurer/inventory_helper', async () => {
    await matrix(['admin', 'quartermaster', 'treasurer', 'inventory_helper'], (db) => getDoc(doc(db, 'purchases', 'p1')), { auditor: false });
  });
  it('purchases create (Log Purchase) and delete: admin/QM', async () => {
    await matrix(MANAGERS, (db) => addDoc(collection(db, 'purchases'), { vendor: 'V', status: 'ordered', lines: [], createdBy: 'x' }), { auditor: false });
    await matrix(MANAGERS, (db) => deleteDoc(doc(db, 'purchases', 'p1')), { auditor: false });
  });
  it('purchases receive (non-payment update): admin/QM/inventory_helper', async () => {
    await matrix(['admin', 'quartermaster', 'inventory_helper'], (db) => updateDoc(doc(db, 'purchases', 'p1'), { status: 'received', lines: [], updatedAt: serverTimestamp() }), { auditor: false });
  });
  it('payment fields: admin/treasurer only (update and create)', async () => {
    await matrix(['admin', 'treasurer'], (db) => updateDoc(doc(db, 'purchases', 'p1'), { paidAt: serverTimestamp(), paidFrom: 'asuc', updatedAt: serverTimestamp() }), { auditor: false });
    await matrix(['admin', 'treasurer'], (db) => updateDoc(doc(db, 'purchases', 'p1'), { reimbursedAt: serverTimestamp() }), { auditor: false });
    await seed();
    await assertFails(addDoc(collection(as(QM), 'purchases'), { vendor: 'V', status: 'ordered', lines: [], paidAt: new Date() }));
    await assertSucceeds(addDoc(collection(as(ADMIN), 'purchases'), { vendor: 'V', status: 'ordered', lines: [], paidAt: new Date() }));
  });
  it('treasurer may edit ONLY payment fields; QM/helper may not touch them', async () => {
    await seed();
    await assertFails(updateDoc(doc(as(UID.treasurer), 'purchases', 'p1'), { status: 'received' }));
    await assertFails(updateDoc(doc(as(UID.treasurer), 'purchases', 'p1'), { paidAt: new Date(), vendor: 'Other' }));
    await assertFails(updateDoc(doc(as(QM), 'purchases', 'p1'), { paidAt: new Date() }));
    await assertFails(updateDoc(doc(as(UID.inventory_helper), 'purchases', 'p1'), { asucPrNumber: '#1' }));
    await assertFails(updateDoc(doc(as(MEDOPS), 'purchases', 'p1'), { status: 'cancelled' }));
  });
});

// ── private finance docs ────────────────────────────────────────────────────

describe('private/* subdocs honour org_settings.privateFinanceRoles', () => {
  const read = (db: Firestore) => getDoc(doc(db, 'purchases', 'p1', 'private', 'payment'));

  it('field missing: default is admin only', async () => {
    await seed();
    for (const role of ROLE_KEYS) {
      if (role === 'admin') await assertSucceeds(read(as(UID[role])));
      else await assertFails(read(as(UID[role])));
    }
    await assertFails(read(as(AUDITOR)));
    await assertFails(read(as(NEWBIE)));
  });
  it('field = [] : admin is still always allowed (cannot lock themselves out)', async () => {
    await seed({ privateFinanceRoles: [] });
    await assertSucceeds(read(as(ADMIN)));
    await assertFails(read(as(QM)));
  });
  it('field = [admin, treasurer, medops]: exactly those roles', async () => {
    await seed({ privateFinanceRoles: ['admin', 'treasurer', 'medops'] });
    for (const role of ROLE_KEYS) {
      if (['admin', 'treasurer', 'medops'].includes(role)) await assertSucceeds(read(as(UID[role])));
      else await assertFails(read(as(UID[role])));
    }
  });
  it('field = [quartermaster]: the QM is listed; admin still allowed', async () => {
    await seed({ privateFinanceRoles: ['quartermaster'] });
    await assertSucceeds(read(as(QM)));
    await assertSucceeds(read(as(ADMIN)));
    await assertFails(read(as(UID.treasurer)));
  });
  it('collection-group style read of every private doc follows the same rule', async () => {
    await seed({ privateFinanceRoles: ['treasurer'] });
    await assertSucceeds(getDocs(collection(as(UID.treasurer), 'purchases', 'p1', 'private')));
    await assertFails(getDocs(collection(as(MEMBER), 'purchases', 'p1', 'private')));
  });
  it('write: admin/QM/treasurer only (provisional); nobody else', async () => {
    await matrix(['admin', 'quartermaster', 'treasurer'], (db) => setDoc(doc(db, 'purchases', 'p1', 'private', 'payment'), { payee: 'Fake Payee 2' }), { auditor: false });
  });
});

// ── provisional planned collections ─────────────────────────────────────────

describe('uniform_orders / loaner_checkouts (provisional)', () => {
  it('members read only their own docs; admin/QM/treasurer read all', async () => {
    await seed();
    await assertSucceeds(getDoc(doc(as(MEMBER), 'uniform_orders', 'uo_member')));
    await assertFails(getDoc(doc(as(MEMBER), 'uniform_orders', 'uo_other')));
    await assertFails(getDoc(doc(as(MEMBER), 'loaner_checkouts', 'lo_other')));
    await assertSucceeds(getDoc(doc(as(MEMBER), 'loaner_checkouts', 'lo_member')));
    await assertSucceeds(getDocs(query(collection(as(MEMBER), 'uniform_orders'), where('userId', '==', MEMBER))));
    await assertFails(getDocs(collection(as(MEMBER), 'uniform_orders')));
    await assertFails(getDoc(doc(as(MEDOPS), 'uniform_orders', 'uo_other')));
    for (const role of ['admin', 'quartermaster', 'treasurer'] as RoleKey[]) {
      await assertSucceeds(getDoc(doc(as(UID[role]), 'uniform_orders', 'uo_other')));
      await assertSucceeds(getDoc(doc(as(UID[role]), 'loaner_checkouts', 'lo_other')));
    }
  });
  it('write: admin/QM only (orders, rounds, loaners)', async () => {
    await matrix(MANAGERS, (db) => addDoc(collection(db, 'uniform_orders'), { userId: MEMBER }), { auditor: false });
    await matrix(MANAGERS, (db) => updateDoc(doc(db, 'uniform_rounds', 'round1'), { name: 'Spring' }), { auditor: false });
    await matrix(MANAGERS, (db) => updateDoc(doc(db, 'loaner_checkouts', 'lo_member'), { returned: true }), { auditor: false });
  });
  it('uniform_rounds readable by any signed-in member', async () => {
    await seed();
    await assertSucceeds(getDoc(doc(as(MEMBER), 'uniform_rounds', 'round1')));
  });
});

// ── unknown collections keep the stopgap floor ──────────────────────────────

describe('a collection the rules do not know', () => {
  it('top-level docs: signed-in read/write; sub-collections denied', async () => {
    await seed();
    await assertSucceeds(getDoc(doc(as(MEMBER), 'mystery', 'm1')));
    await assertSucceeds(setDoc(doc(as(MEMBER), 'mystery', 'm2'), { x: 1 }));
    await assertFails(setDoc(doc(as(MEMBER), 'mystery', 'm1', 'sub', 's1'), { x: 1 }));
  });
});
