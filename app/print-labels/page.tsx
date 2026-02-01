'use client';

import React, { useEffect, useState, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { doc, getDoc } from 'firebase/firestore';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { auth, db } from '@/firebase';
import type { InventoryItem, Statpack } from '@/app/types';
import LabelCard from '@/app/components/label-card';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Input,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Spinner,
  Divider,
  useDisclosure,
} from '@heroui/react';
import {
  Download,
  Printer,
  Undo2,
  Trash2,
  Save,
  Copy,
  Package,
} from 'lucide-react';
import {
  exportLabelsToPDF,
  DEFAULT_TEMPLATE,
  calculateLabelsPerRow,
  calculateLabelsPerPage,
  saveTemplate,
  loadTemplate,
  getSavedTemplates,
  deleteTemplate,
  type PrintTemplate,
} from '@/app/lib/print';
import '@/app/styles/print-labels.css';

interface AssetData {
  id: string;
  data: InventoryItem | Statpack;
  type: 'inventory' | 'statpack';
}

function PrintLabelsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [assets, setAssets] = useState<AssetData[]>([]);
  const [exporting, setExporting] = useState(false);

  // Template state
  const [template, setTemplate] = useState<PrintTemplate>(DEFAULT_TEMPLATE);
  const [templateName, setTemplateName] = useState('');
  const [savedTemplates, setSavedTemplates] = useState<Record<string, PrintTemplate>>({});

  // Modal state
  const saveTemplateDisclosure = useDisclosure();

  // Label refs for PDF export
  const labelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Auth check
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (!currentUser) {
        router.push('/login');
        return;
      }
      setUser(currentUser);

      // Check role
      try {
        const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
        const role = userDoc.data()?.role || 'member';
        setUserRole(role);

        if (role !== 'admin' && role !== 'quartermaster') {
          router.push('/dashboard');
          return;
        }
      } catch (e) {
        console.error('Error checking user role:', e);
        router.push('/dashboard');
      }
    });

    return () => unsubscribe();
  }, [router]);

  // Fetch assets from URL params or localStorage
  useEffect(() => {
    if (!user || !userRole) return;

    let mounted = true;

    (async () => {
      try {
        let assetIds: string[] = [];

        // Get IDs from URL params
        const idsParam = searchParams.get('ids');
        if (idsParam) {
          assetIds = idsParam.split(',').filter(Boolean);
        } else {
          // Try to get from localStorage
          const stored = localStorage.getItem('printAssetIds');
          if (stored) {
            assetIds = JSON.parse(stored);
            localStorage.removeItem('printAssetIds');
          }
        }

        if (assetIds.length === 0) {
          if (mounted) {
            setLoading(false);
          }
          return;
        }

        const fetchedAssets: AssetData[] = [];

        // Fetch each asset
        for (const id of assetIds) {
          try {
            // Try inventory first
            const invDoc = await getDoc(doc(db, 'inventory', id));
            if (invDoc.exists()) {
              fetchedAssets.push({
                id,
                data: { id, ...invDoc.data() } as InventoryItem,
                type: 'inventory',
              });
            } else {
              // Try statpack
              const spDoc = await getDoc(doc(db, 'statpacks', id));
              if (spDoc.exists()) {
                fetchedAssets.push({
                  id,
                  data: { id, ...spDoc.data() } as Statpack,
                  type: 'statpack',
                });
              }
            }
          } catch (e) {
            console.error(`Failed to fetch asset ${id}:`, e);
          }
        }

        if (mounted) {
          setAssets(fetchedAssets);
          setSavedTemplates(getSavedTemplates());
        }
      } catch (e) {
        console.error('Failed to fetch assets:', e);
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, [user, userRole, searchParams]);

  const handleTemplateSave = () => {
    if (!templateName.trim()) {
      alert('Please enter a template name');
      return;
    }

    saveTemplate(templateName, template);
    setSavedTemplates(getSavedTemplates());
    setTemplateName('');
    saveTemplateDisclosure.onClose();
  };

  const handleLoadTemplate = (name: string) => {
    const loaded = loadTemplate(name);
    if (loaded) {
      setTemplate(loaded);
    }
  };

  const handleDeleteTemplate = (name: string) => {
    if (confirm(`Delete template "${name}"?`)) {
      deleteTemplate(name);
      setSavedTemplates(getSavedTemplates());
    }
  };

  const handleExportPDF = async () => {
    try {
      setExporting(true);

      const elements = labelRefs.current.filter((el) => el !== null) as HTMLElement[];
      if (elements.length === 0) {
        alert('No labels to export');
        return;
      }

      await exportLabelsToPDF(elements, template, 'asset-labels.pdf');
    } catch (error) {
      console.error('Failed to export PDF:', error);
      alert('Failed to export PDF');
    } finally {
      setExporting(false);
    }
  };

  const labelsPerPage = calculateLabelsPerPage(template);
  const totalPages = Math.ceil(assets.length / labelsPerPage);

  if (!user || userRole !== 'admin') {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner label="Checking permissions..." />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner label="Loading assets..." />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
              <Package className="text-indigo-600" />
              Print Asset Labels
            </h1>
            <p className="text-gray-500">Configure and export printable labels for selected assets</p>
            <p className="mt-1 text-gray-600">
              {assets.length} asset{assets.length !== 1 ? 's' : ''} • {totalPages} page{totalPages !== 1 ? 's' : ''}
            </p>
          </div>
          <div>
            <Button isIconOnly variant="light" onPress={() => router.back()} className="text-gray-600">
              <Undo2 size={20} />
            </Button>
          </div>
        </div>

        {assets.length === 0 ? (
          <Card>
            <CardBody className="py-12 text-center">
              <p className="text-gray-500 text-lg">No assets selected for printing</p>
              <Button
                color="primary"
                className="mt-6"
                onPress={() => router.push('/assets')}
              >
                Go to Assets
              </Button>
            </CardBody>
          </Card>
        ) : (
          <>
            {/* Template Settings Card */}
            <Card className="mb-8">
              <CardHeader className="flex gap-3">
                <div className="flex flex-col">
                  <p className="text-lg font-semibold">Label Template</p>
                  <p className="text-sm text-gray-600">
                    Customize dimensions for your printer
                  </p>
                </div>
              </CardHeader>
              <Divider />
              <CardBody className="space-y-4">
                {/* Template selection */}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
                  {Object.keys(savedTemplates).map((name) => (
                    <div key={name} className="flex gap-1">
                      <Button
                        size="sm"
                        variant="bordered"
                        className="flex-1"
                        onPress={() => handleLoadTemplate(name)}
                      >
                        <Copy size={14} />
                        {name}
                      </Button>
                      <Button
                        isIconOnly
                        size="sm"
                        variant="light"
                        color="danger"
                        onPress={() => handleDeleteTemplate(name)}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  ))}
                </div>

                {/* Page settings */}
                <div className="space-y-3">
                  <p className="text-sm font-medium text-gray-700">Page Size (mm)</p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <Input
                      label="Width"
                      type="number"
                      size="sm"
                      value={String(template.pageWidth)}
                      onChange={(e) =>
                        setTemplate({
                          ...template,
                          pageWidth: Number(e.target.value),
                        })
                      }
                    />
                    <Input
                      label="Height"
                      type="number"
                      size="sm"
                      value={String(template.pageHeight)}
                      onChange={(e) =>
                        setTemplate({
                          ...template,
                          pageHeight: Number(e.target.value),
                        })
                      }
                    />
                    <Input
                      label="Margin T/B"
                      type="number"
                      size="sm"
                      value={String(template.marginTop)}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setTemplate({
                          ...template,
                          marginTop: val,
                          marginBottom: val,
                        });
                      }}
                    />
                    <Input
                      label="Margin L/R"
                      type="number"
                      size="sm"
                      value={String(template.marginLeft)}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        setTemplate({
                          ...template,
                          marginLeft: val,
                          marginRight: val,
                        });
                      }}
                    />
                  </div>
                </div>

                {/* Label settings */}
                <div className="space-y-3 pt-3 border-t">
                  <p className="text-sm font-medium text-gray-700">Label Size (mm)</p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <Input
                      label="Width"
                      type="number"
                      size="sm"
                      value={String(template.labelWidth)}
                      onChange={(e) =>
                        setTemplate({
                          ...template,
                          labelWidth: Number(e.target.value),
                        })
                      }
                    />
                    <Input
                      label="Height"
                      type="number"
                      size="sm"
                      value={String(template.labelHeight)}
                      onChange={(e) =>
                        setTemplate({
                          ...template,
                          labelHeight: Number(e.target.value),
                        })
                      }
                    />
                    <Input
                      label="H Gap"
                      type="number"
                      size="sm"
                      value={String(template.horizontalGap)}
                      onChange={(e) =>
                        setTemplate({
                          ...template,
                          horizontalGap: Number(e.target.value),
                        })
                      }
                    />
                    <Input
                      label="V Gap"
                      type="number"
                      size="sm"
                      value={String(template.verticalGap)}
                      onChange={(e) =>
                        setTemplate({
                          ...template,
                          verticalGap: Number(e.target.value),
                        })
                      }
                    />
                  </div>
                </div>

                {/* Summary info */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-3 border-t">
                  <div className="bg-blue-50 rounded p-2 text-center">
                    <div className="text-xs text-gray-600">Labels/Row</div>
                    <div className="text-lg font-semibold text-blue-600">
                      {calculateLabelsPerRow(template)}
                    </div>
                  </div>
                  <div className="bg-blue-50 rounded p-2 text-center">
                    <div className="text-xs text-gray-600">Labels/Page</div>
                    <div className="text-lg font-semibold text-blue-600">
                      {labelsPerPage}
                    </div>
                  </div>
                  <div className="bg-green-50 rounded p-2 text-center">
                    <div className="text-xs text-gray-600">Total Labels</div>
                    <div className="text-lg font-semibold text-green-600">
                      {assets.length}
                    </div>
                  </div>
                  <div className="bg-purple-50 rounded p-2 text-center">
                    <div className="text-xs text-gray-600">Total Pages</div>
                    <div className="text-lg font-semibold text-purple-600">
                      {totalPages}
                    </div>
                  </div>
                </div>

                {/* Template save button */}
                <Button
                  size="sm"
                  variant="flat"
                  startContent={<Save size={16} />}
                  onPress={saveTemplateDisclosure.onOpen}
                  className="mt-4"
                >
                  Save Template
                </Button>
              </CardBody>
            </Card>

            {/* Print Controls */}
            <div className="print-controls flex gap-3 mb-8 flex-wrap">
              <Button
                color="primary"
                size="lg"
                startContent={<Download size={20} />}
                onPress={handleExportPDF}
                isLoading={exporting}
                className="flex-1 sm:flex-none"
              >
                Export as PDF
              </Button>
              <Button
                variant="bordered"
                size="lg"
                startContent={<Printer size={20} />}
                onPress={() => window.print()}
                className="flex-1 sm:flex-none"
              >
                Print Preview
              </Button>
            </div>

            {/* Labels Preview */}
            <div
              ref={containerRef}
              className="print-preview-mode space-y-0"
              style={{
                '--page-width': `${template.pageWidth}mm`,
                '--page-height': `${template.pageHeight}mm`,
                '--page-margin': `${template.marginTop}mm`,
                '--label-width': `${template.labelWidth}mm`,
                '--label-height': `${template.labelHeight}mm`,
                '--label-h-gap': `${template.horizontalGap}mm`,
                '--label-v-gap': `${template.verticalGap}mm`,
              } as React.CSSProperties}
            >
              {Array.from({ length: totalPages }).map((_, pageIdx) => {
                const pageStart = pageIdx * labelsPerPage;
                const pageEnd = Math.min(pageStart + labelsPerPage, assets.length);
                const pageAssets = assets.slice(pageStart, pageEnd);

                return (
                  <div key={pageIdx} className="print-labels-container">
                    <div className="print-labels-grid">
                      {pageAssets.map((asset, idx) => (
                        <div
                          key={`${pageIdx}-${idx}`}
                          ref={(el) => {
                            if (el) labelRefs.current[pageStart + idx] = el;
                          }}
                        >
                          <LabelCard
                            asset={asset.data}
                            width={template.labelWidth}
                            height={template.labelHeight}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Save Template Modal */}
      <Modal isOpen={saveTemplateDisclosure.isOpen} onOpenChange={saveTemplateDisclosure.onOpenChange}>
        <ModalContent>
          <ModalHeader>Save Template</ModalHeader>
          <ModalBody>
            <Input
              label="Template Name"
              placeholder="e.g., Standard A5, Vinyl Labels"
              value={templateName}
              onValueChange={setTemplateName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleTemplateSave();
                }
              }}
            />
          </ModalBody>
          <ModalFooter>
            <Button
              variant="light"
              onPress={saveTemplateDisclosure.onClose}
            >
              Cancel
            </Button>
            <Button
              color="primary"
              onPress={handleTemplateSave}
            >
              Save
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}

export default function PrintLabelsPage() {
  return (
    <Suspense fallback={<div className="h-screen flex items-center justify-center"><Spinner /></div>}>
      <PrintLabelsContent />
    </Suspense>
  );
}
