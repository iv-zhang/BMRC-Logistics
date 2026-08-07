'use client';

/**
 * Interactive, role-aware onboarding tour. Mounted once in sidebar-layout so it
 * survives client-side navigation. Highlights real on-screen elements (matched
 * by `data-tour="<key>"`) and, on "click-target" steps, waits for the user to
 * actually click the highlighted element (which usually navigates).
 *
 * Desktop and mobile run *different step lists* (see `tutorial-tours.ts`) and
 * different callout chrome: on a phone the callout is a full-width sheet pinned
 * to the top or bottom edge, since there is no room beside a highlighted target.
 * The variant is chosen from the same breakpoint the nav uses (`sm`): below it
 * the icon rail is gone and the bottom bar takes over.
 *
 * Triggers exactly once — on first use of a fresh account (`tutorialCompleted`
 * not yet true) — and can be replayed on demand via the `bmrc-replay-tutorial`
 * window event (fired by the Profile → Settings "Replay tutorial" button).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '@/firebase';
import { Button } from '@heroui/react';
import { X, ChevronLeft, ChevronRight, CheckCircle, MousePointerClick, Sparkles } from 'lucide-react';
import { useUserRole } from '@/app/hooks/useUserRole';
import { getTourSteps, type TourStep, type TourVariant } from '@/app/lib/tutorial-tours';

const CALLOUT_W = 320;
const MARGIN = 12;
/** Matches the `sm` breakpoint: below it the rail is hidden and the bottom bar shows. */
const MOBILE_QUERY = '(max-width: 639px)';

/** Local completion fast-path key (see the first-run trigger below). */
const localDoneKey = (uid: string) => `bmrc_tutorial_done_v1_${uid}`;

function localTutorialDone(uid: string): boolean {
  try {
    return localStorage.getItem(localDoneKey(uid)) === '1';
  } catch {
    return false;
  }
}

export default function OnboardingTour() {
  const { user, userData, role, isRoleOverridden, effectiveUid } = useUserRole();
  const [active, setActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  /** Index of the step whose target never showed up — never a stale earlier one. */
  const [missingIndex, setMissingIndex] = useState<number | null>(null);

  // ── Viewport variant ──────────────────────────────────────────────────────
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  const variant: TourVariant = isMobile ? 'mobile' : 'desktop';

  const steps = useMemo(() => getTourSteps(role, variant), [role, variant]);
  const step: TourStep | null = active ? steps[stepIndex] ?? null : null;
  const clickBoundRef = useRef<Element | null>(null);
  /** Which way the user is moving, so a skipped step doesn't bounce them forward. */
  const directionRef = useRef<1 | -1>(1);
  /** Step index we've already scrolled into view (mobile targets are often off-screen). */
  const scrolledForRef = useRef<number | null>(null);

  // Rotating the device / resizing across the breakpoint swaps in a shorter list.
  useEffect(() => {
    setStepIndex((i) => Math.min(i, Math.max(steps.length - 1, 0)));
  }, [steps]);

  // ── First-run trigger ─────────────────────────────────────────────────────
  // Only for a real account (not a test identity / role override) that has not
  // completed onboarding. Runs once when the flag resolves to a non-true value.
  useEffect(() => {
    if (isRoleOverridden) return;
    if (userData && userData.tutorialCompleted !== true) {
      // Firestore's `tutorialCompleted` is authoritative and cross-device; this
      // per-uid localStorage guard is a fallback for when the completion write in
      // `finish()` failed (offline, rules), so a dropped write can't make the tour
      // reappear on every session.
      if (userData.id && localTutorialDone(userData.id)) return;
      directionRef.current = 1;
      setStepIndex(0);
      setActive(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userData?.id, userData?.tutorialCompleted, isRoleOverridden]);

  // ── Replay trigger ────────────────────────────────────────────────────────
  useEffect(() => {
    const onReplay = () => {
      directionRef.current = 1;
      setStepIndex(0);
      setActive(true);
    };
    window.addEventListener('bmrc-replay-tutorial', onReplay);
    return () => window.removeEventListener('bmrc-replay-tutorial', onReplay);
  }, []);

  const finish = useCallback(async () => {
    setActive(false);
    setRect(null);
    setMissingIndex(null);
    const uid = effectiveUid ?? user?.uid ?? null;
    if (uid) {
      // Set the local guard first so a failed write below still can't replay the
      // tour on every session.
      try { localStorage.setItem(localDoneKey(uid), '1'); } catch {}
      try {
        await updateDoc(doc(db, 'users', uid), {
          tutorialCompleted: true,
          tutorialCompletedAt: serverTimestamp(),
        });
      } catch (e) {
        console.error('Failed to save tutorial completion:', e);
      }
    }
  }, [effectiveUid, user?.uid]);

  const advance = useCallback(() => {
    directionRef.current = 1;
    setStepIndex((i) => {
      if (i >= steps.length - 1) {
        void finish();
        return i;
      }
      return i + 1;
    });
  }, [steps.length, finish]);

  const back = useCallback(() => {
    directionRef.current = -1;
    setStepIndex((i) => Math.max(0, i - 1));
  }, []);

  // ── Track the target element's position ───────────────────────────────────
  useEffect(() => {
    if (!active || !step || !step.target) {
      setRect(null);
      setMissingIndex(null);
      return;
    }
    // Clear the previous step's geometry/miss flag so neither leaks into this
    // one — a stale `missing` flag is what used to fast-forward the whole tour.
    setRect(null);
    setMissingIndex(null);

    const selector = `[data-tour="${step.target}"]`;
    let found = false;
    const read = () => {
      const el = document.querySelector(selector);
      if (!el) return;
      if (!found && scrolledForRef.current !== stepIndex) {
        scrolledForRef.current = stepIndex;
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      found = true;
      setRect(el.getBoundingClientRect());
    };
    read();
    // Re-read on layout changes and while routes settle after a navigation.
    const interval = setInterval(read, 150);
    window.addEventListener('resize', read);
    window.addEventListener('scroll', read, true);
    // If the target never appears for this role/viewport, flag *this* step.
    const missTimer = setTimeout(() => {
      if (!found) setMissingIndex(stepIndex);
    }, 1600);
    return () => {
      clearInterval(interval);
      clearTimeout(missTimer);
      window.removeEventListener('resize', read);
      window.removeEventListener('scroll', read, true);
    };
  }, [active, step, stepIndex]);

  // Auto-skip a step whose target can't be found — in the direction the user is
  // travelling. Skipping forward on a Back press is what made the tour jump to
  // "You're all set" as soon as one target was missing.
  useEffect(() => {
    if (missingIndex === null || missingIndex !== stepIndex || !step?.target) return;
    if (directionRef.current === -1) {
      if (stepIndex > 0) setStepIndex((i) => Math.max(0, i - 1));
      return;
    }
    // Never let a missing target end the tour on its own — the user should reach
    // the closing card by pressing Next, not by a step quietly failing.
    if (stepIndex < steps.length - 1) setStepIndex((i) => i + 1);
  }, [missingIndex, stepIndex, step, steps.length]);

  // ── Advance on real click of the highlighted element ──────────────────────
  useEffect(() => {
    if (!active || !step || step.advance !== 'click-target' || !step.target) return;
    const el = document.querySelector(`[data-tour="${step.target}"]`);
    if (!el || clickBoundRef.current === el) return;
    clickBoundRef.current = el;
    const onClick = () => {
      clickBoundRef.current = null;
      advance();
    };
    el.addEventListener('click', onClick, { once: true });
    return () => {
      el.removeEventListener('click', onClick);
      if (clickBoundRef.current === el) clickBoundRef.current = null;
    };
  }, [active, step, rect, advance]);

  // While the tour is active, tell the sidebar to stay expanded so highlighted
  // rail items don't shift/shrink when the mouse leaves the rail (app-sidebar
  // listens for these events). Cleanup fires on finish/skip and unmount.
  useEffect(() => {
    if (!active) return;
    window.dispatchEvent(new Event('bmrc-tour-active'));
    return () => {
      window.dispatchEvent(new Event('bmrc-tour-inactive'));
    };
  }, [active]);

  // Esc closes the tour.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void finish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, finish]);

  if (!active || !step) return null;

  const isFirst = stepIndex === 0;
  const isLast = stepIndex === steps.length - 1;
  const hasTarget = !!step.target && !!rect;

  // ── Centered card (welcome / finish / target-less steps) ──────────────────
  if (!step.target) {
    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
        <div className="w-full max-w-md bg-content1 rounded-large shadow-2xl p-6">
          <div className="flex justify-end">
            <Button size="sm" variant="light" className="text-foreground-400" startContent={<X size={14} />} onPress={() => void finish()}>
              Skip
            </Button>
          </div>
          <div className="flex flex-col items-center text-center gap-4 px-2 pb-2">
            <div className="p-4 rounded-2xl bg-primary-50 dark:bg-primary-900/20">
              {isLast ? <CheckCircle size={30} className="text-success" /> : <Sparkles size={30} className="text-primary" />}
            </div>
            <h2 className="text-xl font-bold text-foreground">{step.title}</h2>
            <p className="text-sm text-foreground-500 leading-relaxed">{step.body}</p>
          </div>
          <Dots total={steps.length} current={stepIndex} />
          <div className="flex justify-between mt-5">
            <Button variant="flat" onPress={back} isDisabled={isFirst} startContent={<ChevronLeft size={16} />}>
              Back
            </Button>
            <Button color="primary" onPress={advance} endContent={isLast ? <CheckCircle size={16} /> : <ChevronRight size={16} />}>
              {isLast ? "Let's go!" : 'Next'}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Target step but rect not resolved yet — show a dim scrim only.
  if (!hasTarget || !rect) {
    return <div className="fixed inset-0 z-[9998] bg-black/40 backdrop-blur-[1px]" />;
  }

  // ── Spotlight geometry ────────────────────────────────────────────────────
  const pad = 6;
  const hole = {
    top: Math.max(rect.top - pad, 0),
    left: Math.max(rect.left - pad, 0),
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768;

  // Phones: a full-width sheet on the edge furthest from the target — there is
  // never room to sit beside a highlight. Desktop: to the right for left-rail
  // targets, otherwise below (or above if there's no room), clamped on-screen.
  let calloutStyle: React.CSSProperties;
  if (isMobile) {
    const targetInLowerHalf = rect.top + rect.height / 2 > vh / 2;
    calloutStyle = targetInLowerHalf
      ? { top: MARGIN, left: MARGIN, right: MARGIN }
      : { bottom: MARGIN, left: MARGIN, right: MARGIN };
  } else {
    const placeRight =
      step.placement === 'right' || ((step.placement === 'auto' || !step.placement) && rect.left < 160);
    if (placeRight) {
      calloutStyle = {
        left: Math.min(rect.right + 16, vw - CALLOUT_W - MARGIN),
        top: Math.min(Math.max(rect.top, MARGIN), vh - 220),
        width: CALLOUT_W,
      };
    } else {
      const below = rect.bottom + 16;
      const fitsBelow = below + 200 < vh;
      calloutStyle = {
        top: fitsBelow ? below : Math.max(rect.top - 200, MARGIN),
        left: Math.min(Math.max(rect.left, MARGIN), vw - CALLOUT_W - MARGIN),
        width: CALLOUT_W,
      };
    }
  }

  // Strips capture clicks so the dimmed area is inert; the parent is
  // pointer-events-none so the transparent "hole" over the target stays
  // clickable (clicking the real nav item advances click-target steps).
  const dim = 'fixed bg-black/55 pointer-events-auto';
  const isClick = step.advance === 'click-target';

  return (
    <div className="fixed inset-0 z-[9999] pointer-events-none" aria-live="polite">
      {/* Four dim strips around the target leave a clickable hole over it. */}
      <div className={dim} style={{ top: 0, left: 0, width: '100%', height: hole.top }} />
      <div className={dim} style={{ top: hole.top + hole.height, left: 0, width: '100%', bottom: 0 }} />
      <div className={dim} style={{ top: hole.top, left: 0, width: hole.left, height: hole.height }} />
      <div className={dim} style={{ top: hole.top, left: hole.left + hole.width, right: 0, height: hole.height }} />

      {/* Pulsing outline ring around the target */}
      <div
        className="fixed rounded-[12px] ring-4 ring-primary/80 animate-pulse pointer-events-none"
        style={{ top: hole.top, left: hole.left, width: hole.width, height: hole.height, boxShadow: '0 0 0 3px rgba(255,255,255,0.35)' }}
      />

      {/* Callout */}
      <div
        className={`fixed bg-content1 shadow-2xl border border-divider flex flex-col gap-2 pointer-events-auto ${
          isMobile ? 'rounded-large p-4 pb-[max(env(safe-area-inset-bottom),16px)]' : 'rounded-large p-4'
        }`}
        style={calloutStyle}
      >
        <div className="flex items-start justify-between gap-2">
          <h3 className={`font-bold text-foreground leading-snug ${isMobile ? 'text-base' : 'text-[15px]'}`}>{step.title}</h3>
          <button onClick={() => void finish()} aria-label="Skip tour" className="text-foreground-400 hover:text-foreground-600 flex-none">
            <X size={16} />
          </button>
        </div>
        <p className={`text-foreground-500 leading-relaxed ${isMobile ? 'text-sm' : 'text-[13px]'}`}>{step.body}</p>

        {isClick && (
          <div className="flex items-center gap-1.5 text-[12px] font-semibold text-primary bg-primary-50 dark:bg-primary-900/20 rounded-medium px-2.5 py-1.5">
            <MousePointerClick size={14} className="flex-none animate-bounce" />
            Tap the highlighted item to continue
          </div>
        )}

        <Dots total={steps.length} current={stepIndex} />

        <div className="flex items-center justify-between mt-1 gap-2">
          <Button size={isMobile ? 'md' : 'sm'} variant="light" className="text-foreground-400" onPress={() => void finish()}>
            Skip
          </Button>
          <div className="flex items-center gap-2">
            <Button
              size={isMobile ? 'md' : 'sm'}
              variant="flat"
              onPress={back}
              isDisabled={isFirst}
              startContent={<ChevronLeft size={15} />}
            >
              Back
            </Button>
            {!isClick && (
              <Button
                size={isMobile ? 'md' : 'sm'}
                color="primary"
                onPress={advance}
                endContent={isLast ? <CheckCircle size={15} /> : <ChevronRight size={15} />}
              >
                {isLast ? 'Done' : 'Next'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Dots({ total, current }: { total: number; current: number }) {
  return (
    <div className="flex justify-center gap-1.5 mt-1">
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className={`h-1.5 rounded-full transition-all ${
            i === current ? 'bg-primary w-5' : i < current ? 'bg-primary/40 w-1.5' : 'bg-content3 w-1.5'
          }`}
        />
      ))}
    </div>
  );
}
