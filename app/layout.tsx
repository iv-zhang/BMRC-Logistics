import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, Geist_Mono } from "next/font/google";
import { Providers } from "@/app/providers";
import "./globals.css";
import SidebarLayout from './components/sidebar-layout';

const hankenGrotesk = Hanken_Grotesk({
  variable: "--font-hanken-grotesk",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "BMRC Logistics",
  description: "Efficient logistics management system",
  icons: {
    icon: "/images/NoBackground_NewLogoWhite.PNG",
  },
};

// `viewportFit: 'cover'` is REQUIRED, not cosmetic: without it `env(safe-area-inset-*)`
// resolves to 0, so the mobile bottom nav's `pb-[max(env(safe-area-inset-bottom),8px)]`
// (mobile-bottom-nav.tsx) collapses to 8px and the bar sits under the home indicator on
// notched iPhones. themeColor values are the HeroUI `background` tokens from
// tailwind.config.ts so browser chrome matches the app in both modes.
// Deliberately no `maximumScale`/`userScalable: false` — blocking pinch zoom is a WCAG
// 1.4.4 failure, and members read small lot numbers in bad closet lighting.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#EEF0F4' },
    { media: '(prefers-color-scheme: dark)',  color: '#0C0E14' },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${hankenGrotesk.variable} ${geistMono.variable} antialiased bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 text-foreground`}
      >
        <Providers>
          <SidebarLayout>
            {children}
          </SidebarLayout>
        </Providers>
      </body>
    </html>
  );
}
