// Simple GS1 parser helpers
// Parses common GS1 Application Identifiers (AIs) from barcode strings.
// Supports AI (17) expiration date (YYMMDD), AI (10) lot/batch, and AI (01) GTIN.

/** Two-digit YY -> four-digit YYYY using a sliding window instead of a
 * hardcoded "2000 + yy". GS1's two-digit year is ambiguous across
 * centuries; this app only ever scans near-term expirations, so anchor the
 * window to the current century and roll back a century if that reads more
 * than ~20 years out (meaning the label's two-digit year actually wrapped
 * from the previous century, not that something expires two decades out). */
function resolveGs1Year(yy: number): number {
  const currentYear = new Date().getFullYear();
  const currentCentury = Math.floor(currentYear / 100) * 100;
  let yyyy = currentCentury + yy;
  if (yyyy > currentYear + 20) yyyy -= 100;
  return yyyy;
}

/** True when a known FIXED-length AI (01 GTIN / 17 expiry) starts at `pos`. */
function fixedAiStartsAt(s: string, pos: number): boolean {
  const ai = s.slice(pos, pos + 2);
  if (ai === '01') return /^\d{14}/.test(s.slice(pos + 2));
  if (ai === '17') return /^\d{6}/.test(s.slice(pos + 2));
  return false;
}

/**
 * Left-to-right walk over a cleaned (whitespace/parens stripped) GS1-128
 * string, consuming AIs by their known length so a fixed-length AI's own
 * digits can never be mistaken for the start of another AI (a naive
 * "search for the substring '10' anywhere" approach false-positives
 * whenever a GTIN happens to start with '0' — "01" + "0..." reads as "10").
 * Only the three AIs this app cares about (01, 17, 10) are recognized;
 * anything else is skipped one character at a time, matching the previous
 * implementation's permissiveness with arbitrary/non-GS1 scanned strings.
 */
function walkGs1(cleaned: string): { expiration?: string; lot?: string; gtin?: string } {
  let gtin: string | undefined;
  let expiration: string | undefined;
  let lot: string | undefined;
  let i = 0;

  while (i < cleaned.length) {
    const ai = cleaned.slice(i, i + 2);

    if (ai === '01' && /^\d{14}/.test(cleaned.slice(i + 2))) {
      gtin = cleaned.slice(i + 2, i + 16);
      i += 16;
      continue;
    }

    if (ai === '17' && /^\d{6}/.test(cleaned.slice(i + 2))) {
      const yymmdd = cleaned.slice(i + 2, i + 8);
      const yyyy = resolveGs1Year(parseInt(yymmdd.slice(0, 2), 10));
      const mm = yymmdd.slice(2, 4);
      const dd = yymmdd.slice(4, 6);
      expiration = `${yyyy}-${mm}-${dd}`;
      i += 8;
      continue;
    }

    if (ai === '10') {
      // Variable-length lot/batch (up to 20 alphanumeric chars). Terminate
      // at the FNC1 group separator, the start of another known fixed-
      // length AI, or the end of the string — whichever comes first.
      let j = i + 2;
      while (j < cleaned.length && cleaned[j] !== '\x1D' && !fixedAiStartsAt(cleaned, j)) {
        j++;
      }
      lot = cleaned.slice(i + 2, j) || undefined;
      i = cleaned[j] === '\x1D' ? j + 1 : j;
      continue;
    }

    i++;
  }

  return { expiration, lot, gtin };
}

export function parseGs1Barcode(code: string): { expiration?: string; lot?: string; gtin?: string } {
  if (!code) return {};
  // Normalize whitespace and human-readable AI parentheses, but keep the
  // FNC1 group separator (\x1D) intact — it's the terminator `walkGs1`
  // relies on for variable-length AIs like (10) lot/batch.
  const cleaned = String(code).replace(/[\s()]/g, '');
  return walkGs1(cleaned);
}
