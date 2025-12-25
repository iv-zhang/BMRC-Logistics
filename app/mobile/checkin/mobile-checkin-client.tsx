'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Card,
  CardBody,
  Button,
  Chip,
  Spinner,
  Progress,
  Input,
  Textarea,
  Divider
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
import { Statpack, User } from '@/app/types';
import {
  ArrowLeft,
  ArrowRight,
  Save,
  Minus,
  Plus,
  RefreshCw,
  CheckCircle2,
  Stethoscope,
  FileText
} from 'lucide-react';

interface ItemState {
  originalQty: number;
  foundQty: number;
  restocked: boolean;
}

export default function MobileCheckinClient() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id') ?? '';
  const router = useRouter();

  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [userRole, setUserRole] = useState<User['role'] | null>(null);
  const [pack, setPack] = useState<Statpack | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  const [activePocketIndex, setActivePocketIndex] = useState(0);
  const [itemStates, setItemStates] = useState<Record<string, ItemState>>({});

  const [incidentId, setIncidentId] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        const returnUrl = id ? `/mobile/checkin?id=${id}` : '/mobile/checkin';
        router.push(`/login?returnUrl=${encodeURIComponent(returnUrl)}`);
        return;
      }
      setUser(u);
      try {
        const userSnap = await getDoc(doc(db, 'users', u.uid));
        const role = (userSnap.data() as User | undefined)?.role ?? 'member';
        setUserRole(role);
      } catch (e) {
        console.error('Failed to load user role:', e);
        setUserRole('member');
      }

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

        const initialStates: Record<string, ItemState> = {};
        data.contents?.forEach((item, idx) => {
          const key = `${item.itemId}_${idx}`;
          initialStates[key] = {
            originalQty: item.currentQuantity || 0,
            foundQty: item.currentQuantity || 0,
            restocked: false
          };
        });
        setItemStates(initialStates);
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

  const updateFoundQty = (key: string, delta: number) => {
    setItemStates(prev => {
      const current = prev[key];
      const newVal = Math.max(0, current.foundQty + delta);
      return {
        ...prev,
        [key]: { ...current, foundQty: newVal }
      };
    });
  };

  const toggleRestock = (key: string) => {
    setItemStates(prev => {
      const current = prev[key];
      return {
        ...prev,
        [key]: { ...current, restocked: !current.restocked }
      };
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

  const handleCompleteCheckin = async () => {
    if (!pack || !user) return;
    const isReturnAllowed = userRole === 'admin' || pack.assignedToUserId === user.uid;
    if (!isReturnAllowed) {
      alert('Only the assignee or an admin can return this bag.');
      return;
    }
    setSubmitting(true);

    try {
      let overallStatus: Statpack['status'] = 'Ready';
      const usageReport: string[] = [];
      const restockReport: string[] = [];
      const missingReport: string[] = [];

      const updatedContents = pack.contents.map((item, idx) => {
        const key = `${item.itemId}_${idx}`;
        const state = itemStates[key];

        const usedAmount = state.originalQty - state.foundQty;
        if (usedAmount > 0) {
          usageReport.push(`${usedAmount}x ${item.itemDetails?.name}`);
        }

        const finalQty = state.restocked ? item.requiredQuantity : state.foundQty;

        if (state.restocked) {
          restockReport.push(item.itemDetails?.name || 'Item');
        }

        if (finalQty < item.requiredQuantity) {
          overallStatus = 'Restock Needed';
          missingReport.push(`${item.itemDetails?.name} (${finalQty}/${item.requiredQuantity})`);
        }

        return { ...item, currentQuantity: finalQty };
      });

      await updateDoc(doc(db, 'statpacks', pack.id), {
        contents: updatedContents,
        status: overallStatus,
        isCheckedOut: false,
        lastCheckedBy: user.uid,
        lastCheckedAt: serverTimestamp(),
        assignedToUserId: null,
        assignedToUserName: null,
        currentEvent: null
      });

      await addDoc(collection(db, 'statpack_logs'), {
        statpackId: pack.id,
        statpackName: pack.name,
        action: 'checkin',
        userId: user.uid,
        userName: user.displayName || user.email,
        timestamp: serverTimestamp(),
        notes: `Check-in Complete.\n\nUsage:\n${usageReport.join('\n') || 'None'}\n\nRestocked:\n${restockReport.join(', ') || 'None'}\n\nIncident ID: ${incidentId}\nNotes: ${notes}`
      });

      setIsSuccess(true);
      router.push(`/mobile?id=${pack.id}`);
    } catch (e) {
      console.error(e);
      alert('Error processing check-in');
      setSubmitting(false);
    }
  };

  if (loading || userRole === null) {
    return (
      <div className="h-screen flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (isSuccess) {
    return (
      <div className="h-screen flex flex-col items-center justify-center space-y-4 animate-fade-in">
        <CheckCircle2 size={64} className="text-success" />
        <h2 className="text-2xl font-bold">Check-In Complete</h2>
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

  const isReturnAllowed = userRole === 'admin' || pack.assignedToUserId === user?.uid;
  if (!isReturnAllowed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-zinc-950 p-6">
        <Card className="max-w-md w-full">
          <CardBody className="space-y-3 text-center">
            <h2 className="text-xl font-bold">Return Restricted</h2>
            <p className="text-sm text-gray-500">
              Only the assignee or an admin can return this bag.
            </p>
            <Button color="primary" onPress={() => router.push(`/mobile?id=${id}`)}>
              Back to Bag
            </Button>
          </CardBody>
        </Card>
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
            <span className="text-xs text-gray-500">Check-In / Restock</span>
          </div>
          <div className="w-8"></div>
        </div>
        <Progress size="sm" value={progressVal} color="success" aria-label="progress" className="w-full" />
      </div>

      <div className="p-4 max-w-lg mx-auto">
        {isLastStep ? (
          <div className="space-y-6 animate-fade-in">
            <div className="text-center space-y-2">
              <RefreshCw size={48} className="mx-auto text-success" />
              <h2 className="text-2xl font-bold">Summary</h2>
              <p className="text-gray-500">Confirm usage and return bag to storage.</p>
            </div>

            <Card className="border shadow-sm">
              <CardBody className="space-y-2">
                <div className="flex items-center gap-2 font-bold text-gray-700 dark:text-gray-200">
                  <Stethoscope size={18} />
                  <span>Supplies Used</span>
                </div>
                <Divider />
                <ul className="text-sm space-y-1 pl-2">
                  {Object.entries(itemStates).map(([key, state]) => {
                    if (state.originalQty > state.foundQty) {
                      const idx = Number(key.split('_')[1]);
                      const name = pack.contents[idx].itemDetails?.name;
                      return (
                        <li key={key} className="flex justify-between">
                          <span>{name}</span>
                          <span className="font-mono font-bold text-danger">-{state.originalQty - state.foundQty}</span>
                        </li>
                      );
                    }
                    return null;
                  })}
                  {!Object.values(itemStates).some(s => s.originalQty > s.foundQty) && (
                    <li className="text-gray-400 italic">No usage recorded.</li>
                  )}
                </ul>
              </CardBody>
            </Card>

            <div className="space-y-4">
              <Input
                label="Incident / PCR Number"
                placeholder="e.g. 23-00512"
                value={incidentId}
                onValueChange={setIncidentId}
                startContent={<FileText size={16} className="text-gray-400" />}
              />
              <Textarea
                label="Shift Notes"
                placeholder="Any issues with the bag or equipment?"
                value={notes}
                onValueChange={setNotes}
              />
            </div>
          </div>
        ) : (
          <div className="space-y-4 animate-fade-in">
            <h2 className="text-2xl font-bold capitalize mb-4">{currentPocket?.replace('_', ' ')}</h2>

            <div className="space-y-3">
              {currentItems.map(({ item, originalIndex }) => {
                const key = `${item.itemId}_${originalIndex}`;
                const state = itemStates[key] || { foundQty: 0, restocked: false, originalQty: 0 };
                const req = item.requiredQuantity;
                const isFoundLow = state.foundQty < req;
                const isRestocked = state.restocked;
                const effectiveCount = isRestocked ? req : state.foundQty;

                return (
                  <Card key={key} className={`border transition-colors ${effectiveCount < req ? 'border-warning' : 'border-gray-200 dark:border-zinc-800'}`}>
                    <CardBody className="p-3">
                      <div className="flex justify-between items-start mb-3">
                        <div>
                          <p className="font-semibold text-sm">{item.itemDetails?.name}</p>
                          <p className="text-xs text-gray-500">Required: {req}</p>
                        </div>
                        {isRestocked && <Chip size="sm" color="success" variant="flat">Restocked</Chip>}
                      </div>

                      <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2 bg-gray-50 dark:bg-zinc-800 rounded-lg p-1 border">
                          <Button isIconOnly size="sm" variant="light" onPress={() => updateFoundQty(key, -1)}>
                            <Minus size={14} />
                          </Button>
                          <div className="flex flex-col items-center w-8">
                            <span className="font-bold text-lg leading-none">{state.foundQty}</span>
                            <span className="text-[10px] text-gray-400 uppercase">Left</span>
                          </div>
                          <Button isIconOnly size="sm" variant="light" onPress={() => updateFoundQty(key, 1)}>
                            <Plus size={14} />
                          </Button>
                        </div>

                        {isFoundLow && (
                          <div className="flex-grow flex justify-end">
                            <Button
                              size="sm"
                              color={state.restocked ? 'success' : 'warning'}
                              variant={state.restocked ? 'solid' : 'ghost'}
                              onPress={() => toggleRestock(key)}
                              startContent={state.restocked ? <CheckCircle2 size={14} /> : <RefreshCw size={14} />}
                            >
                              {state.restocked ? 'Filled' : 'Restock'}
                            </Button>
                          </div>
                        )}
                      </div>

                      {state.originalQty > state.foundQty && (
                        <p className="text-xs text-danger mt-2 flex items-center gap-1">
                          <Minus size={10} /> Used {state.originalQty - state.foundQty} this shift
                        </p>
                      )}
                    </CardBody>
                  </Card>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="fixed bottom-0 left-0 right-0 p-4 bg-white dark:bg-zinc-900 border-t dark:border-zinc-800 z-30">
        <div className="max-w-lg mx-auto flex gap-3">
          <Button
            variant="light"
            onPress={handleBack}
            isDisabled={activePocketIndex === 0}
            className="flex-1"
          >
            Back
          </Button>

          {isLastStep ? (
            <Button
              className="flex-[2] font-bold shadow-lg"
              color="success"
              size="lg"
              onPress={handleCompleteCheckin}
              isLoading={submitting}
              startContent={<Save />}
            >
              Complete Check-In
            </Button>
          ) : (
            <Button
              className="flex-[2] font-bold"
              color="primary"
              size="lg"
              onPress={handleNext}
              endContent={<ArrowRight />}
            >
              Next Pocket
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
