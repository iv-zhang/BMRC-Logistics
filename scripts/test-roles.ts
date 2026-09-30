/**
 * test-roles.ts: offline unit test for app/lib/roles.ts (capability matrix, plan §2).
 * Run: `npx tsx scripts/test-roles.ts` (also chained into `npm run test`).
 *
 * The repo has no vitest/jest (app/lib/__tests__/*.test.ts import vitest, which is
 * not installed), so this follows the plain assert style of test-audit-restock.cjs.
 */

// events.ts pulls in the Firebase SDK; give it a dummy emulator host so importing it
// for the isEventManagerRole consistency check never needs real credentials.
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';

import type { LogisticsArea } from '../app/lib/roles';
import type { User } from '../app/types';

let passed = 0;
const failures: string[] = [];
function check(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
  } else {
    failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function main() {
  const {
    canManageLogistics, canViewLogistics, getLogisticsViewScope, canViewLogisticsArea,
    canRecordPayment, canRequestSupplies, canSeePrivateFinance, canManageEvents,
    DEFAULT_PRIVATE_FINANCE_ROLES, MANAGE_LOGISTICS_ROLES,
  } = await import('../app/lib/roles');
  const { DEFAULT_ORG_CONFIG, ROLES } = await import('../app/config/org-config');

  // Every role in the union (Record<...> makes tsc fail if a role is added but not listed here).
  const ALL_ROLES_RECORD: Record<User['role'], true> = {
    admin: true, quartermaster: true, treasurer: true, medops: true,
    inventory_helper: true, FTO: true, fto_intern: true, member: true,
  };
  const ALL_ROLES = Object.keys(ALL_ROLES_RECORD) as User['role'][];
  const NONE = [null, undefined, '', 'bogus'];

  function only(fn: (r: string | null | undefined) => boolean, name: string, allowed: string[]) {
    for (const r of ALL_ROLES) check(`${name}(${r})`, fn(r), allowed.includes(r));
    for (const r of NONE) check(`${name}(${JSON.stringify(r)})`, fn(r), false);
  }

  only(canManageLogistics, 'canManageLogistics', ['admin', 'quartermaster']);
  only(canViewLogistics, 'canViewLogistics', ['admin', 'quartermaster', 'treasurer']);
  only(canRecordPayment, 'canRecordPayment', ['admin', 'treasurer']);
  only(canRequestSupplies, 'canRequestSupplies', ['admin', 'quartermaster', 'medops']);
  only(canManageEvents, 'canManageEvents', ['admin', 'quartermaster', 'medops']);

  // Scoped logistics view: medops reads inventory + expirations only.
  for (const r of ['admin', 'quartermaster', 'treasurer']) check(`scope(${r})`, getLogisticsViewScope(r), 'full');
  check('scope(medops)', getLogisticsViewScope('medops'), 'inventory_expirations');
  for (const r of ['member', 'FTO', 'fto_intern', 'inventory_helper', null, undefined]) {
    check(`scope(${r})`, getLogisticsViewScope(r), 'none');
  }
  const AREAS: LogisticsArea[] = ['inventory', 'expirations', 'purchases', 'assets', 'storage', 'finance', 'uniforms'];
  for (const a of AREAS) {
    check(`area medops ${a}`, canViewLogisticsArea('medops', a), a === 'inventory' || a === 'expirations');
    check(`area treasurer ${a}`, canViewLogisticsArea('treasurer', a), true);
    check(`area member ${a}`, canViewLogisticsArea('member', a), false);
  }

  // Private finance: admin always; others only when listed; default list = admin only.
  check('default list', [...DEFAULT_PRIVATE_FINANCE_ROLES], ['admin']);
  check('org default matches', DEFAULT_ORG_CONFIG.privateFinanceRoles, ['admin']);
  check('pf admin default', canSeePrivateFinance('admin'), true);
  for (const r of ['quartermaster', 'treasurer', 'medops', 'member', 'FTO']) {
    check(`pf ${r} default`, canSeePrivateFinance(r), false);
    check(`pf ${r} listed`, canSeePrivateFinance(r, [r]), true);
    check(`pf ${r} other listed`, canSeePrivateFinance(r, ['admin', 'treasurer'].filter((x) => x !== r)), false);
  }
  check('pf admin cannot be configured away', canSeePrivateFinance('admin', []), true);
  check('pf null role', canSeePrivateFinance(null, ['admin']), false);
  check('pf undefined role', canSeePrivateFinance(undefined, ['admin']), false);

  // MANAGE_LOGISTICS_ROLES agrees with canManageLogistics.
  for (const r of ALL_ROLES) check(`MANAGE_LOGISTICS_ROLES ${r}`, MANAGE_LOGISTICS_ROLES.includes(r), canManageLogistics(r));

  // ROLES (org-config) lists every role in the union exactly once.
  check('ROLES ids', ROLES.map((r) => r.id).sort(), [...ALL_ROLES].sort());


  // canManageEvents must equal the isEventManagerRole gate in events.ts.
  const { isEventManagerRole } = await import('../app/lib/events');
  for (const r of [...ALL_ROLES, ...NONE]) {
    check(`canManageEvents == isEventManagerRole (${r})`, canManageEvents(r), isEventManagerRole(r));
  }

  console.log(`roles: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(failures.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
