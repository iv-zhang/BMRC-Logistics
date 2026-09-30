'use client';

import React from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button } from '@heroui/react';

export type ResponsiveModalSize =
  | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '5xl' | 'full';

export interface ResponsiveModalProps {
  isOpen: boolean;
  /** Called on backdrop click, Esc, or the close button. */
  onClose: () => void;
  /** Rendered as the `ModalHeader`. A plain string is the common case. */
  title?: React.ReactNode;
  children: React.ReactNode;
  /**
   * Rendered as the `ModalFooter`. Pass nothing to omit the footer entirely.
   * For the standard two-button pattern (secondary + primary), pass
   * `<ResponsiveModalFooter onCancel={...} onConfirm={...} confirmLabel="..." />`.
   */
  footer?: React.ReactNode;
  size?: ResponsiveModalSize;
  scrollBehavior?: 'inside' | 'outside' | 'normal';
  /** Extra classes for the modal's base (panel) element. */
  className?: string;
  /**
   * Below `md`, expand to a full-screen sheet instead of a centered card —
   * there's no room for a partial-height centered dialog on a phone. On by
   * default; turn off only for a modal that's already small enough to fit
   * (e.g. a single confirm prompt) where full-screen would look broken.
   */
  mobileFullScreen?: boolean;
}

/**
 * Standard dialog shell wrapping HeroUI's `Modal`. Use for confirms, small
 * forms, and review dialogs (duplicate review, merge, delete-confirm) — the
 * same `Modal/ModalContent/ModalHeader/ModalBody/ModalFooter` combination
 * already used throughout `/inventory`, now with mobile-safe full-screen
 * sizing baked in. For a persistent right-side/centered panel with its own
 * drawer-vs-modal user preference (inventory/audit/receive/event pop-outs),
 * use `PanelShell` instead — this component is for one-shot dialogs.
 */
export default function ResponsiveModal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  size = 'lg',
  scrollBehavior = 'inside',
  className = '',
  mobileFullScreen = true,
}: ResponsiveModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => { if (!open) onClose(); }}
      size={size}
      scrollBehavior={scrollBehavior}
      classNames={{
        base: `${mobileFullScreen ? 'max-md:w-full max-md:max-w-none max-md:h-full max-md:max-h-none max-md:rounded-none max-md:m-0' : ''} ${className}`,
      }}
    >
      <ModalContent>
        {() => (
          <>
            {title && <ModalHeader>{title}</ModalHeader>}
            <ModalBody className={title ? '' : 'pt-6'}>{children}</ModalBody>
            {footer && <ModalFooter>{footer}</ModalFooter>}
          </>
        )}
      </ModalContent>
    </Modal>
  );
}

export interface ResponsiveModalFooterProps {
  cancelLabel?: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
  confirmColor?: 'primary' | 'danger';
  isConfirmDisabled?: boolean;
  isConfirmLoading?: boolean;
}

/**
 * The standard two-button dialog footer: bordered secondary + solid primary
 * (or danger), equal-width on mobile. Matches the drawer-footer convention.
 */
function ResponsiveModalFooter({
  cancelLabel = 'Cancel',
  confirmLabel = 'Confirm',
  onCancel,
  onConfirm,
  confirmColor = 'primary',
  isConfirmDisabled = false,
  isConfirmLoading = false,
}: ResponsiveModalFooterProps) {
  return (
    <>
      <Button variant="bordered" onPress={onCancel} className="flex-1 sm:flex-none">
        {cancelLabel}
      </Button>
      <Button
        color={confirmColor}
        onPress={onConfirm}
        isDisabled={isConfirmDisabled}
        isLoading={isConfirmLoading}
        className="flex-1 sm:flex-none"
      >
        {confirmLabel}
      </Button>
    </>
  );
}

export { ResponsiveModalFooter };
