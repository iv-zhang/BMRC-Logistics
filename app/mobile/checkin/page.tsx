import { Suspense } from 'react';
import MobileCheckinClient from './mobile-checkin-client';

export default function MobileCheckinPage() {
  return (
    <Suspense fallback={<div className="h-screen flex items-center justify-center">Loading...</div>}>
      <MobileCheckinClient />
    </Suspense>
  );
}
