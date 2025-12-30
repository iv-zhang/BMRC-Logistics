// Simple GS1 parser helpers
// Parses common GS1 Application Identifiers (AIs) from barcode strings.
// Supports AI (17) expiration date (YYMMDD) and AI (10) lot/batch.
export function parseGs1Barcode(code: string): { expiration?: string; lot?: string } {
  if (!code) return {};
  const cleaned = String(code).replace(/[\s\(\)\x1D]/g, '');
  // AI 17 - expiration date YYMMDD
  const m17 = cleaned.match(/17(\d{6})/);
  let expiration: string | undefined;
  if (m17) {
    const yymmdd = m17[1];
    const yy = parseInt(yymmdd.slice(0, 2), 10);
    const mm = yymmdd.slice(2, 4);
    const dd = yymmdd.slice(4, 6);
    const yyyy = 2000 + yy; // assume 2000+ for simplicity
    expiration = `${yyyy}-${mm}-${dd}`;
  }
  // AI 10 - batch/lot (variable length)
  const m10 = cleaned.match(/10([A-Za-z0-9\-\_\.]+)/);
  const lot = m10 ? m10[1] : undefined;
  return { expiration, lot };
}
