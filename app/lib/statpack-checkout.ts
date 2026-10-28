// Picker pages (/statpacks/checkout, /checkin) filter client-side: where(status)+orderBy(name)
// needs a composite index the emulator never enforces, so prod returned an empty list (issue #23).
// Restock Needed is a shortage flag, not a deployment block (D-8).
export const STATPACK_CHECKOUT_PICKER_STATUSES = ['Ready', 'Restock Needed'];

export const STATPACK_MAINTENANCE_CHECKOUT_MESSAGE =
  'This statpack is In Maintenance and is unavailable for checkout. Choose another pack or contact logistics.';

/** Shared deployment gate. Item expiry/verification and check-in ownership keep
 * their existing checks; this policy applies only when checking out a pack. */
export function getStatpackCheckoutUnavailableReason(pack: {
  status?: unknown;
  isCheckedOut?: unknown;
}): string | null {
  if (pack.status === 'In Maintenance') return STATPACK_MAINTENANCE_CHECKOUT_MESSAGE;
  if (pack.isCheckedOut) return 'Statpack is already checked out';
  return null;
}

/** Checkout picker filter. A missing status is shown as Ready by every admin
 * surface, so treat it as Ready here; the transactional gate in logStatpackCheckOff is unchanged. */
export function isStatpackCheckoutPickerEligible(pack: {
  status?: unknown;
  isCheckedOut?: unknown;
}): boolean {
  const status = pack.status ?? 'Ready';
  return (
    typeof status === 'string' &&
    STATPACK_CHECKOUT_PICKER_STATUSES.includes(status) &&
    getStatpackCheckoutUnavailableReason(pack) === null
  );
}

export function isStatpackCheckinPickerEligible(pack: {
  status?: unknown;
  isCheckedOut?: unknown;
}): boolean {
  return pack.status === 'In Use' || pack.isCheckedOut === true;
}

export function sortStatpacksByName<T extends { name?: string }>(packs: T[]): T[] {
  return [...packs].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
}
