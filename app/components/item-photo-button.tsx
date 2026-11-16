'use client';
import React, { useState } from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody, Button, Input, useDisclosure } from '@heroui/react';
import { Camera, ExternalLink } from 'lucide-react';
import { normalizeImageUrl, isGooglePhotosLink } from '@/app/lib/image-url';

/**
 * Icon button that opens a reference photo of an item (issue #31).
 * Renders nothing when there is no url. Stops propagation so it is safe inside
 * clickable rows / cards that toggle or open a drawer on click.
 */
export function ItemPhotoButton({ url, name, size = 'sm' }: { url?: string | null; name: string; size?: 'sm' | 'md' }) {
  const { isOpen, onOpen, onOpenChange } = useDisclosure();
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!url) return null;
  const failed = failedUrl === url;
  const dim = size === 'md' ? 'h-8 w-8 min-w-8' : 'h-6 w-6 min-w-6';
  const icon = size === 'md' ? 18 : 14;

  return (
    <>
      <Button
        isIconOnly
        size="sm"
        variant="light"
        radius="full"
        aria-label={`View photo of ${name}`}
        title="View photo"
        className={`${dim} p-0 text-default-500 hover:text-primary`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onPress={() => onOpen()}
      >
        <Camera size={icon} />
      </Button>
      {/* Portal content still bubbles React events to ancestors; contain them. */}
      <span onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
        <Modal isOpen={isOpen} onOpenChange={onOpenChange} placement="center" backdrop="blur" size="2xl" scrollBehavior="inside">
          <ModalContent>
            <ModalHeader className="text-base">{name}</ModalHeader>
            <ModalBody className="pb-6">
              {failed ? (
                <div className="space-y-3 text-sm text-default-600">
                  <p>Couldn&apos;t load this photo. If it&apos;s on Google Drive, make sure sharing is set to &quot;Anyone with the link&quot;.</p>
                  <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary underline">
                    Open link <ExternalLink size={14} />
                  </a>
                </div>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={url}
                  alt={name}
                  referrerPolicy="no-referrer"
                  onError={() => setFailedUrl(url)}
                  className="mx-auto max-h-[70vh] w-auto max-w-full rounded-lg object-contain"
                />
              )}
            </ModalBody>
          </ModalContent>
        </Modal>
      </span>
    </>
  );
}

/**
 * "Photo link" form field with validation + live preview, shared by the
 * consumable and asset edit forms. `invalidMessage` is null when the value is
 * empty or valid.
 */
export function photoLinkError(raw: string): string | null {
  if (!raw.trim()) return null;
  if (normalizeImageUrl(raw)) return null;
  return isGooglePhotosLink(raw)
    ? "Google Photos links can't be embedded. Upload the picture to Google Drive and paste that share link instead."
    : 'Enter a valid https:// image link or Google Drive share link.';
}

export function PhotoLinkField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const error = photoLinkError(value);
  const preview = normalizeImageUrl(value);
  const [badPreview, setBadPreview] = useState<string | null>(null);
  return (
    <div className="flex items-start gap-3">
      <Input
        label="Photo link"
        variant="bordered"
        size="sm"
        value={value}
        onValueChange={onChange}
        isInvalid={!!error}
        errorMessage={error ?? undefined}
        description="Paste a Google Drive share link or image URL. Drive files must be shared 'Anyone with the link'. Google Photos links won't work."
        className="flex-1"
      />
      {preview && badPreview !== preview && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview}
          alt="Photo preview"
          referrerPolicy="no-referrer"
          onError={() => setBadPreview(preview)}
          className="h-12 w-12 shrink-0 rounded-md border border-divider object-cover"
        />
      )}
    </div>
  );
}
