'use client';

import React, { useEffect, useState, use } from 'react';
import { useRouter } from 'next/navigation';
import { 
  Card, CardBody, CardHeader, CardFooter,
  Button, Chip, Spinner, Avatar, Divider
} from '@heroui/react';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/firebase'; 
import { Statpack } from '@/app/types'; 
import { 
  BriefcaseMedical, LogOut, LogIn, AlertTriangle, 
  History, ShieldCheck, User, Clock
} from 'lucide-react';

interface MobileDashboardProps {
  params: Promise<{ id: string }>;
}

export default function MobilePackDashboard({ params }: MobileDashboardProps) {
  const { id } = use(params);
  const router = useRouter();
  
  const [pack, setPack] = useState<Statpack | null>(null);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<any>(null);

  // 1. Auth & Fetch
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      // Allow viewing dashboard even if not logged in? 
      // Usually better to force login to see sensitive bag data.
      if (!u) {
        router.push(`/login?returnUrl=/mobile/${id}`);
        return;
      }
      setUser(u);
      loadPack(id);
    });
    return () => unsubscribe();
  }, [id, router]);

  const loadPack = async (packId: string) => {
    try {
      const snap = await getDoc(doc(db, 'statpacks', packId));
      if (snap.exists()) {
        setPack({ id: snap.id, ...snap.data() } as Statpack);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  // 2. Render Helpers
  const getStatusColor = (s: string) => {
    if (s === 'Ready') return 'success';
    if (s === 'In Use') return 'primary'; // Blue for in-use
    return 'danger';
  };

  const getStatusIcon = (s: string) => {
    if (s === 'Ready') return <ShieldCheck size={18} />;
    if (s === 'In Use') return <User size={18} />;
    return <AlertTriangle size={18} />;
  };

  if (loading) return <div className="h-screen flex items-center justify-center"><Spinner size="lg" /></div>;
  if (!pack) return <div className="p-6 text-center">Pack not found</div>;

  const isCheckedOut = pack.status === 'In Use' || pack.isCheckedOut;

  return (
    <div className="min-h-screen bg-gray-100 dark:bg-zinc-950 p-4 pb-20">
      
      {/* Top Identity Card */}
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

      {/* Status Indicator */}
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

      {/* Main Action Area */}
      <div className="space-y-4">
        
        {/* SCENARIO A: Bag is Ready (or Needs Restock) -> Check Out */}
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
                onPress={() => router.push(`/mobile/${id}/checkout`)}
              >
                {pack.status === 'Restock Needed' ? 'Verify & Restock' : 'Check Out Bag'}
              </Button>
            </CardBody>
          </Card>
        )}

        {/* SCENARIO B: Bag is In Use -> Check In */}
        {isCheckedOut && (
          <Card className="border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-900/20">
            <CardBody className="space-y-4">
              {/* Assignee Info */}
              <div className="flex items-center gap-3">
                <Avatar name={pack.assignedToUserName} className="w-12 h-12" />
                <div>
                  <p className="text-xs text-blue-600 dark:text-blue-300 font-bold uppercase">Currently Assigned To</p>
                  <p className="font-bold text-lg">{pack.assignedToUserName || 'Unknown User'}</p>
                  <div className="flex items-center gap-1 text-xs text-gray-500">
                    <Clock size={12} />
                    <span>Since {pack.checkedOutAt?.toDate ? pack.checkedOutAt.toDate().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'Unknown time'}</span>
                  </div>
                </div>
              </div>

              <Divider className="my-2"/>

              <Button 
                size="lg" 
                color="primary" 
                className="w-full font-bold text-lg shadow-lg"
                startContent={<LogIn />}
                onPress={() => router.push(`/mobile/${id}/checkin`)}
                // Optional: Only allow the assignee or an admin to check it back in?
                // isDisabled={pack.assignedToUserId !== user.uid} 
              >
                Return & Restock
              </Button>
            </CardBody>
          </Card>
        )}
      </div>

      {/* Secondary Actions / Info */}
      <div className="mt-8 grid grid-cols-2 gap-3">
        <Button variant="flat" startContent={<History size={18}/>}>
          View History
        </Button>
        <Button variant="flat" onPress={() => router.push(`/mobile/dashboard`)}>
          My Dashboard
        </Button>
      </div>

    </div>
  );
}