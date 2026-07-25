/**
 * AED child-component assets: batteries and pads attached to a parent AED.
 *
 * A child component is a normal `inventory` doc (`isAsset: true`) that carries
 * `parentAssetId` (the AED's doc id) and `componentType: 'battery' | 'pads'`.
 * It is NOT a separate collection — it lives alongside every other inventory
 * item, discriminated by these flags (see CLAUDE.md: "there is no separate
 * assets collection").
 *
 * Mirrors the conventions in `app/lib/exchange-bags.ts` (subscribe pattern,
 * `db` import, Timestamp→Date hydration) and reuses `deepRemoveUndefined`
 * from `app/lib/audit.ts` to clean write payloads.
 */

import {
  collection,
  query,
  where,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '@/firebase';
import { deepRemoveUndefined } from '@/app/lib/audit';

export interface AedComponent {
  id: string;
  parentAssetId: string;
  componentType: 'battery' | 'pads';
  name?: string;
  assetModel?: string;
  lotNumber?: string;
  expirationDate?: Date;
  assetSerial?: string;
  batteryStatus?: 'Good' | 'Low' | 'Unknown';
  padsSealed?: boolean;
}

function toDateVal(v: unknown): Date | undefined {
  if (!v) return undefined;
  if (v instanceof Date) return v;
  const anyV = v as { toDate?: () => Date };
  if (typeof anyV.toDate === 'function') return anyV.toDate();
  return undefined;
}

function hydrateAedComponent(id: string, raw: Record<string, unknown>): AedComponent {
  const assetChecks = (raw.assetChecks as Record<string, unknown> | undefined) ?? {};
  return {
    id,
    parentAssetId: raw.parentAssetId as string,
    componentType: raw.componentType as 'battery' | 'pads',
    name: raw.name as string | undefined,
    assetModel: raw.assetModel as string | undefined,
    lotNumber: raw.lotNumber as string | undefined,
    expirationDate: toDateVal(raw.expirationDate),
    assetSerial: raw.assetSerial as string | undefined,
    batteryStatus: assetChecks.batteryStatus as 'Good' | 'Low' | 'Unknown' | undefined,
    padsSealed: assetChecks.padsSealed as boolean | undefined,
  };
}

/**
 * Live subscription to a parent AED's child components (battery + pads).
 * Queries `inventory` by `parentAssetId` only (no composite index needed),
 * then filters client-side to docs whose `componentType` is 'battery' or
 * 'pads' — this excludes any other item that happens to reference the same
 * `parentAssetId` for an unrelated reason.
 */
export function subscribeAedComponents(
  parentId: string,
  cb: (components: AedComponent[]) => void,
): () => void {
  const q = query(collection(db, 'inventory'), where('parentAssetId', '==', parentId));
  return onSnapshot(q, (snap) => {
    const components = snap.docs
      .filter((d) => {
        const componentType = d.data().componentType;
        return componentType === 'battery' || componentType === 'pads';
      })
      .map((d) => hydrateAedComponent(d.id, d.data()));
    cb(components);
  });
}

/**
 * Create (no `id`) or update (with `id`) an AED child-component inventory
 * doc. Returns the doc id.
 */
export async function saveAedComponent(
  parentId: string,
  component: Partial<AedComponent> & { id?: string },
  actor: { id?: string; name?: string },
): Promise<string> {
  const { id, ...rest } = component;

  const base = deepRemoveUndefined({
    isAsset: true,
    parentAssetId: parentId,
    componentType: rest.componentType,
    name: rest.name,
    assetModel: rest.assetModel,
    lotNumber: rest.lotNumber,
    expirationDate: rest.expirationDate,
    assetSerial: rest.assetSerial,
    assetChecks: {
      batteryStatus: rest.batteryStatus,
      padsSealed: rest.padsSealed,
    },
    updatedAt: serverTimestamp(),
    updatedBy: actor.name ?? null,
  });

  if (id) {
    await updateDoc(doc(db, 'inventory', id), base);
    return id;
  }

  const ref = await addDoc(
    collection(db, 'inventory'),
    deepRemoveUndefined({
      ...base,
      createdAt: serverTimestamp(),
    }),
  );
  return ref.id;
}

export async function deleteAedComponent(id: string): Promise<void> {
  await deleteDoc(doc(db, 'inventory', id));
}
