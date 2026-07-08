'use client';

import { useState, useEffect } from 'react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/firebase';
import type { User } from '@/app/types';

interface UseUserRoleReturn {
  loading: boolean;
  user: FirebaseUser | null;
  userData: User | null;
  role: User['role'] | null;
  fullName: string | null;
}

export function useUserRole(): UseUserRoleReturn {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [userData, setUserData] = useState<User | null>(null);
  const [roleOverride, setRoleOverride] = useState<User['role'] | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('bmrc_role_override') as User['role'] | null;
    }
    return null;
  });

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      
      if (currentUser) {
        try {
          const userRef = doc(db, 'users', currentUser.uid);
          const userSnap = await getDoc(userRef);
          
          if (userSnap.exists()) {
            const data = userSnap.data();
            setUserData({
              id: currentUser.uid,
              email: data.email || currentUser.email || '',
              fullName: data.fullName || currentUser.displayName || 'Unknown User',
              role: data.role || 'member',
              canAudit: data.canAudit === true,
              isCommitteeMember: data.isCommitteeMember === true,
              createdAt: data.createdAt?.toDate() || new Date(),
              updatedAt: data.updatedAt?.toDate() || new Date(),
            });
          } else {
            // Fallback if user doc doesn't exist yet
            setUserData({
              id: currentUser.uid,
              email: currentUser.email || '',
              fullName: currentUser.displayName || 'Unknown User',
              role: 'member',
              createdAt: new Date(),
              updatedAt: new Date(),
            });
          }
        } catch (error) {
          console.error('Error fetching user data:', error);
          setUserData(null);
        }
      } else {
        setUserData(null);
      }
      
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  // Read role override from localStorage and listen for changes (for testing)
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'bmrc_role_override') {
        setRoleOverride(e.newValue as User['role'] | null);
      }
    };

    const onCustom = () => {
      const stored = localStorage.getItem('bmrc_role_override');
      setRoleOverride(stored as User['role'] | null);
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

  const effectiveRole: User['role'] | null = roleOverride ?? (userData?.role || null);

  return {
    loading,
    user,
    userData,
    role: effectiveRole,
    fullName: userData?.fullName || null,
  };
}
