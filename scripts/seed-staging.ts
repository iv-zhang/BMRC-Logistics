/**
 * One-time seed script for the REAL cloud Firebase project `bmrc-staging`.
 *
 * This is the mirror image of scripts/emulator/guard.ts: that guard REFUSES to
 * run unless it is talking to a local `demo-*` emulator project and hard-exits
 * if real credentials are present. This script does the opposite — it
 * REQUIRES a real service-account key and refuses to run against anything
 * other than the `bmrc-staging` project (in particular it will never touch
 * the production project `bmrc-logistics`, even if pointed at it by mistake).
 *
 * All Firestore data written here is SYNTHETIC, generated from the app's own
 * schema (app/types.ts) and from the emulator's representative seed
 * (scripts/emulator/seed.ts). It is NOT a production export and contains no
 * real member data — every name, email, and history record below is made up
 * for the purpose of having a populated staging environment to click through.
 *
 * Usage:
 *   npx tsx scripts/seed-staging.ts --key ./staging-service-account.json --confirm
 *   npx tsx scripts/seed-staging.ts --key ./staging-service-account.json --confirm --wipe
 *
 * The key path may also come from GOOGLE_APPLICATION_CREDENTIALS instead of --key.
 * Without --confirm, the script only prints what it WOULD do and exits 0.
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import * as fs from 'fs';
import { buildSeedData, IDS } from './emulator/seed';

// ---------------------------------------------------------------------------
// SAFETY GUARD — must run, and must refuse, before any admin client exists.
// ---------------------------------------------------------------------------

const STAGING_PROJECT_ID = 'bmrc-staging';
const PROD_PROJECT_ID = 'bmrc-logistics';

function redBanner(reason: string): never {
  const line = '━'.repeat(72);
  console.error(
    `\n\x1b[41m\x1b[97m ABORTED — REFUSING TO SEED THIS PROJECT \x1b[0m\n` +
      `${line}\n` +
      `${reason}\n\n` +
      `This script may ONLY write to the '${STAGING_PROJECT_ID}' staging project.\n` +
      `${line}\n`,
  );
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const keyIdx = argv.findIndex((a) => a === '--key');
  const keyPath = keyIdx >= 0 ? argv[keyIdx + 1] : undefined;
  return {
    keyPath: keyPath || process.env.GOOGLE_APPLICATION_CREDENTIALS,
    confirm: argv.includes('--confirm'),
    wipe: argv.includes('--wipe'),
  };
}

interface ServiceAccountLike {
  project_id?: string;
  [key: string]: unknown;
}

function loadServiceAccount(keyPath: string | undefined): ServiceAccountLike {
  if (!keyPath) {
    redBanner(
      'No service-account key provided. Pass --key <path> or set ' +
        'GOOGLE_APPLICATION_CREDENTIALS to a bmrc-staging service-account JSON file.',
    );
  }
  if (!fs.existsSync(keyPath)) {
    redBanner(`Service-account key file not found at '${keyPath}'.`);
  }
  let parsed: ServiceAccountLike;
  try {
    parsed = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  } catch (e) {
    redBanner(`Could not parse '${keyPath}' as JSON: ${(e as Error).message}`);
  }
  if (!parsed.project_id) {
    redBanner(`Key file '${keyPath}' has no 'project_id' field — cannot verify target project.`);
  }
  if (parsed.project_id === PROD_PROJECT_ID) {
    redBanner(
      `The key file's project_id is '${PROD_PROJECT_ID}' — this is PRODUCTION.\n` +
        `Refused to touch PRODUCTION. This script only ever writes to '${STAGING_PROJECT_ID}'.`,
    );
  }
  if (parsed.project_id !== STAGING_PROJECT_ID) {
    redBanner(
      `The key file's project_id is '${parsed.project_id}', not '${STAGING_PROJECT_ID}'.\n` +
        `Refusing to seed an unrecognized project.`,
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Auth accounts
// ---------------------------------------------------------------------------

const STAGING_PASSWORD = 'staging1234';
const FAR_FUTURE = new Date('2099-01-01');

interface StagingAccount {
  uid: string;
  email: string;
  role: 'admin' | 'quartermaster' | 'member' | 'FTO' | 'fto_intern' | 'medops';
  name: string;
  memberStatus?: 'new' | 'probationary' | 'general';
  joinedTerm?: string;
  withCerts?: boolean;
}

const STAGING_ACCOUNTS: StagingAccount[] = [
  { uid: 'staging-admin', email: 'admin@bmrc.staging.test', role: 'admin', name: 'Ada Admin' },
  { uid: 'staging-qm', email: 'qm@bmrc.staging.test', role: 'quartermaster', name: 'Quinn Quartermaster' },
  {
    uid: 'staging-member',
    email: 'member@bmrc.staging.test',
    role: 'member',
    name: 'Morgan Member',
    memberStatus: 'general',
    joinedTerm: 'Fall 2024',
    withCerts: true,
  },
  {
    uid: 'staging-fto',
    email: 'fto@bmrc.staging.test',
    role: 'FTO',
    name: 'Frankie FTO',
    memberStatus: 'general',
    joinedTerm: 'Fall 2023',
    withCerts: true,
  },
  { uid: 'staging-medops', email: 'medops@bmrc.staging.test', role: 'medops', name: 'Max MedOps' },
  {
    uid: 'staging-member-2',
    email: 'member2@bmrc.staging.test',
    role: 'member',
    name: 'Sam Sophomore',
    memberStatus: 'probationary',
    joinedTerm: 'Spring 2025',
    withCerts: true,
  },
  {
    uid: 'staging-member-3',
    email: 'member3@bmrc.staging.test',
    role: 'member',
    name: 'Riley Rookie',
    memberStatus: 'new',
    joinedTerm: 'Fall 2025',
    withCerts: true,
  },
  {
    uid: 'staging-fto-2',
    email: 'fto2@bmrc.staging.test',
    role: 'FTO',
    name: 'Casey Captain',
    memberStatus: 'general',
    joinedTerm: 'Fall 2022',
    withCerts: true,
  },
  {
    uid: 'staging-fto-intern',
    email: 'ftointern@bmrc.staging.test',
    role: 'fto_intern',
    name: 'Indy Intern',
    memberStatus: 'probationary',
    joinedTerm: 'Spring 2025',
    withCerts: true,
  },
];

async function seedAuthAccounts(): Promise<void> {
  for (const acct of STAGING_ACCOUNTS) {
    try {
      await getAuth().createUser({
        uid: acct.uid,
        email: acct.email,
        password: STAGING_PASSWORD,
        displayName: acct.name,
      });
      console.log(`  [auth] created ${acct.email}`);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'auth/uid-already-exists' || code === 'auth/email-already-exists') {
        await getAuth().updateUser(acct.uid, {
          email: acct.email,
          password: STAGING_PASSWORD,
          displayName: acct.name,
        });
        console.log(`  [auth] updated ${acct.email}`);
      } else {
        throw e;
      }
    }

    const now = new Date();
    const userDoc: Record<string, unknown> = {
      id: acct.uid,
      fullName: acct.name,
      name: acct.name, // legacy dup
      email: acct.email,
      role: acct.role,
      tutorialCompleted: true,
      createdAt: now,
      updatedAt: now,
    };
    if (acct.memberStatus) userDoc.memberStatus = acct.memberStatus;
    if (acct.joinedTerm) userDoc.joinedTerm = acct.joinedTerm;
    if (acct.withCerts) {
      userDoc.certifications = {
        emt: { expiresOn: FAR_FUTURE, verifiedBy: 'staging-admin', verifiedAt: now },
        cpr: { expiresOn: FAR_FUTURE, verifiedBy: 'staging-admin', verifiedAt: now },
      };
    }
    await getFirestore().collection('users').doc(acct.uid).set(userDoc, { merge: true });
  }
}

// ---------------------------------------------------------------------------
// Synthetic history (events / shift_requests / statpack_logs / vehicles /
// vehicle_logs / issue_reports / notifications)
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
function daysFromNow(n: number): Date {
  return new Date(Date.now() + n * DAY);
}
function atTime(base: Date, hh: number, mm: number): Date {
  const d = new Date(base);
  d.setHours(hh, mm, 0, 0);
  return d;
}

interface TeamSlotLike {
  userId?: string;
  userName?: string;
  requestId?: string;
}
function slot(userId?: string, userName?: string, requestId?: string): TeamSlotLike {
  if (!userId) return {};
  return { userId, userName, requestId };
}

const NAME_BY_UID: Record<string, string> = {
  'staging-admin': 'Ada Admin',
  'staging-qm': 'Quinn Quartermaster',
  'staging-member': 'Morgan Member',
  'staging-fto': 'Frankie FTO',
  'staging-medops': 'Max MedOps',
  'staging-member-2': 'Sam Sophomore',
  'staging-member-3': 'Riley Rookie',
  'staging-fto-2': 'Casey Captain',
  'staging-fto-intern': 'Indy Intern',
};

function buildHistoryData() {
  // ── EVENTS ────────────────────────────────────────────────────────────
  const evt1Date = daysFromNow(-21);
  const evt2Date = daysFromNow(-35);
  const evt3Date = daysFromNow(7);
  const evt4Date = daysFromNow(21);

  const events: Record<string, Record<string, unknown>> = {
    'staging-evt-1': {
      name: 'Sproul Plaza Standby',
      eventType: 'Standby',
      venue: 'Sproul Plaza',
      date: evt1Date,
      callTime: '09:00',
      endTime: '13:00',
      description: 'Weekly standby coverage at Sproul Plaza.',
      status: 'closed',
      teams: [
        {
          id: 'staging-evt-1-team-1',
          name: 'Team 1',
          ftoSlot: slot('staging-fto', NAME_BY_UID['staging-fto'], 'staging-req-1'),
          hasFtoIntern: true,
          ftoInternSlot: slot('staging-fto-intern', NAME_BY_UID['staging-fto-intern'], 'staging-req-14'),
          emtCount: 3,
          emtSlots: [
            slot('staging-member', NAME_BY_UID['staging-member'], 'staging-req-2'),
            slot('staging-member-2', NAME_BY_UID['staging-member-2'], 'staging-req-3'),
            slot('staging-member-3', NAME_BY_UID['staging-member-3'], 'staging-req-4'),
          ],
        },
      ],
      notified: true,
      createdBy: 'staging-admin',
      createdByName: NAME_BY_UID['staging-admin'],
      createdAt: daysFromNow(-30),
      updatedAt: evt1Date,
    },
    'staging-evt-2': {
      name: 'Memorial Stadium Football Game',
      eventType: 'Football Game',
      venue: 'Memorial Stadium',
      date: evt2Date,
      callTime: '10:00',
      endTime: '15:00',
      description: 'Home game medical coverage.',
      status: 'closed',
      teams: [
        {
          id: 'staging-evt-2-team-1',
          name: 'Team 1',
          ftoSlot: slot('staging-fto-2', NAME_BY_UID['staging-fto-2'], 'staging-req-5'),
          hasFtoIntern: true,
          ftoInternSlot: {},
          emtCount: 3,
          emtSlots: [
            slot('staging-member', NAME_BY_UID['staging-member'], 'staging-req-6'),
            slot('staging-member-2', NAME_BY_UID['staging-member-2'], 'staging-req-7'),
            {},
          ],
        },
        {
          id: 'staging-evt-2-team-2',
          name: 'Team 2',
          ftoSlot: slot('staging-fto', NAME_BY_UID['staging-fto'], 'staging-req-8'),
          hasFtoIntern: true,
          ftoInternSlot: {},
          emtCount: 2,
          emtSlots: [slot('staging-member-3', NAME_BY_UID['staging-member-3'], 'staging-req-9'), {}],
        },
      ],
      notified: true,
      createdBy: 'staging-qm',
      createdByName: NAME_BY_UID['staging-qm'],
      createdAt: daysFromNow(-42),
      updatedAt: evt2Date,
    },
    'staging-evt-3': {
      name: 'Zellerbach Hall Standby',
      eventType: 'Standby',
      venue: 'Zellerbach Hall',
      date: evt3Date,
      callTime: '18:00',
      endTime: '22:00',
      description: 'Evening performance standby coverage.',
      status: 'open',
      teams: [
        {
          id: 'staging-evt-3-team-1',
          name: 'Team 1',
          ftoSlot: {},
          hasFtoIntern: true,
          ftoInternSlot: {},
          emtCount: 3,
          emtSlots: [slot('staging-member', NAME_BY_UID['staging-member'], 'staging-req-10'), {}, {}],
        },
      ],
      notified: true,
      createdBy: 'staging-medops',
      createdByName: NAME_BY_UID['staging-medops'],
      createdAt: daysFromNow(-2),
      updatedAt: daysFromNow(-2),
    },
    'staging-evt-4': {
      name: 'Community Health Fair',
      eventType: 'Community Event',
      venue: 'Lower Sproul',
      date: evt4Date,
      callTime: '11:00',
      endTime: '14:00',
      description: 'Health screening / outreach table.',
      status: 'open',
      teams: [
        {
          id: 'staging-evt-4-team-1',
          name: 'Team 1',
          ftoSlot: {},
          emtCount: 3,
          emtSlots: [{}, {}, {}],
        },
      ],
      notified: false,
      createdBy: 'staging-admin',
      createdByName: NAME_BY_UID['staging-admin'],
      createdAt: daysFromNow(-1),
      updatedAt: daysFromNow(-1),
    },
  };

  // ── SHIFT REQUESTS ───────────────────────────────────────────────────────
  function approvedReq(opts: {
    id: string;
    eventId: string;
    eventName: string;
    eventDate: Date;
    teamId: string;
    teamName: string;
    role: 'FTO' | 'FTO_INTERN' | 'EMT';
    userId: string;
    memberStatus: 'new' | 'probationary' | 'general';
    joinedTerm: string;
    assignedSlot: string;
    attendance?: Record<string, unknown>;
  }) {
    return {
      eventId: opts.eventId,
      eventName: opts.eventName,
      eventDate: opts.eventDate,
      teamId: opts.teamId,
      teamName: opts.teamName,
      role: opts.role,
      userId: opts.userId,
      userName: NAME_BY_UID[opts.userId],
      memberStatus: opts.memberStatus,
      joinedTerm: opts.joinedTerm,
      status: 'approved' as const,
      assignedSlot: opts.assignedSlot,
      requestedAt: daysFromNow(-45),
      decidedBy: 'staging-admin',
      decidedByName: NAME_BY_UID['staging-admin'],
      decidedAt: daysFromNow(-44),
      ...(opts.attendance ? { attendance: opts.attendance } : {}),
    };
  }

  function pendingReq(opts: {
    eventId: string;
    eventName: string;
    eventDate: Date;
    teamId: string;
    teamName: string;
    role: 'FTO' | 'EMT';
    userId: string;
    memberStatus: 'new' | 'probationary' | 'general';
    joinedTerm: string;
  }) {
    return {
      eventId: opts.eventId,
      eventName: opts.eventName,
      eventDate: opts.eventDate,
      teamId: opts.teamId,
      teamName: opts.teamName,
      role: opts.role,
      userId: opts.userId,
      userName: NAME_BY_UID[opts.userId],
      memberStatus: opts.memberStatus,
      joinedTerm: opts.joinedTerm,
      status: 'pending' as const,
      requestedAt: daysFromNow(-3),
    };
  }

  const evt1Call = atTime(evt1Date, 9, 0);
  const evt2Call = atTime(evt2Date, 10, 0);

  const shift_requests: Record<string, Record<string, unknown>> = {
    // Event 1 — on-time / late / no-show / excused (one of each).
    'staging-req-1': approvedReq({
      id: 'staging-req-1',
      eventId: 'staging-evt-1',
      eventName: 'Sproul Plaza Standby',
      eventDate: evt1Date,
      teamId: 'staging-evt-1-team-1',
      teamName: 'Team 1',
      role: 'FTO',
      userId: 'staging-fto',
      memberStatus: 'general',
      joinedTerm: 'Fall 2023',
      assignedSlot: 'fto',
      attendance: {
        checkedInAt: atTime(evt1Date, 8, 58),
        shiftEndAt: atTime(evt1Date, 13, 5),
        minutesLate: 0,
        recordedBy: 'staging-fto',
        recordedByName: NAME_BY_UID['staging-fto'],
        recordedAt: atTime(evt1Date, 8, 58),
      },
    }),
    'staging-req-2': approvedReq({
      id: 'staging-req-2',
      eventId: 'staging-evt-1',
      eventName: 'Sproul Plaza Standby',
      eventDate: evt1Date,
      teamId: 'staging-evt-1-team-1',
      teamName: 'Team 1',
      role: 'EMT',
      userId: 'staging-member',
      memberStatus: 'general',
      joinedTerm: 'Fall 2024',
      assignedSlot: 'emt:0',
      attendance: {
        checkedInAt: atTime(evt1Date, 9, 15),
        shiftEndAt: atTime(evt1Date, 13, 5),
        minutesLate: 15,
        recordedBy: 'staging-fto',
        recordedByName: NAME_BY_UID['staging-fto'],
        recordedAt: atTime(evt1Date, 9, 15),
      },
    }),
    'staging-req-3': approvedReq({
      id: 'staging-req-3',
      eventId: 'staging-evt-1',
      eventName: 'Sproul Plaza Standby',
      eventDate: evt1Date,
      teamId: 'staging-evt-1-team-1',
      teamName: 'Team 1',
      role: 'EMT',
      userId: 'staging-member-2',
      memberStatus: 'probationary',
      joinedTerm: 'Spring 2025',
      assignedSlot: 'emt:1',
      attendance: {
        exception: 'no_show',
        recordedBy: 'staging-fto',
        recordedByName: NAME_BY_UID['staging-fto'],
        recordedAt: atTime(evt1Date, 9, 30),
      },
    }),
    'staging-req-4': approvedReq({
      id: 'staging-req-4',
      eventId: 'staging-evt-1',
      eventName: 'Sproul Plaza Standby',
      eventDate: evt1Date,
      teamId: 'staging-evt-1-team-1',
      teamName: 'Team 1',
      role: 'EMT',
      userId: 'staging-member-3',
      memberStatus: 'new',
      joinedTerm: 'Fall 2025',
      assignedSlot: 'emt:2',
      attendance: {
        exception: 'excused',
        notes: 'Excused — midterm conflict.',
        recordedBy: 'staging-fto',
        recordedByName: NAME_BY_UID['staging-fto'],
        recordedAt: atTime(evt1Date, 8, 0),
      },
    }),
    'staging-req-14': approvedReq({
      id: 'staging-req-14',
      eventId: 'staging-evt-1',
      eventName: 'Sproul Plaza Standby',
      eventDate: evt1Date,
      teamId: 'staging-evt-1-team-1',
      teamName: 'Team 1',
      role: 'FTO_INTERN',
      userId: 'staging-fto-intern',
      memberStatus: 'probationary',
      joinedTerm: 'Spring 2025',
      assignedSlot: 'intern',
      attendance: {
        checkedInAt: atTime(evt1Date, 8, 59),
        shiftEndAt: atTime(evt1Date, 13, 5),
        minutesLate: 0,
        recordedBy: 'staging-fto',
        recordedByName: NAME_BY_UID['staging-fto'],
        recordedAt: atTime(evt1Date, 8, 59),
      },
    }),

    // Event 2 — two teams, one open slot each (a cancellation), all-attended.
    'staging-req-5': approvedReq({
      id: 'staging-req-5',
      eventId: 'staging-evt-2',
      eventName: 'Memorial Stadium Football Game',
      eventDate: evt2Date,
      teamId: 'staging-evt-2-team-1',
      teamName: 'Team 1',
      role: 'FTO',
      userId: 'staging-fto-2',
      memberStatus: 'general',
      joinedTerm: 'Fall 2022',
      assignedSlot: 'fto',
      attendance: {
        checkedInAt: atTime(evt2Date, 9, 55),
        shiftEndAt: atTime(evt2Date, 15, 10),
        minutesLate: 0,
        recordedBy: 'staging-fto-2',
        recordedByName: NAME_BY_UID['staging-fto-2'],
        recordedAt: atTime(evt2Date, 9, 55),
      },
    }),
    'staging-req-6': approvedReq({
      id: 'staging-req-6',
      eventId: 'staging-evt-2',
      eventName: 'Memorial Stadium Football Game',
      eventDate: evt2Date,
      teamId: 'staging-evt-2-team-1',
      teamName: 'Team 1',
      role: 'EMT',
      userId: 'staging-member',
      memberStatus: 'general',
      joinedTerm: 'Fall 2024',
      assignedSlot: 'emt:0',
      attendance: {
        checkedInAt: atTime(evt2Date, 9, 58),
        shiftEndAt: atTime(evt2Date, 15, 10),
        minutesLate: 0,
        recordedBy: 'staging-fto-2',
        recordedByName: NAME_BY_UID['staging-fto-2'],
        recordedAt: atTime(evt2Date, 9, 58),
      },
    }),
    'staging-req-7': approvedReq({
      id: 'staging-req-7',
      eventId: 'staging-evt-2',
      eventName: 'Memorial Stadium Football Game',
      eventDate: evt2Date,
      teamId: 'staging-evt-2-team-1',
      teamName: 'Team 1',
      role: 'EMT',
      userId: 'staging-member-2',
      memberStatus: 'probationary',
      joinedTerm: 'Spring 2025',
      assignedSlot: 'emt:1',
      attendance: {
        checkedInAt: atTime(evt2Date, 10, 10),
        shiftEndAt: atTime(evt2Date, 15, 10),
        minutesLate: 10,
        recordedBy: 'staging-fto-2',
        recordedByName: NAME_BY_UID['staging-fto-2'],
        recordedAt: atTime(evt2Date, 10, 10),
      },
    }),
    'staging-req-8': approvedReq({
      id: 'staging-req-8',
      eventId: 'staging-evt-2',
      eventName: 'Memorial Stadium Football Game',
      eventDate: evt2Date,
      teamId: 'staging-evt-2-team-2',
      teamName: 'Team 2',
      role: 'FTO',
      userId: 'staging-fto',
      memberStatus: 'general',
      joinedTerm: 'Fall 2023',
      assignedSlot: 'fto',
      attendance: {
        checkedInAt: atTime(evt2Date, 9, 50),
        shiftEndAt: atTime(evt2Date, 15, 5),
        minutesLate: 0,
        recordedBy: 'staging-fto',
        recordedByName: NAME_BY_UID['staging-fto'],
        recordedAt: atTime(evt2Date, 9, 50),
      },
    }),
    'staging-req-9': approvedReq({
      id: 'staging-req-9',
      eventId: 'staging-evt-2',
      eventName: 'Memorial Stadium Football Game',
      eventDate: evt2Date,
      teamId: 'staging-evt-2-team-2',
      teamName: 'Team 2',
      role: 'EMT',
      userId: 'staging-member-3',
      memberStatus: 'new',
      joinedTerm: 'Fall 2025',
      assignedSlot: 'emt:0',
      attendance: {
        checkedInAt: atTime(evt2Date, 9, 52),
        shiftEndAt: atTime(evt2Date, 15, 5),
        minutesLate: 0,
        recordedBy: 'staging-fto',
        recordedByName: NAME_BY_UID['staging-fto'],
        recordedAt: atTime(evt2Date, 9, 52),
      },
    }),

    // Event 3 (upcoming) — one approved (no attendance yet, future) + pending.
    'staging-req-10': approvedReq({
      id: 'staging-req-10',
      eventId: 'staging-evt-3',
      eventName: 'Zellerbach Hall Standby',
      eventDate: evt3Date,
      teamId: 'staging-evt-3-team-1',
      teamName: 'Team 1',
      role: 'EMT',
      userId: 'staging-member',
      memberStatus: 'general',
      joinedTerm: 'Fall 2024',
      assignedSlot: 'emt:0',
    }),
    'staging-req-11': pendingReq({
      eventId: 'staging-evt-3',
      eventName: 'Zellerbach Hall Standby',
      eventDate: evt3Date,
      teamId: 'staging-evt-3-team-1',
      teamName: 'Team 1',
      role: 'FTO',
      userId: 'staging-fto-2',
      memberStatus: 'general',
      joinedTerm: 'Fall 2022',
    }),
    'staging-req-12': pendingReq({
      eventId: 'staging-evt-3',
      eventName: 'Zellerbach Hall Standby',
      eventDate: evt3Date,
      teamId: 'staging-evt-3-team-1',
      teamName: 'Team 1',
      role: 'EMT',
      userId: 'staging-member-2',
      memberStatus: 'probationary',
      joinedTerm: 'Spring 2025',
    }),

    // Event 4 (upcoming) — pending only.
    'staging-req-13': pendingReq({
      eventId: 'staging-evt-4',
      eventName: 'Community Health Fair',
      eventDate: evt4Date,
      teamId: 'staging-evt-4-team-1',
      teamName: 'Team 1',
      role: 'EMT',
      userId: 'staging-member-3',
      memberStatus: 'new',
      joinedTerm: 'Fall 2025',
    }),
  };
  void evt1Call;
  void evt2Call;

  // ── STATPACK LOGS ────────────────────────────────────────────────────────
  function checkoutLog(opts: {
    id: string;
    packId: string;
    packName: string;
    pairId: string;
    userId: string;
    at: Date;
    eventId?: string;
    eventName?: string;
  }) {
    return {
      statpackId: opts.packId,
      statpackName: opts.packName,
      action: 'checkout' as const,
      pairId: opts.pairId,
      userId: opts.userId,
      userName: NAME_BY_UID[opts.userId],
      timestamp: opts.at,
      clientTimestamp: opts.at,
      ...(opts.eventId ? { eventId: opts.eventId, eventName: opts.eventName } : {}),
      summary: { totalItems: 5, verifiedCount: 5, mismatchCount: 0, expiredCount: 0 },
    };
  }
  function checkinLog(opts: {
    id: string;
    packId: string;
    packName: string;
    pairId: string;
    userId: string;
    at: Date;
    eventId?: string;
    eventName?: string;
    quickCheckin?: boolean;
  }) {
    return {
      statpackId: opts.packId,
      statpackName: opts.packName,
      action: 'checkin' as const,
      pairId: opts.pairId,
      quickCheckin: !!opts.quickCheckin,
      userId: opts.userId,
      userName: NAME_BY_UID[opts.userId],
      timestamp: opts.at,
      clientTimestamp: opts.at,
      ...(opts.eventId ? { eventId: opts.eventId, eventName: opts.eventName } : {}),
      summary: {
        totalItems: 5,
        verifiedCount: 5,
        mismatchCount: 0,
        expiredCount: 0,
        restockedCount: opts.quickCheckin ? 0 : 1,
        shelfEmptyCount: 0,
        reportedCount: 0,
      },
    };
  }

  const statpack_logs: Record<string, Record<string, unknown>> = {
    'staging-log-1-out': checkoutLog({
      id: 'staging-log-1-out',
      packId: IDS.packMRC1,
      packName: 'MRC1 Primary',
      pairId: 'staging-pair-1',
      userId: 'staging-fto',
      at: atTime(evt1Date, 8, 55),
      eventId: 'staging-evt-1',
      eventName: 'Sproul Plaza Standby',
    }),
    'staging-log-1-in': checkinLog({
      id: 'staging-log-1-in',
      packId: IDS.packMRC1,
      packName: 'MRC1 Primary',
      pairId: 'staging-pair-1',
      userId: 'staging-fto',
      at: atTime(evt1Date, 13, 10),
      eventId: 'staging-evt-1',
      eventName: 'Sproul Plaza Standby',
    }),
    'staging-log-2-out': checkoutLog({
      id: 'staging-log-2-out',
      packId: IDS.packMRC2,
      packName: 'MRC2 Primary',
      pairId: 'staging-pair-2',
      userId: 'staging-member',
      at: atTime(evt2Date, 9, 45),
      eventId: 'staging-evt-2',
      eventName: 'Memorial Stadium Football Game',
    }),
    'staging-log-2-in': checkinLog({
      id: 'staging-log-2-in',
      packId: IDS.packMRC2,
      packName: 'MRC2 Primary',
      pairId: 'staging-pair-2',
      userId: 'staging-member',
      at: atTime(evt2Date, 15, 15),
      eventId: 'staging-evt-2',
      eventName: 'Memorial Stadium Football Game',
    }),
    'staging-log-3-out': checkoutLog({
      id: 'staging-log-3-out',
      packId: IDS.packMRC1,
      packName: 'MRC1 Primary',
      pairId: 'staging-pair-3',
      userId: 'staging-member-2',
      at: daysFromNow(-14),
    }),
    'staging-log-3-in': checkinLog({
      id: 'staging-log-3-in',
      packId: IDS.packMRC1,
      packName: 'MRC1 Primary',
      pairId: 'staging-pair-3',
      userId: 'staging-member-2',
      at: daysFromNow(-14),
      quickCheckin: true,
    }),
    'staging-log-4-out': checkoutLog({
      id: 'staging-log-4-out',
      packId: IDS.packMRC2,
      packName: 'MRC2 Primary',
      pairId: 'staging-pair-4',
      userId: 'staging-fto-2',
      at: atTime(evt2Date, 9, 40),
      eventId: 'staging-evt-2',
      eventName: 'Memorial Stadium Football Game',
    }),
    'staging-log-4-in': checkinLog({
      id: 'staging-log-4-in',
      packId: IDS.packMRC2,
      packName: 'MRC2 Primary',
      pairId: 'staging-pair-4',
      userId: 'staging-fto-2',
      at: atTime(evt2Date, 15, 20),
      eventId: 'staging-evt-2',
      eventName: 'Memorial Stadium Football Game',
    }),
    'staging-log-5-audit': {
      statpackId: IDS.packMRC1,
      statpackName: 'MRC1 Primary',
      action: 'audit' as const,
      userId: 'staging-admin',
      userName: NAME_BY_UID['staging-admin'],
      timestamp: daysFromNow(-5),
      clientTimestamp: daysFromNow(-5),
      summary: { totalItems: 5, verifiedCount: 5, mismatchCount: 0, expiredCount: 0 },
    },
  };

  // ── VEHICLES ─────────────────────────────────────────────────────────────
  const vehicles: Record<string, Record<string, unknown>> = {
    'staging-veh-1': {
      name: 'Ambulance 2',
      typeId: 'ambulance',
      status: 'active',
      notes: 'Primary response ambulance.',
      isCheckedOut: false,
      activeLogId: null,
      assignedToUserId: null,
      assignedToUserName: null,
      checkedOutAt: null,
      lastMileage: 48210,
      lastFuelLevel: 75,
      lastBatteryLevel: null,
      createdAt: daysFromNow(-200),
      createdBy: 'staging-admin',
      updatedAt: daysFromNow(-5),
    },
    'staging-veh-2': {
      name: 'UTV-1',
      typeId: 'utv',
      status: 'active',
      notes: 'Off-road event support.',
      isCheckedOut: false,
      activeLogId: null,
      assignedToUserId: null,
      assignedToUserName: null,
      checkedOutAt: null,
      lastMileage: 1120,
      lastFuelLevel: 50,
      lastBatteryLevel: null,
      createdAt: daysFromNow(-150),
      createdBy: 'staging-admin',
      updatedAt: daysFromNow(-10),
    },
  };

  const vehicle_logs: Record<string, Record<string, unknown>> = {
    'staging-vlog-1': {
      vehicleId: 'staging-veh-1',
      vehicleName: 'Ambulance 2',
      vehicleTypeId: 'ambulance',
      status: 'closed',
      driverUserId: 'staging-fto',
      driverName: NAME_BY_UID['staging-fto'],
      crewNames: ['Morgan Member', 'Sam Sophomore'],
      checkoutAt: atTime(evt1Date, 8, 45),
      checkoutClientAt: atTime(evt1Date, 8, 45),
      checkinAt: atTime(evt1Date, 13, 15),
      checkinClientAt: atTime(evt1Date, 13, 15),
      checkinUserId: 'staging-fto',
      checkinUserName: NAME_BY_UID['staging-fto'],
      preReadings: { mileage: 48100, fuelLevel: 100 },
      postReadings: { mileage: 48145, fuelLevel: 75 },
      preDamage: null,
      postDamage: null,
      mileageMismatchAck: null,
      notes: 'Sproul Plaza standby shift.',
    },
    'staging-vlog-2': {
      vehicleId: 'staging-veh-2',
      vehicleName: 'UTV-1',
      vehicleTypeId: 'utv',
      status: 'closed',
      driverUserId: 'staging-fto',
      driverName: NAME_BY_UID['staging-fto'],
      crewNames: ['Riley Rookie'],
      checkoutAt: atTime(evt2Date, 9, 40),
      checkoutClientAt: atTime(evt2Date, 9, 40),
      checkinAt: atTime(evt2Date, 15, 20),
      checkinClientAt: atTime(evt2Date, 15, 20),
      checkinUserId: 'staging-fto',
      checkinUserName: NAME_BY_UID['staging-fto'],
      preReadings: { mileage: 1080, fuelLevel: 75 },
      postReadings: { mileage: 1120, fuelLevel: 50 },
      preDamage: null,
      postDamage: null,
      mileageMismatchAck: null,
      notes: 'Football game support.',
    },
  };

  // ── ISSUE REPORTS ────────────────────────────────────────────────────────
  const issue_reports: Record<string, Record<string, unknown>> = {
    'staging-issue-1': {
      reporter: { userId: 'staging-member', userName: NAME_BY_UID['staging-member'], userEmail: 'member@bmrc.staging.test' },
      target: { collection: 'statpacks', docId: IDS.packMRC1 },
      type: 'bug',
      priority: 'medium',
      status: 'open',
      title: 'Sharps container was nearly full',
      description: 'Noticed the sharps container in MRC1 was almost full during check-in; flagging for swap.',
      pagePath: '/statpacks/check-off',
      createdAt: atTime(evt1Date, 13, 12),
      updatedAt: atTime(evt1Date, 13, 12),
    },
    'staging-issue-2': {
      reporter: { userId: 'staging-member-2', userName: NAME_BY_UID['staging-member-2'], userEmail: 'member2@bmrc.staging.test' },
      target: { collection: 'inventory', docId: IDS.gauze },
      type: 'feedback',
      priority: 'low',
      status: 'triaged',
      title: 'Gauze box running low',
      description: '2x2 gauze back-room stock looked low on last restock sweep.',
      pagePath: '/restock',
      assignedTo: { userId: 'staging-qm', userName: NAME_BY_UID['staging-qm'] },
      createdAt: daysFromNow(-10),
      updatedAt: daysFromNow(-9),
    },
  };

  // ── NOTIFICATIONS ────────────────────────────────────────────────────────
  const notifications: Record<string, Record<string, unknown>> = {
    'staging-notif-1': {
      userId: 'staging-admin',
      type: 'broadcast',
      title: 'New shift request',
      body: `${NAME_BY_UID['staging-fto-2']} requested Team 1 · FTO for Zellerbach Hall Standby`,
      link: '/events?event=staging-evt-3',
      read: false,
      createdAt: daysFromNow(-3),
      createdBy: 'staging-fto-2',
    },
    'staging-notif-2': {
      userId: 'staging-qm',
      type: 'broadcast',
      title: 'New shift request',
      body: `${NAME_BY_UID['staging-member-2']} requested Team 1 · EMT for Zellerbach Hall Standby`,
      link: '/events?event=staging-evt-3',
      read: false,
      createdAt: daysFromNow(-3),
      createdBy: 'staging-member-2',
    },
    'staging-notif-3': {
      userId: 'staging-fto',
      type: 'broadcast',
      title: 'New shift request',
      body: `${NAME_BY_UID['staging-member-3']} requested Team 1 · EMT for Community Health Fair`,
      link: '/events?event=staging-evt-4',
      read: true,
      createdAt: daysFromNow(-1),
      createdBy: 'staging-member-3',
    },
  };

  return { events, shift_requests, statpack_logs, vehicles, vehicle_logs, issue_reports, notifications };
}

// ---------------------------------------------------------------------------
// Batched writes
// ---------------------------------------------------------------------------

/** Every collection this script manages — also the --wipe list. */
const MANAGED_COLLECTIONS = [
  'inventory',
  'statpacks',
  'laf_records',
  'pools',
  'org_settings',
  'users',
  'events',
  'shift_requests',
  'statpack_logs',
  'vehicles',
  'vehicle_logs',
  'issue_reports',
  'notifications',
  'inventory_logs',
  'auditEvents',
  'buyList',
  'medication_logs',
] as const;

const BATCH_CHUNK = 400;

async function wipeCollections(db: Firestore): Promise<void> {
  for (const name of MANAGED_COLLECTIONS) {
    const snap = await db.collection(name).get();
    if (snap.empty) continue;
    let batch = db.batch();
    let n = 0;
    for (const docSnap of snap.docs) {
      batch.delete(docSnap.ref);
      n += 1;
      if (n % BATCH_CHUNK === 0) {
        await batch.commit();
        batch = db.batch();
      }
    }
    await batch.commit();
    console.log(`  [wipe] ${name}: deleted ${snap.size} docs`);
  }
}

async function writeCollection(
  db: Firestore,
  name: string,
  docs: Record<string, Record<string, unknown>>,
): Promise<number> {
  const entries = Object.entries(docs);
  let batch = db.batch();
  let n = 0;
  for (const [id, payload] of entries) {
    batch.set(db.collection(name).doc(id), payload, { merge: false });
    n += 1;
    if (n % BATCH_CHUNK === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  if (n % BATCH_CHUNK !== 0) await batch.commit();
  return entries.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { keyPath, confirm, wipe } = parseArgs(process.argv.slice(2));
  const serviceAccount = loadServiceAccount(keyPath);

  if (!confirm) {
    console.log(
      `\n[seed-staging] DRY RUN (no --confirm passed).\n` +
        `  Target project : ${serviceAccount.project_id}\n` +
        `  Would wipe     : ${wipe ? 'YES — ' + MANAGED_COLLECTIONS.join(', ') : 'no'}\n` +
        `  Would seed     : ${STAGING_ACCOUNTS.length} auth accounts + Firestore synthetic dataset\n` +
        `  Re-run with --confirm to actually write.\n`,
    );
    process.exit(0);
  }

  initializeApp({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    credential: cert(serviceAccount as any),
    projectId: serviceAccount.project_id,
  });
  const db = getFirestore();

  console.log(`\n[seed-staging] Seeding '${serviceAccount.project_id}'…`);

  if (wipe) {
    console.log('[seed-staging] --wipe: clearing managed collections first…');
    await wipeCollections(db);
  }

  console.log('[seed-staging] Seeding auth accounts + users/{uid} docs…');
  await seedAuthAccounts();

  console.log('[seed-staging] Writing base dataset (inventory/statpacks/laf_records/pools/org_settings)…');
  const base = buildSeedData();
  const counts: Record<string, number> = {};
  counts.inventory = await writeCollection(db, 'inventory', base.inventory);
  counts.statpacks = await writeCollection(db, 'statpacks', base.statpacks);
  counts.laf_records = await writeCollection(db, 'laf_records', base.laf_records);
  counts.pools = await writeCollection(db, 'pools', base.pools);
  counts.org_settings = await writeCollection(db, 'org_settings', base.org_settings);

  console.log('[seed-staging] Writing synthetic history (events/requests/logs/vehicles/issues/notifications)…');
  const history = buildHistoryData();
  counts.events = await writeCollection(db, 'events', history.events);
  counts.shift_requests = await writeCollection(db, 'shift_requests', history.shift_requests);
  counts.statpack_logs = await writeCollection(db, 'statpack_logs', history.statpack_logs);
  counts.vehicles = await writeCollection(db, 'vehicles', history.vehicles);
  counts.vehicle_logs = await writeCollection(db, 'vehicle_logs', history.vehicle_logs);
  counts.issue_reports = await writeCollection(db, 'issue_reports', history.issue_reports);
  counts.notifications = await writeCollection(db, 'notifications', history.notifications);
  counts.users = STAGING_ACCOUNTS.length;

  console.log(`\n[seed-staging] Done.`);
  console.log(`  Target project : ${serviceAccount.project_id}`);
  console.log(`  Wiped first    : ${wipe ? 'yes' : 'no'}`);
  console.log('  Doc counts:');
  for (const [name, count] of Object.entries(counts)) {
    console.log(`    • ${name.padEnd(20)} ${count}`);
  }
  console.log(`\n  Login accounts (password: ${STAGING_PASSWORD}):`);
  for (const acct of STAGING_ACCOUNTS) {
    console.log(`    • ${acct.role.padEnd(13)} ${acct.email}`);
  }
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-staging] FAILED:', e);
    process.exit(1);
  });
