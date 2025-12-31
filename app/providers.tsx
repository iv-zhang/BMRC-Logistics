"use client";

import * as React from "react";
import { HeroUIProvider } from "@heroui/react";
import { useRouter } from 'next/navigation';
import { ThemeProvider as NextThemesProvider } from "next-themes";

// Provide a small global helper to toggle `inert` on the app root when overlays open.
// This dynamically loads the wicg-inert polyfill if needed.
function ensureInertSupport() {
  if (typeof window === 'undefined') return;
  if (!(document as any).hasOwnProperty('inert') && !(window as any).__wicgInertLoaded) {
    // dynamic import; non-blocking
    import('wicg-inert').then(() => { (window as any).__wicgInertLoaded = true; }).catch(() => {});
  }
}

function setAppRootInert(value: boolean) {
  if (typeof document === 'undefined') return;
  const root = document.getElementById('__next') || document.body;
  if (!root) return;
  try {
    // Instead of setting `inert` on the entire root (which also affects
    // the modal itself), set `inert` on root's *children* except the
    // element(s) that represent the active modal/dialog/portal. This
    // keeps the modal interactive while inerting the rest of the UI.
    const modalSelector = '[role="dialog"], [data-portal], .hri-modal, .heroui-modal, .heroui-modal';
    const excluded = Array.from(document.querySelectorAll(modalSelector));
    Array.from(root.children).forEach((child) => {
      const isExcluded = excluded.some(ex => ex === child || ex.contains(child) || child.contains(ex));
      if (isExcluded) {
        if (!value && child.hasAttribute('inert')) child.removeAttribute('inert');
        return;
      }
      if (value) child.setAttribute('inert', '');
      else child.removeAttribute('inert');
    });
  } catch (e) {
    // fallback for servers or if inert not available
    try {
      // @ts-ignore
      (root as any).inert = value;
    } catch (_) {}
  }
}

// expose for components to call (safe noop on server)
if (typeof window !== 'undefined') {
  ensureInertSupport();
  (window as any).setAppInert = setAppRootInert;
}

export interface ProvidersProps {
  children: React.ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  const router = useRouter();

  return (
    <HeroUIProvider navigate={router.push}>
      {/* Theme provider wrapper */}
      <NextThemesProvider attribute="class" defaultTheme="system">
        {children}
      </NextThemesProvider>
    </HeroUIProvider>
  );
}
