/**
 * Small shared helpers for the Settings UI — id generation and validation.
 * No JSON editing anywhere; these just keep the tab components terse.
 */
import type { OrgConfigDoc } from '@/app/config/org-config';

/** Generate a reasonably unique id for a new location/room/category/pocket/etc. */
export function newId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Validate a full draft config; returns a list of plain-language problems (empty = valid). */
export function validateOrgConfig(draft: OrgConfigDoc): string[] {
  const errors: string[] = [];

  if (!draft.org.name.trim()) errors.push('Organization name cannot be empty.');
  if (!draft.org.shortName.trim()) errors.push('Organization short name cannot be empty.');

  draft.locations.forEach((loc) => {
    if (!loc.name.trim()) errors.push('Every site needs a name.');
    loc.rooms.forEach((r) => {
      if (!r.name.trim()) errors.push(`Every room in "${loc.name || 'a site'}" needs a name.`);
    });
  });

  draft.itemCategories.forEach((c) => {
    if (!c.trim()) errors.push('Item categories cannot be empty.');
  });

  draft.assetCategories.forEach((c) => {
    if (!c.name.trim()) errors.push('Every asset category needs a name.');
  });

  draft.statpackTypes.forEach((t) => {
    if (!t.name.trim()) errors.push('Every statpack type needs a name.');
    t.pockets.forEach((p) => {
      if (!p.label.trim()) errors.push(`Every pocket in "${t.name || 'a statpack type'}" needs a label.`);
    });
  });

  draft.vehicles.forEach((v) => {
    if (!v.name.trim()) errors.push('Every vehicle needs a name.');
    if (v.hasStatpacks && v.maxStatpacks != null && v.maxStatpacks < 0) {
      errors.push(`"${v.name}" cannot carry a negative number of statpacks.`);
    }
  });

  const t = draft.thresholds;
  (Object.keys(t) as (keyof typeof t)[]).forEach((key) => {
    if (typeof t[key] === 'number' && (t[key] < 0 || Number.isNaN(t[key]))) {
      errors.push('Thresholds must be zero or greater.');
    }
  });

  return errors;
}
