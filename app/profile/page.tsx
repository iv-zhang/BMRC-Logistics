'use client';
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Chip, Spinner } from '@heroui/react';
import { ArrowLeft, Mail, UserRound, Sun, Moon, ShieldCheck, LogOut as LogOutIcon, Bug } from 'lucide-react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { useTheme } from 'next-themes';
import { auth, db } from '@/firebase';
import { ROLES } from '@/app/config/org-config';
import { useUserRole } from '@/app/hooks/useUserRole';
import IssueReportForm from '@/app/components/IssueReportForm';
import type { User } from '@/app/types';

export default function ProfilePage() {
  const router = useRouter();
  const { role } = useUserRole();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [mounted, setMounted] = useState(false);
  const { setTheme, resolvedTheme } = useTheme();
  const [roleOverrideActive, setRoleOverrideActive] = useState<string | null>(null);
  const [isReportOpen, setIsReportOpen] = useState(false);

  useEffect(() => setMounted(true), []);

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

  // Role override state sync
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setRoleOverrideActive(localStorage.getItem('bmrc_role_override'));
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'bmrc_role_override') setRoleOverrideActive(e.newValue);
    };
    const onCustom = () => {
      const stored = localStorage.getItem('bmrc_role_override');
      setRoleOverrideActive(stored);
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('bmrc-role-changed', onCustom as EventListener);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('bmrc-role-changed', onCustom as EventListener);
    };
  }, []);

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

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      router.push('/');
    } catch (e) {
      console.error('Sign out error:', e);
    }
  };

  const handleRoleOverride = () => {
    try {
      const current = localStorage.getItem('bmrc_role_override');
      if (current) {
        localStorage.removeItem('bmrc_role_override');
      } else {
        const target = (role === 'admin' || role === 'quartermaster') ? 'member' : 'admin';
        localStorage.setItem('bmrc_role_override', target);
      }
      window.dispatchEvent(new Event('bmrc-role-changed'));
    } catch (e) {
      console.error('role override failed', e);
    }
  };

  // Show the Test Role control based on the REAL account role (user.role from the
  // Firestore doc, unaffected by the override) OR whenever an override is active —
  // otherwise toggling to a member test-role hides the very button needed to exit it.
  const canManageTestRole =
    user.role === 'admin' || user.role === 'quartermaster' || !!roleOverrideActive;
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

          <div className="bg-content1 border border-divider rounded-large p-5 mt-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-3">Appearance</div>
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-foreground">Theme</div>
                <div className="text-xs text-foreground-400 mt-0.5">Choose light or dark mode</div>
              </div>
              {mounted && (
                <div className="flex items-center gap-1 bg-content2 rounded-large p-1 flex-none">
                  <button
                    onClick={() => setTheme('light')}
                    className={`flex items-center gap-1.5 h-8 px-3 rounded-medium text-[13px] font-medium transition-colors ${resolvedTheme === 'light' ? 'bg-content1 text-foreground shadow-sm' : 'text-foreground-400 hover:text-foreground-600'}`}
                  >
                    <Sun size={15} /> Light
                  </button>
                  <button
                    onClick={() => setTheme('dark')}
                    className={`flex items-center gap-1.5 h-8 px-3 rounded-medium text-[13px] font-medium transition-colors ${resolvedTheme === 'dark' ? 'bg-content1 text-foreground shadow-sm' : 'text-foreground-400 hover:text-foreground-600'}`}
                  >
                    <Moon size={15} /> Dark
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="bg-content1 border border-divider rounded-large p-5 mt-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-3">Account</div>
            <div className="flex flex-col gap-3">
              {canManageTestRole && (
                <Button
                  className="w-full justify-start"
                  variant="flat"
                  startContent={<ShieldCheck size={16} />}
                  onPress={handleRoleOverride}
                >
                  {roleOverrideActive ? `Clear Test Role (${roleOverrideActive})` : 'Toggle Test Role'}
                </Button>
              )}
              <Button
                className="w-full justify-start"
                color="danger"
                variant="flat"
                startContent={<LogOutIcon size={16} />}
                onPress={handleSignOut}
              >
                Sign Out
              </Button>
            </div>
          </div>

          <div className="bg-content1 border border-divider rounded-large p-5 mt-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-3">Support</div>
            <div className="flex flex-col gap-3">
              <Button
                className="w-full justify-start"
                variant="flat"
                startContent={<Bug size={16} />}
                onPress={() => setIsReportOpen(true)}
              >
                Report a Bug
              </Button>
            </div>
          </div>
        </div>
      </div>

      <IssueReportForm
        isOpen={isReportOpen}
        onOpenChange={setIsReportOpen}
        lockType="bug"
        pagePath="/profile"
      />
    </div>
  );
}
