// Server-side function to generate static params for statpack detail pages
// Returns empty array as statpacks are fully dynamic via Firebase

export async function generateStaticParams() {
  // For static export, return a placeholder route so Next can export the page.
  return [{ id: '_' }];
}
