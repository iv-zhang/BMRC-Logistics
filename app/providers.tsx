'use client';

import * as React from "react";
import { HeroUIProvider } from "@heroui/react";
import { useRouter } from 'next/navigation';
import { ThemeProvider as NextThemesProvider } from "next-themes"; // 👈 1. Import this

export interface ProvidersProps {
  children: React.ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  const router = useRouter();

  return (
    <HeroUIProvider navigate={router.push}>
      {/* 👇 2. Add this wrapper */}
      <NextThemesProvider attribute="class" defaultTheme="system">
        {children}
      </NextThemesProvider>
    </HeroUIProvider>
  );
}