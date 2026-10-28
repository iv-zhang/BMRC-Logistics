"use client";
import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
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
import { Package, Clipboard, AlertTriangle, ClipboardList, FileSpreadsheet, Search, X, Plus, ArrowLeft, ShieldAlert } from 'lucide-react';
import QRCode from 'qrcode';
import { collection, onSnapshot, query, orderBy, updateDoc, addDoc, doc, serverTimestamp, getDoc, getDocs, where, documentId, deleteDoc } from 'firebase/firestore';
import { db } from '@/firebase';
import { recordAuditEvent } from '@/app/lib/audit';
import type { Statpack, StatpackPocket, StatpackItem, InventoryItem } from '@/app/types';
import StatpackCheckOffModal from '@/app/components/statpack-checkoff-modal';
import BarcodeScanner from '@/app/components/barcode-scanner';
import { BagVisualizer } from '@/app/components/statpackvisualizer';
import SortableStatpackContentList from '@/app/components/sortable-statpack-list';
import AssetAttachModal from '@/app/components/asset-attach-modal';
import AssetModal from '@/app/components/assetmodal';
import StatpackWidget from '@/app/components/statpack-widget';
import StatpackLogHistory from '@/app/components/statpack-log-history';
import StatpackImportModal from '@/app/components/statpack-import-modal';
import { useUserRole } from '@/app/hooks/useUserRole';
import { buildStatpackEditorPatch, duplicateStatpack, updateStatpackDetails } from '@/app/lib/statpacks';
import { useOrgConfig } from '@/app/hooks/useOrgConfig';
import { canManageLogistics, canViewLogisticsArea } from '@/app/lib/roles';
import { fetchAndEnrichItemDetails } from '@/app/lib/inventory';
import { formatDuration } from '@/app/lib/logs';
import { StatpackAssetSummary } from '@/app/components/asset-statpack-badge';

export default function StatpacksListPage() {
  const router = useRouter();
  const [statpacks, setStatpacks] = useState<Statpack[]>([]);
  const [loading, setLoading] = useState(true);
  const { user, role: userRole, effectiveUid, fullName, loading: authLoading } = useUserRole();
  const { thresholds } = useOrgConfig();
  const canView = canViewLogisticsArea(userRole, 'assets');
  const canManage = canManageLogistics(userRole);
  const actorName = fullName || user?.displayName || 'Unknown';
  const loadSeq = useRef(0);

  // New-statpack dialog (the old /statpacks/new route never existed)
  const newPackDisclosure = useDisclosure();
  const [newPackName, setNewPackName] = useState('');
  const [newPackType, setNewPackType] = useState<Statpack['type']>('Primary');
  const [creatingPack, setCreatingPack] = useState(false);

  const [selectedPack, setSelectedPack] = useState<Statpack | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const editorDisclosure = useDisclosure();
  // Deletion state for statpacks
  const [deletingPack, setDeletingPack] = useState<Statpack | null>(null);
  const [deletingPackLoading, setDeletingPackLoading] = useState(false);
  const [editingPack, setEditingPack] = useState<Statpack | null>(null);
  const editorSeedRef = useRef<Statpack | null>(null);
  const checkoffDisclosure = useDisclosure();
  const [checkoffAction, setCheckoffAction] = useState<'checkin' | 'maintenance' | 'checkout'>('checkin');
  const importModalDisclosure = useDisclosure();

  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerTarget, setScannerTarget] = useState<Statpack | null>(null);
  const [duplicating, setDuplicating] = useState<string | null>(null);
  const qrDisclosure = useDisclosure();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrLink, setQrLink] = useState<string>('');
  const [qrPrintDataUrl, setQrPrintDataUrl] = useState<string | null>(null);
  const [qrPackName, setQrPackName] = useState<string>('');

  // Log history modal state
  const logHistoryDisclosure = useDisclosure();
  const [logHistoryPackId, setLogHistoryPackId] = useState<string | null>(null);
  const [logHistoryPackName, setLogHistoryPackName] = useState<string>('');

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
      QRCode.toCanvas(canvas, text, { width: size, margin: 1 }, (err: Error | null | undefined) => {
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
  const [editingAsset, setEditingAsset] = useState<InventoryItem | null>(null);
  const [selectedPocketView, setSelectedPocketView] = useState<'all' | StatpackPocket>('all');

  const updateEditingContent = (index: number, patch: Partial<StatpackItem>) => {
    setEditingPack(prev => {
      const base = prev || selectedPack;
      if (!base) return prev;
      const contents = Array.isArray(base.contents) ? [...base.contents] : [];
      const existing = contents[index] || ({} as StatpackItem);
      // If patch contains itemDetails, deep-merge it with existing.itemDetails
      if (patch && patch.itemDetails) {
        const mergedDetails = { ...(existing.itemDetails || {}), ...patch.itemDetails } as InventoryItem;
        contents[index] = { ...existing, ...patch, itemDetails: mergedDetails };
      } else {
        contents[index] = { ...existing, ...patch };
      }
      return ({ ...base, contents } as Statpack);
    });
  };

  const addNewContentItem = () => {
    // Use the currently viewed pocket if filtered, otherwise fall back to the pocket dropdown
    const targetPocket = selectedPocketView !== 'all' ? selectedPocketView : attachPocket;
    const newItem = {
      itemId: `new-${Date.now()}`,
      itemDetails: { name: 'New Item', createdAt: new Date(), updatedAt: new Date() },
      requiredQuantity: 1,
      currentQuantity: 0,
      pocket: targetPocket || 'main',
      compartmentId: undefined,
      batchId: '',
      itemValue: 0,
    } as unknown as StatpackItem;
    setEditingPack(prev => {
      const base = prev || selectedPack;
      if (!base) return prev;
      const contents = Array.isArray(base.contents) ? [...base.contents, newItem] : [newItem];
      return ({ ...base, contents } as Statpack);
    });
  };

  const handleImportComplete = (items: StatpackItem[]) => {
    setEditingPack(prev => {
      const base = prev || selectedPack;
      if (!base) return prev;
      const existingContents = Array.isArray(base.contents) ? [...base.contents] : [];
      return { ...base, contents: [...existingContents, ...items] } as Statpack;
    });
  };

  const formatDateForInput = (v: unknown) => {
    if (!v) return '';
    // Firestore Timestamp
    if (v && typeof (v as { toDate?: unknown }).toDate === 'function') {
      const d = (v as { toDate: () => Date }).toDate();
      return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
    }
    const d = typeof v === 'string' ? new Date(v) : v instanceof Date ? v : new Date(v as number);
    return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  };

  useEffect(() => {
    if (authLoading || !canView) return;
    setLoading(true);
    const q = query(collection(db, 'statpacks'), orderBy('name'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        // Each snapshot starts an async enrichment run; only the newest run may
        // publish, otherwise a slow stale run can overwrite fresher data.
        const runId = ++loadSeq.current;
        (async () => {
          try {
            const packs: Statpack[] = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Statpack));

            const itemIds = packs
              .flatMap((p) => (p.contents || []).flatMap((i) => [i.itemId, i.assetInstanceId]))
              .filter((id): id is string => Boolean(id));

            const map = new Map<string, InventoryItem>();
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
                snapInv.forEach((s) => map.set(s.id, { id: s.id, ...s.data() } as InventoryItem));
              } catch (e) {
                // ignore
              }
              if (runId !== loadSeq.current) return;
            }
            if (runId !== loadSeq.current) return;

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
                      if (instances.some((a: { serial?: string; id?: string; assetTag?: string }) => a.serial === serial || a.id === serial || a.assetTag === serial)) return true;
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

                const merged = (inv ? { ...(item.itemDetails || {}), ...inv } : (item.itemDetails || {})) as InventoryItem;
                if (inv) merged.category = inv.category || inv.assetCategory || merged.category || 'Other';

                return { ...item, itemDetails: merged };
              }),
            }));

            setStatpacks(enriched);
            setLoading(false);
          } catch (err) {
            console.error('Failed to load statpacks:', err);
            if (runId === loadSeq.current) setLoading(false);
          }
        })();
      },
      (err) => {
        console.error('Failed to load statpacks:', err);
        setLoading(false);
      }
    );
    return () => {
      loadSeq.current++; // eslint-disable-line react-hooks/exhaustive-deps -- intentional: invalidates in-flight runs
      unsub();
    };
  }, [authLoading, canView]);

  const openCheckin = (pack: Statpack) => {
    if (!pack.id) return;
    router.push(`/statpacks/check-off?id=${pack.id}&mode=checkin`);
  };
  const openCheckout = (pack: Statpack) => {
    if (!pack.id) return;
    router.push(`/statpacks/check-off?id=${pack.id}&mode=checkout`);
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

  const handleOpenEditor = (pack: Statpack) => {
    setSelectedPack(pack);
    editorSeedRef.current = pack;
    setEditingPack(null);
    editorDisclosure.onOpen();
  };

  const handleCreatePack = async () => {
    const name = newPackName.trim();
    if (!name || !canManage) return;
    setCreatingPack(true);
    try {
      const ref = await addDoc(collection(db, 'statpacks'), {
        name,
        type: newPackType,
        status: 'Pending Initial Check',
        compartments: [],
        contents: [],
        isCheckedOut: false,
        currentLocation: '',
        assetValue: 0,
        maintenance_logs: [],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      try {
        await recordAuditEvent({
          eventType: 'create_statpack',
          source: 'statpacks',
          sourceId: ref.id,
          actor: { userId: effectiveUid ?? null, userName: actorName },
          targets: [{ collection: 'statpacks', docId: ref.id }],
          details: { name },
        });
      } catch (e) {
        console.error('Statpack created but audit event failed', e);
      }
      newPackDisclosure.onClose();
      // Open the existing editor on the new pack so contents can be added.
      setSelectedPack({ id: ref.id, name, type: newPackType, status: 'Pending Initial Check', compartments: [], contents: [], isCheckedOut: false, currentLocation: '' } as unknown as Statpack);
      editorSeedRef.current = { id: ref.id, name, type: newPackType, status: 'Pending Initial Check', compartments: [], contents: [], isCheckedOut: false, currentLocation: '' } as unknown as Statpack;
      setEditingPack(null);
      editorDisclosure.onOpen();
    } catch (e) {
      console.error('Failed to create statpack', e);
      alert('Failed to create statpack. Please try again.');
    } finally {
      setCreatingPack(false);
    }
  };

  const handleGenerateQr = async (pack: Statpack) => {
    try {
      setSelectedPack(pack);
      const base = getHostedOrigin();
      const link = `${base}/statpacks/checkout?pack=${encodeURIComponent(pack.id || '')}`;
      setQrLink(link);
      setQrPackName(pack.name || '');
      const preview = await generateQrWithLogo(link, 520);
      setQrDataUrl(preview);
      const printUrl = await generateQrWithLogo(link, 1800);
      setQrPrintDataUrl(printUrl);
      qrDisclosure.onOpen();
    } catch (err) {
      console.error('Failed to generate QR', err);
      alert('Failed to generate QR code');
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
      setEditingAsset({ id: snap.id, ...data } as InventoryItem);
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
        itemDetails: fullItemDetails as InventoryItem,
        verificationRules: suggestedRules, // Auto-populate verification rules based on asset type
      });
    } else {
      // No existing item targeted: create a new content item with this asset assigned
      const targetPocket = selectedPocketView !== 'all' ? selectedPocketView : attachPocket;
      const newItem: Statpack['contents'][0] = {
        itemId: assetId, // Use asset ID as itemId for linking
        itemDetails: fullItemDetails as InventoryItem,
        requiredQuantity: 1,
        currentQuantity: 1,
        pocket: targetPocket as unknown as StatpackPocket,
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

  if (authLoading || (canView && loading)) return <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center"><Spinner size="lg" color="primary" /></div>;

  // Statpack management is admin/QM/treasurer only (D-13: medops/FTO/members never see it)
  if (!canView) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center p-4">
        <div className="bg-content1 border border-divider rounded-large max-w-md w-full text-center py-10 px-6">
          <ShieldAlert size={40} className="mx-auto text-foreground-300 mb-4" />
          <h2 className="text-base font-semibold text-foreground mb-2">Access Denied</h2>
          <p className="text-sm text-foreground-500 mb-4">You do not have permission to view Statpack management.</p>
          <Button color="primary" onPress={() => router.push('/dashboard')}>Back to dashboard</Button>
        </div>
      </div>
    );
  }

  // ── Expiration warnings for items inside statpacks ─────────────────────
  const expirationWarnings = (() => {
    const now = new Date();
    const in30Days = new Date(now.getTime() + thresholds.expirationCriticalDays * 24 * 60 * 60 * 1000);
    const warnings: { packName: string; packId: string; itemName: string; expirationDate: Date; isExpired: boolean }[] = [];

    for (const pack of statpacks) {
      for (const item of (pack.contents || [])) {
        let expDate: Date | null = null;
        if (item.expirationDate) {
          const d = item.expirationDate instanceof Date
            ? item.expirationDate
            : typeof (item.expirationDate as Record<string, unknown>)?.toDate === 'function'
              ? (item.expirationDate as unknown as { toDate: () => Date }).toDate()
              : new Date(item.expirationDate as unknown as string);
          if (!isNaN(d.getTime())) expDate = d;
        }
        if (!expDate && item.effectiveExpiration) {
          const d = item.effectiveExpiration instanceof Date
            ? item.effectiveExpiration
            : typeof (item.effectiveExpiration as Record<string, unknown>)?.toDate === 'function'
              ? (item.effectiveExpiration as unknown as { toDate: () => Date }).toDate()
              : new Date(item.effectiveExpiration as unknown as string);
          if (!isNaN(d.getTime())) expDate = d;
        }

        if (expDate && expDate <= in30Days) {
          warnings.push({
            packName: pack.name || 'Unknown Pack',
            packId: pack.id || '',
            itemName: item.itemDetails?.name || 'Unknown Item',
            expirationDate: expDate,
            isExpired: expDate < now,
          });
        }
      }
    }

    return warnings.sort((a, b) => a.expirationDate.getTime() - b.expirationDate.getTime());
  })();

  const checkedOutPacks = statpacks.filter(p => p.isCheckedOut);
  const readyCount = statpacks.filter(p => !p.isCheckedOut && (p.status || 'Ready').toLowerCase().includes('ready') && !(p.status || '').toLowerCase().includes('not')).length;
  const notReadyCount = statpacks.filter(p => (p.status || '').toLowerCase().includes('not ready') || (p.status || '').toLowerCase().includes('maintenance')).length;

  const visiblePacks = searchTerm
    ? statpacks.filter(p => {
        const t = searchTerm.toLowerCase();
        return (
          (p.name || '').toLowerCase().includes(t) ||
          (p.currentLocation || '').toLowerCase().includes(t) ||
          (p.assignedToUserName || '').toLowerCase().includes(t) ||
          (p.contents || []).some(it => (it.itemDetails?.name || '').toLowerCase().includes(t))
        );
      })
    : statpacks;

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">

        {/* ── Page header ────────────────────────────────────────────────── */}
        <div className="flex items-end justify-between gap-4 mb-6 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-foreground mb-1.5">Statpacks</h1>
            <div className="flex items-center gap-2 flex-wrap mt-1">
              <div className="flex items-center gap-2 bg-content1 border border-divider rounded-large px-3 py-1.5">
                <span className="font-mono font-semibold tabular-nums text-foreground">{statpacks.length}</span>
                <span className="text-xs text-foreground-400">total</span>
              </div>
              <div className="flex items-center gap-2 bg-success-50 dark:bg-success-900/20 border border-success/30 rounded-large px-3 py-1.5">
                <span className="w-2 h-2 rounded-sm bg-success flex-none" />
                <span className="font-mono font-semibold tabular-nums text-success">{readyCount}</span>
                <span className="text-xs text-success/80 font-medium">ready</span>
              </div>
              <div className="flex items-center gap-2 bg-warning-50 dark:bg-warning-900/20 border border-warning/30 rounded-large px-3 py-1.5">
                <span className="w-2 h-2 rounded-sm bg-warning flex-none" />
                <span className="font-mono font-semibold tabular-nums text-warning">{checkedOutPacks.length}</span>
                <span className="text-xs text-warning/80 font-medium">checked out</span>
              </div>
              <div className="flex items-center gap-2 bg-danger-50 dark:bg-danger-900/20 border border-danger/30 rounded-large px-3 py-1.5">
                <span className="w-2 h-2 rounded-sm bg-danger flex-none" />
                <span className="font-mono font-semibold tabular-nums text-danger">{notReadyCount + expirationWarnings.length}</span>
                <span className="text-xs text-danger/80 font-medium">needs attention</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button size="sm" variant="flat" startContent={<ArrowLeft size={14} />} onPress={() => router.push('/assets')}>
              Assets
            </Button>
            <Button color="primary" size="sm" isDisabled={!canManage} startContent={<Plus size={15} />} onPress={() => { setNewPackName(''); setNewPackType('Primary'); newPackDisclosure.onOpen(); }}>
              Add statpack
            </Button>
          </div>
        </div>

        {/* ── Search ─────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 bg-content1 border border-divider rounded-large px-4 py-1 mb-4">
          <Search size={16} className="text-foreground-400 flex-none" />
          <input
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder="Search packs, locations, holders, contents…"
            className="flex-1 text-sm bg-transparent outline-none py-2.5 text-foreground placeholder:text-foreground-400"
          />
          {searchTerm && (
            <button onClick={() => setSearchTerm('')} className="text-foreground-400 hover:text-foreground-600 transition-colors">
              <X size={15} />
            </button>
          )}
        </div>

        {statpacks.length === 0 ? (
          <div className="bg-content1 border border-dashed border-divider rounded-large text-center py-16">
            <Package size={32} className="mx-auto text-foreground-300 mb-2" />
            <p className="text-sm font-semibold text-foreground-500">No statpacks yet</p>
            <p className="text-xs text-foreground-400 mt-1">Add a statpack to get started.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Expiration warnings for items inside statpacks */}
            {expirationWarnings.length > 0 && (
              <div className="bg-danger-50/60 dark:bg-danger-950/20 border border-danger/30 rounded-large p-4">
                <div className="flex items-center gap-2 mb-3">
                  <AlertTriangle size={16} className="text-danger flex-none" />
                  <h2 className="text-base font-semibold text-foreground">Expiring items in statpacks</h2>
                  <span className="font-mono text-xs font-semibold px-2.5 py-1 rounded-full bg-danger-50 dark:bg-danger-900/20 text-danger tabular-nums">
                    {expirationWarnings.length}
                  </span>
                </div>
                <div className="space-y-2 overflow-y-auto" style={{ maxHeight: 192 }}>
                  {expirationWarnings.map((w, i) => (
                    <div
                      key={`exp-${i}`}
                      className="flex items-center justify-between gap-3 bg-content1 border border-divider rounded-medium px-3 py-2"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Chip size="sm" variant="flat" color={w.isExpired ? 'danger' : 'warning'}>
                          {w.isExpired ? 'Expired' : 'Exp. Soon'}
                        </Chip>
                        <span className="text-sm font-semibold text-foreground truncate">{w.itemName}</span>
                        <span className="text-xs text-foreground-400 truncate">in {w.packName}</span>
                      </div>
                      <span className={`text-xs font-semibold flex-none tabular-nums ${w.isExpired ? 'text-danger' : 'text-warning'}`}>
                        {w.expirationDate.toLocaleDateString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Currently checked out */}
            {checkedOutPacks.length > 0 && (
              <div className="bg-warning-50/60 dark:bg-warning-950/20 border border-warning/30 rounded-large p-4">
                <div className="flex items-center gap-2 mb-3">
                  <ClipboardList size={16} className="text-warning flex-none" />
                  <h2 className="text-base font-semibold text-foreground">Currently checked out</h2>
                  <span className="font-mono text-xs font-semibold px-2.5 py-1 rounded-full bg-warning-50 dark:bg-warning-900/20 text-warning tabular-nums">
                    {checkedOutPacks.length}
                  </span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {checkedOutPacks.map(p => {
                    const rawCheckedOutAt = p.checkedOutAt as unknown;
                    const checkedOutAt = rawCheckedOutAt
                      ? (typeof (rawCheckedOutAt as { toDate?: () => Date }).toDate === 'function'
                          ? (rawCheckedOutAt as { toDate: () => Date }).toDate()
                          : rawCheckedOutAt instanceof Date
                          ? rawCheckedOutAt
                          : new Date(rawCheckedOutAt as string))
                      : null;
                    const elapsed = checkedOutAt && !isNaN(checkedOutAt.getTime()) ? Date.now() - checkedOutAt.getTime() : null;
                    return (
                      <div
                        key={`co-${p.id}`}
                        className="bg-content1 border border-divider rounded-medium p-3 flex flex-col gap-1.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-sm text-foreground truncate">{p.name}</span>
                          {elapsed !== null && (
                            <span className={`font-mono text-xs font-semibold tabular-nums flex-none ${elapsed > 8 * 60 * 60 * 1000 ? 'text-danger' : 'text-warning'}`}>
                              {formatDuration(elapsed)}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-foreground-500">
                          {p.assignedToUserName || 'Unknown'} · {p.currentLocation || 'No location'}
                        </div>
                        <div className="flex gap-2 mt-1">
                          <Button size="sm" color="primary" variant="flat" onPress={() => openCheckin(p)}>
                            Check in
                          </Button>
                          <Button
                            size="sm"
                            variant="light"
                            onPress={() => {
                              setLogHistoryPackId(p.id || null);
                              setLogHistoryPackName(p.name || '');
                              logHistoryDisclosure.onOpen();
                            }}
                          >
                            Logs
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Pack grid */}
            {visiblePacks.length === 0 ? (
              <div className="bg-content1 border border-dashed border-divider rounded-large text-center py-16">
                <Package size={32} className="mx-auto text-foreground-300 mb-2" />
                <p className="text-sm font-semibold text-foreground-500">No packs match this search</p>
                <p className="text-xs text-foreground-400 mt-1">Try a different pack name, location, or item.</p>
              </div>
            ) : (
              <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3 items-start">
                {visiblePacks.map((p) => (
                  <StatpackWidget
                    key={p.id}
                    statpack={p}
                    userRole={userRole}
                    isDuplicating={duplicating === p.id}
                    onOpenEditor={handleOpenEditor}
                    onCheckin={openCheckin}
                    onCheckout={openCheckout}
                    onMaintenance={openMaintenance}
                    onAudit={(pack) => { if (pack.id) router.push(`/statpacks/check-off?id=${pack.id}&mode=audit`); }}
                    onDuplicate={handleDuplicate}
                    onScan={openScanner}
                    onGenerateQr={handleGenerateQr}
                    onEditAsset={handleEditAssetPolicy}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <StatpackCheckOffModal
        isOpen={checkoffDisclosure.isOpen}
        onOpenChange={(open) => (open ? checkoffDisclosure.onOpen() : checkoffDisclosure.onClose())}
        statpack={selectedPack}
        action={checkoffAction}
        userId={effectiveUid || 'unknown'}
        userName={actorName}
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
      <Modal isOpen={editorDisclosure.isOpen} onOpenChange={editorDisclosure.onOpenChange} size="4xl" scrollBehavior="inside">
        <ModalContent className="max-h-[calc(100vh-4rem)]">
          <ModalHeader>Statpack Editor - {editingPack?.name || selectedPack?.name}</ModalHeader>
          <ModalBody className="space-y-4 overflow-y-auto max-h-[calc(100vh-8rem)]">
            {!selectedPack && <p className="text-sm text-foreground-500">No statpack selected.</p>}
            {selectedPack && (
              <div className="space-y-4">
                <div className="flex justify-center">
                  <BagVisualizer
                    statpack={editingPack || selectedPack}
                    selectedPocket={selectedPocketView}
                    onSelectPocket={(p) => {
                      setSelectedPocketView(p);
                      // Sync the pocket dropdown so new items use this pocket
                      if (p !== 'all') setAttachPocket(p as string);
                    }}
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
                      <SelectItem key="Ready" isDisabled={!!editorSeedRef.current?.isCheckedOut}>Ready</SelectItem>
                      <SelectItem key="In Use">In Use</SelectItem>
                      <SelectItem key="Not Ready" isDisabled={!!editorSeedRef.current?.isCheckedOut}>Not Ready</SelectItem>
                    </Select>
                    {editorSeedRef.current?.isCheckedOut && <p className="mt-1 text-xs text-foreground-500">Check this pack in before changing its status.</p>}
                  </div>
                </div>

                <div>
                  <p className="text-sm font-semibold">Location</p>
                  <Input value={editingPack?.currentLocation ?? selectedPack.currentLocation ?? ''} onValueChange={(v) => setEditingPack(prev => ({ ...(prev || selectedPack), currentLocation: v } as Statpack))} />
                </div>

                {/* Assets assigned to this statpack */}
                <StatpackAssetSummary
                  assets={(editingPack?.contents ?? selectedPack.contents ?? [])
                    .filter(item => item.itemDetails?.isAsset || item.assetInstanceId)
                    .map(item => ({
                      id: item.itemId,
                      name: item.itemDetails?.name || 'Unknown Asset',
                      assetSerial: item.serialNumber,
                      assetCategory: item.itemDetails?.category,
                      pocket: item.pocket,
                    }))
                  }
                />

                {/* Contents editor: compact list with drag-to-reorder */}
                <div>
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold">Contents</p>
                      <Chip size="sm" variant="flat" color={selectedPocketView === 'all' ? 'default' : 'primary'}>
                        {selectedPocketView === 'all' ? 'All Pockets' : selectedPocketView === 'main' ? 'Main' : selectedPocketView === 'front_aux' ? 'Front' : selectedPocketView === 'side_left' ? 'Left' : 'Right'}
                      </Chip>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Select
                        className="min-w-[140px]"
                        label="Pocket"
                        size="sm"
                        selectedKeys={[selectedPocketView === 'all' ? attachPocket : selectedPocketView]}
                        onChange={(e) => {
                          const val = e.target.value;
                          setAttachPocket(val);
                          // Also update the pocket view so they stay in sync
                          setSelectedPocketView(val as StatpackPocket);
                        }}
                      >
                        <SelectItem key="main">Main</SelectItem>
                        <SelectItem key="front_aux">Front</SelectItem>
                        <SelectItem key="side_left">Left</SelectItem>
                        <SelectItem key="side_right">Right</SelectItem>
                      </Select>
                      <Button size="sm" color="primary" variant="flat" onPress={addNewContentItem}>+ Add Item</Button>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <Button size="sm" variant="light" onPress={() => { setAttachingItemIndex(null); setAttachingItemName(''); assetAttachDisclosure.onOpen(); }}>
                      <span className="text-sm mr-2">+</span>
                      Attach Asset
                    </Button>
                    <Button size="sm" variant="light" onPress={() => importModalDisclosure.onOpen()}>
                      <FileSpreadsheet size={14} className="mr-1" />
                      Import from Sheets
                    </Button>
                    {selectedPocketView !== 'all' && (
                      <Button size="sm" variant="light" color="default" onPress={() => { setSelectedPocketView('all'); }}>Show All</Button>
                    )}
                  </div>

                  <div className="mt-2 max-h-64 overflow-y-auto">
                    {(() => {
                      const base = editingPack || selectedPack;
                      if (!base) return null;
                      const allContents = Array.isArray(base.contents) ? base.contents : [];
                      const visibleContents = selectedPocketView === 'all' ? allContents : allContents.filter((it) => it.pocket === selectedPocketView);

                      const getGlobalIndex = (visibleIndex: number) => {
                        const item = visibleContents[visibleIndex];
                        if (!item) return -1;
                        return allContents.findIndex((it) => it === item || (it.itemId && item.itemId && it.itemId === item.itemId) || (it.assetInstanceId && item.assetInstanceId && it.assetInstanceId === item.assetInstanceId));
                      };

                      const handleReorder = (newVisibleItems: StatpackItem[]) => {
                        if (selectedPocketView === 'all') {
                          setEditingPack((prev) => ({ ...(prev || selectedPack), contents: newVisibleItems } as Statpack));
                          return;
                        }
                        setEditingPack((prev) => {
                          const base2 = prev || selectedPack;
                          if (!base2) return prev;
                          const all2 = Array.isArray(base2.contents) ? [...base2.contents] : [];
                          const merged: StatpackItem[] = [];
                          let vi = 0;
                          for (const it of all2) {
                            if (it.pocket !== selectedPocketView) merged.push(it);
                            else {
                              merged.push(newVisibleItems[vi++] || it);
                            }
                          }
                          return ({ ...base2, contents: merged } as Statpack);
                        });
                      };

                      const handleUpdateVisible = (visibleIndex: number, patch: Partial<StatpackItem>) => {
                        const gi = getGlobalIndex(visibleIndex);
                        if (gi === -1) return;
                        updateEditingContent(gi, patch);
                      };

                      return (
                        <>
                        <p className="mb-2 text-xs text-foreground-500">Set par to 0 to stop stocking an item. It stays on the checklist.</p>
                        <SortableStatpackContentList
                          items={visibleContents}
                          onReorder={handleReorder}
                          onUpdateItem={handleUpdateVisible}
                          onAttachAsset={canManage ? handleAttachAsset : undefined}
                          onEditAssetPolicy={canManage ? handleEditAssetPolicy : undefined}
                        />
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <div className="flex gap-2">
              <Button variant="light" onPress={() => { editorDisclosure.onClose(); setEditingPack(null); }}>Close</Button>
              {canManage && (
                <Button color="primary" onPress={async () => {
                  const packToSave = editingPack || selectedPack;
                  if (!packToSave) return;
                  try {
                    const seed = editorSeedRef.current;
                    if (!seed) throw new Error('Reopen the editor before saving.');
                    await updateStatpackDetails(
                      packToSave.id as string,
                      buildStatpackEditorPatch(packToSave, seed),
                      { uid: effectiveUid || user?.uid, name: actorName },
                      { status: seed.status, name: seed.name },
                      undefined,
                      seed,
                    );
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
                    alert(err instanceof Error ? err.message : 'Failed to save statpack');
                  }
                }}>Save</Button>
              )}
              {canManage && (
                <Button color="danger" variant="light" onPress={() => { const packToDelete = editingPack || selectedPack; if (packToDelete) setDeletingPack(packToDelete); }}>
                  Delete
                </Button>
              )}
            </div>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={newPackDisclosure.isOpen} onOpenChange={newPackDisclosure.onOpenChange} size="sm">
        <ModalContent>
          <ModalHeader>New statpack</ModalHeader>
          <ModalBody>
            <Input label="Name" autoFocus value={newPackName} onValueChange={setNewPackName} />
            <Select label="Type" selectedKeys={[newPackType]} onChange={(e) => { if (e.target.value) setNewPackType(e.target.value as Statpack['type']); }}>
              <SelectItem key="Primary">Primary</SelectItem>
              <SelectItem key="Secondary">Secondary</SelectItem>
              <SelectItem key="Event Bag">Event Bag</SelectItem>
            </Select>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={newPackDisclosure.onClose}>Cancel</Button>
            <Button color="primary" isLoading={creatingPack} isDisabled={!newPackName.trim()} onPress={handleCreatePack}>Create</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* Delete confirmation for statpack */}
      <Modal isOpen={!!deletingPack} onOpenChange={(open) => { if (!open) setDeletingPack(null); }} size="sm">
        <ModalContent>
          <ModalHeader>Confirm Delete</ModalHeader>
          <ModalBody>
            <p className="text-sm">Are you sure you want to delete the statpack <strong>{deletingPack?.name}</strong>? This cannot be undone and will remove the statpack configuration.</p>
          </ModalBody>
          <ModalFooter>
            <div className="flex gap-2">
              <Button variant="light" onPress={() => setDeletingPack(null)}>Cancel</Button>
              <Button color="danger" isLoading={deletingPackLoading} onPress={async () => {
                if (!deletingPack) return;
                setDeletingPackLoading(true);
                try {
                  await deleteDoc(doc(db, 'statpacks', deletingPack.id as string));
                  await recordAuditEvent({
                    eventType: 'delete_statpack',
                    source: 'statpacks',
                    sourceId: deletingPack.id as string,
                    actor: {
                      userId: effectiveUid ?? null,
                      userName: actorName,
                    },
                    targets: [{ collection: 'statpacks', docId: deletingPack.id as string }],
                    details: { name: deletingPack.name },
                  });
                  // close editor if it was open
                  editorDisclosure.onClose();
                  setEditingPack(null);
                  setDeletingPack(null);
                } catch (e) {
                  console.error('Failed to delete statpack', e);
                  alert('Failed to delete statpack. See console for details.');
                } finally {
                  setDeletingPackLoading(false);
                }
              }}>Delete</Button>
            </div>
          </ModalFooter>
        </ModalContent>
      </Modal>
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

      <StatpackLogHistory
        isOpen={logHistoryDisclosure.isOpen}
        onOpenChange={(open) => (open ? logHistoryDisclosure.onOpen() : logHistoryDisclosure.onClose())}
        statpackId={logHistoryPackId}
        statpackName={logHistoryPackName}
      />

      <StatpackImportModal
        isOpen={importModalDisclosure.isOpen}
        onOpenChange={importModalDisclosure.onOpenChange}
        onImportComplete={handleImportComplete}
      />
    </div>
  );
}
