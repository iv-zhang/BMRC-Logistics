/**
 * Critical statpack items: the life-safety gear whose problems page an admin.
 *
 * Decided 2026-11-03 (decisions.md D-8 amendment): every shortage, report and
 * acknowledgement creates a report / restock task, but only these items also
 * send an in-app notification to admin/QM. Pure — no Firebase imports.
 */
import type { StatpackItem } from '@/app/types';

export type CriticalKind = 'aed' | 'oxygen' | 'epinephrine';

export interface CriticalItemSignals {
  name?: string | null;
  assetCategory?: string | null;
  isOxygen?: boolean | null;
  /** The item carries an O₂ PSI minimum (check-off `needPsi`). */
  hasPsiRule?: boolean | null;
}

const AED_RE = /\baed\b/i;
const EPI_RE = /\bepi(?:pen|nephrine)?\b|\bepinephrine\b|\badrenaline\b/i;

export function criticalKindOf(s: CriticalItemSignals): CriticalKind | null {
  const name = s.name ?? '';
  if (s.assetCategory === 'AED' || AED_RE.test(name)) return 'aed';
  if (s.isOxygen === true || s.hasPsiRule === true) return 'oxygen';
  if (EPI_RE.test(name)) return 'epinephrine';
  return null;
}

export function isCriticalItem(s: CriticalItemSignals): boolean {
  return criticalKindOf(s) !== null;
}

/** Convenience for pack contents (reads the denormalized `itemDetails`). */
export function isCriticalStatpackItem(item: StatpackItem): boolean {
  const d = item.itemDetails;
  return isCriticalItem({
    name: d?.name,
    assetCategory: d?.assetCategory,
    isOxygen: d?.isOxygen,
    hasPsiRule: (item.verificationRules?.requireO2PsiMin ?? 0) > 0,
  });
}
