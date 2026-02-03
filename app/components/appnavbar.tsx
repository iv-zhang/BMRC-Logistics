'use client';

import React, { useEffect, useState } from 'react';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { 
  Navbar, 
  NavbarBrand, 
  NavbarContent, 
  NavbarItem, 
  NavbarMenu,
  NavbarMenuItem,
  Link, 
  Dropdown, 
  DropdownTrigger, 
  DropdownMenu, 
  DropdownItem,
  Tooltip,
  Button
} from '@heroui/react';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'; 
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { auth, db } from '@/firebase';
import { useUserRole } from '@/app/hooks/useUserRole';

// Icons
import { 
  HomeIcon, 
  CubeIcon, 
  UsersIcon, 
  ChartBarIcon, 
  DevicePhoneMobileIcon, 
  UserIcon as HeroUserIcon, 
  ArrowRightOnRectangleIcon,
  ExclamationTriangleIcon
} from '@heroicons/react/24/outline';
import { ClipboardCheck } from 'lucide-react';
import IssueReportForm from './IssueReportForm';

export default function AppNavbar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, role } = useUserRole();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isReportOpen, setIsReportOpen] = useState(false);

  // Check if user is admin or quartermaster
  const isAdmin = role === 'admin' || role === 'quartermaster';
  const canAudit = role === 'admin' || role === 'quartermaster' || role === 'inventory_helper' || role === 'FTO';

  // Sync user to Firestore on sign-in
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (currentUser) {
        const userRef = doc(db, 'users', currentUser.uid);
        const userSnap = await getDoc(userRef);
        if (!userSnap.exists()) {
          await setDoc(userRef, {
            id: currentUser.uid,
            email: currentUser.email,
            fullName: currentUser.displayName || 'Unknown Member',
            role: 'member',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          console.log("User synced to Firestore");
        }
      }
    });
    return () => unsubscribe();
  }, []);

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      router.push('/');
    } catch (error) {
      console.error('Sign out error:', error);
    }
  };

  const handleProfile = () => {
    router.push('/profile');
  };

  // Local role override state for testing (keeps UI in sync)
  const [roleOverrideActive, setRoleOverrideActive] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('bmrc_role_override');
    }
    return null;
  });

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'bmrc_role_override') setRoleOverrideActive(e.newValue);
    };

    const onCustom = () => {
      const stored = localStorage.getItem('bmrc_role_override');
      setRoleOverrideActive(stored);
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('storage', onStorage);
      window.addEventListener('bmrc-role-changed', onCustom as EventListener);
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('storage', onStorage);
        window.removeEventListener('bmrc-role-changed', onCustom as EventListener);
      }
    };
  }, []);

  const isActive = (path: string) => pathname === path;

  return (
    <Navbar 
      maxWidth="xl" 
      className="py-1 px-[5px] bg-white/70 dark:bg-slate-900/70 backdrop-blur-md border-b border-gray-200 dark:border-slate-800 [&_ul]:list-none [&_li]:list-none"
      onMenuOpenChange={setIsMenuOpen}
      isMenuOpen={isMenuOpen}
    >
      {/* Added ml-[10px] to shift the Logo and Links towards the middle */}
      <NavbarBrand className="gap-4 ml-[10px]">
        <div className="flex items-center gap-0">
          <Link href="/dashboard" className="block">
            <div className="relative w-[79px] h-[79px]">
              <Image
                src="/images/NoBackground_NewLogoWhite.PNG"
                alt="BMRC logo"
                fill
                className="object-contain"
                priority
              />
            </div>
          </Link>
        </div>
        
        {/* Desktop Links */}
        <div className="hidden sm:flex gap-4 ml-0">
          <NavbarItem isActive={isActive('/dashboard')}>
            <Tooltip content="View main dashboard">
              <Link 
                href="/dashboard" 
                color={isActive('/dashboard') ? "primary" : "foreground"}
                className={isActive('/dashboard') ? "font-semibold" : "text-gray-500 dark:text-gray-400"}
              >
                <HomeIcon className="w-5 h-5 mr-1" />
                Dashboard
              </Link>
            </Tooltip>
          </NavbarItem>

          {/* Chronological Log - Admin Only (standalone tab) */}
          {isAdmin && (
            <NavbarItem isActive={isActive('/audit/events')}>
              <Tooltip content="Chronological Log">
                <Link 
                  href="/audit/events" 
                  color={isActive('/audit/events') ? 'primary' : 'foreground'}
                  className={isActive('/audit/events') ? 'font-semibold' : 'text-gray-500 dark:text-gray-400'}
                >
                  <ClipboardCheck className="w-5 h-5 mr-1 inline-block" />
                  Chronological Log
                </Link>
              </Tooltip>
            </NavbarItem>
          )}

          <Dropdown>
            <NavbarItem>
              <DropdownTrigger>
                <button className={`flex items-center ${isActive('/assets') || pathname.startsWith('/statpacks') ? 'font-semibold text-primary' : 'text-gray-500 dark:text-gray-400'}`}>
                  <CubeIcon className="w-5 h-5 mr-1" />
                  Assets
                </button>
              </DropdownTrigger>
            </NavbarItem>
            <DropdownMenu aria-label="Assets menu">
              <DropdownItem key="assets" onClick={() => router.push('/assets')}>
                Manage Assets
              </DropdownItem>
              <DropdownItem key="statpacks" onClick={() => router.push('/statpacks')}>
                Statpacks
              </DropdownItem>
            </DropdownMenu>
          </Dropdown>

          {/* Inventory Dropdown - Admin Only */}
          {isAdmin && (
            <Dropdown>
              <NavbarItem>
                <DropdownTrigger>
                  <button className={`flex items-center ${isActive('/inventory') || isActive('/restock') || isActive('/restock-stats') || isActive('/audit/events') ? 'font-semibold text-primary' : 'text-gray-500 dark:text-gray-400'}`}>
                    <CubeIcon className="w-5 h-5 mr-1" />
                    Inventory
                  </button>
                </DropdownTrigger>
              </NavbarItem>
              <DropdownMenu aria-label="Inventory menu">
                <DropdownItem key="inventory" onClick={() => router.push('/inventory')}>
                  View Inventory
                </DropdownItem>
                <DropdownItem key="restock" onClick={() => router.push('/restock')}>
                  Restock Items
                </DropdownItem>
                <DropdownItem key="restock-stats" onClick={() => router.push('/restock-stats')}>
                  Restock Stats
                </DropdownItem>
                <DropdownItem key="logs" onClick={() => router.push('/audit/events')}>
                  Chronological Log
                </DropdownItem>
                <DropdownItem key="storage" onClick={() => router.push('/storage')}>
                  Storage Management
                </DropdownItem>
              </DropdownMenu>
            </Dropdown>
          )}

          {/* Roster - Admin Only */}
          {isAdmin && (
            <NavbarItem isActive={isActive('/roster')}>
              <Tooltip content="View team roster">
                <Link 
                  href="/roster" 
                  color={isActive('/roster') ? "primary" : "foreground"}
                  className={isActive('/roster') ? "font-semibold" : "text-gray-500 dark:text-gray-400"}
                >
                  <UsersIcon className="w-5 h-5 mr-1" />
                  Roster
                </Link>
              </Tooltip>
            </NavbarItem>
          )}

          {/* Reports - Admin Only */}
          {isAdmin && (
            <NavbarItem isActive={isActive('/issue-reports') || isActive('/reports')}>
              <Tooltip content="View reports">
                <Link 
                  href="/issue-reports" 
                  color={isActive('/issue-reports') || isActive('/reports') ? "primary" : "foreground"}
                  className={isActive('/issue-reports') || isActive('/reports') ? "font-semibold" : "text-gray-500 dark:text-gray-400"}
                >
                  <ExclamationTriangleIcon className="w-5 h-5 mr-1" />
                  Reports
                </Link>
              </Tooltip>
            </NavbarItem>
          )}
        </div>

      </NavbarBrand>

      <NavbarContent justify="end" className="gap-3">
        <NavbarItem>
          <Dropdown 
            placement="bottom-end" 
            offset={10}
            className="dark:bg-slate-800"
          >
            <DropdownTrigger>
              <button className="flex items-center justify-center w-10 h-10 bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-700 dark:hover:bg-indigo-600 text-white rounded-full transition-colors cursor-pointer font-semibold text-lg border-2 border-indigo-500 dark:border-indigo-600 outline-none">
                {(user?.displayName || user?.email)?.[0]?.toUpperCase() || 'U'}
              </button>
            </DropdownTrigger>
            
            <DropdownMenu 
              aria-label="User menu" 
              className="w-[198px] gap-1 p-2 dark:bg-slate-700 border-2 border-indigo-600 dark:border-indigo-500 rounded-2xl"
            >
              <DropdownItem 
                key="profile" 
                onClick={handleProfile}
                startContent={<HeroUserIcon className="w-4 h-4" />}
                className="p-2.5 text-sm font-medium text-left hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
              >
                Profile
              </DropdownItem>
              {isAdmin ? (
                <DropdownItem 
                  key="reports" 
                  onClick={() => router.push('/reports')}
                  startContent={<ChartBarIcon className="w-4 h-4" />}
                  className="p-2.5 text-sm font-medium text-left hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                >
                  Reports
                </DropdownItem>
              ) : null}

              {/* Role override toggle for testing admin vs member views */}
              <DropdownItem
                key="role-override"
                onClick={() => {
                  try {
                    const current = localStorage.getItem('bmrc_role_override');
                    if (current) {
                      localStorage.removeItem('bmrc_role_override');
                    } else {
                      // toggle to the opposite of the current effective role
                      const target = (role === 'admin' || role === 'quartermaster') ? 'member' : 'admin';
                      localStorage.setItem('bmrc_role_override', target);
                    }
                    // notify listeners
                    window.dispatchEvent(new Event('bmrc-role-changed'));
                  } catch (e) {
                    console.error('role override failed', e);
                  }
                }}
                startContent={<DevicePhoneMobileIcon className="w-4 h-4" />}
                className="p-2.5 text-sm font-medium text-left hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
              >
                {roleOverrideActive ? `Clear Test Role (${roleOverrideActive})` : `Toggle Test Role`}
              </DropdownItem>
              <DropdownItem 
                key="logout" 
                onClick={handleSignOut}
                startContent={<ArrowRightOnRectangleIcon className="w-4 h-4" />}
                className="p-2.5 text-sm font-medium text-left text-danger hover:bg-black/5 dark:hover:bg-white/10 transition-colors" 
                color="danger"
              >
                Log Out
              </DropdownItem>
            </DropdownMenu>
          </Dropdown>
        </NavbarItem>
      </NavbarContent>

      {/* Mobile Menu */}
      <NavbarMenu className="pt-6">
        <NavbarMenuItem isActive={isActive('/dashboard')}>
          <Link href="/dashboard" className="w-full">Dashboard</Link>
        </NavbarMenuItem>
        <NavbarMenuItem isActive={isActive('/assets')}>
          <Link href="/assets" className="w-full">Assets</Link>
        </NavbarMenuItem>
        {isAdmin && (
          <NavbarMenuItem>
            <span className="font-semibold">Inventory</span>
            <div className="ml-4 space-y-1">
              <Link href="/inventory" className="block">View Inventory</Link>
              <Link href="/restock" className="block">Restock Items</Link>
              <Link href="/restock-stats" className="block">Restock Stats</Link>
              <Link href="/audit/events" className="block">Chronological Log</Link>
              <Link href="/storage" className="block">Storage Management</Link>
            </div>
          </NavbarMenuItem>
        )}
        {isAdmin && (
          <NavbarMenuItem isActive={isActive('/roster')}>
            <Link href="/roster" className="w-full">Roster</Link>
          </NavbarMenuItem>
        )}

        {isAdmin && (
          <NavbarMenuItem isActive={isActive('/reports')}>
            <Link href="/reports" className="w-full">Reports</Link>
          </NavbarMenuItem>
        )}
      </NavbarMenu>

      {/* Report Issue Modal */}
      <IssueReportForm
        isOpen={isReportOpen}
        onOpenChange={setIsReportOpen}
        pagePath={pathname}
      />
    </Navbar>
  );
}
