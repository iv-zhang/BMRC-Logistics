'use client';

import React, { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Card,
  CardBody,
  CardHeader,
  Button,
  Chip,
  Spinner,
  Avatar,
  Divider
} from '@heroui/react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { doc, getDoc, Timestamp } from 'firebase/firestore';
import { auth, db } from '@/firebase';
import type { Statpack, User as AppUser } from '@/app/types';
import {
  BriefcaseMedical,
  LogOut,
  LogIn,
  AlertTriangle,
  History,
  ShieldCheck,
  User,
  Clock
} from 'lucide-react';

// --- Safe Date Helper ---
// Prevents "toDate is not a function" errors by handling various formats
const getDate = (ts: any): Date | undefined => {
  if (!ts) return undefined;
  if (typeof ts.toDate === 'function') return ts.toDate();
  if (ts instanceof Date) return ts;
  if (typeof ts === 'string' || typeof ts === 'number') return new Date(ts);
  return undefined;
};

export default function MobilePackDashboardClient() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id') ?? '';
  const router = useRouter();

  const [pack, setPack] = useState<Statpack | null>(null);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [userRole, setUserRole] = useState<AppUser['role'] | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        const returnUrl = encodeURIComponent(`/mobile/dashboard?id=${id}`);
        router.push(`/login?redirect=${returnUrl}`);
      } else {
        setUser(u);
        // Fetch User Role
        try {
            const userDoc = await getDoc(doc(db, 'users', u.uid));
            if (userDoc.exists()) {
                const userData = userDoc.data() as AppUser;
                setUserRole(userData.role);
            }
        } catch (e) {
            console.error("Error fetching user role", e);
        }
      }
    });
    return () => unsubscribe();
  }, [router, id]);

  useEffect(() => {
    if (!id) return;
    const fetchPack = async () => {
      try {
        const ref = doc(db, 'statpacks', id);
        const snap = await getDoc(ref);
        if (snap.exists()) {
          const data = snap.data();
          
          // Safely convert dates before setting state
          const safePack: Statpack = {
            id: snap.id,
            ...data,
            checkedOutAt: getDate(data.checkedOutAt),
            lastCheckedAt: getDate(data.lastCheckedAt),
            // Add other date fields if necessary
          } as Statpack;

          setPack(safePack);
        } else {
          console.error("Pack not found");
        }
      } catch (err) {
        console.error("Error fetching pack:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchPack();
  }, [id]);

  if (loading) return <div className="h-screen flex items-center justify-center"><Spinner size="lg" /></div>;
  if (!pack) return <div className="p-6 text-center">Statpack not found.</div>;

  const isCheckedOut = pack.isCheckedOut;
  const isAssignedToMe = user && pack.assignedToUserId === user.uid;
  const canReturn = isAssignedToMe || userRole === 'admin' || userRole === 'quartermaster';

  // Status Styling
  const getStatusColor = (s: string) => {
    switch (s) {
      case 'Ready': return 'success';
      case 'In Use': return 'primary';
      case 'Restock Needed': return 'danger';
      case 'Expired Items': return 'warning';
      default: return 'default';
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-900 p-4 pb-20">
      
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BriefcaseMedical className="text-primary" />
            {pack.name}
          </h1>
          <p className="text-sm text-gray-500">{pack.type}</p>
        </div>
        <Chip color={getStatusColor(pack.status)} variant="shadow" className="capitalize">
          {pack.status}
        </Chip>
      </div>

      <div className="grid grid-cols-1 gap-4">
        
        {/* ACTION CARD */}
        {!isCheckedOut ? (
          <Card className="bg-white dark:bg-slate-800 border-l-4 border-l-green-500 shadow-sm">
            <CardBody className="gap-4">
              <div className="flex items-start gap-3">
                <div className="p-2 bg-green-100 dark:bg-green-900/30 text-green-600 rounded-lg">
                   <ShieldCheck size={24} />
                </div>
                <div>
                  <h3 className="font-bold text-lg">Ready for Checkout</h3>
                  <p className="text-sm text-gray-500">
                    Verify seal & contents before starting shift.
                  </p>
                </div>
              </div>
              <Button 
                size="lg" 
                color="success" 
                className="w-full font-bold text-white shadow-lg"
                startContent={<LogOut />}
                onPress={() => router.push(`/mobile/checkout?id=${id}`)}
              >
                Checkout Pack
              </Button>
            </CardBody>
          </Card>
        ) : (
          <Card className="bg-white dark:bg-slate-800 border-l-4 border-l-blue-500 shadow-sm">
            <CardBody className="gap-4">
              <div className="flex items-start gap-3">
                <div className="p-2 bg-blue-100 dark:bg-blue-900/30 text-blue-600 rounded-lg">
                   <User size={24} />
                </div>
                <div>
                  <h3 className="font-bold text-lg">Currently In Use</h3>
                  <p className="text-sm text-gray-500 mb-1">Assigned to:</p>
                  <p className="font-bold text-lg">{pack.assignedToUserName || 'Unknown User'}</p>
                  <div className="flex items-center gap-1 text-xs text-gray-500">
                    <Clock size={12} />
                    <span>
                      Since {pack.checkedOutAt ? pack.checkedOutAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Unknown time'}
                    </span>
                  </div>
                </div>
              </div>

              <Divider className="my-2" />

              <Button
                size="lg"
                color="primary"
                className="w-full font-bold text-lg shadow-lg"
                startContent={<LogIn />}
                onPress={() => router.push(`/mobile/checkin?id=${id}`)}
                isDisabled={!canReturn}
              >
                Return & Restock
              </Button>
              {!canReturn && (
                <p className="text-xs text-blue-700 dark:text-blue-300">
                  Only the assignee or an admin can return this bag.
                </p>
              )}
            </CardBody>
          </Card>
        )}
      </div>

      <div className="mt-8 grid grid-cols-2 gap-3">
        <Button variant="flat" startContent={<History size={18} />}>
          View History
        </Button>
        <Button variant="flat" onPress={() => router.push('/statpacks')}>
          Statpack List
        </Button>
      </div>
      
      {/* Alert if RESTOCK NEEDED */}
      {pack.status === 'Restock Needed' && !isCheckedOut && (
         <Card className="mt-6 bg-red-50 dark:bg-red-900/20 border-red-200">
            <CardBody className="flex flex-row items-center gap-3 text-red-700 dark:text-red-400">
                <AlertTriangle />
                <div>
                    <div className="font-bold">Restock Required</div>
                    <div className="text-xs">Check missing items before checkout.</div>
                </div>
            </CardBody>
         </Card>
      )}

    </div>
  );
}