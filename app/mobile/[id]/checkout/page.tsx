'use client';

import React, { useEffect, useState, use, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { 
  Card, CardBody, Button, Spinner, Progress,
  Input, Textarea
} from '@heroui/react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { 
  doc, getDoc, updateDoc, addDoc, collection, serverTimestamp 
} from 'firebase/firestore';
import { auth, db } from '@/firebase'; 
import { Statpack } from '@/app/types'; 
import { 
  ArrowLeft, CheckCircle2, 
  Minus, Plus, ClipboardCheck
} from 'lucide-react';

interface MobileCheckoutProps {
  params: Promise<{ id: string }>;
}

export default function MobileCheckoutPage({ params }: MobileCheckoutProps) {
  const { id } = use(params); 
  const router = useRouter();
  
  // -- State --
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [pack, setPack] = useState<Statpack | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  
  // ✨ FIX 1: Add success state to block "Not Found" errors during redirect
  const [isSuccess, setIsSuccess] = useState(false);

  // -- Wizard State --
  const [activePocketIndex, setActivePocketIndex] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({}); 
  const [eventName, setEventName] = useState("");
  const [notes, setNotes] = useState("");

  // -- Setup & Fetch --
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.push(`/login?returnUrl=/mobile/${id}/checkout`);
        return;
      }
      setUser(u);
      
      // ✨ FIX 2: Only load if we haven't succeeded yet
      if (!isSuccess) { 
        await loadPack(id);
      }
    });
    return () => unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]); // Removed 'router' from dependencies to prevent loop

  const loadPack = async (packId: string) => {
    try {
      const snap = await getDoc(doc(db, 'statpacks', packId));
      if (snap.exists()) {
        const data = { id: snap.id, ...snap.data() } as Statpack;
        setPack(data);
        
        // Initialize counts
        const initialCounts: Record<string, number> = {};
        data.contents?.forEach((item, idx) => {
          initialCounts[`${item.itemId}_${idx}`] = 0; 
        });
        setCounts(initialCounts);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  // -- Computed Data --
  const pocketSteps = useMemo(() => {
    if (!pack?.contents) return [];
    const pockets = Array.from(new Set(pack.contents.map(i => i.pocket || 'Main')));
    return pockets.sort((a, b) => {
      if (a === 'Main') return -1;
      if (b === 'Main') return 1;
      return 0;
    });
  }, [pack]);

  const currentPocket = pocketSteps[activePocketIndex];
  const isLastStep = activePocketIndex === pocketSteps.length; 

  const currentItems = useMemo(() => {
    if (!pack?.contents || isLastStep) return [];
    return pack.contents
      .map((item, originalIndex) => ({ item, originalIndex }))
      .filter(({ item }) => (item.pocket || 'Main') === currentPocket);
  }, [pack, currentPocket, isLastStep]);

  // -- Handlers --
  const handleCountChange = (key: string, delta: number) => {
    setCounts(prev => {
      const current = prev[key] || 0;
      return { ...prev, [key]: Math.max(0, current + delta) };
    });
  };

  const handleNext = () => {
    if (activePocketIndex < pocketSteps.length) {
      setActivePocketIndex(prev => prev + 1);
      window.scrollTo(0,0);
    }
  };

  const handleBack = () => {
    if (activePocketIndex > 0) setActivePocketIndex(prev => prev - 1);
    else router.back();
  };

  // -- Submission --
  const handleCompleteCheckout = async () => {
    if (!pack || !user) return;
    setSubmitting(true);

    try {
      // 1. Calculate status
      let newStatus: Statpack['status'] = 'In Use';
      const missingItems: string[] = [];
      const updatedContents = pack.contents.map((item, idx) => {
        const count = counts[`${item.itemId}_${idx}`] || 0;
        if (count < item.requiredQuantity) {
          newStatus = 'Restock Needed';
          missingItems.push(`${item.itemDetails?.name} (${count}/${item.requiredQuantity})`);
        }
        return { ...item, currentQuantity: count };
      });

      // 2. Update Pack
      await updateDoc(doc(db, 'statpacks', pack.id), {
        contents: updatedContents,
        status: newStatus,
        isCheckedOut: true,
        assignedToUserId: user.uid,
        assignedToUserName: user.displayName || user.email,
        checkedOutAt: serverTimestamp(),
        currentEvent: eventName
      });

      // 3. Log it
      await addDoc(collection(db, 'statpack_logs'), {
        statpackId: pack.id,
        action: 'checkout',
        userId: user.uid,
        timestamp: serverTimestamp(),
        notes: `Checkout. Status: ${newStatus}. Event: ${eventName}. Notes: ${notes}`
      });

      // ✨ FIX 3: Set success state BEFORE routing
      setIsSuccess(true); 
      
      // 4. Redirect
      router.push(`/mobile/${id}`); // Back to dashboard
      
    } catch (e) {
      console.error(e);
      alert("Error submitting checkout");
      setSubmitting(false); 
    }
  };

  // -- RENDER STATES --

  // 1. Loading
  if (loading) return <div className="h-screen flex items-center justify-center"><Spinner size="lg"/></div>;
  
  // 2. ✨ SUCCESS STATE (Prevents "Pack Not Found" flash)
  if (isSuccess) return (
    <div className="h-screen flex flex-col items-center justify-center space-y-4 animate-pulse">
      <CheckCircle2 size={64} className="text-success" />
      <h2 className="text-2xl font-bold">Checkout Complete</h2>
      <p className="text-gray-500">Redirecting to dashboard...</p>
    </div>
  );

  // 3. Not Found (Only shows if NOT loading and NOT success)
  if (!pack) return <div className="p-6 text-center mt-10">Pack not found.</div>;

  // -- MAIN RENDER --
  const progressVal = ((activePocketIndex) / (pocketSteps.length)) * 100;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-zinc-950 pb-28">
      
      {/* Header */}
      <div className="bg-white dark:bg-zinc-900 sticky top-0 z-20 shadow-sm">
        <div className="px-4 py-3 flex items-center justify-between">
          <Button isIconOnly size="sm" variant="light" onPress={handleBack}>
            <ArrowLeft />
          </Button>
          <div className="text-center">
            <h1 className="font-bold text-sm uppercase tracking-wider">{pack.name}</h1>
            <span className="text-xs text-gray-500">Checkout Mode</span>
          </div>
          <div className="w-8"></div> 
        </div>
        <Progress size="sm" value={progressVal} color="primary" aria-label="progress" className="w-full" />
      </div>

      <div className="p-4 max-w-lg mx-auto">
        {isLastStep ? (
          // --- REVIEW STEP ---
          <div className="space-y-6 animate-fade-in">
            <div className="text-center space-y-2">
              <ClipboardCheck size={48} className="mx-auto text-primary" />
              <h2 className="text-2xl font-bold">Final Review</h2>
              <p className="text-gray-500">Confirm details before taking the bag.</p>
            </div>
            
            <Input label="Event Name" placeholder="e.g. Varsity Game" value={eventName} onValueChange={setEventName} />
            <Textarea label="Notes" placeholder="Any issues?" value={notes} onValueChange={setNotes} />
            
            <Button 
              className="w-full font-bold shadow-lg mt-4" 
              color="primary" size="lg"
              onPress={handleCompleteCheckout}
              isLoading={submitting}
            >
              Confirm Checkout
            </Button>
          </div>
        ) : (
          // --- COUNTING STEPS ---
          <div className="space-y-4 animate-fade-in">
             <h2 className="text-2xl font-bold capitalize">{currentPocket}</h2>
             
             {currentItems.map(({ item, originalIndex }) => {
               const key = `${item.itemId}_${originalIndex}`;
               const count = counts[key] || 0;
               const req = item.requiredQuantity;
               
               return (
                 <Card key={key} className="border border-gray-200 dark:border-zinc-800">
                   <CardBody className="flex flex-row items-center justify-between p-3">
                     <div className="flex-grow">
                       <div className="font-semibold text-sm">{item.itemDetails?.name}</div>
                       <div className="text-xs text-gray-500">Required: {req}</div>
                     </div>
                     <div className="flex items-center gap-3 bg-gray-100 dark:bg-zinc-800 rounded-lg p-1">
                       <Button isIconOnly size="sm" variant="light" onPress={() => handleCountChange(key, -1)}>
                         <Minus size={16} />
                       </Button>
                       <span className="font-mono font-bold w-4 text-center">{count}</span>
                       <Button isIconOnly size="sm" variant="light" onPress={() => handleCountChange(key, 1)}>
                         <Plus size={16} />
                       </Button>
                     </div>
                   </CardBody>
                 </Card>
               );
             })}
             
             <Button className="w-full mt-4" color="primary" onPress={handleNext}>
               Next Pocket
             </Button>
          </div>
        )}
      </div>
    </div>
  );
}
