'use client';

import { useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';

export default function StatpackCheckoutRedirect() {
  const router = useRouter();
  const params = useParams();
  const rawId = Array.isArray(params?.id) ? params.id[0] : (params?.id as string);

  useEffect(() => {
    if (!rawId) return;
    // Redirect to query-based checkout URL which the checkout page already understands
    const target = `/statpacks/checkout?pack=${encodeURIComponent(rawId)}`;
    try {
      router.replace(target);
    } catch (e) {
      // fallback
      window.location.href = target;
    }
  }, [rawId, router]);

  return null;
}
