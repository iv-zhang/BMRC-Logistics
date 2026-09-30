/**
 * Variant signature: the size/age/color "fingerprint" of an item name.
 *
 * Two inventory items may only be treated as duplicates (and merged) when their
 * variant signatures match. `NPA 28 Fr` and `NPA 30 Fr` are different products
 * even though their names are one edit apart, and merging them would repoint
 * every statpack that requires a 28 Fr airway at a pooled SKU.
 *
 * Pure module: no Firestore, no org-config reads. Safe to import from anywhere
 * (including scripts run through tsx).
 *
 * What is extracted (each becomes one `kind:value` token; the signature is the
 * sorted, de-duplicated token set):
 *   - dimensions        `4x4`, `2 x 3 in`                      -> dim:4x4
 *   - `size N`          `size 3`, `sz 4`                       -> size:3
 *   - French / gauge    `28 Fr`, `28 french`, `14g`, `18 ga`   -> fr:28, g:14
 *   - length/volume     `80 mm`, `4 in`, `4"`, `500 mL`, `1 L` -> mm:80, in:4, ml:500, ml:1000
 *   - weight/strength   `15 g`, `5 oz`, `10 mg`, `1 lb`        -> g:15, oz:5, mg:10, lb:1
 *   - letter sizes      S, M, L, XL, XXL, small, x-large, S/M  -> letter:m, letter:s/m
 *   - age group         adult, peds/pediatric, infant, neonate -> age:adult ...
 *   - triage colors     red, yellow, green, black, ...         -> color:red
 *   - bare numbers      `Stat Pack 1`                          -> num:1
 *
 * Deliberately NOT part of the signature: pack counts (`100 ct`, `box of 50`,
 * `x100`, `100/box`). Units-per-box differences are guarded separately by
 * `itemsPerBox` in the merge plan; they do not make two items different
 * products.
 *
 * Strictness: an unsized name vs a sized name is a MISMATCH (`Gloves` vs
 * `Gloves, M`). An unsized legacy record cannot be assumed to be size M, so it
 * is never auto-merged into one. Two names with no variant tokens match.
 */

export interface VariantSignature {
  /** Sorted, de-duplicated `kind:value` tokens. Empty when the name has no variant info. */
  tokens: string[];
  /** Stable string form of `tokens` ('' when empty). Equal keys <=> matching signatures. */
  key: string;
}

type Span = { re: RegExp; fn: (m: RegExpExecArray) => string | string[] | null };

const NUM = String.raw`\d+(?:\.\d+)?`;
const B = String.raw`(?<![a-z0-9])`; // left word boundary that treats digits as word chars
const E = String.raw`(?![a-z0-9])`; // right word boundary

function normNum(s: string): string {
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : s;
}

const LETTER = String.raw`(?:xxxl|xxl|xl|xxs|xs|2xl|3xl|4xl|s|m|l)`;

/** Words that mean a letter size, rewritten in place to the letter before token extraction. */
const LETTER_WORDS: Array<[RegExp, string]> = [
  [/(?<![a-z0-9])(?:xxx|3x)[\s-]*(?:large|lrg|lg)(?![a-z0-9])/g, ' xxxl '],
  [/(?<![a-z0-9])(?:xx|2x)[\s-]*(?:large|lrg|lg)(?![a-z0-9])/g, ' xxl '],
  [/(?<![a-z0-9])(?:extra|x)[\s-]*(?:large|lrg|lg)(?![a-z0-9])/g, ' xl '],
  [/(?<![a-z0-9])(?:xx|2x)[\s-]*(?:small|sm)(?![a-z0-9])/g, ' xxs '],
  [/(?<![a-z0-9])(?:extra|x)[\s-]*(?:small|sm)(?![a-z0-9])/g, ' xs '],
  [/(?<![a-z0-9])(?:small|sm)(?![a-z0-9])/g, ' s '],
  [/(?<![a-z0-9])(?:medium)(?![a-z0-9])/g, ' m '],
  [/(?<![a-z0-9])(?:large|lrg|lg)(?![a-z0-9])/g, ' l '],
  // "Med" is only read as Medium when it is the last word ("Gloves Med"), since
  // "Med kit" / "Med bag" use it as an abbreviation for medical.
  [/(?<![a-z0-9])med(?=[\s)\]]*$)/g, ' m '],
];

function unitToken(value: string, unit: string): string {
  const v = normNum(value);
  switch (unit) {
    case 'fr':
    case 'french':
      return `fr:${v}`;
    case 'ga':
    case 'gauge':
    case 'g':
      // Gauge and grams share a token: both distinguish variants, and a name
      // never carries both for the same item.
      return `g:${v}`;
    case 'mm':
      return `mm:${v}`;
    case 'cm':
      return `cm:${v}`;
    case 'in':
    case 'inch':
    case 'inches':
    case '"':
      return `in:${v}`;
    case 'ft':
      return `ft:${v}`;
    case 'ml':
    case 'cc':
      return `ml:${v}`;
    case 'l':
    case 'liter':
    case 'liters':
    case 'litre':
    case 'litres':
      return `ml:${normNum(String(Number(value) * 1000))}`;
    case 'oz':
      return `oz:${v}`;
    case 'mg':
      return `mg:${v}`;
    case 'mcg':
      return `mcg:${v}`;
    case 'lb':
    case 'lbs':
      return `lb:${v}`;
    default:
      return `${unit}:${v}`;
  }
}

const AGE_MAP: Array<[RegExp, string]> = [
  [/(?<![a-z0-9])adults?(?![a-z0-9])/g, 'age:adult'],
  [/(?<![a-z0-9])(?:pediatrics?|paediatrics?|pedi|peds|ped|child|children|kids?|toddlers?)(?![a-z0-9])/g, 'age:peds'],
  [/(?<![a-z0-9])(?:infants?|babies|baby)(?![a-z0-9])/g, 'age:infant'],
  [/(?<![a-z0-9])(?:neonates?|neonatal|newborns?|neo)(?![a-z0-9])/g, 'age:neo'],
];

const COLOR_RE =
  /(?<![a-z0-9])(red|yellow|green|black|white|blue|orange|gray|grey|pink|purple)(?![a-z0-9])/g;

/** Run a regex over `s`, collect tokens from each match, and blank the matched text. */
function extract(s: string, spans: Span[], out: Set<string>): string {
  let cur = s;
  for (const { re, fn } of spans) {
    re.lastIndex = 0;
    cur = cur.replace(re, (...args) => {
      // Reconstruct an exec-like array (match + groups) from replace args.
      const groupCount = args.findIndex((a) => typeof a === 'number');
      const m = args.slice(0, groupCount) as unknown as RegExpExecArray;
      const r = fn(m);
      if (r) for (const t of Array.isArray(r) ? r : [r]) out.add(t);
      return ' ';
    });
  }
  return cur;
}

/**
 * Compute the variant signature of an item name (or name + variant label).
 * Case-, spacing-, and punctuation-insensitive.
 */
export function variantSignature(name: string): VariantSignature {
  const out = new Set<string>();
  let s = (name ?? '')
    .toLowerCase()
    .replace(/[’‘']/g, '') // men's -> mens (so a stray "s" is not a size)
    .replace(/[“”]/g, '"')
    .replace(/[×]/g, 'x')
    .replace(/[–—]/g, '-');

  // 1. Dimensions: 4x4, 2 x 3 in, 4.5" x 4.1 yd ... (unit defaults to inches).
  s = extract(
    s,
    [
      {
        re: new RegExp(
          `${B}${NUM}\\s*(?:inches|inch|in|"|cm|mm)?(?:\\s*x\\s*${NUM}\\s*(?:inches|inch|in|"|cm|mm)?)+${E}`,
          'g',
        ),
        fn: (m) => {
          const whole = m[0];
          const nums = whole.match(new RegExp(NUM, 'g')) ?? [];
          if (nums.length < 2) return null;
          const unit = /cm/.test(whole) ? 'cm' : /mm/.test(whole) ? 'mm' : '';
          return `dim:${nums.map(normNum).join('x')}${unit ? unit : ''}`;
        },
      },
    ],
    out,
  );

  // 2. Pack counts: stripped, never part of the signature.
  s = s
    .replace(
      new RegExp(
        `${B}${NUM}\\s*(?:/\\s*)?(?:ct|count|pk|pkg|packs?|pcs?|pieces?|ea|each|bx|box|boxes|cases?|cs|bags?|pairs?|prs?)${E}`,
        'g',
      ),
      ' ',
    )
    .replace(new RegExp(`${B}(?:of|qty|quantity)\\s*:?\\s*${NUM}${E}`, 'g'), ' ')
    .replace(new RegExp(`${B}x\\s*${NUM}${E}`, 'g'), ' ')
    .replace(new RegExp(`${NUM}\\s*/\\s*(?:bx|box|case|cs|pk|pack|bag|ct|ea)${E}`, 'g'), ' ');

  // 3. "size N" / "sz N".
  s = extract(
    s,
    [
      {
        re: new RegExp(`${B}(?:size|sz)\\.?\\s*#?\\s*(${NUM})${E}`, 'g'),
        fn: (m) => `size:${normNum(m[1])}`,
      },
    ],
    out,
  );

  // 4. Number + unit (Fr, gauge, mm, in, mL, L, g, oz, mg, ...).
  s = extract(
    s,
    [
      {
        re: new RegExp(
          `${B}(${NUM})\\s*(french|fr|gauge|ga|g|mm|cm|inches|inch|in|ft|ml|cc|liters?|litres?|l|oz|mcg|mg|lbs|lb|")(?![a-z0-9])`,
          'g',
        ),
        fn: (m) => unitToken(m[1], m[2]),
      },
    ],
    out,
  );

  // 5. Letter sizes. Words are normalized to letters in place, ranges first.
  for (const [re, rep] of LETTER_WORDS) s = s.replace(re, rep);
  s = extract(
    s,
    [
      {
        re: new RegExp(`${B}(${LETTER})\\s*[/-]\\s*(${LETTER})${E}`, 'g'),
        fn: (m) => `letter:${m[1]}/${m[2]}`,
      },
      {
        re: new RegExp(`${B}(${LETTER})${E}`, 'g'),
        fn: (m) => `letter:${m[1]}`,
      },
    ],
    out,
  );

  // 6. Age group.
  for (const [re, tok] of AGE_MAP) {
    re.lastIndex = 0;
    if (re.test(s)) out.add(tok);
    re.lastIndex = 0;
    s = s.replace(re, ' ');
  }

  // 7. Colors (triage tags, tape, pack colors).
  s = extract(s, [{ re: COLOR_RE, fn: (m) => `color:${m[1] === 'grey' ? 'gray' : m[1]}` }], out);

  // 8. Any remaining bare number (Stat Pack 1 vs Stat Pack 2, ET tube 7.0 vs 7.5).
  s = extract(
    s,
    [{ re: new RegExp(`${B}(${NUM})${E}`, 'g'), fn: (m) => `num:${normNum(m[1])}` }],
    out,
  );

  const tokens = [...out].sort();
  return { tokens, key: tokens.join('|') };
}

/** Variant signature of an inventory item: derived `name` plus `variantLabel` when not already in it. */
export function itemVariantSignature(item: { name?: string; variantLabel?: string }): VariantSignature {
  const name = item.name ?? '';
  const label = item.variantLabel ?? '';
  // Whole-word check: a bare "L" label must not count as "already present" just
  // because "Gloves" contains the letter l.
  const escaped = label.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const present = label
    ? new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(name.toLowerCase())
    : true;
  return variantSignature(present ? name : `${name} ${label}`);
}

/** True when two names/signatures describe the same variant (both empty counts as a match). */
export function variantsMatch(
  a: string | VariantSignature,
  b: string | VariantSignature,
): boolean {
  const sa = typeof a === 'string' ? variantSignature(a) : a;
  const sb = typeof b === 'string' ? variantSignature(b) : b;
  return sa.key === sb.key;
}

export type VariantMergeVerdict = 'ok' | 'blocked' | 'conflict';

export interface VariantMergeCheck {
  verdict: VariantMergeVerdict;
  /** Human-readable, plain-language reason (empty when `ok`). */
  reason: string;
  aTokens: string[];
  bTokens: string[];
}

function norm(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/**
 * May these two items be merged as duplicates?
 *   - `ok`       signatures match.
 *   - `conflict` signatures differ BUT the items share a SKU or barcode: the
 *                catalog contradicts itself (one code, two variants). Needs a
 *                human to decide which is wrong; never auto-merged.
 *   - `blocked`  signatures differ and nothing links them: different products.
 */
export function checkVariantMerge(
  a: { name?: string; variantLabel?: string; sku?: string; barcode?: string | null },
  b: { name?: string; variantLabel?: string; sku?: string; barcode?: string | null },
): VariantMergeCheck {
  const sa = itemVariantSignature(a);
  const sb = itemVariantSignature(b);
  if (sa.key === sb.key) return { verdict: 'ok', reason: '', aTokens: sa.tokens, bTokens: sb.tokens };

  const describe = (t: string[]) => (t.length ? t.map((x) => x.replace(':', ' ')).join(', ') : 'no size/variant');
  const skuA = norm(a.sku), skuB = norm(b.sku);
  const barA = norm(a.barcode), barB = norm(b.barcode);
  const sharedCode = (skuA && skuA === skuB) || (barA && barA === barB);
  const diff = `"${a.name ?? ''}" (${describe(sa.tokens)}) vs "${b.name ?? ''}" (${describe(sb.tokens)})`;
  return sharedCode
    ? {
        verdict: 'conflict',
        reason: `They share a SKU/barcode but are different variants: ${diff}. Fix the wrong code or name first.`,
        aTokens: sa.tokens,
        bTokens: sb.tokens,
      }
    : {
        verdict: 'blocked',
        reason: `They are different sizes/variants: ${diff}.`,
        aTokens: sa.tokens,
        bTokens: sb.tokens,
      };
}
