// Server component layout for dynamic statpack detail pages
// With static export, we use a placeholder route and handle routing client-side

export const dynamicParams = false;

export async function generateStaticParams() {
  // For static export, return all possible placeholder routes
  // Actual statpack IDs are fetched and rendered client-side
  return [
    { id: '_' }, // Placeholder route
  ];
}

export default function StatpackDetailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
