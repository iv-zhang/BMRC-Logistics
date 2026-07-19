'use client';
import React, { useEffect, useState } from 'react';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';
import { auth, db } from '@/firebase';
import { useUserRole } from '@/app/hooks/useUserRole';
import { useTheme } from 'next-themes';
import {
  Home, Package, RefreshCw,
  BarChart2, Users, AlertTriangle,
  GraduationCap,
  ChevronsLeft, ChevronsRight, ScanBarcode, SlidersHorizontal,
  SquareKanban, Ambulance,
} from 'lucide-react';
import TutorialOverlay from './tutorial-overlay';

export interface AppSidebarProps {
  navHidden: boolean;
  onHide: () => void;
  onShow: () => void;
}

export type LucideIcon = React.ComponentType<{ size?: number; className?: string }>;
export interface NavItem { key: string; label: string; Icon: LucideIcon; path: string; }
export interface NavSection { label?: string; items: NavItem[]; }

/** Shared by ADMIN_NAV and (for flagged members) MEMBER_NAV + the mobile bottom nav. */
export const COMMITTEE_NAV_SECTION: NavSection = {
  label: 'Committee',
  items: [
    { key: 'committee-board', label: 'Committee & Tasks', Icon: SquareKanban, path: '/committee-board' },
  ],
};

export const ADMIN_NAV: NavSection[] = [
  {
    items: [
      { key: 'dashboard', label: 'Dashboard', Icon: Home, path: '/dashboard' },
    ],
  },
  {
    label: 'Assets',
    items: [
      { key: 'assets',   label: 'Assets & Statpacks', Icon: Package,   path: '/assets' },
      { key: 'vehicles', label: 'Vehicles',           Icon: Ambulance, path: '/vehicles' },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { key: 'inventory',     label: 'Inventory',        Icon: Package,     path: '/inventory' },
      { key: 'audit',         label: 'Supply Audit',     Icon: ScanBarcode, path: '/audit' },
      { key: 'restock',       label: 'Restock',          Icon: RefreshCw,   path: '/restock' },
      { key: 'stats',         label: 'Stats',            Icon: BarChart2,   path: '/stats' },
    ],
  },
  COMMITTEE_NAV_SECTION,
  {
    label: 'Admin',
    items: [
      { key: 'roster',         label: 'Roster',         Icon: Users,             path: '/roster' },
      { key: 'reports',        label: 'Reports',        Icon: AlertTriangle,     path: '/issue-reports' },
      { key: 'settings',       label: 'Settings',       Icon: SlidersHorizontal, path: '/settings' },
    ],
  },
];

export const MEMBER_NAV: NavSection[] = [
  {
    items: [
      { key: 'dashboard', label: 'Dashboard', Icon: Home, path: '/dashboard' },
    ],
  },
];

export default function AppSidebar({ navHidden, onHide, onShow }: AppSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, userData, role } = useUserRole();
  const { theme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [navHover, setNavHover] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);
  const [roleOverrideActive, setRoleOverrideActive] = useState<string | null>(null);

  useEffect(() => setMounted(true), []);

  const isAdmin = role === 'admin' || role === 'quartermaster';
  // Real (non-overridden) role — an override can drop `role` to 'member', so use
  // this to keep the test-role control reachable while an override is active.
  const isRealAdmin = userData?.role === 'admin' || userData?.role === 'quartermaster';
  const isDark = mounted && theme === 'dark';
  const expanded = navHover && !navHidden;

  // Firestore user sync
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (currentUser) => {
      if (!currentUser) return;
      const userRef = doc(db, 'users', currentUser.uid);
      const snap = await getDoc(userRef);
      if (!snap.exists()) {
        await setDoc(userRef, {
          id: currentUser.uid,
          email: currentUser.email,
          fullName: currentUser.displayName || 'Unknown Member',
          role: 'member',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    });
    return () => unsub();
  }, []);

  // Role override state sync
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setRoleOverrideActive(localStorage.getItem('bmrc_role_override'));
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'bmrc_role_override') setRoleOverrideActive(e.newValue);
    };
    const onCustom = () => setRoleOverrideActive(localStorage.getItem('bmrc_role_override'));
    window.addEventListener('storage', onStorage);
    window.addEventListener('bmrc-role-changed', onCustom as EventListener);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('bmrc-role-changed', onCustom as EventListener);
    };
  }, []);

  // Show tutorial when admin activates test role
  useEffect(() => {
    if (role === 'admin' && roleOverrideActive) {
      try { sessionStorage.removeItem('bmrc_tutorial_shown'); } catch {}
      setShowTutorial(true);
    }
  }, [roleOverrideActive, role]);

  // First-login tutorial check
  useEffect(() => {
    try {
      const shown = typeof window !== 'undefined' ? sessionStorage.getItem('bmrc_tutorial_shown') : null;
      if (userData && !userData.tutorialCompleted && !shown) {
        setShowTutorial(true);
        if (typeof window !== 'undefined') sessionStorage.setItem('bmrc_tutorial_shown', '1');
      }
    } catch {
      if (userData && !userData.tutorialCompleted) setShowTutorial(true);
    }
  }, [userData]);

  const isItemActive = (path: string) =>
    pathname === path || pathname.startsWith(path + '/');

  // On mobile the icon rail is replaced app-wide by the bottom nav bar
  // (see mobile-bottom-nav.tsx), so hide the rail below `md` on every route.
  const railHideCls = 'max-md:hidden';

  // Committee members (flag on the users doc) get the board section without being admins
  const isCommitteeMember = userData?.isCommitteeMember === true;
  const navSections = isAdmin
    ? ADMIN_NAV
    : isCommitteeMember
      ? [...MEMBER_NAV, COMMITTEE_NAV_SECTION]
      : MEMBER_NAV;
  const userInitial = (userData?.fullName?.[0] ?? user?.email?.[0] ?? 'U').toUpperCase();
  const userName = userData?.fullName || user?.email?.split('@')[0] || 'User';

  const navItemCls = (active: boolean) =>
    `flex items-center gap-[13px] h-10 px-[11px] rounded-[10px] whitespace-nowrap text-[13.5px] w-full text-left transition-colors duration-150 ${
      active
        ? 'bg-primary-50 dark:bg-primary-900/20 text-primary font-semibold'
        : 'text-foreground-500 font-medium hover:bg-content2'
    }`;

  const labelCls = `transition-opacity duration-150 ${expanded ? 'opacity-100' : 'opacity-0'}`;

  const tutorialNode = showTutorial && user ? (
    <TutorialOverlay userId={user.uid} onComplete={() => setShowTutorial(false)} />
  ) : null;

  if (navHidden) {
    return (
      <>
        <button
          onClick={onShow}
          title="Show sidebar"
          className={`fixed bottom-[18px] left-0 z-40 bg-content1 border border-l-0 border-divider text-foreground-400 hover:text-primary w-[30px] h-11 rounded-r-[12px] flex items-center justify-center transition-colors duration-150 ${railHideCls}`}
          style={{ boxShadow: '2px 2px 10px rgba(0,0,0,.08)' }}
        >
          <ChevronsRight size={18} />
        </button>
        {tutorialNode}
      </>
    );
  }

  return (
    <>
      <aside
        onMouseEnter={() => setNavHover(true)}
        onMouseLeave={() => setNavHover(false)}
        className={`fixed top-0 left-0 bottom-0 z-40 bg-content1 border-r border-divider overflow-hidden ${railHideCls}`}
        style={{
          width: expanded ? 248 : 72,
          transition: 'width 0.22s cubic-bezier(.16,1,.3,1), box-shadow 0.22s',
          boxShadow: expanded ? '6px 0 30px rgba(0,0,0,.1)' : 'none',
        }}
      >
        {/* Inner panel is always 248px wide; outer clips it */}
        <div className="w-[248px] h-full flex flex-col">

          {/* Brand */}
          <div className="px-[17px] pt-3.5 pb-2 flex items-center gap-[11px] h-[62px]">
            <button
              onClick={() => router.push('/dashboard')}
              className="flex-none focus:outline-none"
            >
              <div className="relative w-[34px] h-[34px]">
                <Image
                  src={isDark
                    ? '/images/NoBackground_NewLogoWhite.PNG'
                    : '/images/NoBackground_NewLogoBlack.PNG'}
                  alt="BMRC logo"
                  fill
                  className="object-contain"
                  priority
                />
              </div>
            </button>
            <div className={`flex flex-col leading-none whitespace-nowrap ${labelCls}`}>
              <span className="font-bold text-sm text-foreground tracking-tight">BMRC Logistics</span>
              <span className="text-[10px] text-foreground-400 font-medium tracking-wide">
                Berkeley Medical Reserve Corps
              </span>
            </div>
          </div>

          {/* Nav sections */}
          <nav className="flex-1 px-3 py-1 flex flex-col gap-[3px] overflow-y-auto">
            {navSections.map((section, si) => (
              <React.Fragment key={si}>
                {section.label && (
                  <div className={`text-[10px] font-semibold uppercase tracking-widest text-foreground-400 px-2.5 py-2 whitespace-nowrap ${labelCls} ${si > 0 ? 'mt-2' : ''}`}>
                    {section.label}
                  </div>
                )}
                {section.items.map(({ key, label, Icon, path }) => (
                  <button
                    key={key}
                    onClick={() => router.push(path)}
                    className={navItemCls(isItemActive(path))}
                  >
                    <Icon size={19} className="flex-none" />
                    <span className={labelCls}>{label}</span>
                  </button>
                ))}
              </React.Fragment>
            ))}
          </nav>

          {/* Bottom controls */}
          <div className="px-3 pb-3.5 pt-2 border-t border-divider flex flex-col gap-[2px]">

            {/* Tutorial */}
            <button
              onClick={() => setShowTutorial(true)}
              className="flex items-center gap-[13px] h-9 px-[11px] rounded-[10px] whitespace-nowrap text-[13px] w-full text-left text-foreground-500 font-medium hover:bg-content2 transition-colors duration-150"
            >
              <GraduationCap size={19} className="flex-none" />
              <span className={labelCls}>Tutorial</span>
            </button>

            <div className="border-t border-divider my-1" />

            {/* User row — this IS the profile link (no separate Profile button). */}
            <button
              onClick={() => router.push('/profile')}
              title="Profile"
              className={`flex items-center gap-[11px] h-10 px-[11px] rounded-[10px] whitespace-nowrap w-full text-left transition-colors duration-150 ${
                isItemActive('/profile') ? 'bg-primary-50 dark:bg-primary-900/20' : 'hover:bg-content2'
              }`}
            >
              <div className="w-7 h-7 rounded-full bg-primary text-white font-semibold text-xs flex items-center justify-center flex-none">
                {userInitial}
              </div>
              <div className={`flex flex-col leading-tight min-w-0 ${labelCls}`}>
                <span className={`text-[12.5px] font-semibold truncate ${isItemActive('/profile') ? 'text-primary' : 'text-foreground'}`}>{userName}</span>
                <span className="text-[10.5px] text-foreground-400 font-medium capitalize">
                  {userData?.role ?? role ?? 'member'}
                </span>
              </div>
            </button>

            {/* Collapse */}
            <button
              onClick={onHide}
              className="flex items-center gap-[13px] h-[38px] px-[11px] rounded-[10px] whitespace-nowrap text-foreground-400 hover:bg-content2 hover:text-foreground transition-colors duration-150 w-full text-left"
            >
              <ChevronsLeft size={19} className="flex-none" />
              <span className={`text-[12.5px] font-semibold ${labelCls}`}>Collapse sidebar</span>
            </button>
          </div>
        </div>
      </aside>

      {tutorialNode}
    </>
  );
}
