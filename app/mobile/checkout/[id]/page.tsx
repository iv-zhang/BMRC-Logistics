// app/mobile/checkout/[id]/page.tsx
'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { 
  Card, CardBody, CardHeader, CardFooter,
  Button, Chip, Divider, Spinner,
  Input, Textarea, Avatar
} from '@heroui/react';
import { onAuthStateChanged } from 'firebase/auth';
import { 
  doc, getDoc, updateDoc, addDoc, collection, serverTimestamp 
} from 'firebase/firestore';
import { auth, db } from '@/firebase'; // Adjust path as needed
import { Statpack, StatpackLog } from '@/app/types'; // Adjust path as needed
import { 
  BriefcaseMedical, CheckCircle2, AlertTriangle, 
  ArrowLeft, ShieldCheck, MapPin 
} from 'lucide-react';

interface MobileCheckoutProps {
  params: {
    id: string;
  };
}

export default function MobileCheckoutPage({ params }: MobileCheckoutProps) {
  const router = useRouter();
  const packId = params.id;

  const [user, setUser] = useState<any>(null);
  const [pack, setPack] = useState<Statpack | null>(null);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  
  // Checkout Form State
  const [eventName, setEventName] = useState("");
  const [notes, setNotes] = useState("");

  // 1. Auth & Data Fetch
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (!currentUser) {
        // Redirect to login, but keep the return URL so they come back here after login
        router.push(`/login?returnUrl=/mobile/checkout/${packId}`);
        return;
      }
      setUser(currentUser);
      await fetchPackData(packId);
    });
    return () => unsubscribe();
  }, [packId, router]);

  const fetchPackData = async (id: string) => {
    try {
      const docRef = doc(db, 'statpacks', id);
      const docSnap = await getDoc(docRef);
      
      if (docSnap.exists()) {
        setPack({ id: docSnap.id, ...docSnap.data() } as Statpack);
      } else {
        setPack(null);
      }
    } catch (error) {
      console.error("Error fetching pack:", error);
    } finally {
      setLoading(false);
    }
  };

  // 2. Checkout Logic
  const handleConfirmCheckout = async () => {
    if (!pack || !user) return;
    setProcessing(true);

    try {
      // A. Update the Pack Status
      const packRef = doc(db, 'statpacks', pack.id);
      await updateDoc(packRef, {
        status: 'In Use',
        isCheckedOut: true,
        assignedToUserId: user.uid,
        assignedToUserName: user.displayName || user.email,
        checkedOutAt: serverTimestamp(),
        lastCheckedBy: user.uid,
        lastCheckedAt: serverTimestamp(),
        // Optional: Store the specific event name on the pack if your type supports it
        currentEvent: eventName 
      });

      // B. Create the Log Entry
      const logEntry: StatpackLog = {
        statpackId: pack.id,
        statpackName: pack.name,
        action: 'checkout',
        userId: user.uid,
        userName: user.displayName || user.email,
        timestamp: serverTimestamp(),
        notes: `Mobile Scan Checkout. Event: ${eventName || 'N/A'}. Notes: ${notes}`
      };
      await addDoc(collection(db, 'statpack_logs'), logEntry);

      // C. Refresh Local State
      await fetchPackData(pack.id);
      alert("Checkout Successful!");
      
      // Optional: Redirect to a dashboard or list
      router.push('/mobile/dashboard'); 
    } catch (error) {
      console.error("Checkout failed:", error);
      alert("Error processing checkout.");
    } finally {
      setProcessing(false);
    }
  };

  // 3. Render Helpers
  const getStatusColor = (s: string) => {
    if (s === 'Ready') return 'success';
    if (s === 'In Use') return 'warning';
    return 'danger';
  };

  if (loading) {
    return (
      <div className="min-h-screen w-full flex flex-col items-center justify-center bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 gap-4">
        <Spinner size="lg" />
        <p className="text-sm text-gray-500 animate-pulse">Locating Statpack...</p>
      </div>
    );
  }

  if (!pack) {
    return (
      <div className="min-h-screen p-6 flex flex-col items-center justify-center text-center bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
        <AlertTriangle size={48} className="text-danger mb-4" />
        <h1 className="text-2xl font-bold">Statpack Not Found</h1>
        <p className="text-gray-500 mt-2">The QR code scanned does not match any active inventory.</p>
        <Button className="mt-6" onPress={() => router.push('/')}>Return Home</Button>
      </div>
    );
  }

  // 4. Main UI
  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-4 pb-20">
      
      {/* Top Bar */}
      <div className="flex items-center gap-2 mb-6">
        <Button isIconOnly variant="light" onPress={() => router.back()}>
          <ArrowLeft size={20} />
        </Button>
        <span className="font-bold text-lg">Express Checkout</span>
      </div>

      <div className="max-w-md mx-auto space-y-4">
        
        {/* Pack Identity Card */}
        <Card className="border-t-4 border-primary shadow-md">
          <CardBody className="flex flex-row items-center gap-4 p-5">
            <div className="p-3 bg-primary/10 rounded-full text-primary">
              <BriefcaseMedical size={32} />
            </div>
            <div className="flex flex-col">
              <span className="text-xs text-gray-500 uppercase tracking-wider font-bold">You Scanned</span>
              <h2 className="text-2xl font-black text-foreground">{pack.name}</h2>
              <span className="text-sm text-gray-400">{pack.type} Bag</span>
            </div>
          </CardBody>
        </Card>

        {/* Status Check */}
        {pack.status !== 'Ready' && (
          <Card className={`border border-${getStatusColor(pack.status)} bg-${getStatusColor(pack.status)}/10`}>
            <CardBody className="flex gap-3 items-start">
              <AlertTriangle className={`text-${getStatusColor(pack.status)} shrink-0`} />
              <div>
                <h3 className="font-bold text-foreground">Warning: {pack.status}</h3>
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                  {pack.isCheckedOut 
                    ? `Currently checked out by ${pack.assignedToUserName}` 
                    : "This bag is marked as incomplete or expired."}
                </p>
              </div>
            </CardBody>
          </Card>
        )}

        {/* Action Form */}
        <Card>
          <CardHeader className="pb-0">
             <span className="text-sm font-bold text-gray-500 uppercase">Mission Details</span>
          </CardHeader>
          <CardBody className="space-y-4">
            <Input 
              label="Event / Mission Name" 
              placeholder="e.g. Friday Night Football" 
              value={eventName}
              onValueChange={setEventName}
              variant="bordered"
              startContent={<MapPin size={16} className="text-gray-400" />}
            />
            <Textarea 
              label="Pre-Check Notes" 
              placeholder="Any visible damage? Seals intact?" 
              minRows={2}
              value={notes}
              onValueChange={setNotes}
              variant="bordered"
            />
            
            <div className="bg-white/80 dark:bg-slate-800/80 p-3 rounded-lg text-xs text-gray-500 flex gap-2">
               <ShieldCheck size={16} className="text-success shrink-0" />
               <span>By checking out, you assume responsibility for this kit and its contents until return.</span>
            </div>
          </CardBody>
          <CardFooter className="flex flex-col gap-3">
             <Button 
                size="lg" 
                color="primary" 
                className="w-full font-bold text-lg shadow-lg shadow-primary/40"
                startContent={<CheckCircle2 />}
                isLoading={processing}
                onPress={handleConfirmCheckout}
                // Only disable if it's already checked out by someone else
                isDisabled={pack.isCheckedOut && pack.assignedToUserId !== user.uid}
             >
                {pack.isCheckedOut && pack.assignedToUserId === user.uid 
                  ? "Update Checkout Info" 
                  : "Confirm Checkout"}
             </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
