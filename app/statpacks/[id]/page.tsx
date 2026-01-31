// Server wrapper: export static params for static export and render client component
export const dynamicParams = false;

export async function generateStaticParams() {
  return [{ id: '_' }];
}

import StatpackDetailClient from './page.client';

export default function StatpackDetailPageWrapper() {
  return <StatpackDetailClient />;
}
