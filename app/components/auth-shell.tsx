'use client';
import React, { useEffect, useState } from 'react';
import Image from 'next/image';
import { useTheme } from 'next-themes';

export interface AuthShellProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}

/**
 * Shared branded shell for /login, /register, /forgot-password.
 * Renders the standard page gradient, a content1 card, the real theme-aware
 * BMRC logo + wordmark, and a slot for a page-specific title/subtitle + form.
 */
export default function AuthShell({ title, subtitle, children }: AuthShellProps) {
  const { theme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isDark = mounted && theme === 'dark';

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-4">
      <div className="w-full max-w-md bg-content1 border border-divider rounded-2xl shadow-lg p-8 flex flex-col gap-6">
        {/* Brand */}
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="relative w-10 h-10">
            <Image
              src={isDark
                ? '/images/NoBackground_NewLogoWhite.PNG'
                : '/images/NoBackground_NewLogoBlack.PNG'}
              alt="BMRC logo"
              fill
              className="object-contain"
              priority
            />
          </div>
          <div className="flex flex-col leading-none gap-1">
            <span className="font-semibold text-base text-foreground tracking-tight">BMRC Logistics</span>
            <span className="text-xs text-foreground-400 font-medium">Berkeley Medical Reserve Corps</span>
          </div>
        </div>

        {/* Page-specific header */}
        <div className="flex flex-col gap-1 text-center">
          <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
          {subtitle && <p className="text-sm text-foreground-500">{subtitle}</p>}
        </div>

        {/* Form slot */}
        {children}
      </div>
    </div>
  );
}
