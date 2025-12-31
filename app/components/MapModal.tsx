'use client';

import React from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button } from '@heroui/react';
import { BagVisualizer } from '@/app/components/statpackvisualizer';
import { Statpack, StatpackPocket } from '@/app/types';

interface Props {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  pack: Statpack | null;
  onSelectPocket: (p: StatpackPocket | 'all') => void;
}

export default function MapModal({ isOpen, onOpenChange, pack, onSelectPocket }: Props) {
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} placement="center" size="full" classNames={{ base: "m-0 rounded-none h-full", header: "border-b border-gray-200 dark:border-slate-700", body: "p-4 bg-gray-50 dark:bg-slate-900" }}>
      <ModalContent>
        {(onClose) => (
          <>
            <ModalHeader className="flex flex-col gap-1"><h3>Jump to Pocket</h3></ModalHeader>
            <ModalBody className="flex items-center justify-center">
              {pack ? <BagVisualizer statpack={pack} selectedPocket={'all'} onSelectPocket={onSelectPocket} /> : <div className="text-sm text-gray-500">No pack data</div>}
            </ModalBody>
            <ModalFooter><Button color="danger" variant="light" onPress={onClose}>Close Map</Button></ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
