'use client';

import { useEffect, useState } from 'react';
import { Card, CardBody, CardHeader, Chip } from '@heroui/react';
import { DollarSign, Package, Calendar, FileText } from 'lucide-react';
import type { InventoryItem, PurchaseInfo } from '@/app/types';
import { doc, getDoc, Timestamp } from 'firebase/firestore';
import { db } from '@/firebase';

interface PurchaseHistoryProps {
  inventoryId: string;
}

interface BatchWithPurchase {
  batchId: string;
  lotNumber?: string;
  stock: number;
  receivedAt?: Date;
  purchase?: PurchaseInfo;
}

export default function PurchaseHistory({ inventoryId }: PurchaseHistoryProps) {
  const [batches, setBatches] = useState<BatchWithPurchase[]>([]);
  const [itemName, setItemName] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchPurchaseHistory() {
      try {
        const itemRef = doc(db, 'inventory', inventoryId);
        const snap = await getDoc(itemRef);
        
        if (!snap.exists()) {
          setLoading(false);
          return;
        }

        const item = snap.data() as InventoryItem;
        setItemName(item.name);

        // Extract batches with purchase info
        const batchesWithPurchase: BatchWithPurchase[] = (item.batches || [])
          .filter(b => b.purchase)
          .map(b => ({
            batchId: b.id,
            lotNumber: b.lotNumber,
            stock: b.stock,
            receivedAt: b.receivedAt,
            purchase: b.purchase,
          }));

        // Sort by received date (newest first)
        batchesWithPurchase.sort((a, b) => {
          const dateA = a.receivedAt || a.purchase?.receivedAt;
          const dateB = b.receivedAt || b.purchase?.receivedAt;
          if (!dateA) return 1;
          if (!dateB) return -1;
          const timeA = dateA instanceof Date ? dateA.getTime() : (dateA as Timestamp).toDate ? (dateA as Timestamp).toDate().getTime() : 0;
          const timeB = dateB instanceof Date ? dateB.getTime() : (dateB as Timestamp).toDate ? (dateB as Timestamp).toDate().getTime() : 0;
          return timeB - timeA;
        });

        setBatches(batchesWithPurchase);
      } catch (err) {
        console.error('Failed to fetch purchase history:', err);
      } finally {
        setLoading(false);
      }
    }

    fetchPurchaseHistory();
  }, [inventoryId]);

  if (loading) {
    return (
      <Card className="w-full">
        <CardBody>
          <p className="text-sm text-gray-500">Loading purchase history...</p>
        </CardBody>
      </Card>
    );
  }

  if (batches.length === 0) {
    return (
      <Card className="w-full">
        <CardBody>
          <p className="text-sm text-gray-500">No purchase history available for this item.</p>
          <p className="text-xs text-gray-400 mt-1">Purchase info will appear here when vendors and pricing are recorded.</p>
        </CardBody>
      </Card>
    );
  }

  // Calculate cheapest supplier
  const batchesWithPrice = batches.filter(b => b.purchase?.pricePerUnit);
  const cheapest = batchesWithPrice.length > 0
    ? batchesWithPrice.reduce((min, b) => 
        (b.purchase!.pricePerUnit! < min.purchase!.pricePerUnit! ? b : min)
      )
    : null;

  return (
    <div className="w-full space-y-3">
      <Card className="w-full">
        <CardHeader className="flex justify-between">
          <div>
            <h3 className="text-lg font-semibold">Purchase History</h3>
            <p className="text-xs text-gray-500">{itemName}</p>
          </div>
          {cheapest && (
            <Chip color="success" size="sm" startContent={<DollarSign size={14} />}>
              Cheapest: {cheapest.purchase?.supplierName} @ ${cheapest.purchase?.pricePerUnit?.toFixed(2)}
            </Chip>
          )}
        </CardHeader>
        <CardBody>
          <div className="space-y-2">
            {batches.map((batch) => {
              const p = batch.purchase!;
              const isCheapest = cheapest && batch.batchId === cheapest.batchId;
              
              return (
                <div
                  key={batch.batchId}
                  className={`p-3 rounded-lg border ${
                    isCheapest
                      ? 'border-green-300 bg-green-50 dark:bg-green-900/10'
                      : 'border-gray-200 bg-gray-50 dark:bg-gray-800'
                  }`}
                >
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <div className="font-semibold text-sm">
                        {p.supplierName || 'Unknown Supplier'}
                      </div>
                      {batch.lotNumber && (
                        <div className="text-xs text-gray-500">Lot: {batch.lotNumber}</div>
                      )}
                    </div>
                    {p.pricePerUnit && (
                      <Chip size="sm" variant="flat" color={isCheapest ? 'success' : 'default'}>
                        ${p.pricePerUnit.toFixed(2)} {p.currency || 'USD'}
                      </Chip>
                    )}
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                    {p.quantityReceived && (
                      <div className="flex items-center gap-1">
                        <Package size={12} className="text-gray-400" />
                        <span>Qty: {p.quantityReceived}</span>
                      </div>
                    )}
                    {(batch.receivedAt || p.receivedAt) && (
                      <div className="flex items-center gap-1">
                        <Calendar size={12} className="text-gray-400" />
                        <span>
                          {(() => {
                            const date = batch.receivedAt || p.receivedAt!;
                            const jsDate = date instanceof Date ? date : (date as Timestamp).toDate ? (date as Timestamp).toDate() : new Date();
                            return jsDate.toLocaleDateString();
                          })()}
                        </span>
                      </div>
                    )}
                    {p.purchaseOrderId && (
                      <div className="flex items-center gap-1">
                        <FileText size={12} className="text-gray-400" />
                        <span>PO: {p.purchaseOrderId}</span>
                      </div>
                    )}
                    {p.invoiceRef && (
                      <div className="flex items-center gap-1">
                        <FileText size={12} className="text-gray-400" />
                        <span>Inv: {p.invoiceRef}</span>
                      </div>
                    )}
                  </div>

                  {p.notes && (
                    <div className="mt-2 text-xs text-gray-600 dark:text-gray-400">
                      Note: {p.notes}
                    </div>
                  )}

                  <div className="mt-2 text-xs text-gray-400">
                    Current stock: {batch.stock} units
                  </div>
                </div>
              );
            })}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
