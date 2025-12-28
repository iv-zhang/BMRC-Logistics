import { Suspense } from 'react';
import MobileQuickCount from '../quick-count-client';

export default function MobileQuickCountPage() {
  return (
    <Suspense fallback={<div className="h-screen flex items-center justify-center">Loading...</div>}>
      <MobileQuickCount />
    </Suspense>
  );
}
