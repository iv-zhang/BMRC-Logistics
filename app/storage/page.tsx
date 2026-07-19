'use client';

// Storage Management merged into Organization Settings (Sites & Storage tab).
// Kept as a redirect so existing links/bookmarks still resolve.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Spinner } from '@heroui/react';

export default function StorageRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/settings?tab=sites');
  }, [router]);
  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
      <Spinner size="lg" color="primary" />
    </div>
  );
}
