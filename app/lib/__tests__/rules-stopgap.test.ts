/**
 * Emulator test for `firestore.prod.rules` (plan §0.5 packet S3).
 *
 * Loads the PRODUCTION stopgap rules (not the open emulator file) into the Firestore
 * emulator and checks that (a) anonymous callers are locked out, (b) a signed-in member
 * cannot self-promote, and (c) every current app flow still passes.
 *
 * Run (boots the emulator with firebase.emulator.json, which only affects which rules the
 * emulator loads by default — this test injects firestore.prod.rules itself):
 *   npm run test:rules
 *
 * Fixtures use fake names only. No real project is ever contacted: demo-* project id,
 * emulator host required.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
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
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';

const PROJECT_ID = 'demo-bmrc-logistics';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('rules-stopgap: FIRESTORE_EMULATOR_HOST not set; run via `npm run test:rules`.');
  process.exit(1);
}

const ADMIN = 'uid_admin_ada';
const QM = 'uid_qm_quinn';
const MEDOPS = 'uid_medops_max';
const MEMBER = 'uid_member_morgan';
const OTHER_MEMBER = 'uid_member_riley';
const NEWBIE = 'uid_newbie_sam'; // authenticated, no users doc yet

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

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const base = { createdAt: new Date(), updatedAt: new Date() };
    await setDoc(doc(db, 'users', ADMIN), { id: ADMIN, fullName: 'Ada Admin', email: 'ada@example.test', role: 'admin', ...base });
    await setDoc(doc(db, 'users', QM), { id: QM, fullName: 'Quinn QM', email: 'quinn@example.test', role: 'quartermaster', ...base });
    await setDoc(doc(db, 'users', MEDOPS), { id: MEDOPS, fullName: 'Max MedOps', email: 'max@example.test', role: 'medops', ...base });
    await setDoc(doc(db, 'users', MEMBER), { id: MEMBER, fullName: 'Morgan Member', email: 'morgan@example.test', role: 'member', tutorialCompleted: false, ...base });
    await setDoc(doc(db, 'users', OTHER_MEMBER), { id: OTHER_MEMBER, fullName: 'Riley Member', email: 'riley@example.test', role: 'member', ...base });
    await setDoc(doc(db, 'statpacks', 'pack1'), { id: 'pack1', name: 'Pack One', isCheckedOut: false, status: 'Ready' });
    await setDoc(doc(db, 'inventory', 'item1'), { id: 'item1', name: 'Gauze', unopenedBoxes: 3 });
    await setDoc(doc(db, 'org_settings', 'current'), { org: { name: 'Fake Org' } });
  });
});

const as = (uid: string) => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();

describe('anonymous access is denied everywhere', () => {
  it('cannot read users', async () => {
    await assertFails(getDoc(doc(anon(), 'users', MEMBER)));
    await assertFails(getDocs(collection(anon(), 'users')));
  });
  it('cannot read other collections', async () => {
    await assertFails(getDoc(doc(anon(), 'inventory', 'item1')));
    await assertFails(getDoc(doc(anon(), 'org_settings', 'current')));
    await assertFails(getDocs(collection(anon(), 'statpacks')));
  });
  it('cannot write or delete anything', async () => {
    await assertFails(setDoc(doc(anon(), 'inventory', 'item2'), { name: 'x' }));
    await assertFails(updateDoc(doc(anon(), 'users', MEMBER), { role: 'admin' }));
    await assertFails(setDoc(doc(anon(), 'users', 'uid_evil'), { id: 'uid_evil', role: 'member' }));
    await assertFails(deleteDoc(doc(anon(), 'inventory', 'item1')));
  });
});

describe('registration (users create)', () => {
  it('register/page.tsx payload is allowed (self, role member)', async () => {
    await assertSucceeds(
      setDoc(doc(as(NEWBIE), 'users', NEWBIE), {
        id: NEWBIE,
        fullName: 'Sam Newbie',
        email: 'sam@example.test',
        role: 'member',
        tutorialCompleted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
  });
  it('app-sidebar self-heal payload is allowed (serverTimestamp, no tutorialCompleted)', async () => {
    await assertSucceeds(
      setDoc(doc(as(NEWBIE), 'users', NEWBIE), {
        id: NEWBIE,
        email: 'sam@example.test',
        fullName: 'Sam Newbie',
        role: 'member',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    );
  });
  it('self-create with role admin / medops / FTO is denied', async () => {
    for (const role of ['admin', 'quartermaster', 'medops', 'FTO']) {
      await assertFails(setDoc(doc(as(NEWBIE), 'users', NEWBIE), { id: NEWBIE, role }));
    }
  });
  it('member cannot create a doc for another uid', async () => {
    await assertFails(setDoc(doc(as(NEWBIE), 'users', 'uid_someone_else'), { id: 'uid_someone_else', role: 'member' }));
  });
});

describe('users update', () => {
  it('self role change is denied (member -> admin), for members and privileged roles alike', async () => {
    await assertFails(updateDoc(doc(as(MEMBER), 'users', MEMBER), { role: 'admin' }));
    await assertFails(setDoc(doc(as(MEMBER), 'users', MEMBER), { role: 'admin' }, { merge: true }));
    await assertFails(updateDoc(doc(as(MEDOPS), 'users', MEDOPS), { role: 'admin' }));
  });
  it('self non-role updates are allowed (onboarding tour stamp)', async () => {
    await assertSucceeds(
      updateDoc(doc(as(MEMBER), 'users', MEMBER), { tutorialCompleted: true, tutorialCompletedAt: serverTimestamp() }),
    );
    await assertSucceeds(setDoc(doc(as(MEMBER), 'users', MEMBER), { tutorialCompleted: true }, { merge: true }));
  });
  it('member cannot update another member', async () => {
    await assertFails(updateDoc(doc(as(MEMBER), 'users', OTHER_MEMBER), { memberStatus: 'new' }));
    await assertFails(updateDoc(doc(as(MEMBER), 'users', ADMIN), { role: 'member' }));
  });
  it('medops roster edits work (role, memberStatus, joinedTerm, canAudit, isCommitteeMember, certs)', async () => {
    const target = doc(as(MEDOPS), 'users', MEMBER);
    await assertSucceeds(updateDoc(target, { role: 'FTO' }));
    await assertSucceeds(updateDoc(target, { memberStatus: 'probationary' }));
    await assertSucceeds(updateDoc(target, { joinedTerm: 'Fall 2026' }));
    await assertSucceeds(updateDoc(target, { canAudit: true }));
    await assertSucceeds(updateDoc(target, { isCommitteeMember: true }));
    await assertSucceeds(
      updateDoc(target, {
        'certifications.emt.verifiedBy': 'Max MedOps',
        'certifications.emt.verifiedAt': serverTimestamp(),
        updatedAt: serverTimestamp(),
      }),
    );
  });
  it('medops cannot escalate: no promoting to admin/QM/medops, no demoting an admin, no self-promotion, no creating admin docs', async () => {
    const db = as(MEDOPS);
    await assertFails(updateDoc(doc(db, 'users', MEMBER), { role: 'admin' }));
    await assertFails(updateDoc(doc(db, 'users', MEMBER), { role: 'quartermaster' }));
    await assertFails(updateDoc(doc(db, 'users', MEMBER), { role: 'medops' }));
    await assertFails(updateDoc(doc(db, 'users', ADMIN), { role: 'member' }));
    await assertFails(updateDoc(doc(db, 'users', MEDOPS), { role: 'admin' }));
    await assertFails(setDoc(doc(db, 'users', '__test_admin'), { id: '__test_admin', role: 'admin' }, { merge: true }));
    await assertSucceeds(updateDoc(doc(db, 'users', ADMIN), { memberStatus: 'general' })); // non-role edit of any user is fine
    await assertSucceeds(updateDoc(doc(db, 'users', MEMBER), { role: 'fto_intern' }));
  });
  it('admin cannot change their own role (self-demotion guard); can still change others', async () => {
    await assertFails(updateDoc(doc(as(ADMIN), 'users', ADMIN), { role: 'member' }));
    await assertSucceeds(updateDoc(doc(as(ADMIN), 'users', ADMIN), { tutorialCompleted: true }));
  });
  it('admin and quartermaster may edit other users, incl. setAuditPermission-style batch', async () => {
    await assertSucceeds(updateDoc(doc(as(ADMIN), 'users', MEMBER), { role: 'quartermaster' }));
    const db = as(QM);
    const batch = writeBatch(db);
    batch.update(doc(db, 'users', OTHER_MEMBER), { canAudit: true, updatedAt: serverTimestamp() });
    batch.set(doc(collection(db, 'auditEvents')), { eventType: 'audit_permission_granted' });
    await assertSucceeds(batch.commit());
  });
  it('privileged role seeds __test_* identity docs (merge setDoc, non-member roles)', async () => {
    for (const uid of [ADMIN, QM]) {
      const db = as(uid);
      for (const [id, role] of [['__test_member', 'member'], ['__test_fto', 'FTO'], ['__test_medops', 'medops'], ['__test_admin', 'admin']]) {
        // First call = create, second = update (idempotent re-seed).
        await assertSucceeds(setDoc(doc(db, 'users', id), { id, role, isTestUser: true, fullName: 'Test', createdAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true }));
        await assertSucceeds(setDoc(doc(db, 'users', id), { id, role, isTestUser: true, updatedAt: serverTimestamp() }, { merge: true }));
      }
    }
  });
  it('a plain member cannot seed __test_* identities', async () => {
    await assertFails(setDoc(doc(as(MEMBER), 'users', '__test_admin'), { id: '__test_admin', role: 'admin' }, { merge: true }));
  });
});

describe('users delete', () => {
  it('members cannot delete users; privileged roles can', async () => {
    await assertFails(deleteDoc(doc(as(MEMBER), 'users', OTHER_MEMBER)));
    await assertFails(deleteDoc(doc(as(MEMBER), 'users', MEMBER)));
    await assertSucceeds(deleteDoc(doc(as(ADMIN), 'users', OTHER_MEMBER)));
  });
});

describe('users read', () => {
  it('any signed-in user can read the roster docs (current app behavior)', async () => {
    await assertSucceeds(getDoc(doc(as(MEMBER), 'users', ADMIN)));
    await assertSucceeds(getDocs(collection(as(MEMBER), 'users')));
  });
  it('a signed-in user with no users doc yet can read own doc path without error', async () => {
    await assertSucceeds(getDoc(doc(as(NEWBIE), 'users', NEWBIE)));
  });
});

describe('normal member flows on other collections', () => {
  it('statpack check-off transaction (update pack + add statpack_logs)', async () => {
    const db = as(MEMBER);
    await assertSucceeds(
      runTransaction(db, async (tx) => {
        const packRef = doc(db, 'statpacks', 'pack1');
        const snap = await tx.get(packRef);
        if (!snap.exists()) throw new Error('missing pack');
        tx.update(packRef, { isCheckedOut: true, assignedToUserId: MEMBER, status: 'In Use' });
        tx.set(doc(collection(db, 'statpack_logs')), { statpackId: 'pack1', userId: MEMBER, action: 'checkout', timestamp: serverTimestamp() });
      }),
    );
  });
  it('shift request + manager notification broadcast', async () => {
    const db = as(MEMBER);
    await assertSucceeds(addDoc(collection(db, 'shift_requests'), { userId: MEMBER, eventId: 'ev1', status: 'pending', createdAt: serverTimestamp() }));
    await assertSucceeds(addDoc(collection(db, 'notifications'), { broadcast: true, type: 'shift_request', createdAt: serverTimestamp() }));
  });
  it('issue report', async () => {
    await assertSucceeds(addDoc(collection(as(MEMBER), 'issue_reports'), { reporter: { userId: MEMBER }, target: 'statpacks/pack1', createdAt: serverTimestamp() }));
  });
  it('audit write helpers (inventory + inventory_logs + auditEvents) and org config read/save', async () => {
    const db = as(MEMBER);
    await assertSucceeds(updateDoc(doc(db, 'inventory', 'item1'), { unopenedBoxes: 4 }));
    await assertSucceeds(addDoc(collection(db, 'inventory_logs'), { itemId: 'item1' }));
    await assertSucceeds(getDoc(doc(db, 'org_settings', 'current')));
    await assertSucceeds(setDoc(doc(as(ADMIN), 'org_settings', 'current'), { org: { name: 'Fake Org 2' } }, { merge: true }));
  });
  it('dashboards layout doc (personal) read/write', async () => {
    await assertSucceeds(setDoc(doc(as(MEMBER), 'dashboards', `${MEMBER}__usage`), { ownerUid: MEMBER, tiles: [] }));
    await assertSucceeds(getDoc(doc(as(MEMBER), 'dashboards', `${MEMBER}__usage`)));
  });
});

describe('known stopgap limitation (documented, not a goal)', () => {
  it('any signed-in member can still write logistics collections and the published dashboard doc (R4 closes this)', async () => {
    await assertSucceeds(setDoc(doc(as(MEMBER), 'dashboards', 'published__usage'), { published: true, tiles: [] }));
    await assertSucceeds(deleteDoc(doc(as(MEMBER), 'inventory', 'item1')));
  });
});
