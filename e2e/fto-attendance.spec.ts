/**
 * End-to-end checks for the FTO attendance rules (decisions.md D-29/D-30) in the
 * REAL browser UI, backed by the Firestore + Auth emulators.
 *
 * Run with BOTH emulators, e.g.
 *   E2E_PORT=3123 firebase emulators:exec --only firestore,auth \
 *     --project demo-bmrc-logistics "npx playwright test e2e/fto-attendance.spec.ts"
 *
 * `/events` is behind the real auth gate, and the FTO gate keys on
 * `effectiveUid` — so each test mints its OWN account in the Auth emulator, logs
 * in through the sign-in form, and builds fixtures around that uid. Fixtures go
 * straight into the emulator (createDoc) so the arrange step never depends on
 * the feature under test.
 */
import { test, expect, type Page } from '@playwright/test';
import { createDoc, listCollection } from './emu-rest';

const AUTH_HOST =
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||
  process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST ||
  '127.0.0.1:9099';
const PASSWORD = 'test1234';

/** Create an account in the Auth emulator and return its uid. */
async function createAuthUser(email: string): Promise<string> {
  const res = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=any-key-works-on-the-emulator`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
    },
  );
  if (!res.ok) throw new Error(`auth emulator signUp failed: ${res.status} ${await res.text()}`);
  return (await res.json()).localId as string;
}

/** Sign in through the real login form and wait for the app shell. */
async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByRole('textbox', { name: /email/i }).fill(email);
  await page.getByRole('textbox', { name: /password/i }).fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30_000 });
}

const EMT_UID = '__test_e2e_emt';
const INTERN_UID = '__test_e2e_intern';

const futureCert = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return { expiresOn: d };
};

/** Today at HH:mm — the seeded event must be LIVE (not past) for the gate to apply. */
function todayAt(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

/** Upsert a users/{uid} doc; ignores a 409 when a previous test already made it. */
async function putUser(uid: string, fullName: string, role: string, email: string) {
  try {
    await createDoc(
      'users',
      {
        fullName,
        email,
        role,
        memberStatus: 'general',
        certifications: { emt: futureCert(), cpr: futureCert() },
        // Otherwise the first-login onboarding tour overlays the whole app and
        // swallows every click (see onboarding-tour.tsx).
        tutorialCompleted: true,
        tutorialCompletedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      uid,
    );
  } catch (e) {
    if (!String(e).includes('ALREADY_EXISTS')) throw e;
  }
}

async function seedFixture(ftoUid: string, ftoEmail: string): Promise<{ eventName: string }> {
  const stamp = Date.now();
  const eventName = `E2E Attendance ${stamp}`;
  const FTO_UID = ftoUid;

  await putUser(FTO_UID, 'E2E Fran FTO', 'FTO', ftoEmail);
  await putUser(EMT_UID, 'E2E Erin EMT', 'member', `${EMT_UID}@bmrc.test`);
  await putUser(INTERN_UID, 'E2E Indy Intern', 'fto_intern', `${INTERN_UID}@bmrc.test`);

  const teams = [
    {
      id: 'e2e-team-1',
      name: 'Team 1',
      ftoSlot: { userId: FTO_UID, userName: 'E2E Fran FTO' },
      hasFtoIntern: true,
      ftoInternSlot: { userId: INTERN_UID, userName: 'E2E Indy Intern' },
      emtCount: 2,
      emtSlots: [{ userId: EMT_UID, userName: 'E2E Erin EMT' }, {}],
    },
    // A second team the viewer is NOT the FTO of — must stay out of their scope.
    {
      id: 'e2e-team-2',
      name: 'Team 2',
      ftoSlot: { userId: 'someone-else', userName: 'Other FTO' },
      hasFtoIntern: false,
      emtCount: 2,
      emtSlots: [{ userId: 'other-emt', userName: 'E2E Otto Other' }, {}],
    },
  ];

  const eventId = await createDoc('events', {
    name: eventName,
    date: todayAt('08:00'),
    // Wide window so the event reads as LIVE all day, whenever the suite runs.
    callTime: '00:01',
    endTime: '23:59',
    status: 'open',
    teams,
    createdBy: 'seed',
    createdByName: 'seed',
    createdAt: new Date(),
  });

  const approved = (userId: string, userName: string, role: string, teamId: string, teamName: string) => ({
    eventId,
    eventName,
    eventDate: todayAt('08:00'),
    teamId,
    teamName,
    role,
    userId,
    userName,
    memberStatus: 'general',
    status: 'approved',
    requestedAt: new Date(),
  });

  await createDoc('shift_requests', approved(FTO_UID, 'E2E Fran FTO', 'FTO', 'e2e-team-1', 'Team 1'));
  await createDoc('shift_requests', approved(EMT_UID, 'E2E Erin EMT', 'EMT', 'e2e-team-1', 'Team 1'));
  await createDoc('shift_requests', approved(INTERN_UID, 'E2E Indy Intern', 'FTO_INTERN', 'e2e-team-1', 'Team 1'));
  await createDoc('shift_requests', approved('other-emt', 'E2E Otto Other', 'EMT', 'e2e-team-2', 'Team 2'));

  return { eventName };
}

/**
 * One member's attendance row, anchored by uid. A name-text locator is not
 * usable here: the Teams roster lists the same names, and the attendance list
 * re-orders itself when the self-check-in gate lifts.
 */
function attendanceRow(page: Page, uid: string) {
  return page.getByTestId(`attendance-row-${uid}`);
}

/** Open the seeded event's detail panel and switch to its Attendance section. */
async function openAttendance(page: Page, eventName: string) {
  await page.goto('/events');
  await page.getByText(eventName, { exact: false }).first().click({ timeout: 20_000 });
  const panel = page.getByRole('dialog').first();
  await expect(panel).toBeVisible({ timeout: 10_000 });
  // At desktop width every section is inline (the "Attendance" tab in the mobile
  // switcher is present but hidden), so wait on the attendance LIST itself:
  // the FTO's own row is in every fixture.
  await expect(panel.getByText('E2E Fran FTO').first()).toBeVisible({ timeout: 15_000 });
  return panel;
}

/** Mint an FTO account, seed the event around its uid, and sign in as them. */
async function arrangeAsFto(page: Page): Promise<{ eventName: string; ftoUid: string }> {
  const email = `e2e-fto-${Date.now()}-${Math.floor(Math.random() * 1e4)}@bmrc.test`;
  const ftoUid = await createAuthUser(email);
  const { eventName } = await seedFixture(ftoUid, email);
  await login(page, email);
  return { eventName, ftoUid };
}

test.describe('FTO attendance gate', () => {
  test('the FTO must check themselves in before they can check anyone else in', async ({ page }) => {
    const { eventName, ftoUid: FTO_UID } = await arrangeAsFto(page);

    const panel = await openAttendance(page, eventName);

    // GATED: the reason banner is shown and other members' controls are locked.
    await expect(panel.getByText(/check yourself in to start the shift/i)).toBeVisible({ timeout: 10_000 });

    const internRow = attendanceRow(page, INTERN_UID);
    const internCheckIn = internRow.getByRole('button', { name: /^check in$/i }).first();
    await expect(internCheckIn).toBeDisabled();

    // The intern's row is labelled by its slot role, not the raw enum.
    await expect(panel.getByText(/FTO Intern/i).first()).toBeVisible();

    // Team scoping: team 2's member is visible in the Teams roster (the FTO can
    // see how the whole event is staffed) but must have NO attendance row —
    // another team's FTO may not record them.
    await expect(attendanceRow(page, 'other-emt')).toHaveCount(0);

    // The FTO's OWN row is actionable while gated.
    const ownRow = attendanceRow(page, FTO_UID);
    await ownRow.getByRole('button', { name: /^check in$/i }).first().click();

    // The check-in landed in the database — attendance is a real stamp.
    await expect
      .poll(
        async () => {
          const reqs = await listCollection('shift_requests');
          return reqs.some((r) => r.userId === FTO_UID && r.attendance?.checkedInAt);
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    // UNGATED: the banner clears and the rest of the team unlocks.
    await expect(panel.getByText(/check yourself in to start the shift/i)).toHaveCount(0, { timeout: 10_000 });
    await expect(internCheckIn).toBeEnabled({ timeout: 10_000 });
  });

  test('there is no arrival-time input in the live flow, and check-out replaces "left early"', async ({ page }) => {
    const { eventName, ftoUid: FTO_UID } = await arrangeAsFto(page);

    const panel = await openAttendance(page, eventName);

    // Times are stamped, never typed: no time inputs anywhere in a live event.
    await expect(panel.locator('input[type="time"]')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: /left early/i })).toHaveCount(0);

    // Check the FTO in, then the EMT, then check the EMT out.
    const ownRow = attendanceRow(page, FTO_UID);
    await ownRow.getByRole('button', { name: /^check in$/i }).first().click();

    const emtRow = attendanceRow(page, EMT_UID);
    const emtCheckIn = emtRow.getByRole('button', { name: /^check in$/i }).first();
    await expect(emtCheckIn).toBeEnabled({ timeout: 10_000 });
    await emtCheckIn.click();

    const checkOut = emtRow.getByRole('button', { name: /^check out$/i }).first();
    await expect(checkOut).toBeVisible({ timeout: 10_000 });
    await checkOut.click();

    // The departure stamp persisted, and left-early was DERIVED (the event runs
    // until 23:59, so checking out now is genuinely early).
    await expect
      .poll(
        async () => {
          const reqs = await listCollection('shift_requests');
          const emt = reqs.find((r) => r.userId === EMT_UID);
          return !!emt?.attendance?.shiftEndAt && emt?.attendance?.leftEarly === true;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  });

  test('an FTO looking back at a finished event gets a read-only view', async ({ page }) => {
    const stamp = Date.now();
    const eventName = `E2E Past Event ${stamp}`;
    const email = `e2e-past-fto-${stamp}@bmrc.test`;
    const FTO_UID = await createAuthUser(email);
    await putUser(FTO_UID, 'E2E Fran FTO', 'FTO', email);

    const past = new Date();
    past.setDate(past.getDate() - 3);
    past.setHours(8, 0, 0, 0);

    const eventId = await createDoc('events', {
      name: eventName,
      date: past,
      callTime: '08:00',
      endTime: '12:00',
      status: 'closed',
      teams: [
        {
          id: 'e2e-past-team',
          name: 'Team 1',
          ftoSlot: { userId: FTO_UID, userName: 'E2E Fran FTO' },
          hasFtoIntern: false,
          emtCount: 2,
          emtSlots: [{ userId: EMT_UID, userName: 'E2E Erin EMT' }, {}],
        },
      ],
      createdBy: 'seed',
      createdAt: past,
    });

    for (const [uid, name, role] of [
      [FTO_UID, 'E2E Fran FTO', 'FTO'],
      [EMT_UID, 'E2E Erin EMT', 'EMT'],
    ] as const) {
      await createDoc('shift_requests', {
        eventId,
        eventName,
        eventDate: past,
        teamId: 'e2e-past-team',
        teamName: 'Team 1',
        role,
        userId: uid,
        userName: name,
        status: 'approved',
        requestedAt: past,
        attendance: { checkedInAt: past, minutesLate: 0, recordedBy: 'seed', recordedAt: past },
      });
    }

    await login(page, email);

    const panel = await openAttendance(page, eventName);

    // Read-only: the FTO is told to escalate, and has no controls at all.
    await expect(panel.getByText(/contact medops or an admin/i)).toBeVisible({ timeout: 10_000 });
    await expect(panel.locator('input[type="time"]')).toHaveCount(0);
    for (const label of [/^check in$/i, /^check out$/i, /no-show/i, /excused/i, /^clear$/i, /end shift/i]) {
      await expect(panel.getByRole('button', { name: label })).toHaveCount(0);
    }
  });
});
