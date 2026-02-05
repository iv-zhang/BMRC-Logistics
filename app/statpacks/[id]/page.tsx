// Server wrapper: export static params for static export and render client component
// For static export with Firebase, we can't pre-fetch all IDs at build time
// Instead, we generate a placeholder and allow dynamic params
export const dynamicParams = false;

export async function generateStaticParams() {
  // For static export, return a dummy param since statpacks are dynamic
  return [{ id: 'dummy' }];
}

import StatpackDetailClient from './page.client';

export default function StatpackDetailPageWrapper() {
  return <StatpackDetailClient />;
}
