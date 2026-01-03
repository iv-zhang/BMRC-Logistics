'use client';

import React, { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { 
  Navbar, 
  NavbarBrand, 
  NavbarContent, 
  NavbarItem, 
  Link, 
  Dropdown, 
  DropdownTrigger, 
  DropdownMenu, 
  DropdownItem
} from '@heroui/react';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'; 
import { onAuthStateChanged, signOut, type User as FirebaseUser } from 'firebase/auth';
import { auth, db } from '@/firebase';

// Icons
const UserIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"></path>
    <circle cx="12" cy="7" r="4"></circle>
  </svg>
);

const LogOutIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
    <polyline points="16 17 21 12 16 7"></polyline>
    <line x1="21" y1="12" x2="9" y2="12"></line>
  </svg>
);

export default function AppNavbar() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<FirebaseUser | null>(null);

  useEffect(() => {
  const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
    setUser(currentUser);
    
    // --- NEW: SYNC CODE ---
    if (currentUser) {
      const userRef = doc(db, 'users', currentUser.uid);
      const userSnap = await getDoc(userRef);

      // If user doesn't exist in Firestore, create them
      if (!userSnap.exists()) {
        await setDoc(userRef, {
          id: currentUser.uid,
          email: currentUser.email,
          fullName: currentUser.displayName || 'Unknown Member',
          role: 'member', // Default role
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        console.log("User synced to Firestore");
      }
    }
    // ----------------------
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

  const isActive = (path: string) => pathname === path;

  return (
    <Navbar 
      maxWidth="xl" 
      // Added [&_ul]:list-none [&_li]:list-none to forcibly remove any bullet points
      className="p-[5px] bg-white/70 dark:bg-slate-900/70 backdrop-blur-md border-b border-gray-200 dark:border-slate-800 [&_ul]:list-none [&_li]:list-none"
    >
      {/* Added ml-[10px] to shift the Logo and Links towards the middle */}
      <NavbarBrand className="gap-4 ml-[10px]">
        <p className="font-bold text-2xl text-indigo-600 dark:text-indigo-400 tracking-tighter">
          BMRC
        </p>
        
        <div className="hidden sm:flex gap-4 ml-6">
          <NavbarItem isActive={isActive('/dashboard')}>
            <Link 
              href="/dashboard" 
              color={isActive('/dashboard') ? "primary" : "foreground"}
              className={isActive('/dashboard') ? "font-semibold" : "text-gray-500 dark:text-gray-400"}
            >
              Dashboard
            </Link>
          </NavbarItem>

          <NavbarItem isActive={isActive('/statpacks')}>
            <Link 
              href="/statpacks" 
              color={isActive('/statpacks') ? "primary" : "foreground"}
              className={isActive('/statpacks') ? "font-semibold" : "text-gray-500 dark:text-gray-400"}
            >
              Statpacks
            </Link>
          </NavbarItem>

          <NavbarItem isActive={isActive('/inventory')}>
            <Link 
              href="/inventory" 
              color={isActive('/inventory') ? "primary" : "foreground"}
              className={isActive('/inventory') ? "font-semibold" : "text-gray-500 dark:text-gray-400"}
            >
              Inventory
            </Link>
          </NavbarItem>

          <NavbarItem isActive={isActive('/roster')}>
            <Link 
              href="/roster" 
              color={isActive('/roster') ? "primary" : "foreground"}
              className={isActive('/roster') ? "font-semibold" : "text-gray-500 dark:text-gray-400"}
            >
              Roster
            </Link>
          </NavbarItem>

          {/* Audit link moved into Inventory page header */}

          <NavbarItem isActive={isActive('/restock')}>
            <Link
              href="/restock"
              color={isActive('/restock') ? "primary" : "foreground"}
              className={isActive('/restock') ? "font-semibold" : "text-gray-500 dark:text-gray-400"}
            >
              Restock
            </Link>
          </NavbarItem>

          <NavbarItem isActive={isActive('/restock-stats')}>
            <Link
              href="/restock-stats"
              color={isActive('/restock-stats') ? "primary" : "foreground"}
              className={isActive('/restock-stats') ? "font-semibold" : "text-gray-500 dark:text-gray-400"}
            >
              Restock Stats
            </Link>
          </NavbarItem>
        </div>

        {/* Mobile links (visible on small screens) */}
        <div className="flex sm:hidden gap-3 ml-3">
          <Link href="/dashboard" className={isActive('/dashboard') ? "font-semibold text-indigo-600" : "text-gray-500 dark:text-gray-400"}>Dashboard</Link>
          <Link href="/statpacks" className={isActive('/statpacks') ? "font-semibold text-indigo-600" : "text-gray-500 dark:text-gray-400"}>Statpacks</Link>
          <Link href="/inventory" className={isActive('/inventory') ? "font-semibold text-indigo-600" : "text-gray-500 dark:text-gray-400"}>Inventory</Link>
          <Link href="/roster" className={isActive('/roster') ? "font-semibold text-indigo-600" : "text-gray-500 dark:text-gray-400"}>Roster</Link>
          <Link href="/audit" className={isActive('/audit') ? "font-semibold text-indigo-600" : "text-gray-500 dark:text-gray-400"}>Audit</Link>
          <Link href="/restock" className={isActive('/restock') ? "font-semibold text-indigo-600" : "text-gray-500 dark:text-gray-400"}>Restock</Link>
          <Link href="/restock-stats" className={isActive('/restock-stats') ? "font-semibold text-indigo-600" : "text-gray-500 dark:text-gray-400"}>Restock Stats</Link>
        </div>
      </NavbarBrand>

      <NavbarContent justify="end">
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
                startContent={<UserIcon />}
                className="p-2.5 text-sm font-medium text-left hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
              >
                Profile
              </DropdownItem>
              <DropdownItem 
                key="logout" 
                onClick={handleSignOut}
                startContent={<LogOutIcon />}
                className="p-2.5 text-sm font-medium text-left text-danger hover:bg-black/5 dark:hover:bg-white/10 transition-colors" 
                color="danger"
              >
                Log Out
              </DropdownItem>
            </DropdownMenu>
          </Dropdown>
        </NavbarItem>
      </NavbarContent>
    </Navbar>
  );
}
