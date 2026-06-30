'use client';
import { useState } from 'react';
import { usePathname } from 'next/navigation';
import AppSidebar from './app-sidebar';

const NO_SIDEBAR_PATHS = ['/login', '/register', '/forgot-password'];

export default function SidebarLayout({ children }: { children: React.ReactNode }) {
  const [navHidden, setNavHidden] = useState(false);
  const pathname = usePathname();

  const showSidebar = !NO_SIDEBAR_PATHS.some(p => pathname?.startsWith(p));

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
        style={{
          marginLeft: showSidebar && !navHidden ? 72 : 0,
          transition: 'margin-left 0.22s cubic-bezier(.16,1,.3,1)',
          minHeight: '100vh',
        }}
      >
        {children}
      </div>
    </>
  );
}
