'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * How pop-out panels (drawers) render across the app. User-switchable in
 * Profile → Settings, alongside the light/dark theme toggle. Persisted to
 * localStorage and broadcast via a custom event so every open panel reacts
 * live — mirrors the test-identity / role-override sync pattern.
 */
export type PanelMode = 'drawer' | 'dropdown' | 'modal';

const STORAGE_KEY = 'bmrc_panel_mode';
const CHANGE_EVENT = 'bmrc-panel-mode-changed';
const DEFAULT_MODE: PanelMode = 'drawer';

const isPanelMode = (v: string | null): v is PanelMode =>
  v === 'drawer' || v === 'dropdown' || v === 'modal';

function readMode(): PanelMode {
  if (typeof window === 'undefined') return DEFAULT_MODE;
  const raw = localStorage.getItem(STORAGE_KEY);
  return isPanelMode(raw) ? raw : DEFAULT_MODE;
}

// Subscribe to cross-tab (`storage`) and same-tab (`CHANGE_EVENT`) updates.
function subscribe(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) onChange();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

export function usePanelMode(): { mode: PanelMode; setMode: (mode: PanelMode) => void } {
  // Read the stored value synchronously on mount so the very first paint uses
  // the correct mode. Panels are only ever rendered after a user interaction
  // (post-hydration), so this initializer never runs during SSR/hydration and
  // therefore can't cause a mismatch — which is why we no longer need the
  // useSyncExternalStore default-snapshot that flashed 'drawer' before the
  // stored mode resolved. Updates arrive via the subscription below.
  const [mode, setModeState] = useState<PanelMode>(readMode);

  useEffect(() => subscribe(() => setModeState(readMode())), []);

  const setMode = useCallback((next: PanelMode) => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return { mode, setMode };
}
