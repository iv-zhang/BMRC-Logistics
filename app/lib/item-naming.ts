/**
 * Structured item naming — parent-first / variant-last.
 *
 * `InventoryItem.name` is DERIVED and persisted (see the doc comment on
 * `name` in `app/types.ts`): `${family}, ${variantLabel}` when a variant is
 * present, else just `family`. `family` is a controlled list from
 * `orgConfig.itemFamilies`; `variantLabel` is free text (e.g. "Small", "M",
 * "28 Fr"). Nothing here writes `name` by hand — always derive it.
 */

import { collection, getDocs, query, where, writeBatch } from 'firebase/firestore';
import { db } from '@/firebase';

/** Firestore write-batch cap is 500 ops; chunk comfortably under that. */
const RENAME_BATCH_CHUNK_SIZE = 400;

/**
 * Title-case a family name: capitalize each word, but leave a word alone if
 * it's already all-caps or mixed-caps (preserves acronyms like "OPAs"/"AED").
 */
function titleCaseWord(word: string): string {
  if (!word) return word;
  const hasInternalUpper = /[A-Z]/.test(word.slice(1));
  if (hasInternalUpper) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function titleCaseFamily(family: string): string {
  return family
    .split(/\s+/)
    .filter(Boolean)
    .map(titleCaseWord)
    .join(' ');
}

/**
 * Derive the persisted `name` from a family + optional variant label.
 * Trims both; title-cases the family (preserving acronyms); joins with
 * ", " when a variant is present, else returns just the family.
 */
export function deriveItemName(family: string, variantLabel?: string): string {
  const famTrim = (family ?? '').trim();
  const varTrim = (variantLabel ?? '').trim();
  const famTitled = titleCaseFamily(famTrim);
  return varTrim ? `${famTitled}, ${varTrim}` : famTitled;
}

export interface ParsedLegacyName {
  family: string;
  variantLabel?: string;
  /**
   * True only when the derived family case-insensitively matches an entry in
   * `families` AND a variant was actually extracted, OR when the whole name
   * matches a family exactly (variant left undefined). Otherwise false, with
   * `family` set to the best guess (the whole name when nothing could split).
   */
  confident: boolean;
}

/**
 * Split a free-typed legacy `InventoryItem.name` into a family + variant
 * label, in the order: (a) trailing parenthetical — "Nitrile Gloves (Large)";
 * (b) last comma — "Bandaids, Small"; (c) ` - ` / ` — ` separator. Pure
 * function, no Firestore.
 */
export function parseLegacyName(name: string, families: string[]): ParsedLegacyName {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return { family: '', confident: false };

  let family = trimmed;
  let variantLabel: string | undefined;

  // (a) trailing parenthetical: "Nitrile Gloves (Large)"
  const parenMatch = trimmed.match(/^(.*\S)\s*\(([^()]+)\)\s*$/);
  if (parenMatch) {
    family = parenMatch[1].trim();
    variantLabel = parenMatch[2].trim();
  } else {
    // (b) last comma: "Bandaids, Small"
    const lastComma = trimmed.lastIndexOf(',');
    if (lastComma > 0 && lastComma < trimmed.length - 1) {
      family = trimmed.slice(0, lastComma).trim();
      variantLabel = trimmed.slice(lastComma + 1).trim();
    } else {
      // (c) ' - ' / ' — ' separator
      const dashMatch = trimmed.match(/^(.*\S)\s+(?:-|—)\s+(\S.*)$/);
      if (dashMatch) {
        family = dashMatch[1].trim();
        variantLabel = dashMatch[2].trim();
      }
    }
  }

  const wholeMatch = families.find((f) => f.toLowerCase() === trimmed.toLowerCase());
  if (wholeMatch && !variantLabel) {
    return { family: wholeMatch, confident: true };
  }

  const familyMatch = families.find((f) => f.toLowerCase() === family.toLowerCase());
  if (familyMatch && variantLabel) {
    return { family: familyMatch, variantLabel, confident: true };
  }

  return { family: family || trimmed, variantLabel, confident: false };
}

/**
 * Rename a family across every `inventory` doc that uses it: writes the new
 * `family` and regenerates `name` from it. Renaming a family (unlike an item
 * category) REGENERATES the derived name on every item using it. Batched in
 * chunks of {@link RENAME_BATCH_CHUNK_SIZE} to stay under the Firestore
 * write-batch cap. Returns the number of items updated.
 */
export async function propagateFamilyRename(
  oldFamily: string,
  newFamily: string,
  actor: { id?: string; name?: string },
): Promise<number> {
  void actor; // reserved for future audit-event stamping on rename
  const q = query(collection(db, 'inventory'), where('family', '==', oldFamily));
  const snap = await getDocs(q);
  if (snap.empty) return 0;

  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += RENAME_BATCH_CHUNK_SIZE) {
    const chunk = docs.slice(i, i + RENAME_BATCH_CHUNK_SIZE);
    const batch = writeBatch(db);
    for (const d of chunk) {
      const data = d.data() as { variantLabel?: string };
      batch.update(d.ref, {
        family: newFamily,
        name: deriveItemName(newFamily, data.variantLabel),
      });
    }
    await batch.commit();
  }

  return docs.length;
}
