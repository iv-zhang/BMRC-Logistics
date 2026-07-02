'use client';
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Chip, Spinner } from '@heroui/react';
import { ArrowLeft, Mail, UserRound } from 'lucide-react';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/firebase';
import { ROLES } from '@/app/config/org-config';
import type { User } from '@/app/types';

export default function ProfilePage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (!currentUser) {
        router.push('/login');
        return;
      }

      try {
        const userRef = doc(db, 'users', currentUser.uid);
        const userSnap = await getDoc(userRef);

        if (userSnap.exists()) {
          const userData = userSnap.data();
          setUser({
            id: userData.id,
            fullName: userData.fullName,
            email: userData.email,
            role: userData.role,
            createdAt: userData.createdAt?.toDate() || new Date(),
            updatedAt: userData.updatedAt?.toDate() || new Date(),
          });
        }
      } catch (error) {
        console.error('Error fetching user data:', error);
      } finally {
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, [router]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center p-4">
        <div className="bg-content1 border border-divider rounded-large max-w-md w-full text-center py-10 px-6">
          <UserRound size={40} className="mx-auto text-foreground-300 mb-4" />
          <p className="text-sm font-semibold text-foreground-500 mb-4">Unable to load profile information.</p>
          <Button color="primary" onPress={() => router.push('/dashboard')}>
            Return to dashboard
          </Button>
        </div>
      </div>
    );
  }

  const getRoleColor = (role: string) => {
    switch (role) {
      case 'admin':
        return 'danger';
      case 'FTO':
        return 'warning';
      case 'quartermaster':
        return 'secondary';
      default:
        return 'primary';
    }
  };

  const roleDef = ROLES.find((r) => r.id === user.role);
  const roleLabel = roleDef?.label ?? (user.role.charAt(0).toUpperCase() + user.role.slice(1));

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
      <div className="max-w-7xl mx-auto px-6 py-8">

        {/* ── Page header ────────────────────────────────────────────────── */}
        <div className="flex items-end justify-between gap-4 mb-6 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-foreground mb-1.5">Profile</h1>
            <p className="text-sm text-foreground-500">Your account information</p>
          </div>
          <Button
            size="sm"
            variant="flat"
            startContent={<ArrowLeft size={14} />}
            onPress={() => router.push('/dashboard')}
          >
            Back to dashboard
          </Button>
        </div>

        <div className="max-w-2xl">
          <div className="bg-content1 border border-divider rounded-large p-5">
            {/* Identity row */}
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-[14px] bg-secondary/15 text-secondary flex items-center justify-center text-xl font-semibold flex-none">
                {user.fullName.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="font-semibold text-lg text-foreground leading-tight truncate">{user.fullName}</div>
                <div className="flex items-center gap-1 text-xs text-foreground-500 mt-0.5">
                  <Mail size={11} className="flex-none" /> {user.email}
                </div>
              </div>
              <div className="ml-auto flex-none">
                <Chip color={getRoleColor(user.role)} variant="flat" size="sm">
                  {roleLabel}
                </Chip>
              </div>
            </div>

            {/* Details */}
            <div className="flex gap-3 mt-5">
              <div className="flex-1 bg-content2 rounded-large p-4">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">Role</div>
                <div className="text-sm font-semibold text-foreground">{roleLabel}</div>
                {roleDef?.description && (
                  <div className="text-xs text-foreground-400 mt-1">{roleDef.description}</div>
                )}
              </div>
              <div className="flex-1 bg-content2 rounded-large p-4">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">Member Since</div>
                <div className="text-sm font-semibold text-foreground tabular-nums">
                  {user.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
