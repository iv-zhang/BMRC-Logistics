import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "@/app/providers";
import "./globals.css";
// 1. Ensure this import remains here
import AppNavbar from './components/appnavbar';

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-white dark:bg-black text-black dark:text-white`}
      >
        <Providers>
          {/* 2. ADD THE NAVBAR HERE */}
          <AppNavbar /> 
          
          {/* The rest of your app pages render here */}
          {children}
        </Providers>
      </body>
    </html>
  );
}