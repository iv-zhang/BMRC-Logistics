'use client';
import { useState } from 'react';
import { usePathname } from 'next/navigation';
import AppSidebar from './app-sidebar';
import MobileBottomNav from './mobile-bottom-nav';

const NO_SIDEBAR_PATHS = ['/login', '/register', '/forgot-password'];
// Self-contained mobile flows that ship their own sticky bottom action bar —
// no global bottom nav there (it would overlap / double up).
const NO_BOTTOM_NAV_PATHS = ['/statpacks/check-off', '/statpacks/checkout', '/statpacks/checkin'];

export default function SidebarLayout({ children }: { children: React.ReactNode }) {
  const [navHidden, setNavHidden] = useState(false);
  const pathname = usePathname();

  const showSidebar = !NO_SIDEBAR_PATHS.some(p => pathname?.startsWith(p));
  // On mobile the icon rail is hidden app-wide (app-sidebar) and replaced by the
  // bottom nav bar. Zero the rail's left margin below `md` and pad the bottom so
  // content clears the fixed bar.
  const showBottomNav = showSidebar && !NO_BOTTOM_NAV_PATHS.some(p => pathname?.startsWith(p));

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
    </>
  );
}
