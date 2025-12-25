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
        const returnUrl = id ? `/mobile?id=${id}` : '/mobile';
        router.push(`/login?returnUrl=${encodeURIComponent(returnUrl)}`);
        return;
      }
      setUser(u);
      try {
        const userSnap = await getDoc(doc(db, 'users', u.uid));
        const role = (userSnap.data() as AppUser | undefined)?.role ?? 'member';
        setUserRole(role);
      } catch (e) {
        console.error('Failed to load user role:', e);
        setUserRole('member');
      }
      await loadPack(id);
    });
    return () => unsubscribe();
  }, [id, router]);

  const loadPack = async (packId: string) => {
    if (!packId) {
      setPack(null);
      setLoading(false);
      return;
    }
    try {
      const snap = await getDoc(doc(db, 'statpacks', packId));
      if (snap.exists()) {
        const data = snap.data();
        const toDateIfTimestamp = (value: unknown) => {
          if (value instanceof Timestamp) {
            return value.toDate();
          }
          if (value instanceof Date) {
            return value;
          }
          return undefined;
        };

        setPack({
          id: snap.id,
          ...data,
          checkedOutAt: toDateIfTimestamp(data.checkedOutAt),
          lastCheckedAt: toDateIfTimestamp(data.lastCheckedAt),
        } as Statpack);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const getStatusColor = (s: string) => {
    if (s === 'Ready') return 'success';
    if (s === 'In Use') return 'primary';
    return 'danger';
  };

  const getStatusIcon = (s: string) => {
    if (s === 'Ready') return <ShieldCheck size={18} />;
    if (s === 'In Use') return <User size={18} />;
    return <AlertTriangle size={18} />;
  };

  if (loading || userRole === null) {
    return (
      <div className="h-screen flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }
  if (!pack) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 text-center p-6 bg-gray-100 dark:bg-zinc-950">
        <p className="text-lg font-semibold">No statpack selected</p>
        <p className="text-sm text-gray-500">Scan a QR code or open a statpack link with an id.</p>
        <Button color="primary" onPress={() => router.push('/statpacks')}>View Statpacks</Button>
      </div>
    );
  }

  const isCheckedOut = pack.status === 'In Use' || pack.isCheckedOut;
  const canReturn = userRole === 'admin' || pack.assignedToUserId === user?.uid;

  return (
    <div className="min-h-screen bg-gray-100 dark:bg-zinc-950 p-4 pb-20">
      <Card className="mb-6 border-t-4 border-primary shadow-md">
        <CardBody className="flex flex-row items-center gap-4 p-5">
          <div className="p-3 bg-primary/10 rounded-full text-primary shrink-0">
            <BriefcaseMedical size={32} />
          </div>
          <div>
            <h1 className="text-2xl font-black text-foreground leading-none">{pack.name}</h1>
            <span className="text-sm text-gray-400">{pack.type} Pack</span>
          </div>
        </CardBody>
      </Card>

      <div className="flex justify-between items-center mb-4 px-1">
        <span className="text-sm font-bold text-gray-500 uppercase">Current Status</span>
        <Chip
          color={getStatusColor(pack.status)}
          variant="flat"
          size="lg"
          startContent={getStatusIcon(pack.status)}
          className="font-bold capitalize"
        >
          {pack.status}
        </Chip>
      </div>

      <div className="space-y-4">
        {!isCheckedOut && (
          <Card className="border-success-200 dark:border-success-900 bg-white dark:bg-zinc-900">
            <CardHeader className="pb-0 pt-4 px-4 flex-col items-start">
              <h4 className="font-bold text-lg">Start Shift / Inspection</h4>
              <p className="text-sm text-gray-500">Scan items and take responsibility.</p>
            </CardHeader>
            <CardBody>
              <Button
                size="lg"
                color={pack.status === 'Restock Needed' ? 'warning' : 'success'}
                className="w-full font-bold text-lg shadow-lg"
                startContent={<LogOut />}
                onPress={() => router.push(`/mobile/checkout?id=${id}`)}
              >
                {pack.status === 'Restock Needed' ? 'Verify & Restock' : 'Check Out Bag'}
              </Button>
            </CardBody>
          </Card>
        )}

        {isCheckedOut && (
          <Card className="border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-900/20">
            <CardBody className="space-y-4">
              <div className="flex items-center gap-3">
                <Avatar name={pack.assignedToUserName} className="w-12 h-12" />
                <div>
                  <p className="text-xs text-blue-600 dark:text-blue-300 font-bold uppercase">Currently Assigned To</p>
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
          Statpacks
        </Button>
      </div>
    </div>
  );
}
