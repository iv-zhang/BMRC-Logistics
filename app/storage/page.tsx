'use client';
import React, { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card,
  CardBody,
  Button,
  Spinner,
  Tabs,
  Tab,
  useDisclosure,
  Table,
  TableHeader,
  TableColumn,
  TableBody,
  TableRow,
  TableCell,
} from '@heroui/react';
import { Plus, Edit2, Trash2 } from 'lucide-react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import {
  collection,
  doc,
  onSnapshot,
  query,
  orderBy,
  addDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  getDocs,
  where,
  writeBatch,
} from 'firebase/firestore';
import { auth, db } from '@/firebase';
import type { StorageZone, Shelf, Container, User as AppUser } from '@/app/types';
import ShelfEditor from '@/app/components/shelf-editor';
import ContainerEditor from '@/app/components/container-editor';
import ZoneEditor from '@/app/components/zone-editor';

export default function StoragePage() {
  const router = useRouter();
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<AppUser['role'] | null>(null);
  const isAuthorized = userRole === 'admin' || userRole === 'quartermaster';

  const [zones, setZones] = useState<StorageZone[]>([]);
  const [shelves, setShelves] = useState<Shelf[]>([]);
  const [containers, setContainers] = useState<Container[]>([]);

  const [editingShelf, setEditingShelf] = useState<Shelf | null>(null);
  const [editingContainer, setEditingContainer] = useState<Container | null>(null);
  const shelfDisclosure = useDisclosure();
  const containerDisclosure = useDisclosure();
  const zoneDisclosure = useDisclosure();
  const [editingZone, setEditingZone] = useState<StorageZone | null>(null);
  const [dedupeLoading, setDedupeLoading] = useState(false);

  // Auth & data listeners
  useEffect(() => {
    const unsubAuth = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        try {
          const userDoc = await import('firebase/firestore').then(m =>
            m.getDoc(doc(db, 'users', u.uid))
          );
          if (userDoc.exists()) {
            setUserRole((userDoc.data() as any)?.role ?? 'member');
          }
        } catch (e) {
          console.error('Failed to fetch user role', e);
        }
      }
      setLoading(false);
    });

    const qZones = query(collection(db, 'storage_zones'), orderBy('name'));
    const unsubZones = onSnapshot(qZones, (snap) => {
      const arr = snap.docs.map(d => ({ id: d.id, ...d.data() } as StorageZone));
      setZones(arr);
    }, (e) => console.error('Zones listener error', e));

    const qShelves = query(collection(db, 'shelves'), orderBy('name'));
    const unsubShelves = onSnapshot(qShelves, (snap) => {
      const arr = snap.docs.map(d => ({ id: d.id, ...d.data() } as Shelf));
      setShelves(arr);
    }, (e) => console.error('Shelves listener error', e));

    const qContainers = query(collection(db, 'containers'), orderBy('name'));
    const unsubContainers = onSnapshot(qContainers, (snap) => {
      const arr = snap.docs.map(d => ({ id: d.id, ...d.data() } as Container));
      setContainers(arr);
    }, (e) => console.error('Containers listener error', e));

    return () => {
      try { unsubAuth(); } catch (e) {}
      try { unsubZones(); } catch (e) {}
      try { unsubShelves(); } catch (e) {}
      try { unsubContainers(); } catch (e) {}
    };
  }, []);

    // Ensure default storage zones exist (add any missing ones)
    const seededRef = useRef(false);
    useEffect(() => {
      if (!user || !isAuthorized) return;
      if (seededRef.current) return;

      const desired = [
        { name: 'CPR Closet', locationType: 'CPR Closet', description: 'Primary CPR supply closet' },
        { name: 'Bancroft Shed', locationType: 'Shed', description: 'Bancroft outdoor shed' },
        { name: 'HQ / Front/Reception', locationType: 'HQ', room: 'Front', description: 'Front / Reception area' },
        { name: 'HQ / Breakroom', locationType: 'HQ', description: 'Breakroom / Middle area' },
        { name: 'HQ / Back', locationType: 'HQ', room: 'Back Room', description: 'Back Room (authoritative inventory)' },
        { name: 'HQ / Office', locationType: 'HQ', room: 'Office', description: 'Office area' },
      ];

      const seedMissing = async () => {
        try {
          for (const d of desired) {
            const exists = zones.some(z => (z.name || '').toLowerCase().trim() === d.name.toLowerCase().trim());
            if (!exists) {
              await addDoc(collection(db, 'storage_zones'), { ...d, createdAt: serverTimestamp(), updatedAt: serverTimestamp() } as any);
            }
          }
        } catch (e) {
          console.error('Failed to seed storage zones', e);
        } finally {
          seededRef.current = true;
        }
      };

      seedMissing();
    }, [user, isAuthorized, zones]);

  if (loading) return <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center"><Spinner size="lg" color="primary" /></div>;
  if (!isAuthorized) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card>
          <CardBody>
            <p className="text-red-600">Access denied. Only admins and quartermasters can manage storage.</p>
            <Button onPress={() => router.push('/')} className="mt-4">Go Home</Button>
          </CardBody>
        </Card>
      </div>
    );
  }

  const handleDeleteShelf = async (shelfId: string) => {
    if (!confirm('Delete this shelf? Items stored directly on it will be unassigned from this shelf and any container on it (they will keep their zone). Containers physically on this shelf will be unassigned from the shelf.')) return;
    try {
      // Clear the shelf/container ref on every inventory item stored on this shelf.
      const qItems = query(collection(db, 'inventory'), where('storageLocation.shelfId', '==', shelfId));
      const itemSnap = await getDocs(qItems);
      if (!itemSnap.empty) {
        const docs = itemSnap.docs;
        for (let i = 0; i < docs.length; i += 450) {
          const chunk = docs.slice(i, i + 450);
          const batch = writeBatch(db);
          chunk.forEach((d) => {
            batch.update(doc(db, 'inventory', d.id), {
              'storageLocation.shelfId': null,
              'storageLocation.shelfName': null,
              'storageLocation.level': null,
              'storageLocation.containerId': null,
              'storageLocation.containerName': null,
            });
          });
          await batch.commit();
        }
      }

      // Unassign any containers physically located on this shelf.
      const qContainers = query(collection(db, 'containers'), where('shelfId', '==', shelfId));
      const containerSnap = await getDocs(qContainers);
      if (!containerSnap.empty) {
        const cDocs = containerSnap.docs;
        for (let i = 0; i < cDocs.length; i += 450) {
          const chunk = cDocs.slice(i, i + 450);
          const batch = writeBatch(db);
          chunk.forEach((d) => {
            batch.update(doc(db, 'containers', d.id), { shelfId: null, updatedAt: serverTimestamp() });
          });
          await batch.commit();
        }
      }

      await deleteDoc(doc(db, 'shelves', shelfId));
    } catch (e) {
      console.error('Delete shelf failed', e);
      alert('Failed to delete shelf.');
    }
  };

  const handleDeleteContainer = async (containerId: string) => {
    if (!confirm('Delete this container? Items stored in it will be unassigned from this container (they will keep their zone/shelf).')) return;
    try {
      const qItems = query(collection(db, 'inventory'), where('storageLocation.containerId', '==', containerId));
      const itemSnap = await getDocs(qItems);
      if (!itemSnap.empty) {
        const docs = itemSnap.docs;
        for (let i = 0; i < docs.length; i += 450) {
          const chunk = docs.slice(i, i + 450);
          const batch = writeBatch(db);
          chunk.forEach((d) => {
            batch.update(doc(db, 'inventory', d.id), {
              'storageLocation.containerId': null,
              'storageLocation.containerName': null,
            });
          });
          await batch.commit();
        }
      }

      await deleteDoc(doc(db, 'containers', containerId));
    } catch (e) {
      console.error('Delete container failed', e);
      alert('Failed to delete container.');
    }
  };

  const normalize = (s?: string) => (s || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');

  const cleanZoneDuplicates = async () => {
    if (!confirm('Clean duplicate storage zones? This will merge duplicates and reassign shelves.')) return;
    setDedupeLoading(true);
    try {
      const snap = await getDocs(collection(db, 'storage_zones'));
      const docs = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
      const groups = new Map<string, any[]>();
      for (const z of docs) {
        const key = `${normalize(z.name)}|${(z.locationType||'').toString()}|${(z.room||'')}`;
        const arr = groups.get(key) || [];
        arr.push(z);
        groups.set(key, arr);
      }

      let mergedCount = 0;
      for (const [key, arr] of groups.entries()) {
        if (arr.length <= 1) continue;
        // choose canonical: document with most non-empty fields
        const scored = arr.map(a => ({ doc: a, score: Object.values(a).filter(Boolean).length }));
        scored.sort((x, y) => y.score - x.score);
        const keep = scored[0].doc;
        const toRemove = scored.slice(1).map(s => s.doc);

        for (const old of toRemove) {
          // reassign shelves that reference the old zone
          const qs = query(collection(db, 'shelves'), where('zoneId', '==', old.id));
          const shelfSnap = await getDocs(qs);
          for (const sDoc of shelfSnap.docs) {
            try {
              await updateDoc(doc(db, 'shelves', sDoc.id), { zoneId: keep.id });
            } catch (e) {
              console.warn('Failed to update shelf zoneId', sDoc.id, e);
            }
          }

          // delete the old zone doc
          try {
            await deleteDoc(doc(db, 'storage_zones', old.id));
            mergedCount += 1;
          } catch (e) {
            console.warn('Failed to delete duplicate zone', old.id, e);
          }
        }
      }

      alert(`Deduplication complete. Removed ${mergedCount} duplicate zone(s).`);
    } catch (e) {
      console.error('Zone dedupe failed', e);
      alert('Zone dedupe failed: see console');
    } finally {
      setDedupeLoading(false);
    }
  };

  const exportContainerLabels = () => {
    if (containers.length === 0) {
      alert('No containers to export.');
      return;
    }
    
    // CSV format: Name, Barcode, ContainerURL, ShelfName, Zone
    // The ContainerURL can be scanned/clicked to open the container in the inventory page.
    const header = 'Container Name,Barcode,Container URL,Shelf,Zone';
    const rows = containers.map(c => {
      const shelf = shelves.find(s => s.id === c.shelfId);
      const zone = shelf ? zones.find(z => z.id === shelf.zoneId) : null;
      const containerUrl = typeof window !== 'undefined' 
        ? `${window.location.origin}/inventory?containerId=${c.id}`
        : `/inventory?containerId=${c.id}`;
      
      const name = `"${(c.name || '').replace(/"/g, '""')}"`;
      const barcode = `"${(c.barcode || '').replace(/"/g, '""')}"`;
      const url = `"${containerUrl}"`;
      const shelfName = `"${(shelf?.name || '').replace(/"/g, '""')}"`;
      const zoneName = `"${(zone?.name || '').replace(/"/g, '""')}"`;
      return [name, barcode, url, shelfName, zoneName].join(',');
    });
    
    const csv = [header, ...rows].join('\r\n');
    const blob = new Blob(["\uFEFF" + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `container_labels_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-4 md:p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
              Storage Management
            </h1>
            <p className="text-foreground-500">Manage shelves, containers, and storage zones.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="flat" onPress={exportContainerLabels}>Export Container Labels (CSV)</Button>
            <Button size="sm" variant="flat" onPress={cleanZoneDuplicates} isLoading={dedupeLoading}>Clean Duplicates</Button>
          </div>
        </div>

        {/* Tabs */}
        <Tabs aria-label="Storage management">
          {/* Zones Tab */}
          <Tab key="zones" title={`Zones (${zones.length})`}>
            <Card className="mt-4">
              <CardBody className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h2 className="text-xl font-semibold">Storage Zones</h2>
                    <p className="text-sm text-foreground-500">High-level location groupings (HQ Back Room, CPR Closet, Shed, etc.)</p>
                  </div>
                  <Button
                    color="primary"
                    startContent={<Plus size={16} />}
                    onPress={() => {
                      setEditingZone(null);
                      zoneDisclosure.onOpen();
                    }}
                  >
                    Add Zone
                  </Button>
                </div>
                {zones.length === 0 && (
                  <div className="text-center py-10">
                    <p className="text-foreground-500 mb-4">No zones created yet.</p>
                    <Button
                      color="primary"
                      startContent={<Plus size={16} />}
                      onPress={() => {
                        setEditingZone(null);
                        zoneDisclosure.onOpen();
                      }}
                    >
                      Add Zone
                    </Button>
                  </div>
                )}
                {zones.length > 0 && (
                  <div className="overflow-x-auto">
                    <Table aria-label="Storage zones">
                      <TableHeader>
                        <TableColumn>Name</TableColumn>
                        <TableColumn>Type</TableColumn>
                        <TableColumn>Room</TableColumn>
                        <TableColumn>Level</TableColumn>
                      </TableHeader>
                      <TableBody>
                        {zones.map(z => (
                          <TableRow
                            key={z.id}
                            role="button"
                            tabIndex={0}
                            className="cursor-pointer hover:bg-indigo-50 dark:hover:bg-slate-800"
                            onClick={() => { setEditingZone(z); zoneDisclosure.onOpen(); }}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { setEditingZone(z); zoneDisclosure.onOpen(); } }}
                          >
                            <TableCell>
                              <div className="text-sm text-primary">{z.name}</div>
                            </TableCell>
                            <TableCell>{z.locationType}</TableCell>
                            <TableCell>{z.room || '—'}</TableCell>
                            <TableCell>{z.level === 'upper' ? 'Upper' : z.level === 'lower' ? 'Lower' : '—'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardBody>
            </Card>
          </Tab>

          {/* Shelves Tab */}
          <Tab key="shelves" title={`Shelves (${shelves.length})`}>
            <Card className="mt-4">
              <CardBody className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold">Shelves</h2>
                  <Button
                    color="primary"
                    startContent={<Plus size={16} />}
                    onPress={() => {
                      setEditingShelf(null);
                      shelfDisclosure.onOpen();
                    }}
                  >
                    Add Shelf
                  </Button>
                </div>
                {shelves.length === 0 && <p className="text-foreground-500">No shelves created yet.</p>}
                {shelves.length > 0 && (
                  <div className="overflow-x-auto">
                  <Table aria-label="Shelves">
                    <TableHeader>
                      <TableColumn>Name</TableColumn>
                      <TableColumn>Zone</TableColumn>
                      <TableColumn>Levels</TableColumn>
                      <TableColumn>Capacity</TableColumn>
                      <TableColumn>Barcode</TableColumn>
                      <TableColumn>Actions</TableColumn>
                    </TableHeader>
                    <TableBody>
                      {shelves.map(s => {
                        const zone = zones.find(z => z.id === s.zoneId);
                        return (
                          <TableRow key={s.id}>
                            <TableCell>{s.name}</TableCell>
                            <TableCell>{zone?.name || '—'}</TableCell>
                            <TableCell>{s.numberOfLevels || '—'}</TableCell>
                            <TableCell>{s.capacity || '—'}</TableCell>
                            <TableCell className="text-xs text-foreground-500">{s.barcode ? `${s.barcode.substring(0, 10)}...` : '—'}</TableCell>
                            <TableCell>
                              <div className="flex gap-2">
                                <Button
                                  isIconOnly
                                  size="sm"
                                  variant="light"
                                  onPress={() => {
                                    setEditingShelf(s);
                                    shelfDisclosure.onOpen();
                                  }}
                                >
                                  <Edit2 size={16} />
                                </Button>
                                <Button
                                  isIconOnly
                                  size="sm"
                                  variant="light"
                                  color="danger"
                                  onPress={() => handleDeleteShelf(s.id)}
                                >
                                  <Trash2 size={16} />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                  </div>
                )}
              </CardBody>
            </Card>
          </Tab>

          {/* Containers Tab */}
          <Tab key="containers" title={`Containers (${containers.length})`}>
            <Card className="mt-4">
              <CardBody className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold">Containers / Boxes</h2>
                  <Button
                    color="primary"
                    startContent={<Plus size={16} />}
                    onPress={() => {
                      setEditingContainer(null);
                      containerDisclosure.onOpen();
                    }}
                  >
                    Add Container
                  </Button>
                </div>
                {containers.length === 0 && <p className="text-foreground-500">No containers created yet.</p>}
                {containers.length > 0 && (
                  <div className="overflow-x-auto">
                  <Table aria-label="Containers">
                    <TableHeader>
                      <TableColumn>Name</TableColumn>
                      <TableColumn>Shelf</TableColumn>
                      <TableColumn>Barcode</TableColumn>
                      <TableColumn>Actions</TableColumn>
                    </TableHeader>
                    <TableBody>
                      {containers.map(c => {
                        const shelf = shelves.find(s => s.id === c.shelfId);
                        return (
                          <TableRow key={c.id}>
                            <TableCell>{c.name}</TableCell>
                            <TableCell>{shelf?.name || '—'}</TableCell>
                            <TableCell className="text-xs text-foreground-500">{c.barcode ? `${c.barcode.substring(0, 10)}...` : '—'}</TableCell>
                            <TableCell>
                              <div className="flex gap-2">
                                <Button
                                  isIconOnly
                                  size="sm"
                                  variant="light"
                                  onPress={() => {
                                    setEditingContainer(c);
                                    containerDisclosure.onOpen();
                                  }}
                                >
                                  <Edit2 size={16} />
                                </Button>
                                <Button
                                  isIconOnly
                                  size="sm"
                                  variant="light"
                                  color="danger"
                                  onPress={() => handleDeleteContainer(c.id)}
                                >
                                  <Trash2 size={16} />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                  </div>
                )}
              </CardBody>
            </Card>
          </Tab>
        </Tabs>

        {/* Shelf Editor Modal */}
        <ShelfEditor
          shelf={editingShelf}
          zones={zones}
          isOpen={shelfDisclosure.isOpen}
          onOpenChange={shelfDisclosure.onOpenChange}
          onSave={() => {
            setEditingShelf(null);
            shelfDisclosure.onClose();
          }}
        />

        {/* Zone Editor Modal */}
        <ZoneEditor
          zone={editingZone}
          isOpen={zoneDisclosure.isOpen}
          onOpenChange={zoneDisclosure.onOpenChange}
          onSave={() => {
            setEditingZone(null);
            zoneDisclosure.onClose();
          }}
        />

        {/* Container Editor Modal */}
        <ContainerEditor
          container={editingContainer}
          shelves={shelves}
          isOpen={containerDisclosure.isOpen}
          onOpenChange={containerDisclosure.onOpenChange}
          onSave={() => {
            setEditingContainer(null);
            containerDisclosure.onClose();
          }}
        />
      </div>
    </div>
  );
}