"use client";
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card,
  CardBody,
  Button,
  Table,
  TableHeader,
  TableColumn,
  TableBody,
  TableRow,
  TableCell,
  Chip,
  Spinner,
  useDisclosure,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Input,
  Select,
  SelectItem,
} from '@heroui/react';
import { Package, MapPin, Eye, Wrench, Copy, Link2, QrCode, Clipboard } from 'lucide-react';
import QRCode from 'qrcode';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { collection, onSnapshot, query, orderBy, updateDoc, doc, serverTimestamp, getDoc, getDocs, where, documentId } from 'firebase/firestore';
import { auth, db } from '@/firebase';
import type { Statpack, StatpackPocket } from '@/app/types';
import StatpackCheckOffModal from '@/app/components/statpack-checkoff-modal';
import BarcodeScanner from '@/app/components/barcode-scanner';
import { BagVisualizer } from '@/app/components/statpackvisualizer';
import AdminAuditModal from '@/app/components/admin-audit-modal';
import SortableStatpackContentList from '@/app/components/sortable-statpack-list';
import AssetAttachModal from '@/app/components/asset-attach-modal';
import AssetModal from '@/app/components/assetmodal';
import { useUserRole } from '@/app/hooks/useUserRole';
import { duplicateStatpack } from '@/app/lib/statpacks';
import { fetchAndEnrichItemDetails } from '@/app/lib/inventory';

export default function StatpacksListPage() {
  const router = useRouter();
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [statpacks, setStatpacks] = useState<Statpack[]>([]);
  const [loading, setLoading] = useState(true);
  const { role: userRole } = useUserRole();

  const [selectedPack, setSelectedPack] = useState<Statpack | null>(null);
  const editorDisclosure = useDisclosure();
  const [editingPack, setEditingPack] = useState<Statpack | null>(null);
  const checkoffDisclosure = useDisclosure();
  const [checkoffAction, setCheckoffAction] = useState<'checkin' | 'maintenance' | 'checkout'>('checkin');
  const auditModalDisclosure = useDisclosure();
  const [auditTarget, setAuditTarget] = useState<Statpack | null>(null);

  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerTarget, setScannerTarget] = useState<Statpack | null>(null);
  const [duplicating, setDuplicating] = useState<string | null>(null);
  const qrDisclosure = useDisclosure();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrLink, setQrLink] = useState<string>('');
  const [qrPrintDataUrl, setQrPrintDataUrl] = useState<string | null>(null);
  const [qrPackName, setQrPackName] = useState<string>('');

  const getHostedOrigin = () => {
    if (typeof window === 'undefined') return '';
    // Prefer explicit override
    const envUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_HOST || process.env.NEXT_PUBLIC_VERCEL_URL || '') as string;
    if (envUrl && envUrl.length > 0) return envUrl.startsWith('http') ? envUrl.replace(/\/$/, '') : `https://${envUrl}`;
    // Allow a user-set production base for local development (persisted)
    try {
      const persisted = localStorage.getItem('qr_base_url');
      if (persisted && persisted.length > 0) return persisted.replace(/\/$/, '');
    } catch (e) {
      // ignore
    }
    const fb = (process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || '') as string;
    if (fb && fb.length > 0) return `https://${fb.replace(/\/$/, '')}`;
    const hostname = window.location.hostname;
    if (hostname === 'localhost' || hostname.startsWith('127.')) {
      // Prompt the user for a production base URL to use when on localhost and persist it
      try {
        const prod = window.prompt('Detected localhost. Enter production base URL to use for QR (e.g. https://app.example.com) or leave blank to use localhost:');
        if (prod && prod.length > 0) {
          try { localStorage.setItem('qr_base_url', prod.replace(/\/$/, '')); } catch (e) {}
          return prod.replace(/\/$/, '');
        }
      } catch (e) {
        // ignore prompt failures
      }
    }
    return window.location.origin.replace(/\/$/, '');
  };

  // Render QR into a canvas and draw the logo centered with a white background
  const generateQrWithLogo = async (text: string, size = 800) => {
    // create an offscreen canvas
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;

    // draw QR to canvas using qrcode lib
    await new Promise<void>((resolve, reject) => {
      QRCode.toCanvas(canvas, text, { width: size, margin: 1 }, (err: any) => {
        if (err) return reject(err);
        resolve();
      });
    });

    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas.toDataURL('image/png');

    // load logo image from public assets
    const logo = new Image();
    // prefer the black transparent logo if available
    logo.src = '/images/NoBackground_NewLogoBlack.PNG';

    await new Promise<void>((resolve) => {
      logo.onload = () => resolve();
      logo.onerror = () => resolve();
    });

    // draw white rounded background behind logo to improve scannability
    const logoMaxRatio = 0.28; // logo size as fraction of QR (conservative)
    const logoSize = Math.floor(size * logoMaxRatio);
    const x = Math.floor((size - logoSize) / 2);
    const y = Math.floor((size - logoSize) / 2);

    // rounded rect
    const radius = Math.max(6, Math.floor(logoSize * 0.08));
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + logoSize - radius, y);
    ctx.quadraticCurveTo(x + logoSize, y, x + logoSize, y + radius);
    ctx.lineTo(x + logoSize, y + logoSize - radius);
    ctx.quadraticCurveTo(x + logoSize, y + logoSize, x + logoSize - radius, y + logoSize);
    ctx.lineTo(x + radius, y + logoSize);
    ctx.quadraticCurveTo(x, y + logoSize, x, y + logoSize - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    ctx.fill();

    // draw logo centered and scaled to fit inside the white box
    try {
      // compute aspect-fit
      const lw = logo.width || logoSize;
      const lh = logo.height || logoSize;
      let dw = logoSize;
      let dh = logoSize;
      if (lw && lh) {
        const scale = Math.min(logoSize / lw, logoSize / lh);
        dw = Math.round(lw * scale);
        dh = Math.round(lh * scale);
      }
      const dx = x + Math.floor((logoSize - dw) / 2);
      const dy = y + Math.floor((logoSize - dh) / 2);
      ctx.drawImage(logo, dx, dy, dw, dh);
    } catch (e) {
      // ignore draw failures
      console.error('Logo draw failed', e);
    }

    return canvas.toDataURL('image/png');
  };
  
  const assetAttachDisclosure = useDisclosure();
  const [attachingItemIndex, setAttachingItemIndex] = useState<number | null>(null);
  const [attachingItemName, setAttachingItemName] = useState<string>('');
  const [attachPocket, setAttachPocket] = useState<string>('main');
  const assetModalDisclosure = useDisclosure();
  const [editingAsset, setEditingAsset] = useState<any | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsub();
  }, []);

  const updateEditingContent = (index: number, patch: Partial<any>) => {
    setEditingPack(prev => {
      const base = prev || selectedPack;
      if (!base) return prev;
      const contents = Array.isArray(base.contents) ? [...base.contents] : [];
      const existing = contents[index] || {};
      // If patch contains itemDetails, deep-merge it with existing.itemDetails
      if (patch && (patch as any).itemDetails) {
        const mergedDetails = { ...(existing.itemDetails || {}), ...(patch as any).itemDetails };
        contents[index] = { ...existing, ...patch, itemDetails: mergedDetails };
      } else {
        contents[index] = { ...existing, ...patch };
      }
      return ({ ...base, contents } as Statpack);
    });
  };

  const addNewContentItem = () => {
    const newItem = {
      itemId: `new-${Date.now()}`,
      itemDetails: { name: 'New Item', createdAt: new Date(), updatedAt: new Date() },
      requiredQuantity: 1,
      currentQuantity: 0,
      pocket: 'main',
      compartmentId: undefined,
      batchId: '',
      itemValue: 0,
    } as any;
    setEditingPack(prev => {
      const base = prev || selectedPack;
      if (!base) return prev;
      const contents = Array.isArray(base.contents) ? [...base.contents, newItem] : [newItem];
      return ({ ...base, contents } as Statpack);
    });
  };

  const removeContentItem = (index: number) => {
    setEditingPack(prev => {
      const base = prev || selectedPack;
      if (!base) return prev;
      const contents = Array.isArray(base.contents) ? [...base.contents] : [];
      contents.splice(index, 1);
      return ({ ...base, contents } as Statpack);
    });
  };

  const formatDateForInput = (v: any) => {
    if (!v) return '';
    // Firestore Timestamp
    if (v && typeof v.toDate === 'function') {
      const d = v.toDate();
      return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
    }
    const d = typeof v === 'string' ? new Date(v) : v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  };

  // Remove `undefined` values recursively to make objects safe for Firestore
  const sanitizeForFirestore = (v: any): any => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (v instanceof Date) return v;
    if (Array.isArray(v)) {
      return v.map((it) => sanitizeForFirestore(it)).filter((it) => it !== undefined);
    }
    if (typeof v === 'object') {
      const out: any = {};
      Object.keys(v).forEach((k) => {
        const s = sanitizeForFirestore(v[k]);
        if (s !== undefined) out[k] = s;
      });
      return out;
    }
    return v;
  };

  // Build an explicit, whitelist-based payload for statpack updates to avoid
  // sending any unexpected/undefined values to Firestore.
  const buildStatpackUpdate = (pack: any) => {
    if (!pack) return {};
    const out: any = {};
    const pickIf = (key: string, val: any) => {
      if (val !== undefined) out[key] = val;
    };

    pickIf('name', pack.name);
    pickIf('type', pack.type);
    pickIf('status', pack.status);
    pickIf('currentLocation', pack.currentLocation);
    pickIf('assetValue', pack.assetValue);
    pickIf('isCheckedOut', pack.isCheckedOut);
    pickIf('assignedToUserId', pack.assignedToUserId);
    pickIf('assignedToUserName', pack.assignedToUserName);
    pickIf('checkedOutAt', pack.checkedOutAt instanceof Date ? pack.checkedOutAt : (pack.checkedOutAt ? new Date(pack.checkedOutAt) : undefined));
    pickIf('lastCheckedBy', pack.lastCheckedBy);
    pickIf('lastCheckedAt', pack.lastCheckedAt instanceof Date ? pack.lastCheckedAt : (pack.lastCheckedAt ? new Date(pack.lastCheckedAt) : undefined));

    // compartments: canonicalize array entries
    if (Array.isArray(pack.compartments)) {
      out.compartments = pack.compartments.map((c: any) => {
        const comp: any = {};
        if (c.id !== undefined) comp.id = c.id;
        if (c.name !== undefined) comp.name = c.name;
        if (c.parentPocket !== undefined) comp.parentPocket = c.parentPocket;
        if (typeof c.isSealed === 'boolean') comp.isSealed = c.isSealed;
        if (c.sealNumber !== undefined) comp.sealNumber = c.sealNumber;
        if (c.expirationDate instanceof Date) comp.expirationDate = c.expirationDate;
        return comp;
      });
    }

    // contents: whitelist per-item fields
    if (Array.isArray(pack.contents)) {
      out.contents = pack.contents.map((it: any) => {
        const ci: any = {};
        if (it.itemId !== undefined) ci.itemId = it.itemId;
        if (it.itemDetails !== undefined) ci.itemDetails = it.itemDetails;
        if (it.variantId !== undefined) ci.variantId = it.variantId;
        if (it.variantName !== undefined) ci.variantName = it.variantName;
        if (it.requiredQuantity !== undefined) ci.requiredQuantity = it.requiredQuantity;
        if (it.currentQuantity !== undefined) ci.currentQuantity = it.currentQuantity;
        if (it.pocket !== undefined) ci.pocket = it.pocket;
        if (it.compartmentId !== undefined) ci.compartmentId = it.compartmentId;
        if (it.batchId !== undefined) ci.batchId = it.batchId;
        if (it.serialNumber !== undefined) ci.serialNumber = it.serialNumber;
        if (it.assetInstanceId !== undefined) ci.assetInstanceId = it.assetInstanceId;
        if (it.expirationDate instanceof Date) ci.expirationDate = it.expirationDate;
        if (it.lotNumber !== undefined) ci.lotNumber = it.lotNumber;
        if (it.effectiveExpiration instanceof Date) ci.effectiveExpiration = it.effectiveExpiration;
        if (it.requiresExpirationCheck !== undefined) ci.requiresExpirationCheck = it.requiresExpirationCheck;
        if (it.itemValue !== undefined) ci.itemValue = it.itemValue;
        if (it.verificationRules !== undefined) ci.verificationRules = it.verificationRules;
        return ci;
      });
    }

    // Maintenance logs (optional)
    if (Array.isArray(pack.maintenance_logs)) {
      out.maintenance_logs = pack.maintenance_logs.map((m: any) => ({
        id: m.id,
        timestamp: m.timestamp instanceof Date ? m.timestamp : (m.timestamp ? new Date(m.timestamp) : undefined),
        serviceType: m.serviceType,
        reason: m.reason,
        technician: m.technician,
        notes: m.notes,
        status: m.status,
        completedAt: m.completedAt instanceof Date ? m.completedAt : (m.completedAt ? new Date(m.completedAt) : undefined),
      }));
    }

    return out;
  };

  // Recursively remove invalid Date objects (which would throw on toISOString)
  const stripInvalidDates = (v: any): any => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? undefined : v;
    if (Array.isArray(v)) {
      return v.map((it) => stripInvalidDates(it)).filter((it) => it !== undefined);
    }
    if (typeof v === 'object') {
      const out: any = {};
      Object.keys(v).forEach((k) => {
        const s = stripInvalidDates(v[k]);
        if (s !== undefined) out[k] = s;
      });
      return out;
    }
    return v;
  };

  useEffect(() => {
    setLoading(true);
    const q = query(collection(db, 'statpacks'), orderBy('name'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        (async () => {
          try {
            const packs: Statpack[] = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));

            const itemIds = packs
              .flatMap((p) => (p.contents || []).flatMap((i) => [i.itemId, i.assetInstanceId]))
              .filter((id): id is string => Boolean(id));

            const map = new Map<string, any>();
            const uniqueIds = Array.from(new Set(itemIds)).filter(Boolean);
            const chunkArray = <T,>(items: T[], size: number) => {
              const chunks: T[][] = [];
              for (let i = 0; i < items.length; i += size) {
                chunks.push(items.slice(i, i + size));
              }
              return chunks;
            };

            const chunks = chunkArray(uniqueIds, 10);
            for (const chunk of chunks) {
              try {
                const qInv = query(collection(db, 'inventory'), where(documentId(), 'in', chunk));
                const snapInv = await getDocs(qInv);
                snapInv.forEach((s) => map.set(s.id, { id: s.id, ...(s.data() as any) }));
              } catch (e) {
                // ignore
              }
            }

            const enriched = packs.map((p) => ({
              ...p,
              contents: (p.contents || []).map((item) => {
                const lookupId = item.assetInstanceId || item.itemId;
                let inv = lookupId ? map.get(lookupId) : undefined;

                if (!inv) {
                  const serial = item.serialNumber || item.assetInstanceId || undefined;
                  if (serial) {
                    inv = Array.from(map.values()).find((iv) => {
                      if (!iv) return false;
                      if (iv.assetSerial && String(iv.assetSerial) === String(serial)) return true;
                      const instances = iv.assets || [];
                      if (instances.some((a: any) => a.serial === serial || a.id === serial || a.assetTag === serial)) return true;
                      return false;
                    });
                  }
                }

                if (!inv) {
                  const name = item.itemDetails?.name;
                  if (name) {
                    const lower = String(name).toLowerCase();
                    inv = Array.from(map.values()).find((iv) => String(iv.name || '').toLowerCase() === lower);
                  }
                }

                const merged = inv ? { ...(item.itemDetails || {}), ...inv } : (item.itemDetails || {});
                if (inv) merged.category = inv.category || inv.assetCategory || merged.category || 'Other';

                return { ...item, itemDetails: merged };
              }),
            }));

            setStatpacks(enriched);
            setLoading(false);
          } catch (err) {
            console.error('Failed to load statpacks:', err);
            setLoading(false);
          }
        })();
      },
      (err) => {
        console.error('Failed to load statpacks:', err);
        setLoading(false);
      }
    );
    return () => unsub();
  }, []);

  const openCheckin = (pack: Statpack) => {
    setSelectedPack(pack);
    setCheckoffAction('checkin');
    checkoffDisclosure.onOpen();
  };
  const openMaintenance = (pack: Statpack) => {
    setSelectedPack(pack);
    setCheckoffAction('maintenance');
    checkoffDisclosure.onOpen();
  };

  const openScanner = (pack: Statpack) => {
    setScannerTarget(pack);
    setScannerOpen(true);
  };

  const onDetected = async (value: string) => {
    if (!scannerTarget) return;
    try {
      await updateDoc(doc(db, 'statpacks', scannerTarget.id as string), { currentLocation: value, updatedAt: serverTimestamp() });
    } catch (err) {
      console.error('Failed to update location from scan', err);
      alert('Failed to save scanned location');
    } finally {
      setScannerOpen(false);
      setScannerTarget(null);
    }
  };

  const handleDuplicate = async (pack: Statpack) => {
    if (!pack.id) return;
    setDuplicating(pack.id);
    try {
      await duplicateStatpack(pack.id);
      // Success feedback (snapshot listener will auto-refresh list)
    } catch (error) {
      console.error('Failed to duplicate statpack:', error);
      alert('Failed to duplicate statpack. Please try again.');
    } finally {
      setDuplicating(null);
    }
  };

  const handleAttachAsset = (itemIndex: number, itemName: string) => {
    setAttachingItemIndex(itemIndex);
    setAttachingItemName(itemName);
    assetAttachDisclosure.onOpen();
  };

  const handleEditAssetPolicy = async (assetInstanceId: string) => {
    try {
      const snap = await getDoc(doc(db, 'inventory', assetInstanceId));
      if (!snap.exists()) {
        alert('Asset not found');
        return;
      }
      const data = snap.data();
      setEditingAsset({ id: snap.id, ...(data as any) });
      assetModalDisclosure.onOpen();
    } catch (err) {
      console.error('Failed to load asset for editing:', err);
      alert('Failed to load asset');
    }
  };

  const handleAssetAttached = async (assetId: string, serial?: string, displayName?: string) => {
    const nameFromAttach = attachingItemName || displayName || (serial ? `Asset ${serial}` : undefined);

    // Fetch full inventory item details to enrich itemDetails with category, asset properties, etc.
    const enriched = await fetchAndEnrichItemDetails(assetId);
    const fullItemDetails = enriched?.itemDetails || { name: nameFromAttach };
    const suggestedRules = enriched?.suggestedVerificationRules;

    if (attachingItemIndex !== null) {
      // Update the existing item with the asset instance ID, serial, and full enriched itemDetails
      updateEditingContent(attachingItemIndex, {
        assetInstanceId: assetId,
        serialNumber: serial,
        itemDetails: fullItemDetails as any,
        verificationRules: suggestedRules, // Auto-populate verification rules based on asset type
      });
    } else {
      // No existing item targeted: create a new content item with this asset assigned
      const newItem: Statpack['contents'][0] = {
        itemId: assetId, // Use asset ID as itemId for linking
        itemDetails: fullItemDetails as any,
        requiredQuantity: 1,
        currentQuantity: 1,
        pocket: attachPocket as unknown as StatpackPocket,
        compartmentId: undefined,
        batchId: '',
        assetInstanceId: assetId,
        serialNumber: serial,
        itemValue: enriched?.itemDetails?.assetValue || 0,
        verificationRules: suggestedRules, // Auto-populate verification rules
      };

      setEditingPack(prev => {
        const base = prev || selectedPack;
        if (!base) return prev;
        const contents = Array.isArray(base.contents) ? [...base.contents, newItem] : [newItem];
        return ({ ...base, contents } as Statpack);
      });
    }

    // Reset
    setAttachingItemIndex(null);
    setAttachingItemName('');
  };

  if (loading) return <div className="h-screen flex items-center justify-center"><Spinner /></div>;

  // Restrict access: general members should not access the Statpacks management UI
  if (!loading && userRole === 'member') {
    return (
      <div className="min-h-screen p-6 bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
        <div className="max-w-3xl mx-auto">
          <Card>
            <CardBody className="text-center">
              <h2 className="text-xl font-semibold">Access Denied</h2>
              <p className="mt-2 text-sm text-gray-600">You do not have permission to view Statpack management.</p>
              <div className="mt-4">
                <Button onPress={() => router.push('/dashboard')}>Back to Dashboard</Button>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6 bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Package className="text-indigo-600" />
            <h1 className="text-2xl font-bold">Statpacks</h1>
          </div>
          <div className="flex gap-2">
            <Button variant="light" onPress={() => router.push('/assets')}>Back to Assets</Button>
            <Button color="primary" onPress={() => router.push('/statpacks/new')}>Add Statpack</Button>
          </div>
        </div>

        <Card>
          <CardBody>
            <Table aria-label="Statpacks table">
              <TableHeader>
                <TableColumn>Name</TableColumn>
                <TableColumn>Status</TableColumn>
                <TableColumn>Location</TableColumn>
                <TableColumn>Value</TableColumn>
                <TableColumn>Actions</TableColumn>
              </TableHeader>
              <TableBody emptyContent="No statpacks">
                {statpacks.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell>
                      <Chip size="sm" variant="flat">{p.status}</Chip>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <MapPin size={14} className="text-gray-400" />
                        <span>{p.currentLocation || '—'}</span>
                      </div>
                    </TableCell>
                    <TableCell>{p.assetValue ? `$${p.assetValue.toFixed(2)}` : '—'}</TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button size="sm" variant="light" onPress={() => { setSelectedPack(p); editorDisclosure.onOpen(); }}>
                          <Eye size={14} />
                        </Button>
                        <Button size="sm" onPress={() => openCheckin(p)}>Check-In</Button>
                        <Button size="sm" variant="light" onPress={() => openMaintenance(p)}>Maintenance</Button>
                        {userRole === 'admin' && (
                          <>
                            <Button isIconOnly size="sm" variant="light" onPress={() => { setAuditTarget(p); auditModalDisclosure.onOpen(); }} title="Manual Audit">
                              <Wrench size={14} />
                            </Button>
                            <Button 
                              isIconOnly 
                              size="sm" 
                              variant="light" 
                              onPress={() => handleDuplicate(p)} 
                              title="Duplicate Statpack"
                              isLoading={duplicating === p.id}
                            >
                              <Copy size={14} />
                            </Button>
                          </>
                        )}
                        <Button isIconOnly size="sm" variant="light" onPress={() => openScanner(p)}>
                          <MapPin size={14} />
                        </Button>
                        <Button
                          isIconOnly
                          size="sm"
                          variant="light"
                          onPress={async () => {
                            try {
                              const base = getHostedOrigin();
                              const link = `${base}/statpacks/checkout?pack=${encodeURIComponent(p.id || '')}`;
                              setQrLink(link);
                              setQrPackName(p.name || '');
                              // generate small preview
                              const preview = await generateQrWithLogo(link, 520);
                              setQrDataUrl(preview);
                              // generate high-res for print/download
                              const printUrl = await generateQrWithLogo(link, 1800);
                              setQrPrintDataUrl(printUrl);
                              qrDisclosure.onOpen();
                            } catch (err) {
                              console.error('Failed to generate QR', err);
                              alert('Failed to generate QR code');
                            }
                          }}
                          title="Generate checkout QR"
                        >
                          <QrCode size={14} />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardBody>
        </Card>
      </div>

      <StatpackCheckOffModal
        isOpen={checkoffDisclosure.isOpen}
        onOpenChange={(open) => (open ? checkoffDisclosure.onOpen() : checkoffDisclosure.onClose())}
        statpack={selectedPack}
        action={checkoffAction}
        userId={user?.uid || 'unknown'}
        userName={user?.displayName || 'Unknown'}
        onCheckOffComplete={() => checkoffDisclosure.onClose()}
      />

      <AssetModal
        isOpen={assetModalDisclosure.isOpen}
        onOpenChange={(open) => (open ? assetModalDisclosure.onOpen() : assetModalDisclosure.onClose())}
        initial={editingAsset}
        onAdd={async (payload) => {
          // Adding a new asset from this modal is not the primary flow here; fall back to snapshot update
          try {
            // delegate to an add flow elsewhere or simply close
            assetModalDisclosure.onClose();
          } catch (e) {
            console.error('Failed to add asset from modal', e);
          }
        }}
        onUpdate={async (id, payload) => {
          try {
            await updateDoc(doc(db, 'inventory', id), { ...payload, updatedAt: serverTimestamp() });
            assetModalDisclosure.onClose();
          } catch (e) {
            console.error('Failed to update asset', e);
            alert('Failed to save asset changes');
          }
        }}
      />

      <BarcodeScanner isOpen={scannerOpen} onClose={() => { setScannerOpen(false); setScannerTarget(null); }} onDetected={onDetected} />

      {/* In-page Statpack Editor Modal */}
      <Modal isOpen={editorDisclosure.isOpen} onOpenChange={editorDisclosure.onOpenChange} size="3xl">
        <ModalContent className="max-h-[90vh]">
          <ModalHeader>Statpack Editor - {editingPack?.name || selectedPack?.name}</ModalHeader>
          <ModalBody className="space-y-4 overflow-y-auto max-h-[80vh]">
            {!selectedPack && <p className="text-sm text-gray-500">No statpack selected.</p>}
            {selectedPack && (
              <div className="space-y-4">
                <div className="flex justify-center">
                  <BagVisualizer
                    statpack={editingPack || selectedPack}
                    selectedPocket={'all'}
                    onSelectPocket={() => {}}
                    completedPockets={new Set()}
                  />
                </div>

                <div className="flex gap-2">
                  <div className="flex-[0.7]">
                    <p className="text-sm font-semibold">Name</p>
                    <Input className="w-full" value={editingPack?.name ?? selectedPack.name} onValueChange={(v) => setEditingPack(prev => ({ ...(prev || selectedPack), name: v } as Statpack))} />
                  </div>
                  <div className="flex-[0.3] min-w-[160px]">
                    <p className="text-sm font-semibold">Status</p>
                    <Select className="w-full" selectedKeys={[String((editingPack?.status ?? selectedPack?.status) || 'Ready')]} onChange={(e) => setEditingPack(prev => ({ ...(prev || selectedPack), status: e.target.value } as Statpack))}>
                      <SelectItem key="Ready">Ready</SelectItem>
                      <SelectItem key="In Use">In Use</SelectItem>
                      <SelectItem key="Not Ready">Not Ready</SelectItem>
                    </Select>
                  </div>
                </div>

                <div>
                  <p className="text-sm font-semibold">Location</p>
                  <Input value={editingPack?.currentLocation ?? selectedPack.currentLocation ?? ''} onValueChange={(v) => setEditingPack(prev => ({ ...(prev || selectedPack), currentLocation: v } as Statpack))} />
                </div>

                {/* Contents editor: compact list with drag-to-reorder */}
                <div>
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">Contents</p>
                    <div className="flex items-center gap-2">
                      <Select className="min-w-[140px]" selectedKeys={[attachPocket]} onChange={(e) => setAttachPocket(e.target.value)}>
                        <SelectItem key="main">Main</SelectItem>
                        <SelectItem key="front_aux">Front</SelectItem>
                        <SelectItem key="side_left">Left</SelectItem>
                        <SelectItem key="side_right">Right</SelectItem>
                      </Select>
                      <Button size="sm" onPress={addNewContentItem}>Add Item</Button>
                      <Button size="sm" variant="light" onPress={() => { setAttachingItemIndex(null); setAttachingItemName(''); assetAttachDisclosure.onOpen(); }}>
                        <span className="text-sm mr-2">+</span>
                        Attach Asset
                      </Button>
                    </div>
                  </div>

                  <div className="mt-2 max-h-64 overflow-y-auto">
                    <SortableStatpackContentList
                      items={editingPack?.contents || selectedPack.contents || []}
                      onReorder={(newItems) => setEditingPack(prev => ({ ...(prev || selectedPack), contents: newItems } as Statpack))}
                      onUpdateItem={updateEditingContent}
                      onRemoveItem={removeContentItem}
                      onAttachAsset={userRole === 'admin' ? handleAttachAsset : undefined}
                      onEditAssetPolicy={userRole === 'admin' ? handleEditAssetPolicy : undefined}
                    />
                  </div>
                </div>
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <div className="flex gap-2">
              <Button variant="light" onPress={() => { editorDisclosure.onClose(); setEditingPack(null); }}>Close</Button>
              {userRole === 'admin' && (
                <Button color="primary" onPress={async () => {
                  const packToSave = editingPack || selectedPack;
                  if (!packToSave) return;
                  try {
                    // normalize expiration date strings to Date objects
                    const normalized = { ...packToSave } as any;
                    if (Array.isArray(normalized.contents)) {
                      normalized.contents = normalized.contents.map((it: any) => {
                        const copy = { ...it };
                        if (copy.expirationDate && typeof copy.expirationDate === 'string' && copy.expirationDate.length > 0) {
                          copy.expirationDate = new Date(copy.expirationDate);
                        }
                        return copy;
                      });
                    }
                    // Build a whitelist payload and send only allowed fields to Firestore
                    const payload = buildStatpackUpdate(normalized);
                    const cleaned = stripInvalidDates(payload);
                    await updateDoc(doc(db, 'statpacks', packToSave.id as string), { ...cleaned, updatedAt: serverTimestamp() } as any);
                    editorDisclosure.onClose();
                    setEditingPack(null);

      <AssetAttachModal
        isOpen={assetAttachDisclosure.isOpen}
        onOpenChange={assetAttachDisclosure.onOpenChange}
        onAttach={handleAssetAttached}
        currentItemName={attachingItemName}
      />
                    // refresh handled by snapshot listener
                  } catch (err) {
                    console.error('Failed to save statpack', err);
                    alert('Failed to save statpack');
                  }
                }}>Save</Button>
              )}
            </div>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <AdminAuditModal
        isOpen={auditModalDisclosure.isOpen}
        onOpenChange={(open) => (open ? auditModalDisclosure.onOpen() : auditModalDisclosure.onClose())}
        auditType="statpack"
        targetStatpack={auditTarget}
        userId={user?.uid || 'unknown'}
        userName={user?.displayName || 'Unknown'}
        onAuditComplete={() => auditModalDisclosure.onClose()}
      />
      {/* QR Code Modal for Checkout Link */}
      <Modal isOpen={qrDisclosure.isOpen} onOpenChange={qrDisclosure.onOpenChange} size="sm">
        <ModalContent>
          <ModalHeader>Statpack Checkout QR</ModalHeader>
          <ModalBody className="flex flex-col items-center gap-4">
            {qrDataUrl ? (
              <div className="flex flex-col items-center">
                <img src={qrDataUrl} alt="Statpack checkout QR" className="w-56 h-56" />
                <p className="text-xs text-default-500 mt-2 text-center">Scan to open checkout flow for this statpack.</p>
              </div>
            ) : (
              <p>Generating…</p>
            )}
            <div className="w-full">
              <Input value={qrLink} onValueChange={setQrLink} readOnly />
              <div className="flex items-center justify-between gap-2 mt-2">
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="light"
                    onPress={async () => {
                      try {
                        await navigator.clipboard.writeText(qrLink || '');
                        alert('Link copied to clipboard');
                      } catch (e) {
                        console.error('Failed to copy', e);
                        alert('Failed to copy link');
                      }
                    }}
                  >
                    <Clipboard size={14} />
                  </Button>
                  <Button
                    size="sm"
                    variant="light"
                    onPress={() => {
                      if (!qrPrintDataUrl) return alert('Print image not available');
                      // download high-res PNG
                      const a = document.createElement('a');
                      a.href = qrPrintDataUrl;
                      a.download = `${(selectedPack?.name || 'statpack').replace(/\s+/g, '_')}_qr.png`;
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                    }}
                  >
                    Download PNG
                  </Button>
                  <Button
                    size="sm"
                    variant="light"
                    onPress={() => {
                      if (!qrPrintDataUrl) return alert('Print image not available');
                      // open printable window with front/back layout sized for business card (2in x 3.5in portrait)
                      const w = window.open('', '_blank');
                      if (!w) return alert('Pop-up blocked');
                      const name = (qrPackName || selectedPack?.name || '');
                      const logoSrc = '/images/NoBackground_NewLogoBlack.PNG';
                      const safeName = String(name).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
                      const html = `
                        <html>
                          <head>
                            <title>Print QR - ${name}</title>
                            <meta name="viewport" content="width=device-width,initial-scale=1" />
                            <style>
                              /* Use portrait 2in width x 3.5in height */
                              @page { size: 2in 3.5in; margin: 0.125in; }
                              html,body{height:100%;margin:0;padding:0}
                              .sheet{width:2in;height:3.5in;display:flex;align-items:center;justify-content:center;font-family:-apple-system,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;box-sizing:border-box;padding:0.125in}
                              .front, .back{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center}
                              .qr{width:1.4in;height:1.4in;object-fit:contain}
                              .name{font-size:16px;font-weight:600;margin-top:8px;text-align:center}
                              .logo{max-width:1.2in;max-height:0.9in;object-fit:contain;margin-top:8px}
                              .back .logoLarge{max-width:1.6in;max-height:1.2in}
                              .back .desc{font-size:12px;margin-top:8px;text-align:center}
                              .name{font-size:18px;font-weight:700;margin-top:10px;text-align:center}
                              /* ensure no overflow when printing */
                              img{display:block}
                            </style>
                          </head>
                          <body>
                            <!-- Front: QR only -->
                            <div class="sheet front">
                              <img src="${qrPrintDataUrl}" class="qr" alt="QR" />
                            </div>
                            <div style="page-break-before:always"></div>
                            <!-- Back: Name + Logo -->
                            <div class="sheet back">
                              <img src="${logoSrc}" class="logo logoLarge" alt="Logo" />
                              <div class="name">${safeName}</div>
                            </div>
                            <script>
                              // trigger print after small delay
                              setTimeout(()=>{ window.print(); }, 400);
                              function escapeHtml(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
                            </script>
                          </body>
                        </html>
                      `;
                      w.document.open();
                      w.document.write(html);
                      w.document.close();
                    }}
                  >
                    Printable
                  </Button>
                </div>
                <div>
                  <Button size="sm" color="primary" onPress={() => qrDisclosure.onClose()}>Close</Button>
                </div>
              </div>
            </div>
          </ModalBody>
        </ModalContent>
      </Modal>
    </div>
  );
}
