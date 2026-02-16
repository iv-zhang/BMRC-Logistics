'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  collection,
  query,
  orderBy,
  onSnapshot,
} from 'firebase/firestore';
import { db } from '@/firebase';
import type { StorageZone, Shelf, Container } from '@/app/types';

export interface UseStorageLocationsReturn {
  /** All storage zones, sorted by name */
  zones: StorageZone[];
  /** All shelves, sorted by name */
  shelves: Shelf[];
  /** All containers, sorted by name */
  containers: Container[];
  /** Whether data is still loading from Firestore */
  loading: boolean;
  /** Get shelves belonging to a specific zone */
  getShelvesForZone: (zoneId: string) => Shelf[];
  /** Get containers belonging to a specific shelf */
  getContainersForShelf: (shelfId: string) => Container[];
  /** Get the number of levels for a shelf (defaults to 1) */
  getLevelsForShelf: (shelfId: string) => number;
  /** Get level labels for a shelf (if configured) */
  getLevelLabelsForShelf: (shelfId: string) => string[];
  /** Find a zone by its ID */
  getZoneById: (zoneId: string) => StorageZone | undefined;
  /** Find a shelf by its ID */
  getShelfById: (shelfId: string) => Shelf | undefined;
  /** Find a container by its ID */
  getContainerById: (containerId: string) => Container | undefined;
}

/**
 * Shared hook that provides real-time access to storage locations
 * (zones, shelves, containers) from Firestore.
 *
 * Uses onSnapshot listeners so the data stays up-to-date when
 * Storage Management is edited in another tab/user.
 */
export function useStorageLocations(): UseStorageLocationsReturn {
  const [zones, setZones] = useState<StorageZone[]>([]);
  const [shelves, setShelves] = useState<Shelf[]>([]);
  const [containers, setContainers] = useState<Container[]>([]);
  const [loading, setLoading] = useState(true);

  // Track individual collection readiness
  const [zonesReady, setZonesReady] = useState(false);
  const [shelvesReady, setShelvesReady] = useState(false);
  const [containersReady, setContainersReady] = useState(false);

  useEffect(() => {
    const qZones = query(collection(db, 'storage_zones'), orderBy('name'));
    const unsubZones = onSnapshot(
      qZones,
      (snap) => {
        setZones(
          snap.docs.map((d) => ({ id: d.id, ...d.data() } as StorageZone))
        );
        setZonesReady(true);
      },
      (e) => {
        console.error('[useStorageLocations] Zones listener error', e);
        setZonesReady(true); // still mark ready so loading resolves
      }
    );

    const qShelves = query(collection(db, 'shelves'), orderBy('name'));
    const unsubShelves = onSnapshot(
      qShelves,
      (snap) => {
        setShelves(
          snap.docs.map((d) => ({ id: d.id, ...d.data() } as Shelf))
        );
        setShelvesReady(true);
      },
      (e) => {
        console.error('[useStorageLocations] Shelves listener error', e);
        setShelvesReady(true);
      }
    );

    const qContainers = query(collection(db, 'containers'), orderBy('name'));
    const unsubContainers = onSnapshot(
      qContainers,
      (snap) => {
        setContainers(
          snap.docs.map((d) => ({ id: d.id, ...d.data() } as Container))
        );
        setContainersReady(true);
      },
      (e) => {
        console.error('[useStorageLocations] Containers listener error', e);
        setContainersReady(true);
      }
    );

    return () => {
      unsubZones();
      unsubShelves();
      unsubContainers();
    };
  }, []);

  // Loading is resolved once all three collections have reported at least once
  useEffect(() => {
    if (zonesReady && shelvesReady && containersReady) {
      setLoading(false);
    }
  }, [zonesReady, shelvesReady, containersReady]);

  // --- Memoized lookup maps ---
  const shelfByZone = useMemo(() => {
    const map = new Map<string, Shelf[]>();
    for (const s of shelves) {
      if (!s.zoneId) continue;
      const arr = map.get(s.zoneId) || [];
      arr.push(s);
      map.set(s.zoneId, arr);
    }
    return map;
  }, [shelves]);

  const containerByShelf = useMemo(() => {
    const map = new Map<string, Container[]>();
    for (const c of containers) {
      if (!c.shelfId) continue;
      const arr = map.get(c.shelfId) || [];
      arr.push(c);
      map.set(c.shelfId, arr);
    }
    return map;
  }, [containers]);

  const zoneMap = useMemo(
    () => new Map(zones.map((z) => [z.id, z])),
    [zones]
  );
  const shelfMap = useMemo(
    () => new Map(shelves.map((s) => [s.id, s])),
    [shelves]
  );
  const containerMap = useMemo(
    () => new Map(containers.map((c) => [c.id, c])),
    [containers]
  );

  // --- Helper callbacks ---
  const getShelvesForZone = useCallback(
    (zoneId: string) => shelfByZone.get(zoneId) || [],
    [shelfByZone]
  );

  const getContainersForShelf = useCallback(
    (shelfId: string) => containerByShelf.get(shelfId) || [],
    [containerByShelf]
  );

  const getLevelsForShelf = useCallback(
    (shelfId: string) => {
      const shelf = shelfMap.get(shelfId);
      return shelf?.numberOfLevels ?? 1;
    },
    [shelfMap]
  );

  const getLevelLabelsForShelf = useCallback(
    (shelfId: string) => {
      const shelf = shelfMap.get(shelfId);
      return shelf?.levelLabels ?? [];
    },
    [shelfMap]
  );

  const getZoneById = useCallback(
    (zoneId: string) => zoneMap.get(zoneId),
    [zoneMap]
  );

  const getShelfById = useCallback(
    (shelfId: string) => shelfMap.get(shelfId),
    [shelfMap]
  );

  const getContainerById = useCallback(
    (containerId: string) => containerMap.get(containerId),
    [containerMap]
  );

  return {
    zones,
    shelves,
    containers,
    loading,
    getShelvesForZone,
    getContainersForShelf,
    getLevelsForShelf,
    getLevelLabelsForShelf,
    getZoneById,
    getShelfById,
    getContainerById,
  };
}
