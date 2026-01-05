import React, { Suspense } from 'react';
import MobileScanReportClient from './mobile-scan-report-client';

export default function Page() {
  return (
    <Suspense fallback={<div className="p-4">Loading scan report...</div>}>
      <MobileScanReportClient />
    </Suspense>
  );
}
