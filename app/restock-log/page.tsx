"use client";

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function RestockLogRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/restock'); }, [router]);
  return null;
}
