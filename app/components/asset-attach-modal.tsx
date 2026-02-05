'use client';

import React, { useState, useEffect } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Input,
  Table,
  TableHeader,
  TableColumn,
  TableBody,
  TableRow,
  TableCell,
  Chip,
  Spinner,
} from '@heroui/react';
import { Search, Link2 } from 'lucide-react';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '@/firebase';
import type { InventoryItem } from '@/app/types';

interface AssetAttachModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  // third param is a human-friendly display name (e.g. "AED 1")
  onAttach: (assetId: string, serial?: string, displayName?: string) => void;
  currentItemName?: string;
}

/**
 * Asset search and attach modal for statpack items
 * Allows admins to search for existing assets and link them to statpack entries
 */
export default function AssetAttachModal({
  isOpen,
  onOpenChange,
  onAttach,
  currentItemName,
}: AssetAttachModalProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<InventoryItem[]>([]);
  const searchTimeout = React.useRef<number | null>(null);

  // Auto-search when modal opens with current item name
  useEffect(() => {
    if (isOpen && currentItemName) {
      setSearchTerm(currentItemName);
      const performSearch = async () => {
        await handleSearch(currentItemName);
      };
      performSearch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, currentItemName]);

  // Debounced live-search when user types
  useEffect(() => {
    if (!isOpen) return;
    if (searchTimeout.current) {
      window.clearTimeout(searchTimeout.current);
      searchTimeout.current = null;
    }
    if (!searchTerm.trim()) {
      setResults([]);
      return;
    }
    // debounce 300ms
    searchTimeout.current = window.setTimeout(() => {
      handleSearch(searchTerm).catch((err) => console.error('Search failed', err));
    }, 300);

    return () => {
      if (searchTimeout.current) {
        window.clearTimeout(searchTimeout.current);
        searchTimeout.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, isOpen]);

  const handleSearch = async (term: string = searchTerm) => {
    if (!term.trim()) {
      setResults([]);
      return;
    }

    setSearching(true);
    try {
      // Search by name, serial, barcode, or assigned barcode
      const inventoryRef = collection(db, 'inventory');
      
      // Create multiple queries for different search criteria
      const queries = [
        query(inventoryRef, where('isAsset', '==', true)),
      ];

      const snapshots = await Promise.all(queries.map(q => getDocs(q)));
      
      // Combine results and filter by search term
      const allDocs = snapshots.flatMap(snap => snap.docs);
      const searchLower = term.toLowerCase();
      
      const filtered = allDocs
        .map(doc => ({ id: doc.id, ...doc.data() } as InventoryItem))
        .filter(item => {
          // Only show assets (either flagged or with a serial/instances)
          if (!item.isAsset && !item.assetSerial && !(item.assets && item.assets.length > 0)) return false;

          // Filter by search term across several possible fields
          const matchesName = item.name?.toLowerCase().includes(searchLower) ?? false;
          const matchesSerial = item.assetSerial?.toLowerCase().includes(searchLower) ?? false;
          const matchesBarcode = item.barcode?.toLowerCase().includes(searchLower) ?? false;
          const matchesAssignedBarcode = item.assignedBarcode?.toString().toLowerCase().includes(searchLower) ?? false;
          const matchesCategory = item.assetCategory?.toLowerCase().includes(searchLower) ?? false;
          const matchesModel = item.assetModel?.toLowerCase().includes(searchLower) ?? false;

          // Check per-instance serials/barcodes/model fields
          const matchesInstance = (item.assets || []).some((inst: any) => {
            const s = ((inst.serial || inst.assetTag || inst.barcode || inst.assignedBarcode || inst.model || inst.assetModel) || '').toString().toLowerCase();
            return s.includes(searchLower);
          });

          return matchesName || matchesSerial || matchesBarcode || matchesAssignedBarcode || matchesInstance || matchesCategory || matchesModel;
        })
        // Remove duplicates by id
        .filter((item, idx, arr) => arr.findIndex(i => i.id === item.id) === idx)
        .slice(0, 20); // Limit results

      setResults(filtered);
    } catch (error) {
      console.error('Failed to search assets:', error);
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const handleAttachAsset = (asset: InventoryItem) => {
    const displayName = asset.name || asset.assetModel || asset.assetCategory;
    onAttach(asset.id, asset.assetSerial, displayName);
    onOpenChange(false);
    // Reset
    setSearchTerm('');
    setResults([]);
  };

  const handleClose = () => {
    onOpenChange(false);
    setSearchTerm('');
    setResults([]);
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} size="2xl" backdrop="blur">
      <ModalContent>
        <ModalHeader className="flex items-center gap-2">
          <Link2 size={20} />
          <span>Attach Existing Asset</span>
        </ModalHeader>
        <ModalBody>
          <div className="space-y-4">
            <div className="flex gap-2">
              <Input
                placeholder="Search by name, serial, or barcode..."
                value={searchTerm}
                onValueChange={setSearchTerm}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleSearch();
                  }
                }}
                startContent={<Search size={16} />}
              />
              <Button
                color="primary"
                onPress={() => handleSearch()}
                isLoading={searching}
              >
                Search
              </Button>
            </div>

            {searching && (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            )}

            {!searching && results.length > 0 && (
              <div className="max-h-96 overflow-y-auto">
                <Table aria-label="Asset search results">
                  <TableHeader>
                    <TableColumn>Name</TableColumn>
                    <TableColumn>Serial</TableColumn>
                    <TableColumn>Status</TableColumn>
                    <TableColumn>Location</TableColumn>
                    <TableColumn>Action</TableColumn>
                  </TableHeader>
                  <TableBody>
                    {results.map((asset) => (
                              <TableRow key={asset.id}>
                              <TableCell>
                                <div>
                                  <div className="font-medium">{asset.name || asset.assetModel || asset.assetCategory || 'Asset'}</div>
                                  <div className="text-xs text-gray-500">{asset.assetModel ? `${asset.assetModel}` : asset.category ? asset.category : ''}</div>
                                </div>
                              </TableCell>
                              <TableCell>
                                <div className="flex flex-col">
                                  <code className="text-xs bg-gray-100 text-gray-900 dark:bg-slate-700 dark:text-white px-1 py-0.5 rounded">{asset.assetSerial || asset.assignedBarcode || '—'}</code>
                                  <div className="text-xs text-gray-500 mt-1">{asset.currentLocation || asset.assignedToId || '—'}</div>
                                </div>
                              </TableCell>
                        <TableCell>
                          <Chip
                            size="sm"
                            color={
                              asset.assetStatus === 'Ready'
                                ? 'success'
                                : asset.assetStatus === 'Not Ready'
                                ? 'danger'
                                : 'default'
                            }
                            variant="flat"
                          >
                            {asset.assetStatus || 'Unknown'}
                          </Chip>
                        </TableCell>
                        <TableCell>
                          <div className="text-xs">
                            {asset.currentLocation || asset.assignedToId || '—'}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            color="primary"
                            onPress={() => handleAttachAsset(asset)}
                          >
                            Attach
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {!searching && results.length === 0 && searchTerm.trim() && (
              <div className="text-center py-8 text-gray-500">
                No assets found. Try a different search term.
              </div>
            )}

            {!searching && !searchTerm.trim() && (
              <div className="text-center py-8 text-gray-500">
                Enter a search term to find assets
              </div>
            )}
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="light" onPress={handleClose}>
            Cancel
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
