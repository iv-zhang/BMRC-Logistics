'use client';
import React, { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Card, CardBody, Divider, Spinner } from '@heroui/react';
import { useTheme } from 'next-themes';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { auth } from '@/firebase';

export default function Home() {
  const router = useRouter();
  const [checkingAuth, setCheckingAuth] = useState(true);
  const { theme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u: FirebaseUser | null) => {
      if (u) {
        router.replace('/dashboard');
      } else {
        setCheckingAuth(false);
      }
    });
    return () => unsub();
  }, [router]);

  const isDark = mounted && theme === 'dark';

  if (checkingAuth) return <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center"><Spinner size="lg" color="primary" /></div>;

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-4 sm:p-6">
      <main className="max-w-5xl mx-auto space-y-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl md:text-4xl font-semibold text-foreground flex items-center gap-3">
            <div className="relative w-9 h-9 flex-none">
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
            BMRC Logistics
          </h1>
          <p className="text-foreground-500">
            Efficient logistics management for your operations
          </p>
        </div>
        <Divider />
        <Card className="shadow-lg bg-content1 border border-divider rounded-large">
          <CardBody className="p-8 gap-8">
            <div className="space-y-3">
              <h2 className="text-2xl font-semibold text-foreground">Welcome to your dashboard</h2>
              <p className="text-foreground-500 leading-relaxed">
                BMRC Logistics provides a clear view of fleet readiness, inventory health, and audit history.
                Sign in to manage statpacks, supplies, and team activity in one place.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-content2 rounded-large p-4">
                <h3 className="font-semibold text-foreground mb-2">Track Readiness</h3>
                <p className="text-sm text-foreground-500">Inspect kits, verify counts, and document checks.</p>
              </div>
              <div className="bg-content2 rounded-large p-4">
                <h3 className="font-semibold text-foreground mb-2">Manage Inventory</h3>
                <p className="text-sm text-foreground-500">Monitor supply levels and restock thresholds.</p>
              </div>
              <div className="bg-content2 rounded-large p-4">
                <h3 className="font-semibold text-foreground mb-2">Audit History</h3>
                <p className="text-sm text-foreground-500">Review recent activity and compliance logs.</p>
              </div>
            </div>

            <div className="flex flex-col md:flex-row gap-4 pt-2 items-center justify-center">
              <Link href="/login" className="w-full md:w-auto">
                <Button
                  as="div"
                  color="primary"
                  className="w-full md:w-48 h-12 font-semibold"
                >
                  Sign In
                </Button>
              </Link>
            </div>
          </CardBody>
        </Card>
      </main>
    </div>
  );
}
