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

const AED_ACCESSORY_RE = /\bpads?\b|\bbatter(?:y|ies)\b|\btrainer\b/i;

export interface AedDeviceSignals {
  name?: string | null;
  assetCategory?: string | null;
  isTrainer?: boolean | null;
}

/**
 * True only for the AED unit itself (gets the pads / battery / expiry checklist).
 * "AED Pads", "AED Battery" and trainer AEDs are not the device. An explicit
 * `assetCategory === 'AED'` always wins.
 */
export function isAedDevice(d: AedDeviceSignals | null | undefined): boolean {
  if (!d) return false;
  if (d.assetCategory === 'AED') return true;
  if (d.isTrainer === true) return false;
  const name = d.name ?? '';
  return AED_RE.test(name) && !AED_ACCESSORY_RE.test(name);
}

/** Epinephrine auto-injector / vial (needs the "solution clear" check). */
export function isEpinephrine(d: { name?: string | null } | null | undefined): boolean {
  return EPI_RE.test(d?.name ?? '');
}

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
