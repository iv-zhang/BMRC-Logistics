'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Button, Card, CardBody, Progress } from '@heroui/react';
import {
  Home,
  ClipboardList,
  LogIn,
  Package,
  User,
  X,
  ChevronRight,
  ChevronLeft,
  Sparkles,
  CheckCircle,
} from 'lucide-react';
import { doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '@/firebase';

interface TutorialStep {
  title: string;
  description: string;
  icon: React.ReactNode;
  tip?: string;
}

const TUTORIAL_STEPS: TutorialStep[] = [
  {
    title: 'Welcome to BMRC Logistics!',
    description:
      'This quick tutorial will walk you through the key areas of the app. You can skip it at any time and revisit it from your profile.',
    icon: <Sparkles size={32} className="text-primary" />,
    tip: 'You can always ask an admin to reset the tutorial if you need a refresher.',
  },
  {
    title: 'Dashboard',
    description:
      'Your home base. The dashboard shows recent activity, inventory alerts, and quick links to check out or return a statpack.',
    icon: <Home size={32} className="text-indigo-500" />,
    tip: 'Check the dashboard at the start of every shift to see any alerts or announcements.',
  },
  {
    title: 'Statpack Checkout',
    description:
      'Before each shift, check out your assigned statpack. You\'ll go through each pocket and verify the item counts match what\'s required. If something is short, note the shortage and restock if possible.',
    icon: <ClipboardList size={32} className="text-blue-500" />,
    tip: 'Tap the count to edit it. If a count is short, you\'ll be prompted to restock or explain why.',
  },
  {
    title: 'Check-In',
    description:
      'At the end of your shift, check in your statpack and any assets. This logs what was used and helps the team track inventory usage over time.',
    icon: <LogIn size={32} className="text-emerald-500" />,
    tip: 'Note any items you used during the shift — this helps quartermasters restock accurately.',
  },
  {
    title: 'Inventory & Assets',
    description:
      'Browse the full inventory of supplies and assets. Assets (like monitors and radios) require barcode verification. Disposables are tracked by box count.',
    icon: <Package size={32} className="text-amber-500" />,
    tip: 'If you notice something damaged or low, use the issue report button in the menu.',
  },
  {
    title: 'Your Profile',
    description:
      'View your shift history, update your information, and manage preferences. You can also find a link to re-run this tutorial here.',
    icon: <User size={32} className="text-violet-500" />,
    tip: 'Keep your contact info up to date so leads can reach you during shifts.',
  },
];

interface TutorialOverlayProps {
  userId: string;
  onComplete: () => void;
}

export default function TutorialOverlay({ userId, onComplete }: TutorialOverlayProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [exiting, setExiting] = useState(false);

  const step = TUTORIAL_STEPS[currentStep];
  const isLast = currentStep === TUTORIAL_STEPS.length - 1;

  const finishTutorial = useCallback(async () => {
    setExiting(true);
    try {
      await updateDoc(doc(db, 'users', userId), {
        tutorialCompleted: true,
        tutorialCompletedAt: serverTimestamp(),
      });
    } catch (e) {
      console.error('Failed to save tutorial completion:', e);
    }
    // Small delay for exit animation
    setTimeout(() => onComplete(), 300);
  }, [userId, onComplete]);

  const handleSkip = () => finishTutorial();
  const handleNext = () => {
    if (isLast) {
      finishTutorial();
    } else {
      setCurrentStep((s) => s + 1);
    }
  };
  const handleBack = () => setCurrentStep((s) => Math.max(0, s - 1));

  // Keyboard nav
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'Enter') handleNext();
      else if (e.key === 'ArrowLeft') handleBack();
      else if (e.key === 'Escape') handleSkip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep, isLast]);

  return (
    <div
      className={`fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm transition-opacity duration-300 ${
        exiting ? 'opacity-0' : 'opacity-100'
      }`}
    >
      <Card
        className={`w-[90vw] max-w-md mx-auto shadow-2xl transition-all duration-300 ${
          exiting ? 'scale-95 opacity-0' : 'scale-100 opacity-100'
        }`}
      >
        <CardBody className="p-6">
          {/* Skip button */}
          <div className="flex justify-end mb-2">
            <Button
              size="sm"
              variant="light"
              className="text-default-400"
              startContent={<X size={14} />}
              onPress={handleSkip}
            >
              Skip Tutorial
            </Button>
          </div>

          {/* Progress */}
          <Progress
            size="sm"
            value={((currentStep + 1) / TUTORIAL_STEPS.length) * 100}
            color="primary"
            className="mb-4"
            aria-label="Tutorial progress"
          />
          <p className="text-xs text-default-400 text-center mb-4">
            Step {currentStep + 1} of {TUTORIAL_STEPS.length}
          </p>

          {/* Icon + Content */}
          <div className="flex flex-col items-center text-center gap-4 min-h-[220px]">
            <div className="p-4 rounded-2xl bg-default-100">{step.icon}</div>
            <h2 className="text-xl font-bold">{step.title}</h2>
            <p className="text-sm text-default-600 leading-relaxed">{step.description}</p>
            {step.tip && (
              <div className="w-full bg-primary-50 dark:bg-primary-900/20 rounded-lg px-4 py-3 text-left">
                <p className="text-xs text-primary-700 dark:text-primary-300">
                  <strong>💡 Tip:</strong> {step.tip}
                </p>
              </div>
            )}
          </div>

          {/* Step dots */}
          <div className="flex justify-center gap-2 mt-4">
            {TUTORIAL_STEPS.map((_, i) => (
              <button
                key={i}
                onClick={() => setCurrentStep(i)}
                className={`w-2.5 h-2.5 rounded-full transition-all ${
                  i === currentStep
                    ? 'bg-primary w-6'
                    : i < currentStep
                      ? 'bg-primary/40'
                      : 'bg-default-200'
                }`}
                aria-label={`Go to step ${i + 1}`}
              />
            ))}
          </div>

          {/* Navigation */}
          <div className="flex justify-between mt-6">
            <Button
              variant="flat"
              onPress={handleBack}
              isDisabled={currentStep === 0}
              startContent={<ChevronLeft size={16} />}
            >
              Back
            </Button>
            <Button
              color="primary"
              onPress={handleNext}
              endContent={isLast ? <CheckCircle size={16} /> : <ChevronRight size={16} />}
            >
              {isLast ? "Let's Go!" : 'Next'}
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
