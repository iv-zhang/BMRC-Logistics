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
