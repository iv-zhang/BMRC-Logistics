 'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Card, CardBody, Divider, Spinner } from '@heroui/react';
import { Truck } from 'lucide-react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { auth } from '@/firebase';

export default function Home() {
  const router = useRouter();
  const [checkingAuth, setCheckingAuth] = useState(true);

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

  if (checkingAuth) return <div className="min-h-screen bg-background flex items-center justify-center"><Spinner size="lg" color="primary" /></div>;

  
  
  
  
  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-6">
      <main className="max-w-5xl mx-auto space-y-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl md:text-4xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Truck className="text-indigo-600" size={30} />
            BMRC Logistics
          </h1>
          <p className="text-gray-500 dark:text-gray-400">
            Efficient logistics management for your operations
          </p>
        </div>
        <Divider />
        <Card className="shadow-lg bg-white/80 dark:bg-slate-800/80 border border-gray-200/70 dark:border-slate-700 rounded-xl">
          <CardBody className="p-8 gap-8">
            <div className="space-y-3">
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">Welcome to your dashboard</h2>
              <p className="text-gray-600 dark:text-gray-400 leading-relaxed">
                BMRC Logistics provides a clear view of fleet readiness, inventory health, and audit history.
                Sign in to manage statpacks, supplies, and team activity in one place.
              </p>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Card className="bg-white/80 dark:bg-slate-900/60 border border-gray-200/70 dark:border-slate-700 rounded-xl">
                <CardBody className="p-4">
                  <h3 className="font-semibold text-gray-900 dark:text-gray-100 mb-2">Track Readiness</h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Inspect kits, verify counts, and document checks.</p>
                </CardBody>
              </Card>
              <Card className="bg-white/80 dark:bg-slate-900/60 border border-gray-200/70 dark:border-slate-700 rounded-xl">
                <CardBody className="p-4">
                  <h3 className="font-semibold text-gray-900 dark:text-gray-100 mb-2">Manage Inventory</h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Monitor supply levels and restock thresholds.</p>
                </CardBody>
              </Card>
              <Card className="bg-white/80 dark:bg-slate-900/60 border border-gray-200/70 dark:border-slate-700 rounded-xl">
                <CardBody className="p-4">
                  <h3 className="font-semibold text-gray-900 dark:text-gray-100 mb-2">Audit History</h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Review recent activity and compliance logs.</p>
                </CardBody>
              </Card>
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
              <Button 
                variant="bordered"
                color="primary"
                className="w-full md:w-48 h-12 font-semibold"
              >
                Learn More
              </Button>
            </div>
          </CardBody>
        </Card>
      </main>
    </div>
  );
}
