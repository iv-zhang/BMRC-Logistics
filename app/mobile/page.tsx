import { Suspense } from 'react';
import MobilePackDashboardClient from './mobile-pack-dashboard-client';

export default function MobilePackDashboardPage() {
  return (
    <Suspense fallback={<div className="h-screen flex items-center justify-center">Loading...</div>}>
      <MobilePackDashboardClient />
    </Suspense>
  );
}
