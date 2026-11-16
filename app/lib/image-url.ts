/**
 * Photo-link normalization for InventoryItem.imageUrl (issue #31).
 * Admins paste a URL; Google Drive share links are rewritten to the embeddable
 * thumbnail endpoint. Pure, no browser/Firebase deps.
 */

const DRIVE_THUMB = (id: string) => `https://drive.google.com/thumbnail?id=${id}&sz=w1000`;

function parseHttps(raw: string): URL | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** Google Photos share links cannot be embedded in an <img>. */
export function isGooglePhotosLink(raw: string): boolean {
  const u = parseHttps(raw ?? '');
  if (!u) return false;
  const host = u.hostname.toLowerCase();
  if (host === 'photos.app.goo.gl') return true;
  if (host === 'photos.google.com') return true;
  if (host === 'goo.gl' && u.pathname.startsWith('/photos')) return true;
  return false;
}

/** Returns an embeddable https image URL, or null if empty/invalid/unembeddable. */
export function normalizeImageUrl(raw: string): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  const u = parseHttps(trimmed);
  if (!u) return null;
  if (isGooglePhotosLink(trimmed)) return null;

  const host = u.hostname.toLowerCase();
  if (host === 'drive.google.com' || host === 'docs.google.com') {
    const fileMatch = u.pathname.match(/^\/file\/d\/([\w-]+)/);
    const id = fileMatch?.[1] ?? u.searchParams.get('id');
    if (!id) return host === 'drive.google.com' ? null : trimmed;
    // Already-normalized thumbnail URLs pass through untouched.
    if (host === 'drive.google.com' && u.pathname === '/thumbnail') return trimmed;
    return DRIVE_THUMB(id);
  }
  return trimmed;
}
