/* eslint-disable @typescript-eslint/no-explicit-any */
import { Timestamp } from 'firebase/firestore';

const uniqueIdFallback = () => (typeof crypto !== 'undefined' && (crypto as any).randomUUID ? (crypto as any).randomUUID() : `${Date.now().toString()}-${Math.random().toString(36).slice(2,9)}`);

export const safeParseDate = (v?: Date | string | null) => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof (v as any)?.toDate === 'function') {
    try {
      const d = (v as any).toDate();
      return d instanceof Date && !isNaN(d.getTime()) ? d : undefined;
    } catch {
      return undefined;
    }
  }
  const d = new Date(v as any);
  return isNaN(d.getTime()) ? undefined : d;
};

// Prepare payload for writing to Firestore: normalize dates, numbers, variants and batches
export function preparePayload(data: any, opts?: { uniqueId?: () => string }) {
  const uniqueId = opts?.uniqueId ?? uniqueIdFallback;
  const payload: any = { ...(data || {}) };

  if (payload.openedAt) {
    if (typeof payload.openedAt === 'string') {
      const d = new Date(payload.openedAt);
      payload.openedAt = isNaN(d.getTime()) ? null : d;
    } else if (!(payload.openedAt instanceof Date)) {
      payload.openedAt = null;
    }
  }

  // Box-based tracking
  payload.unopenedBoxes = Number(payload.unopenedBoxes ?? 0);
  payload.itemsPerBox = payload.itemsPerBox ? Number(payload.itemsPerBox) : null;
  
  // Legacy fields for backwards compat
  payload.totalStockQuantity = Number(payload.totalStockQuantity ?? 0);
  payload.reorderThreshold = Number(payload.reorderThreshold ?? 0);

  // Variations feature removed: prevent writing variants/hasVariants to Firestore
  if (payload.variants) {
    delete payload.variants;
  }
  // ensure hasVariants flag is not persisted
  if (payload.hasVariants) payload.hasVariants = false;

  // Remove deprecated flags: disposability and audit requirement are derived/not persisted
  if (payload.isDisposable !== undefined) delete payload.isDisposable;
  if (payload.isAuditRequired !== undefined) delete payload.isAuditRequired;

  // Normalize batches
  if (Array.isArray(payload.batches) && payload.batches.length > 0) {
    const normBatches = payload.batches.map((b: any) => {
      const out: any = { ...b };
      if (out.expirationDate) {
        if (typeof out.expirationDate === 'string') {
          const d = new Date(out.expirationDate);
          out.expirationDate = isNaN(d.getTime()) ? null : d;
        } else if (!(out.expirationDate instanceof Date)) {
          out.expirationDate = null;
        }
      }
      out.stock = Number(out.stock ?? 0);
      out.receivedAt = out.receivedAt ? (out.receivedAt instanceof Date ? out.receivedAt : new Date(out.receivedAt)) : undefined;
      out.locations = Array.isArray(out.locations) ? out.locations.map((l: any) => ({ id: l.id ?? uniqueId(), name: l.name ?? '', quantity: Number(l.quantity ?? 0) })) : [];
      return out;
    });
    payload.batches = normBatches;

    const hasBatchData = normBatches.some((b: any) =>
      !!b.expirationDate || !!b.lotNumber || !!b.serialized ||
      (Array.isArray(b.serialNumbers) && b.serialNumbers.length > 0) ||
      b.bagCount !== undefined || b.itemsPerBag !== undefined
    );
    payload.totalStockQuantity = normBatches.reduce((acc: number, b: any) => acc + Number(b.stock ?? 0), 0);
    if (!hasBatchData) {
      // treat as static-tracked
      delete payload.batches;
    }
  }

  const removeUndefinedDeep = (obj: any) => {
    if (obj === null || obj === undefined) return;
    if (Array.isArray(obj)) {
      for (let i = obj.length - 1; i >= 0; i--) {
        const v = obj[i];
        if (v === undefined) obj.splice(i, 1);
        else if (typeof v === 'object' && v !== null) removeUndefinedDeep(v);
      }
      return;
    }
    if (typeof obj === 'object') {
      Object.keys(obj).forEach((k) => {
        const v = obj[k];
        if (v === undefined) delete obj[k];
        else if (typeof v === 'object' && v !== null) removeUndefinedDeep(v);
      });
    }
  };

  removeUndefinedDeep(payload);
  return payload;
}

export default {
  safeParseDate,
  preparePayload,
};
