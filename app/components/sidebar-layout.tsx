'use client';
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
  const { role, isRoleOverridden } = useUserRole();
  const isAdmin = role === 'admin' || role === 'quartermaster';

  const showSidebar = !NO_SIDEBAR_PATHS.some(p => pathname?.startsWith(p));
  // On mobile the icon rail is hidden app-wide (app-sidebar) and replaced by the
  // bottom nav bar. Zero the rail's left margin below `md` and pad the bottom so
  // content clears the fixed bar.
  // Members' dashboard is a single self-contained screen with its own actions —
  // the bottom nav has nowhere else useful to send them, so skip it there. Keep it,
  // though, for an admin testing a "member" role override — it's their only mobile
  // way back to admin view (see the exit-test-role control in MobileBottomNav).
  const isMemberDashboard = pathname === '/dashboard' && !!role && !isAdmin && !isRoleOverridden;
  const showBottomNav = showSidebar && !isMemberDashboard && !NO_BOTTOM_NAV_PATHS.some(p => pathname?.startsWith(p));

  return (
    <>
      {showSidebar && (
        <AppSidebar
          navHidden={navHidden}
          onHide={() => setNavHidden(true)}
          onShow={() => setNavHidden(false)}
        />
      )}
      <div
        className={`${showSidebar ? 'max-sm:!ml-0' : ''} ${showBottomNav ? 'max-sm:pb-[72px]' : ''}`}
        style={{
          marginLeft: showSidebar && !navHidden ? 72 : 0,
          transition: 'margin-left 0.22s cubic-bezier(.16,1,.3,1)',
          minHeight: '100vh',
        }}
      >
        {children}
      </div>
      {showBottomNav && <MobileBottomNav />}
      {showSidebar && <OnboardingTour />}
    </>
  );
}
