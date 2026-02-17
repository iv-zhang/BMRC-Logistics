/**
 * Google Sheets import helpers for statpack configuration.
 * Parses TSV/CSV pasted content and converts to StatpackItem[] with enriched inventory matches.
 */

import type { StatpackItem, StatpackPocket, ItemCategory, InventoryItem } from '@/app/types';

/**
 * Parsed row from sheet paste, before enrichment
 */
export interface ParsedSheetRow {
  rawName: string;
  quantity: number;
  pocket: string;
  rawPocket: string; // original value before normalization
  lineNum: number; // 1-indexed, for error reporting
}

/**
 * Enriched row with inventory match and mapping
 */
export interface EnrichedSheetRow extends ParsedSheetRow {
  matchedItemId?: string; // matched inventory item ID
  matchedItemName?: string;
  matchedItemCategory?: string;
  batchId?: string;
  compartmentId?: string;
  normalizedPocket: StatpackPocket;
  confidence: 'high' | 'medium' | 'low' | 'none'; // based on name match quality
  error?: string; // validation error if any
}

/**
 * Parse TSV/CSV from Google Sheets paste (tab-separated or comma-separated).
 * Expects format: [name] [tab/comma] [quantity] [optional: other cols] [tab/comma] [pocket]
 *
 * Heuristic: quantity is typically numeric in column 2; pocket is typically the last non-empty column.
 * Handles variable column counts.
 *
 * @param pastedText Raw text from Ctrl+C on Google Sheets
 * @returns Array of parsed rows with line numbers for error reporting
 */
export function parseSheetPaste(pastedText: string): ParsedSheetRow[] {
  if (!pastedText?.trim()) return [];

  const lines = pastedText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0); // skip empty lines

  const rows: ParsedSheetRow[] = [];
  let lineNum = 1;

  for (const line of lines) {
    // Detect delimiter: try tab first, then comma
    let cols: string[] = [];
    if (line.includes('\t')) {
      cols = line.split('\t').map((c) => c.trim());
    } else {
      cols = line.split(',').map((c) => c.trim());
    }

    // Filter out completely empty columns
    cols = cols.filter((c) => c.length > 0);

    if (cols.length < 2) {
      lineNum++;
      continue; // skip rows with fewer than 2 non-empty columns
    }

    // Heuristic: first col = name, second col = quantity (or name if non-numeric)
    // Last non-empty column = pocket
    const name = cols[0];
    let qty = 1;
    let pocket = 'main';

    // Try to parse second column as quantity
    const secondColNum = Number(cols[1]);
    if (!isNaN(secondColNum) && secondColNum >= 0) {
      // Second column is numeric: it's the quantity
      qty = Math.floor(secondColNum);
      // Pocket is the last column
      pocket = cols[cols.length - 1] || 'main';
    } else {
      // Second column is not numeric: it might be part of the name
      // In this case, assume qty=1 and try to find pocket in the last column
      pocket = cols[cols.length - 1] || 'main';
    }

    rows.push({
      rawName: name,
      quantity: qty,
      pocket: normalizePocket(pocket),
      rawPocket: pocket,
      lineNum,
    });

    lineNum++;
  }

  return rows;
}

/**
 * Normalize pocket string to StatpackPocket enum value.
 * Heuristics: case-insensitive matching on keywords.
 * Examples:
 *   "front pocket" / "Front" / "front_aux" → "front_aux"
 *   "left" / "left pocket" / "side_left" → "side_left"
 *   "right" / "right pocket" / "side_right" → "side_right"
 *   default / "main" → "main"
 */
export function normalizePocket(rawPocket: string): StatpackPocket {
  const lower = rawPocket.toLowerCase().trim();

  if (lower.includes('front')) return 'front_aux';
  if (lower.includes('left')) return 'side_left';
  if (lower.includes('right')) return 'side_right';
  if (lower.includes('main')) return 'main';

  return 'main'; // default fallback
}

/**
 * Simple string similarity score (Levenshtein-based approximation for UI UX).
 * Returns 0–1 where 1 is exact match.
 */
export function itemNameSimilarity(query: string, candidate: string): number {
  const q = query.toLowerCase().trim();
  const c = candidate.toLowerCase().trim();

  if (q === c) return 1.0; // exact match
  if (c.includes(q) || q.includes(c)) return 0.85; // substring match

  // Simple character overlap heuristic
  const qChars = new Set(q.split(''));
  const cChars = new Set(c.split(''));
  const overlap = [...qChars].filter((ch) => cChars.has(ch)).length;
  const maxLen = Math.max(q.length, c.length);

  return Math.min(overlap / maxLen, 0.7);
}

/**
 * Confidence level based on similarity score.
 */
export function confidenceFromSimilarity(similarity: number): 'high' | 'medium' | 'low' | 'none' {
  if (similarity >= 0.8) return 'high';
  if (similarity >= 0.6) return 'medium';
  if (similarity > 0) return 'low';
  return 'none';
}

/**
 * Convert enriched rows to StatpackItem[] for saving.
 * Validates that required fields are present.
 *
 * @param enrichedRows Rows with inventory matches and batch IDs assigned
 * @returns Array of StatpackItem ready for save
 * @throws Error if validation fails (e.g., missing batchId)
 */
export function convertToStatpackItems(enrichedRows: EnrichedSheetRow[]): StatpackItem[] {
  const items: StatpackItem[] = [];

  for (const row of enrichedRows) {
    if (row.error) {
      throw new Error(`Row ${row.lineNum}: ${row.error}`);
    }

    if (!row.matchedItemId) {
      throw new Error(
        `Row ${row.lineNum} ("${row.rawName}"): No inventory item matched. Please select a match or verify the item exists.`
      );
    }

    if (!row.batchId) {
      throw new Error(`Row ${row.lineNum} ("${row.rawName}"): batch ID is required. Please assign a batch.`);
    }

    const item: StatpackItem = {
      itemId: row.matchedItemId,
      requiredQuantity: row.quantity,
      currentQuantity: 0,
      pocket: row.normalizedPocket,
      compartmentId: row.compartmentId,
      batchId: row.batchId,
      itemDetails: {
        id: row.matchedItemId,
        name: row.matchedItemName || row.rawName,
        category: ((row.matchedItemCategory || 'Other') as unknown) as ItemCategory,
        unopenedBoxes: 0,
        tracksExpiration: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as InventoryItem,
    };

    items.push(item);
  }

  return items;
}
