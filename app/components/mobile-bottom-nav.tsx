'use client';
import React, { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useUserRole } from '@/app/hooks/useUserRole';
import {
  Home, Boxes, Package, CheckSquare, MoreHorizontal,
  User, X, SquareKanban, CalendarDays, Users, History,
} from 'lucide-react';
import { ADMIN_NAV, type LucideIcon } from './app-sidebar';

interface Tab { key: string; label: string; Icon: LucideIcon; path: string; }

const ADMIN_TABS: Tab[] = [
  { key: 'dashboard', label: 'Dashboard', Icon: Home,          path: '/dashboard' },
  { key: 'assets',    label: 'Assets',    Icon: Boxes,         path: '/assets' },
  { key: 'inventory', label: 'Inventory', Icon: Package,       path: '/inventory' },
  { key: 'audit',     label: 'Audit',     Icon: CheckSquare,   path: '/audit' },
];

const MEMBER_TABS: Tab[] = [
  { key: 'dashboard', label: 'Dashboard', Icon: Home,         path: '/dashboard' },
  { key: 'shifts',    label: 'Shifts',    Icon: CalendarDays, path: '/events' },
  { key: 'history',   label: 'History',   Icon: History,      path: '/history' },
];

// MedOps: staffs events + manages members, no logistics surfaces.
const MEDOPS_TABS: Tab[] = [
  { key: 'dashboard', label: 'Dashboard', Icon: Home,         path: '/dashboard' },
  { key: 'shifts',    label: 'Shifts',    Icon: CalendarDays, path: '/events' },
  { key: 'members',   label: 'Members',   Icon: Users,        path: '/roster' },
];

export default function MobileBottomNav() {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const { role, user, userData, isRoleOverridden } = useUserRole();
  const [moreOpen, setMoreOpen] = useState(false);

  const isAdmin = role === 'admin' || role === 'quartermaster';
  const isMedOps = role === 'medops';
  // Real (non-overridden) role — an override can drop `role` to 'member', so this
  // is how an admin testing a member role stays able to exit back to admin view.
  const isRealAdmin = userData?.role === 'admin' || userData?.role === 'quartermaster';
  // Committee members get a Board tab; admins reach the board via the More sheet (ADMIN_NAV)
  const memberTabs = userData?.isCommitteeMember === true
    ? [...MEMBER_TABS, { key: 'committee-board', label: 'Board', Icon: SquareKanban, path: '/committee-board' }]
    : MEMBER_TABS;
  const tabs = isAdmin ? ADMIN_TABS : isMedOps ? MEDOPS_TABS : memberTabs;

  const isActive = (path: string) => pathname === path || pathname.startsWith(path + '/');
  const primaryActive = tabs.some(t => isActive(t.path));

  const go = (path: string) => { setMoreOpen(false); router.push(path); };


  const userInitial = (userData?.fullName?.[0] ?? user?.email?.[0] ?? 'U').toUpperCase();
  const userName = userData?.fullName || user?.email?.split('@')[0] || 'User';

  const tabBtnCls = (active: boolean) =>
    `flex-1 flex flex-col items-center gap-1 py-1 active:scale-90 transition-transform ${
      active ? 'text-primary' : 'text-foreground-400'
    }`;

  return (
    <>
      <nav
        className="sm:hidden fixed left-0 right-0 bottom-0 z-30 bg-background/85 backdrop-blur-md border-t border-divider px-2 pt-2 pb-[max(env(safe-area-inset-bottom),8px)] flex"
        style={{ transform: 'translateZ(0)', willChange: 'transform', WebkitBackfaceVisibility: 'hidden' }}
      >
        {tabs.map(({ key, label, Icon, path }) => {
          const active = isActive(path);
          return (
            <button key={key} data-tour={key === 'members' ? 'roster' : key} onClick={() => go(path)} className={tabBtnCls(active)}>
              <Icon size={22} />
              <span className={`text-[10px] ${active ? 'font-semibold' : 'font-medium'}`}>{label}</span>
            </button>
          );
        })}

        {/* Members: Report shortcut. Admins: More sheet. */}
        {isAdmin ? (
          <button data-tour="more" onClick={() => setMoreOpen(true)} className={tabBtnCls(moreOpen || !primaryActive)}>
            <MoreHorizontal size={22} />
            <span className={`text-[10px] ${moreOpen || !primaryActive ? 'font-semibold' : 'font-medium'}`}>More</span>
          </button>
        ) : (
          <button data-tour="profile" onClick={() => go('/profile')} className={tabBtnCls(isActive('/profile'))}>
            <User size={22} />
            <span className={`text-[10px] ${isActive('/profile') ? 'font-semibold' : 'font-medium'}`}>Profile</span>
          </button>
        )}
      </nav>

      {/* More sheet — full navigation for admins */}
      {moreOpen && (
        <div className="sm:hidden fixed inset-0 z-50 flex flex-col justify-end" onClick={() => setMoreOpen(false)}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <div
            className="relative bg-content1 rounded-t-[22px] flex flex-col overflow-hidden max-h-[85vh]"
            style={{ boxShadow: '0 -12px 40px rgba(0,0,0,.25)' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Sheet header */}
            <div className="flex items-center gap-3 px-5 py-4 border-b border-divider flex-none">
              <div className="w-9 h-9 rounded-full bg-primary text-white font-semibold text-sm flex items-center justify-center flex-none">
                {userInitial}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-bold tracking-tight text-foreground truncate">{userName}</div>
                <div className="text-[11.5px] text-foreground-400 font-medium capitalize">{userData?.role ?? role ?? 'member'}</div>
              </div>
              <button
                onClick={() => setMoreOpen(false)}
                aria-label="Close"
                className="w-9 h-9 rounded-[11px] bg-content2 text-foreground-400 flex items-center justify-center flex-none active:scale-95 transition-transform"
              >
                <X size={17} />
              </button>
            </div>

            {/* Nav sections */}
            <div className="overflow-y-auto px-3 py-3">
              {ADMIN_NAV.map((section, si) => (
                <div key={si} className={si > 0 ? 'mt-3' : ''}>
                  {section.label && (
                    <div className="text-[10px] font-semibold uppercase tracking-widest text-foreground-400 px-2.5 pb-1.5">
                      {section.label}
                    </div>
                  )}
                  {section.items.map(({ key, label, Icon, path }) => {
                    const active = isActive(path);
                    return (
                      <button
                        key={key}
                        onClick={() => go(path)}
                        className={`flex items-center gap-3 w-full text-left h-11 px-2.5 rounded-[11px] text-[13.5px] transition-colors ${
                          active ? 'bg-primary-50 dark:bg-primary-900/20 text-primary font-semibold' : 'text-foreground-500 font-medium active:bg-content2'
                        }`}
                      >
                        <Icon size={19} className="flex-none" />
                        {label}
                      </button>
                    );
                  })}
                </div>
              ))}

              {/* Account controls */}
              <div className="mt-3 pt-2 border-t border-divider">
                <button
                  onClick={() => go('/profile')}
                  className={`flex items-center gap-3 w-full text-left h-11 px-2.5 rounded-[11px] text-[13.5px] transition-colors ${
                    isActive('/profile') ? 'bg-primary-50 dark:bg-primary-900/20 text-primary font-semibold' : 'text-foreground-500 font-medium active:bg-content2'
                  }`}
                >
                  <User size={19} className="flex-none" /> Profile
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
