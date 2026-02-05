// Server component layout for dynamic statpack detail pages
// With static export, we use a placeholder route and handle routing client-side

export const dynamicParams = false;

// generateStaticParams is defined on the page component; keep layout minimal for static export

export default function StatpackDetailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
