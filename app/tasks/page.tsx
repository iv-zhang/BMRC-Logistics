'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Spinner } from '@heroui/react';

// Tasks & Buy List was merged into the Committee Board as a view switcher.
// This route stays alive (old links/bookmarks) and forwards to the new home.
export default function TasksRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/committee-board?view=tasks');
  }, [router]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
      <Spinner size="lg" color="primary" />
    </div>
  );
}
