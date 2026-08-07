/**
 * Role-aware onboarding tour content. Each role gets its own ordered list of
 * steps. A step either highlights a real on-screen element (`target`, matched
 * by a `data-tour="<key>"` attribute) or, when it has no target, renders as a
 * centered welcome/finish card.
 *
 * **Desktop and mobile get separate tours** (`TOURS.desktop` / `TOURS.mobile`),
 * because the two viewports genuinely expose different navigation:
 *   - Below `sm` the icon rail is hidden app-wide and replaced by the bottom nav
 *     bar — and on the *member* dashboard even that bar is hidden (see
 *     `sidebar-layout.tsx`), so a phone tour there may only point at on-page cards.
 *   - The member/FTO/MedOps sidebar only ever contains Dashboard + the profile
 *     row, so their desktop tours point at dashboard cards too, not rail items
 *     that don't exist for them.
 * Listing a step whose target is never present is not "safe" — it makes the tour
 * skip several steps at once, which is what the old shared list did. Only list a
 * target you know renders for that role on that viewport.
 *
 * The tour controller lives in `app/components/onboarding-tour.tsx`.
 */

export type TourRole = 'member' | 'FTO' | 'medops' | 'admin';
export type TourVariant = 'desktop' | 'mobile';

export interface TourStep {
  /** `data-tour` key of the element to spotlight. Omit for a centered card. */
  target?: string;
  title: string;
  body: string;
  /** Where the callout sits relative to the target. Default 'auto'. */
  placement?: 'auto' | 'top' | 'bottom' | 'left' | 'right';
  /**
   * `next` — advance via the callout's Next button.
   * `click-target` — advance when the user actually clicks the highlighted
   *   element (which usually navigates). Falls back to a Next button if the
   *   target can't be found.
   */
  advance: 'next' | 'click-target';
}

/** Map a raw user role to the tour variant it should receive. */
export function tourRoleFor(role: string | null | undefined): TourRole {
  if (role === 'admin' || role === 'quartermaster') return 'admin';
  if (role === 'medops') return 'medops';
  // fto_intern is the training tier below FTO — interns shadow a real FTO and
  // don't yet run FTO surfaces (staffing/check-in), so they get the member tour.
  if (role === 'fto_intern') return 'member';
  if (role === 'FTO') return 'FTO';
  return 'member';
}

const WELCOME: TourStep = {
  title: 'Welcome to BMRC Logistics!',
  body: "Here's a quick, hands-on tour of the areas you'll use most. Follow the highlights — you can skip anytime, and replay it later from your Profile.",
  advance: 'next',
};

const finishStep = (body: string): TourStep => ({
  title: "You're all set!",
  body,
  advance: 'next',
});

const FINISH_DESKTOP = finishStep(
  'That covers the essentials. Explore at your own pace, and reach out to an admin or MedOps if you get stuck.',
);

const FINISH_MOBILE = finishStep(
  'That covers the essentials. Tap through at your own pace — and reach out to an admin or MedOps if you get stuck.',
);

// ── Shared steps ─────────────────────────────────────────────────────────────
// Same copy on both viewports; only the surrounding order differs.

const CHECKOUT_STEP: TourStep = {
  target: 'checkout',
  title: 'Check out a statpack',
  body: 'Before a shift, check out your pack and verify each pocket. The app walks you through the counts.',
  advance: 'next',
};

const CHECKIN_STEP: TourStep = {
  target: 'checkin',
  title: 'Check in after your shift',
  body: 'When you return, check the pack back in. This logs what was used so the team can restock.',
  advance: 'next',
};

const SHIFTS_CARD_STEP: TourStep = {
  target: 'shifts',
  title: 'Sign up for shifts',
  body: 'Browse upcoming events and request a team slot here. You need current EMT + CPR certs to sign up.',
  advance: 'next',
};

const HISTORY_CARD_STEP: TourStep = {
  target: 'history',
  title: 'Your history',
  body: 'Your past checkouts and shift record live here — handy for tracking your volunteer hours.',
  advance: 'next',
};

const PROFILE_RAIL_STEP: TourStep = {
  target: 'profile',
  title: 'Your profile',
  body: 'Certifications, volunteer record, preferences, and light/dark mode. You can sign out and replay this tour from here too.',
  advance: 'next',
};

// ── Desktop tours (icon rail on the left) ────────────────────────────────────

const MEMBER_DESKTOP: TourStep[] = [
  WELCOME,
  {
    target: 'dashboard',
    title: 'Your Dashboard',
    body: 'This is your home base — alerts, quick actions, and your assigned statpacks all live here.',
    advance: 'next',
  },
  CHECKOUT_STEP,
  CHECKIN_STEP,
  SHIFTS_CARD_STEP,
  HISTORY_CARD_STEP,
  PROFILE_RAIL_STEP,
  FINISH_DESKTOP,
];

const FTO_DESKTOP: TourStep[] = [
  WELCOME,
  {
    target: 'dashboard',
    title: 'Your Dashboard',
    body: 'Your home base — alerts, quick actions, and your assigned gear.',
    advance: 'next',
  },
  {
    target: 'shifts',
    title: 'Run your team',
    body: 'As an FTO you staff and check in your team on the Shifts board. Attendance and lateness are tracked from your check-ins.',
    advance: 'next',
  },
  {
    target: 'checkout',
    title: 'Statpack checkout',
    body: 'Check out your team pack and verify each pocket before heading out.',
    advance: 'next',
  },
  {
    target: 'checkin',
    title: 'Check-in ends the shift',
    body: 'Checking the pack back in logs usage and closes out the shift hours for your team.',
    advance: 'next',
  },
  PROFILE_RAIL_STEP,
  FINISH_DESKTOP,
];

const MEDOPS_DESKTOP: TourStep[] = [
  WELCOME,
  {
    target: 'dashboard',
    title: 'Your Dashboard',
    body: 'Your starting point for staffing events and managing the roster.',
    advance: 'next',
  },
  {
    target: 'shifts',
    title: 'Staff events',
    body: 'As MedOps you build events, staff teams, and manage sign-ups on the Shifts board.',
    advance: 'next',
  },
  {
    target: 'roster',
    title: 'Manage the roster',
    body: 'View members, edit their status and certifications, and check each person’s activity and volunteer record.',
    advance: 'next',
  },
  PROFILE_RAIL_STEP,
  FINISH_DESKTOP,
];

const ADMIN_DESKTOP: TourStep[] = [
  WELCOME,
  {
    target: 'dashboard',
    title: 'Admin Dashboard',
    body: 'The operational overview — alerts, activity, and quick links all live here.',
    advance: 'next',
  },
  {
    target: 'inventory',
    title: 'Inventory',
    body: 'The single source of truth for every item — stock levels, locations, batches, and expirations.',
    advance: 'next',
  },
  {
    target: 'audit',
    title: 'Supply Audit',
    body: 'Count, move, receive shipments, and report issues on whatever is physically in front of you — in any order.',
    advance: 'next',
  },
  {
    target: 'restock',
    title: 'Restock',
    body: 'Manage the front shelves and the weekly re-count that keeps deployed stock honest.',
    advance: 'next',
  },
  {
    target: 'stats',
    title: 'Stats',
    body: 'Usage over time, checkout trends, restock turnaround, and how long items stay missing.',
    advance: 'next',
  },
  {
    target: 'assets',
    title: 'Assets & Statpacks',
    body: 'Manage serialized assets and the statpacks members check out.',
    advance: 'next',
  },
  {
    target: 'roster',
    title: 'Roster',
    body: 'Members, roles, certifications, and per-member activity all live here.',
    advance: 'next',
  },
  {
    target: 'settings',
    title: 'Settings',
    body: 'Almost everything is configurable without a deploy — locations, categories, thresholds, events, and branding.',
    advance: 'next',
  },
  FINISH_DESKTOP,
];

// ── Mobile tours ─────────────────────────────────────────────────────────────
// Members/FTO/MedOps land on the member dashboard, where the bottom nav bar is
// deliberately hidden — so their phone tours point only at cards on that page.
// Admins keep the bottom bar, so theirs points at the bar.

const MEMBER_MOBILE: TourStep[] = [
  WELCOME,
  CHECKOUT_STEP,
  CHECKIN_STEP,
  SHIFTS_CARD_STEP,
  HISTORY_CARD_STEP,
  FINISH_MOBILE,
];

const FTO_MOBILE: TourStep[] = [
  WELCOME,
  {
    target: 'shifts',
    title: 'Run your team',
    body: 'As an FTO you staff and check in your team from the Shifts board. Attendance and lateness come from your check-ins.',
    advance: 'next',
  },
  CHECKOUT_STEP,
  {
    target: 'checkin',
    title: 'Check-in ends the shift',
    body: 'Checking the pack back in logs usage and closes out the shift hours for your team.',
    advance: 'next',
  },
  HISTORY_CARD_STEP,
  FINISH_MOBILE,
];

const MEDOPS_MOBILE: TourStep[] = [
  WELCOME,
  {
    target: 'shifts',
    title: 'Staff events',
    body: 'Build events, staff teams, and manage sign-ups from the Shifts board.',
    advance: 'next',
  },
  {
    target: 'roster',
    title: 'Manage the roster',
    body: 'View members, edit their status and certifications, and check each person’s activity and volunteer record.',
    advance: 'next',
  },
  FINISH_MOBILE,
];

const ADMIN_MOBILE: TourStep[] = [
  WELCOME,
  {
    target: 'dashboard',
    title: 'Your Dashboard',
    body: 'The operational overview — alerts, activity, and quick links. The bar at the bottom is how you move around on a phone.',
    advance: 'next',
  },
  {
    target: 'inventory',
    title: 'Inventory',
    body: 'The single source of truth for every item — stock levels, locations, batches, and expirations.',
    advance: 'next',
  },
  {
    target: 'audit',
    title: 'Supply Audit',
    body: 'Count, move, receive shipments, and report issues on whatever is physically in front of you — in any order.',
    advance: 'next',
  },
  {
    target: 'assets',
    title: 'Assets & Statpacks',
    body: 'Manage serialized assets and the statpacks members check out.',
    advance: 'next',
  },
  {
    target: 'more',
    title: 'Everything else',
    body: 'Restock, Stats, Shifts, Roster, Reports, and Settings all live behind More.',
    advance: 'next',
  },
  FINISH_MOBILE,
];

export const TOURS: Record<TourVariant, Record<TourRole, TourStep[]>> = {
  desktop: {
    member: MEMBER_DESKTOP,
    FTO: FTO_DESKTOP,
    medops: MEDOPS_DESKTOP,
    admin: ADMIN_DESKTOP,
  },
  mobile: {
    member: MEMBER_MOBILE,
    FTO: FTO_MOBILE,
    medops: MEDOPS_MOBILE,
    admin: ADMIN_MOBILE,
  },
};

/** The ordered steps for a role on a given viewport. */
export function getTourSteps(role: string | null | undefined, variant: TourVariant): TourStep[] {
  return TOURS[variant][tourRoleFor(role)];
}
