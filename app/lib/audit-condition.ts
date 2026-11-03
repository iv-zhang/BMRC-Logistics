/**
 * Pure helpers for the per-unit condition breakdown recorded in the supply
 * audit Count action. No Firebase imports — safe for tests and UI.
 */

  export type AuditConditionValue = 'Good' | 'Damaged' | 'Expired';
export interface AuditConditionCounts { damaged: number; expired: number }

const RANK: Record<AuditConditionValue, number> = { Good: 0, Damaged: 1, Expired: 2 };

/** Expired > Damaged > Good. */
export function worstCondition(...conditions: AuditConditionValue[]): AuditConditionValue {
  let worst = 0;
  for (const c of conditions) if (RANK[c] > worst) worst = RANK[c];
  return worst == 0 ? 'Good'
    : worst == 1 ? 'Damaged'
    : 'Expired';
}

/** worst(packageCondition, expired>0 ? 'Expired' : damaged>0 ? 'Damaged' : 'Good'); counts null/undefined = Good. */
export function deriveAuditCondition(
  packageCondition: AuditConditionValue,
  counts?: AuditConditionCounts | null,
): AuditConditionValue {
  const fromCounts: AuditConditionValue = counts && counts.expired > 0 ? 'Expired'
    : counts && counts.damaged > 0 ? 'Damaged' : 'Good';
  return worstCondition(packageCondition, fromCounts);
}

/** null when valid; else a short plain-language error. */
export function validateConditionCounts(counts: AuditConditionCounts, looseUnits: number): string | null {
  const ok = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (!ok(counts.damaged) || !ok(counts.expired)) {
    return 'Damaged and expired counts must be whole numbers, zero or more.';
  }
  if (counts.damaged + counts.expired > looseUnits) {
    return `Damaged + expired (${counts.damaged + counts.expired}) can't exceed the ${looseUnits} loose units counted.`;
  }
  return null;
}

/** "2 damaged · 1 expired", "1 damaged", "3 expired"; null when both are 0 or counts missing. */
export function formatConditionCounts(counts?: AuditConditionCounts | null): string | null {
  if (!counts) return null;
  const parts: string[] = [];
  if (counts.damaged > 0) parts.push(`${counts.damaged} damaged`);
  if (counts.expired > 0) parts.push(`${counts.expired} expired`);
  return parts.length ? parts.join(' · ') : null;
}
