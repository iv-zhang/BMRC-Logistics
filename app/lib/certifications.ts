'use client';

/**
 * Member certification framework (shift-signup gating).
 *
 * The app tracks EXPIRY DATES ONLY — the underlying EMT/CPR documents live
 * off-app. A member may only request a shift when BOTH the CA EMT and CPR
 * certifications are present and unexpired. When a cert lapses the member sends
 * fresh paperwork to MedOps, who manually updates the expiry date here (which
 * re-opens signup). See `updateMemberCertification`.
 */

import { doc, updateDoc, serverTimestamp, Timestamp } from 'firebase/firestore';
import { db } from '@/firebase';
import { getRequireCertsForShiftSignup } from '@/app/config/org-config';
import type {
  User,
  CertStatus,
  CertificationRecord,
  MemberCertifications,
} from '@/app/types';

export type CertKind = 'emt' | 'cpr';

export const CERT_LABELS: Record<CertKind, string> = {
  emt: 'CA EMT Certification',
  cpr: 'CPR Certification',
};

/** Coerce a Firestore Timestamp / Date / undefined to a Date (or null). */
function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (value instanceof Timestamp) return value.toDate();
  // Plain object with toDate() (Timestamp-like) or a millis number/string.
  const anyVal = value as { toDate?: () => Date };
  if (typeof anyVal.toDate === 'function') return anyVal.toDate();
  const d = new Date(value as string | number);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Status of a single certification record relative to `now`. */
export function getCertStatus(record?: CertificationRecord, now: Date = new Date()): CertStatus {
  const exp = toDate(record?.expiresOn);
  if (!exp) return 'missing';
  // Expired the moment the expiration day has fully passed (end-of-day grace).
  const endOfDay = new Date(exp);
  endOfDay.setHours(23, 59, 59, 999);
  return endOfDay.getTime() >= now.getTime() ? 'valid' : 'expired';
}

/** Per-cert status map for a member. */
export function getMemberCertStatuses(
  user: Pick<User, 'certifications'> | null | undefined,
  now: Date = new Date(),
): Record<CertKind, CertStatus> {
  const certs = user?.certifications;
  return {
    emt: getCertStatus(certs?.emt, now),
    cpr: getCertStatus(certs?.cpr, now),
  };
}

/** True only when every required cert is present and unexpired. When the org has
 * turned off `requireCertsForShiftSignup`, this always returns true. */
export function canSignUpForShifts(
  user: Pick<User, 'certifications'> | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!getRequireCertsForShiftSignup()) return true;
  const s = getMemberCertStatuses(user, now);
  return s.emt === 'valid' && s.cpr === 'valid';
}

/**
 * Human-readable reason a member cannot sign up, or `null` if they can. Suitable
 * for a disabled-button tooltip.
 */
export function getShiftBlockReason(
  user: Pick<User, 'certifications'> | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!getRequireCertsForShiftSignup()) return null;
  const s = getMemberCertStatuses(user, now);
  const problems: string[] = [];
  (['emt', 'cpr'] as CertKind[]).forEach((k) => {
    if (s[k] === 'missing') problems.push(`${CERT_LABELS[k]} not on file`);
    else if (s[k] === 'expired') problems.push(`${CERT_LABELS[k]} expired`);
  });
  if (problems.length === 0) return null;
  return `${problems.join(' · ')}. Send updated documents to MedOps to restore signup.`;
}

/** Days until a cert expires (negative = already expired, null = missing). */
export function daysUntilExpiry(record?: CertificationRecord, now: Date = new Date()): number | null {
  const exp = toDate(record?.expiresOn);
  if (!exp) return null;
  return Math.floor((exp.getTime() - now.getTime()) / 86_400_000);
}

/**
 * Set/renew one of a member's certifications. Called by medops/admin from the
 * roster. `expiresOn` of `null` clears the date (back to `missing`).
 */
export async function updateMemberCertification(
  userId: string,
  kind: CertKind,
  patch: { number?: string; expiresOn?: Date | null },
  actor: { uid: string; name: string },
): Promise<void> {
  const update: Record<string, unknown> = {
    [`certifications.${kind}.verifiedBy`]: actor.name,
    [`certifications.${kind}.verifiedAt`]: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  if (patch.expiresOn !== undefined) {
    update[`certifications.${kind}.expiresOn`] =
      patch.expiresOn === null ? null : Timestamp.fromDate(patch.expiresOn);
  }
  if (patch.number !== undefined) {
    update[`certifications.${kind}.number`] = patch.number.trim() || null;
  }
  await updateDoc(doc(db, 'users', userId), update);
}

export type { CertificationRecord, MemberCertifications };
