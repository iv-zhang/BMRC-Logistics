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
  /** True when `role`/`userData` reflect a test identity or a legacy `bmrc_role_override` string rather than the real Firestore user. */
  isRoleOverridden: boolean;
  /**
   * The uid that member-scoped reads/writes should key on: the active test
   * identity's uid when one is active, otherwise the real Firebase Auth uid.
   * Use this (not `user.uid`) for anything that should follow the test
   * identity — e.g. "my requests" queries, ownership checks. `user` itself
   * stays the real auth object; writes still run under real auth.
   */
  effectiveUid: string | null;
}

function readTestIdentityId(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('bmrc_test_identity') || null;
}

function readRoleOverride(): User['role'] | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('bmrc_role_override') as User['role'] | null;
}

/** Shared shape for a `users/{id}` doc snapshot, real or test identity. */
function parseUserDoc(id: string, data: Record<string, unknown>, fallbackEmail = '', fallbackName = 'Unknown User'): User {
  const createdAt = data.createdAt as { toDate?: () => Date } | undefined;
  const updatedAt = data.updatedAt as { toDate?: () => Date } | undefined;
  return {
    id,
    email: (data.email as string) || fallbackEmail,
    fullName: (data.fullName as string) || fallbackName,
    role: (data.role as User['role']) || 'member',
    canAudit: data.canAudit === true,
    isCommitteeMember: data.isCommitteeMember === true,
    certifications: (data.certifications as User['certifications']) || undefined,
    // These MUST be carried through: dropping them made `tutorialCompleted`
    // permanently undefined (so the onboarding tour re-triggered on every
    // login) and `memberStatus`/`joinedTerm` invisible to shift requests, which
    // denormalize them at signup (D-15) — every request recorded "general"
    // regardless of what the roster said.
    tutorialCompleted: data.tutorialCompleted === true,
    tutorialCompletedAt: (data.tutorialCompletedAt as { toDate?: () => Date } | undefined)?.toDate?.(),
    memberStatus: (data.memberStatus as User['memberStatus']) || undefined,
    joinedTerm: (data.joinedTerm as string) || undefined,
    createdAt: createdAt?.toDate?.() || new Date(),
    updatedAt: updatedAt?.toDate?.() || new Date(),
  };
}

export function useUserRole(): UseUserRoleReturn {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [userData, setUserData] = useState<User | null>(null);
  const [roleOverride, setRoleOverride] = useState<User['role'] | null>(readRoleOverride);
  // A test identity fully swaps `userData`/`role` for a seeded `users/{__test_*}`
  // doc (see app/lib/test-identity.ts) so an admin can "become" a member/FTO/etc.
  // and have writes attributed to that identity, not their real account. The
  // real Firebase Auth `user` object underneath is untouched — auth stays real.
  const [testIdentityId, setTestIdentityId] = useState<string | null>(readTestIdentityId);
  const [testIdentityData, setTestIdentityData] = useState<User | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      
      if (currentUser) {
        try {
          const userRef = doc(db, 'users', currentUser.uid);
          const userSnap = await getDoc(userRef);
          
          if (userSnap.exists()) {
            setUserData(parseUserDoc(currentUser.uid, userSnap.data(), currentUser.email || '', currentUser.displayName || 'Unknown User'));
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

  // Read role override + test identity from localStorage and listen for
  // changes (for testing) — both fire off the same custom event so a single
  // dispatch from /profile updates either.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'bmrc_role_override') {
        setRoleOverride(e.newValue as User['role'] | null);
      } else if (e.key === 'bmrc_test_identity') {
        setTestIdentityId(e.newValue || null);
      }
    };

    const onCustom = () => {
      setRoleOverride(readRoleOverride());
      setTestIdentityId(readTestIdentityId());
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

  // When a test identity is active, fetch its `users/{testUid}` doc so
  // `userData`/`role` reflect that identity instead of the real user. Guarded
  // against races: if `testIdentityId` changes again mid-fetch, the stale
  // response is dropped.
  useEffect(() => {
    // No identity active: nothing to fetch. `testIdentityData` may still hold
    // a previous identity's doc, but the read below only consults it while
    // `testIdentityId` is truthy, so a stale value here is inert.
    if (!testIdentityId) return;
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'users', testIdentityId));
        if (cancelled) return;
        setTestIdentityData(snap.exists() ? parseUserDoc(testIdentityId, snap.data()) : null);
      } catch (error) {
        console.error('Error fetching test identity:', error);
        if (!cancelled) setTestIdentityData(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [testIdentityId]);

  // A test identity takes full precedence (identity + role) only once its doc
  // has actually loaded for the CURRENT id — the `testIdentityData?.id` check
  // guards against briefly showing the previous identity's data while a new
  // fetch is in flight. The legacy role-only override is the fallback when no
  // identity is active.
  const activeTestIdentity =
    testIdentityId && testIdentityData?.id === testIdentityId ? testIdentityData : null;
  const effectiveUserData = activeTestIdentity ?? userData;
  const effectiveRole: User['role'] | null =
    activeTestIdentity?.role ?? (roleOverride ?? (userData?.role || null));

  return {
    loading,
    user,
    userData: effectiveUserData,
    role: effectiveRole,
    fullName: effectiveUserData?.fullName || null,
    isRoleOverridden: !!testIdentityId || roleOverride !== null,
    effectiveUid: effectiveUserData?.id ?? user?.uid ?? null,
  };
}
