import { Suspense } from 'react';
import MobileCheckoutClient from './mobile-checkout-client';

export default function MobileCheckoutPage() {
  return (
    <Suspense fallback={<div className="h-screen flex items-center justify-center">Loading...</div>}>
      <MobileCheckoutClient />
    </Suspense>
  );
}
