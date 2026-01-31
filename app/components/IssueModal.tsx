"use client";

import React from "react";
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, RadioGroup, Radio, Switch, Input, Divider, Textarea } from "@heroui/react";
import { StatpackItem } from "@/app/types";
import { AlertOctagon } from "lucide-react";

interface IssueReport {
  itemId: string;
  itemName: string;
  issueType: "missing" | "expired" | "damaged" | "other";
  isReplaced: boolean;
  replacedQuantity: number;
  newExpirationDate?: string;
  notes: string;
}

interface Props {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  currentIssueItem: StatpackItem | null;
  tempIssueData: Partial<IssueReport>;
  setTempIssueData: React.Dispatch<React.SetStateAction<Partial<IssueReport>>>;
  saveIssueReport: () => void;
  aedChecks: Record<string, any>;
  handleAedToggle: (itemId: string, field: "powerOn" | "padsSealed", val: boolean) => void;
  handleAedExpirationChange: (itemId: string, field: "padExpiration" | "batteryExpiration", val: string) => void;
}

export default function IssueModal({ isOpen, onOpenChange, currentIssueItem, tempIssueData, setTempIssueData, saveIssueReport, aedChecks, handleAedToggle, handleAedExpirationChange }: Props) {
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} placement="center" size="sm" backdrop="blur">
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader>Report Issue: {currentIssueItem?.itemDetails?.name}</ModalHeader>
            <ModalBody>
              <p className="text-sm text-gray-500 mb-2">What is wrong with this item?</p>
              <RadioGroup
                className="space-y-3"
                value={tempIssueData.issueType}
                onValueChange={(val: string) => setTempIssueData(prev => ({ ...prev, issueType: val as IssueReport['issueType'] }))}
              >
                <Radio className="gap-3" value="missing" description="Item is not in the bag">Missing / Not Found</Radio>
                <Radio className="gap-3" value="expired" description="Expiration date passed">Expired</Radio>
                <Radio className="gap-3" value="damaged" description="Broken or open seal">Damaged / Compromised</Radio>
                <Radio className="gap-3" value="other">Other Issue</Radio>
              </RadioGroup>

              <Divider className="my-2" />

              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="font-bold text-sm">Did you replace it?</span>
                  <span className="text-xs text-gray-500">Available from inventory</span>
                </div>
                <Switch
                  isSelected={!!tempIssueData.isReplaced}
                  onValueChange={(val) => setTempIssueData(prev => ({ ...prev, isReplaced: val }))}
                />
              </div>

              {tempIssueData.isReplaced && (
                <div className="mt-2 bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg border border-blue-100 dark:border-blue-800 space-y-3">
                  <div>
                    <Input
                      type="number"
                      label="Quantity Replaced"
                      placeholder="1"
                      size="sm"
                      variant="bordered"
                      value={tempIssueData.replacedQuantity?.toString()}
                      onValueChange={(v) => setTempIssueData(prev => ({ ...prev, replacedQuantity: parseInt(v) || 0 }))}
                    />
                    <p className="text-[10px] text-blue-600 mt-1 flex items-center gap-1"><AlertOctagon size={10} /> Stock will be automatically deducted.</p>
                  </div>

                  {currentIssueItem?.itemDetails?.tracksExpiration && (
                    <Input
                      type="date"
                      label="New Item Expiration"
                      size="sm"
                      variant="bordered"
                      color="primary"
                      value={tempIssueData.newExpirationDate}
                      onValueChange={(v) => setTempIssueData(prev => ({ ...prev, newExpirationDate: v }))}
                      isRequired
                    />
                  )}

                  {/* AED checks UI */}
                  {(currentIssueItem?.itemDetails?.isAsset && currentIssueItem?.itemDetails?.assetCategory === 'AED') && (
                    <div className="mt-3 space-y-2" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant={aedChecks[currentIssueItem.itemId]?.powerOn ? 'solid' : 'bordered'} color={aedChecks[currentIssueItem.itemId]?.powerOn ? 'success' : 'default'} onPress={() => handleAedToggle(currentIssueItem.itemId, 'powerOn', !(aedChecks[currentIssueItem.itemId]?.powerOn))}>Power On OK</Button>
                        <Button size="sm" variant={aedChecks[currentIssueItem.itemId]?.padsSealed ? 'solid' : 'bordered'} color={aedChecks[currentIssueItem.itemId]?.padsSealed ? 'success' : 'default'} onPress={() => handleAedToggle(currentIssueItem.itemId, 'padsSealed', !(aedChecks[currentIssueItem.itemId]?.padsSealed))}>Pads Present & Sealed</Button>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="text-[10px] text-gray-400">Pad Exp</div>
                        <Input type="date" size="sm" value={aedChecks[currentIssueItem.itemId]?.padExpiration || ''} onValueChange={(v) => handleAedExpirationChange(currentIssueItem.itemId, 'padExpiration', v)} className="max-w-[140px]" />
                        <div className="text-[10px] text-gray-400 ml-2">Battery Exp</div>
                        <Input type="date" size="sm" value={aedChecks[currentIssueItem.itemId]?.batteryExpiration || ''} onValueChange={(v) => handleAedExpirationChange(currentIssueItem.itemId, 'batteryExpiration', v)} className="max-w-[140px]" />
                      </div>
                      <Input size="sm" variant="flat" placeholder="Notes (optional)" value={aedChecks[currentIssueItem.itemId]?.notes || ''} onValueChange={(v) => { /* parent manages */ }} />
                    </div>
                  )}
                </div>
              )}

              <Textarea
                label="Notes"
                placeholder="Details..."
                minRows={2}
                value={tempIssueData.notes as string}
                onValueChange={(v) => setTempIssueData(prev => ({ ...prev, notes: v }))}
              />
            </ModalBody>
            <ModalFooter>
              <Button variant="light" color="danger" onPress={onClose}>Cancel</Button>
              <Button color="warning" onPress={saveIssueReport} className="font-bold shadow-md">Log Issue</Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
