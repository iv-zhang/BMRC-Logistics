'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Card,
  CardBody,
  Button,
  Spinner,
  Progress,
  Input,
  Textarea
} from '@heroui/react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import {
  doc,
  getDoc,
  updateDoc,
  addDoc,
  collection,
  serverTimestamp
} from 'firebase/firestore';
import { auth, db } from '@/firebase';
import { Statpack } from '@/app/types';
import {
  ArrowLeft,
  CheckCircle2,
  Minus,
  Plus,
  ClipboardCheck
} from 'lucide-react';

export default function MobileCheckoutClient() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id') ?? '';
  const router = useRouter();

  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [pack, setPack] = useState<Statpack | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  const [activePocketIndex, setActivePocketIndex] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [eventName, setEventName] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        const returnUrl = id ? `/mobile/checkout?id=${id}` : '/mobile/checkout';
        router.push(`/login?returnUrl=${encodeURIComponent(returnUrl)}`);
        return;
      }
      setUser(u);

      if (!isSuccess) {
        await loadPack(id);
      }
    });
    return () => unsubscribe();
  }, [id, router, isSuccess]);

  const loadPack = async (packId: string) => {
    if (!packId) {
      setPack(null);
      setLoading(false);
      return;
    }
    try {
      const snap = await getDoc(doc(db, 'statpacks', packId));
      if (snap.exists()) {
        const data = { id: snap.id, ...snap.data() } as Statpack;
        setPack(data);

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

  const handleCountChange = (key: string, delta: number) => {
    setCounts(prev => {
      const current = prev[key] || 0;
      return { ...prev, [key]: Math.max(0, current + delta) };
    });
  };

  const handleNext = () => {
    if (activePocketIndex < pocketSteps.length) {
      setActivePocketIndex(prev => prev + 1);
      window.scrollTo(0, 0);
    }
  };

  const handleBack = () => {
    if (activePocketIndex > 0) setActivePocketIndex(prev => prev - 1);
    else router.back();
  };

  const handleCompleteCheckout = async () => {
    if (!pack || !user) return;
    setSubmitting(true);

    try {
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

      await updateDoc(doc(db, 'statpacks', pack.id), {
        contents: updatedContents,
        status: newStatus,
        isCheckedOut: true,
        assignedToUserId: user.uid,
        assignedToUserName: user.displayName || user.email,
        checkedOutAt: serverTimestamp(),
        currentEvent: eventName
      });

      await addDoc(collection(db, 'statpack_logs'), {
        statpackId: pack.id,
        action: 'checkout',
        userId: user.uid,
        timestamp: serverTimestamp(),
        notes: `Checkout. Status: ${newStatus}. Event: ${eventName}. Notes: ${notes}`
      });

      setIsSuccess(true);
      router.push(`/mobile?id=${pack.id}`);
    } catch (e) {
      console.error(e);
      alert('Error submitting checkout');
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (isSuccess) {
    return (
      <div className="h-screen flex flex-col items-center justify-center space-y-4 animate-pulse">
        <CheckCircle2 size={64} className="text-success" />
        <h2 className="text-2xl font-bold">Checkout Complete</h2>
        <p className="text-gray-500">Redirecting to dashboard...</p>
      </div>
    );
  }

  if (!pack) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 text-center p-6 bg-gray-50 dark:bg-zinc-950">
        <p className="text-lg font-semibold">No statpack selected</p>
        <p className="text-sm text-gray-500">Open this page with an id query parameter.</p>
        <Button color="primary" onPress={() => router.push('/statpacks')}>View Statpacks</Button>
      </div>
    );
  }

  const progressVal = ((activePocketIndex) / (pocketSteps.length)) * 100;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-zinc-950 pb-28">
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
              color="primary"
              size="lg"
              onPress={handleCompleteCheckout}
              isLoading={submitting}
            >
              Confirm Checkout
            </Button>
          </div>
        ) : (
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
