'use client';
import { canManageLogistics } from '@/app/lib/roles';
import { isEventManagerRole } from '@/app/lib/events';
import { useState } from 'react';
import { usePathname } from 'next/navigation';
import AppSidebar from './app-sidebar';
import MobileBottomNav from './mobile-bottom-nav';
import OnboardingTour from './onboarding-tour';
import { useUserRole } from '@/app/hooks/useUserRole';

const NO_SIDEBAR_PATHS = ['/login', '/register', '/forgot-password'];
// Self-contained mobile flows that ship their own sticky bottom action bar —
// no global bottom nav there (it would overlap / double up).
const NO_BOTTOM_NAV_PATHS = [
  '/statpacks/check-off', '/statpacks/checkout', '/statpacks/checkin',
  '/vehicles/check-off', '/vehicles/checkout', '/vehicles/checkin',
];

export default function SidebarLayout({ children }: { children: React.ReactNode }) {
  const [navHidden, setNavHidden] = useState(false);
  const pathname = usePathname();
  const { role, isRoleOverridden, user, loading } = useUserRole();
  const isAdmin = canManageLogistics(role);

  // No app chrome on auth pages, or for logged-out visitors (once auth has resolved).
  const authPage = NO_SIDEBAR_PATHS.some(p => pathname?.startsWith(p));
  const loggedOut = !loading && !user;
  // Space is reserved while auth resolves (no layout jump); the chrome itself
  // only mounts once there is a signed-in user.
  const showSidebar = !authPage && !loggedOut;
  const showChrome = showSidebar && !!user;
  // On mobile the icon rail is hidden app-wide (app-sidebar) and replaced by the
  // bottom nav bar. Zero the rail's left margin below `md` and pad the bottom so
  // content clears the fixed bar.
  // Members' dashboard is a single self-contained screen with its own actions —
  // the bottom nav has nowhere else useful to send them, so skip it there. Keep it,
  // though, for an admin testing a "member" role override — it's their only mobile
  // way back to admin view (see the exit-test-role control in MobileBottomNav).
  const isMemberDashboard = pathname === '/dashboard' && !!role && !isAdmin && !isEventManagerRole(role) && !isRoleOverridden;
  const showBottomNav = showChrome && !isMemberDashboard && !NO_BOTTOM_NAV_PATHS.some(p => pathname?.startsWith(p));

  return (
    <>
      {showChrome && (
        <AppSidebar
          navHidden={navHidden}
          onHide={() => setNavHidden(true)}
          onShow={() => setNavHidden(false)}
        />
      )}
      <div
        className={`${showSidebar ? 'max-md:!ml-0' : ''} ${showBottomNav ? 'max-md:pb-[72px]' : ''}`}
        style={{
          marginLeft: showSidebar && !navHidden ? 72 : 0,
          transition: 'margin-left 0.22s cubic-bezier(.16,1,.3,1)',
          minHeight: '100vh',
        }}
      >
        {children}
      </div>
      {showBottomNav && <MobileBottomNav />}
      {showChrome && <OnboardingTour />}
    </>
  );
}
