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
  NavbarMenuToggle,
  Link, 
  Dropdown, 
  DropdownTrigger, 
  DropdownMenu, 
  DropdownItem,
  Tooltip,
  Button,
  Divider,
} from '@heroui/react';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'; 
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { auth, db } from '@/firebase';
import { useUserRole } from '@/app/hooks/useUserRole';

// Use lucide-react icons consistently throughout the app
import {
  Home,
  Box,
  Users,
  BarChart3,
  User,
  LogOut,
  AlertTriangle,
  ShieldCheck,
  Package,
  BarChart2,
  Warehouse,
  ScanBarcode,
  RefreshCw,
  CheckSquare,
  GraduationCap,
  ShieldAlert,
  Sun,
  Moon,
} from 'lucide-react';

import { useTheme } from 'next-themes';

import IssueReportForm from './IssueReportForm';
import TutorialOverlay from './tutorial-overlay';

export default function AppNavbar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, role, loading: roleLoading } = useUserRole();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isReportOpen, setIsReportOpen] = useState(false);
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const isAdmin = role === 'admin' || role === 'quartermaster';
  const [showTutorial, setShowTutorial] = useState(false);

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

  // When admin enables role override (test role), treat them as new user and show tutorial
  useEffect(() => {
    if (role === 'admin' && roleOverrideActive) {
      try { if (typeof window !== 'undefined') sessionStorage.removeItem('bmrc_tutorial_shown'); } catch (e) {}
      setShowTutorial(true);
    }
  }, [roleOverrideActive, role]);

  const isActive = (path: string) => pathname === path;
  const isActivePrefix = (prefix: string) => pathname.startsWith(prefix);

  const navigateMobile = (path: string) => {
    setIsMenuOpen(false);
    router.push(path);
  };

  // Admin dashboard has its own sidebar nav — hide the top navbar there
  if (!roleLoading && isAdmin && pathname === '/dashboard') return null;

  return (
    <Navbar 
      maxWidth="xl" 
      className="py-1 px-[5px] bg-content1/70 backdrop-blur-md border-b border-divider [&_ul]:list-none [&_li]:list-none"
      onMenuOpenChange={setIsMenuOpen}
      isMenuOpen={isMenuOpen}
    >
      {/* Mobile hamburger toggle */}
      <NavbarContent className="sm:hidden" justify="start">
        <NavbarMenuToggle aria-label={isMenuOpen ? 'Close menu' : 'Open menu'} />
      </NavbarContent>

      {/* Brand logo - mobile centered */}
      <NavbarContent className="sm:hidden pr-3" justify="center">
        <NavbarBrand>
          <Link href="/dashboard" className="block">
            <div className="relative w-[60px] h-[60px]">
              <Image
                src={mounted && theme === 'light' ? '/images/NoBackground_NewLogoBlack.PNG' : '/images/NoBackground_NewLogoWhite.PNG'}
                alt="BMRC logo"
                fill
                className="object-contain"
                priority
              />
            </div>
          </Link>
        </NavbarBrand>
      </NavbarContent>

      {/* Desktop: Logo + Nav Links */}
      <NavbarBrand className="gap-4 ml-[10px] hidden sm:flex">
        <Link href="/dashboard" className="block">
          <div className="relative w-[79px] h-[79px]">
            <Image
              src={mounted && theme === 'light' ? '/images/NoBackground_NewLogoBlack.PNG' : '/images/NoBackground_NewLogoWhite.PNG'}
              alt="BMRC logo"
              fill
              className="object-contain"
              priority
            />
          </div>
        </Link>
        <div className="flex flex-col leading-none">
          <span className="font-bold text-[15px] tracking-tight text-foreground" style={{ letterSpacing: '-0.02em' }}>BMRC Logistics</span>
          <span className="text-[10.5px] font-medium text-foreground-300" style={{ letterSpacing: '0.02em' }}>Berkeley Medical Reserve Corps</span>
        </div>
        <div className="flex gap-4 ml-0">
          <NavbarItem isActive={isActive('/dashboard')}>
            <Link href="/dashboard" className={isActive('/dashboard') ? 'flex items-center gap-1.5 px-3 py-[7px] rounded-[8px] bg-primary-50 dark:bg-primary-900/20 text-primary font-semibold text-[15px] transition-colors duration-150' : 'flex items-center gap-1.5 px-3 py-[7px] rounded-[8px] text-foreground-400 font-medium text-[15px] hover:bg-content2 transition-colors duration-150'}>
              <Home className="w-4 h-4" /> Dashboard
            </Link>
          </NavbarItem>

          {isAdmin && (
            <Dropdown>
              <NavbarItem>
                <DropdownTrigger>
                  <button className={isActive('/assets') || isActivePrefix('/statpacks') ? 'flex items-center gap-1.5 px-3 py-[7px] rounded-[8px] bg-primary-50 dark:bg-primary-900/20 text-primary font-semibold text-[15px] transition-colors duration-150' : 'flex items-center gap-1.5 px-3 py-[7px] rounded-[8px] text-foreground-400 font-medium text-[15px] hover:bg-content2 transition-colors duration-150'}>
                    <Box className="w-4 h-4" /> Assets
                  </button>
                </DropdownTrigger>
              </NavbarItem>
              <DropdownMenu aria-label="Assets menu">
                <DropdownItem key="assets" onClick={() => router.push('/assets')} startContent={<Package size={16} />}>Assets &amp; Statpacks</DropdownItem>
              </DropdownMenu>
            </Dropdown>
          )}

          {isAdmin && (
            <Dropdown>
              <NavbarItem>
                <DropdownTrigger>
                  <button className={isActive('/inventory') || isActive('/restock') || isActive('/stats') || isActive('/storage') || isActive('/audit') ? 'flex items-center gap-1.5 px-3 py-[7px] rounded-[8px] bg-primary-50 dark:bg-primary-900/20 text-primary font-semibold text-[15px] transition-colors duration-150' : 'flex items-center gap-1.5 px-3 py-[7px] rounded-[8px] text-foreground-400 font-medium text-[15px] hover:bg-content2 transition-colors duration-150'}>
                    <Warehouse className="w-4 h-4" /> Inventory
                  </button>
                </DropdownTrigger>
              </NavbarItem>
              <DropdownMenu aria-label="Inventory menu">
                <DropdownItem key="inventory" onClick={() => router.push('/inventory')} startContent={<Package size={16} />}>View Inventory</DropdownItem>
                <DropdownItem key="audit" onClick={() => router.push('/audit')} startContent={<ScanBarcode size={16} />}>Supply Audit</DropdownItem>
                <DropdownItem key="restock" onClick={() => router.push('/restock')} startContent={<RefreshCw size={16} />}>Restock Items</DropdownItem>
                <DropdownItem key="stats" onClick={() => router.push('/stats')} startContent={<BarChart2 size={16} />}>Stats</DropdownItem>
                <DropdownItem key="storage" onClick={() => router.push('/storage')} startContent={<Warehouse size={16} />}>Storage Management</DropdownItem>
                <DropdownItem key="tasks" onClick={() => router.push('/committee-board?view=tasks')} startContent={<CheckSquare size={16} />}>Tasks & Buy List</DropdownItem>
              </DropdownMenu>
            </Dropdown>
          )}

          {isAdmin && (
            <NavbarItem isActive={isActive('/roster')}>
              <Link href="/roster" className={isActive('/roster') ? 'flex items-center gap-1.5 px-3 py-[7px] rounded-[8px] bg-primary-50 dark:bg-primary-900/20 text-primary font-semibold text-[15px] transition-colors duration-150' : 'flex items-center gap-1.5 px-3 py-[7px] rounded-[8px] text-foreground-400 font-medium text-[15px] hover:bg-content2 transition-colors duration-150'}>
                <Users className="w-4 h-4" /> Roster
              </Link>
            </NavbarItem>
          )}

          {isAdmin && (
            <NavbarItem isActive={isActive('/issue-reports') || isActive('/reports')}>
              <Link href="/issue-reports" className={isActive('/issue-reports') || isActive('/reports') ? 'flex items-center gap-1.5 px-3 py-[7px] rounded-[8px] bg-primary-50 dark:bg-primary-900/20 text-primary font-semibold text-[15px] transition-colors duration-150' : 'flex items-center gap-1.5 px-3 py-[7px] rounded-[8px] text-foreground-400 font-medium text-[15px] hover:bg-content2 transition-colors duration-150'}>
                <AlertTriangle className="w-4 h-4" /> Reports
              </Link>
            </NavbarItem>
          )}

          {isAdmin && (
            <NavbarItem isActive={isActive('/reconciliation')}>
              <Link href="/reconciliation" className={isActive('/reconciliation') ? 'flex items-center gap-1.5 px-3 py-[7px] rounded-[8px] bg-primary-50 dark:bg-primary-900/20 text-primary font-semibold text-[15px] transition-colors duration-150' : 'flex items-center gap-1.5 px-3 py-[7px] rounded-[8px] text-foreground-400 font-medium text-[15px] hover:bg-content2 transition-colors duration-150'}>
                <ShieldAlert className="w-4 h-4" /> Exceptions
              </Link>
            </NavbarItem>
          )}
        </div>
      </NavbarBrand>

      {/* User avatar */}
      <NavbarContent justify="end" className="gap-3">
        <NavbarItem>
          <Tooltip content="Tutorial">
            <Button isIconOnly size="sm" variant="light" onPress={() => { setShowTutorial(true); }}>
              <GraduationCap className="w-4 h-4" />
            </Button>
          </Tooltip>
        </NavbarItem>
        {mounted && (
          <NavbarItem>
            <Button
              isIconOnly
              variant="light"
              size="sm"
              aria-label="Toggle theme"
              onPress={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              className="text-foreground-400"
            >
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </Button>
          </NavbarItem>
        )}
        <NavbarItem>
          <Dropdown placement="bottom-end" offset={10} className="dark:bg-slate-800">
            <DropdownTrigger>
              <button className="flex items-center justify-center w-10 h-10 bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-700 dark:hover:bg-indigo-600 text-white rounded-full transition-colors cursor-pointer font-semibold text-lg border-2 border-indigo-500 dark:border-indigo-600 outline-none">
                {(user?.displayName || user?.email)?.[0]?.toUpperCase() || 'U'}
              </button>
            </DropdownTrigger>
            <DropdownMenu aria-label="User menu" className="w-[198px] gap-1 p-2 dark:bg-slate-700 border-2 border-indigo-600 dark:border-indigo-500 rounded-2xl">
              <DropdownItem key="profile" onClick={() => router.push('/profile')} startContent={<User className="w-4 h-4" />} className="p-2.5 text-sm font-medium text-left hover:bg-black/5 dark:hover:bg-white/10 transition-colors">Profile</DropdownItem>
              {isAdmin ? (
                <DropdownItem key="reports" onClick={() => router.push('/reports')} startContent={<BarChart3 className="w-4 h-4" />} className="p-2.5 text-sm font-medium text-left hover:bg-black/5 dark:hover:bg-white/10 transition-colors">Reports</DropdownItem>
              ) : null}
              <DropdownItem key="role-override" onClick={() => { try { const current = localStorage.getItem('bmrc_role_override'); if (current) { localStorage.removeItem('bmrc_role_override'); } else { const target = (role === 'admin' || role === 'quartermaster') ? 'member' : 'admin'; localStorage.setItem('bmrc_role_override', target); } window.dispatchEvent(new Event('bmrc-role-changed')); } catch (e) { console.error('role override failed', e); } }} startContent={<ShieldCheck className="w-4 h-4" />} className="p-2.5 text-sm font-medium text-left hover:bg-black/5 dark:hover:bg-white/10 transition-colors">
                {roleOverrideActive ? `Clear Test Role (${roleOverrideActive})` : `Toggle Test Role`}
              </DropdownItem>
              <DropdownItem key="logout" onClick={handleSignOut} startContent={<LogOut className="w-4 h-4" />} className="p-2.5 text-sm font-medium text-left text-danger hover:bg-black/5 dark:hover:bg-white/10 transition-colors" color="danger">Log Out</DropdownItem>
            </DropdownMenu>
          </Dropdown>
        </NavbarItem>
      </NavbarContent>

      {showTutorial && user && (
        <TutorialOverlay userId={user.uid} onComplete={() => setShowTutorial(false)} />
      )}

      {/* Mobile Menu */}
      <NavbarMenu className="pt-4 pb-6 gap-0 bg-content1/95 backdrop-blur-lg">
        <NavbarMenuItem className="py-2">
          <Link href="/dashboard" className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${isActive('/dashboard') ? 'bg-primary-100 dark:bg-primary-900/30 text-primary font-semibold' : 'text-foreground'}`} onPress={() => navigateMobile('/dashboard')}>
            <Home size={18} /> Dashboard
          </Link>
        </NavbarMenuItem>
        {isAdmin && (<>
          <Divider className="my-1" />
          <NavbarMenuItem className="py-1"><p className="px-3 py-1 text-xs font-semibold text-foreground-400 uppercase tracking-wide">Assets</p></NavbarMenuItem>
          <NavbarMenuItem className="py-1">
            <Link href="/assets" className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${isActive('/assets') || isActivePrefix('/statpacks') ? 'bg-primary-100 dark:bg-primary-900/30 text-primary font-semibold' : 'text-foreground'}`} onPress={() => navigateMobile('/assets')}>
              <Package size={18} /> Assets &amp; Statpacks
            </Link>
          </NavbarMenuItem>
        </>)}
        {isAdmin && (<>
          <Divider className="my-1" />
          <NavbarMenuItem className="py-1"><p className="px-3 py-1 text-xs font-semibold text-foreground-400 uppercase tracking-wide">Inventory</p></NavbarMenuItem>
          <NavbarMenuItem className="py-1">
            <Link href="/inventory" className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${isActive('/inventory') ? 'bg-primary-100 dark:bg-primary-900/30 text-primary font-semibold' : 'text-foreground'}`} onPress={() => navigateMobile('/inventory')}>
              <Package size={18} /> View Inventory
            </Link>
          </NavbarMenuItem>
          <NavbarMenuItem className="py-1">
            <Link href="/audit" className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${isActive('/audit') ? 'bg-primary-100 dark:bg-primary-900/30 text-primary font-semibold' : 'text-foreground'}`} onPress={() => navigateMobile('/audit')}>
              <ScanBarcode size={18} /> Supply Audit
            </Link>
          </NavbarMenuItem>
          <NavbarMenuItem className="py-1">
            <Link href="/restock" className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${isActive('/restock') ? 'bg-primary-100 dark:bg-primary-900/30 text-primary font-semibold' : 'text-foreground'}`} onPress={() => navigateMobile('/restock')}>
              <RefreshCw size={18} /> Restock Items
            </Link>
          </NavbarMenuItem>
          <NavbarMenuItem className="py-1">
            <Link href="/stats" className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${isActive('/stats') ? 'bg-primary-100 dark:bg-primary-900/30 text-primary font-semibold' : 'text-foreground'}`} onPress={() => navigateMobile('/stats')}>
              <BarChart2 size={18} /> Stats
            </Link>
          </NavbarMenuItem>
          <NavbarMenuItem className="py-1">
            <Link href="/storage" className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${isActive('/storage') ? 'bg-primary-100 dark:bg-primary-900/30 text-primary font-semibold' : 'text-foreground'}`} onPress={() => navigateMobile('/storage')}>
              <Warehouse size={18} /> Storage
            </Link>
          </NavbarMenuItem>
          <NavbarMenuItem className="py-1">
            <Link href="/committee-board?view=tasks" className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${isActivePrefix('/tasks') ? 'bg-primary-100 dark:bg-primary-900/30 text-primary font-semibold' : 'text-foreground'}`} onPress={() => navigateMobile('/committee-board?view=tasks')}>
              <CheckSquare size={18} /> Tasks & Buy List
            </Link>
          </NavbarMenuItem>
        </>)}
        {isAdmin && (<>
          <Divider className="my-1" />
          <NavbarMenuItem className="py-1"><p className="px-3 py-1 text-xs font-semibold text-foreground-400 uppercase tracking-wide">Admin</p></NavbarMenuItem>
          <NavbarMenuItem className="py-1">
            <Link href="/roster" className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${isActive('/roster') ? 'bg-primary-100 dark:bg-primary-900/30 text-primary font-semibold' : 'text-foreground'}`} onPress={() => navigateMobile('/roster')}>
              <Users size={18} /> Roster
            </Link>
          </NavbarMenuItem>
          <NavbarMenuItem className="py-1">
            <Link href="/issue-reports" className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${isActive('/issue-reports') ? 'bg-primary-100 dark:bg-primary-900/30 text-primary font-semibold' : 'text-foreground'}`} onPress={() => navigateMobile('/issue-reports')}>
              <AlertTriangle size={18} /> Reports
            </Link>
          </NavbarMenuItem>
          <NavbarMenuItem className="py-1">
            <Link href="/reconciliation" className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${isActive('/reconciliation') ? 'bg-primary-100 dark:bg-primary-900/30 text-primary font-semibold' : 'text-foreground'}`} onPress={() => navigateMobile('/reconciliation')}>
              <ShieldAlert size={18} /> Exceptions
            </Link>
          </NavbarMenuItem>
        </>)}
        <Divider className="my-2" />
        <NavbarMenuItem className="py-1">
          <Link href="/profile" className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${isActive('/profile') ? 'bg-primary-100 dark:bg-primary-900/30 text-primary font-semibold' : 'text-foreground'}`} onPress={() => navigateMobile('/profile')}>
            <User size={18} /> Profile
          </Link>
        </NavbarMenuItem>
        <NavbarMenuItem className="py-1">
          <button className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-danger transition-colors hover:bg-danger-50 dark:hover:bg-danger-900/20" onClick={() => { setIsMenuOpen(false); handleSignOut(); }}>
            <LogOut size={18} /> Log Out
          </button>
        </NavbarMenuItem>
      </NavbarMenu>

      <IssueReportForm isOpen={isReportOpen} onOpenChange={setIsReportOpen} pagePath={pathname} />
    </Navbar>
  );
}
