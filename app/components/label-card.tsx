'use client';

import React, { useEffect, useState, useRef } from 'react';
import QRCode from 'qrcode';
import JsBarcode from 'jsbarcode';
import type { InventoryItem, Statpack } from '@/app/types';

interface LabelCardProps {
  asset: InventoryItem | Statpack;
  width?: number; // width in mm (will be converted to px for display)
  height?: number; // height in mm (will be converted to px for display)
  dpi?: number; // dots per inch for rendering (default 96)
}

/**
 * LabelCard renders a printable label for an asset containing:
 * - QR code
 * - Barcode (code128)
 * - Asset name, serial/tag, and category
 *
 * Sized to exact mm dimensions for accurate PDF export.
 */
export default function LabelCard({
  asset,
  width = 48,
  height = 30,
  dpi = 96,
}: LabelCardProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Convert mm to px: mm * (dpi / 25.4)
  const pxWidth = width * (dpi / 25.4);
  const pxHeight = height * (dpi / 25.4);

  // Get the label content (tag/serial)
  const getTagContent = (): string => {
    if ('assetSerial' in asset) {
      // InventoryItem
      return String((asset as InventoryItem).assetSerial || (asset as InventoryItem).qr || asset.name || '');
    } else {
      // Statpack
      return String((asset as Statpack).id || asset.name || '');
    }
  };

  const getAssetCategory = (): string => {
    if ('assetCategory' in asset) {
      return String((asset as InventoryItem).assetCategory || 'Item');
    }
    return 'Statpack';
  };

  const tagContent = getTagContent();
  const category = getAssetCategory();

  // Generate QR code
  useEffect(() => {
    let mounted = true;

    if (!tagContent) {
      setQrDataUrl('');
      return;
    }

    (async () => {
      try {
        const dataUrl = await QRCode.toDataURL(tagContent, {
          width: 120,
          errorCorrectionLevel: 'H',
        });
        if (mounted) setQrDataUrl(dataUrl);
      } catch (e) {
        console.error('Failed to generate QR code:', e);
        if (mounted) setQrDataUrl('');
      }
    })();

    return () => {
      mounted = false;
    };
  }, [tagContent]);

  // Generate barcode SVG
  useEffect(() => {
    if (!tagContent || !svgRef.current) return;

    try {
      // @ts-expect-error JsBarcode types are not fully typed
      JsBarcode(svgRef.current, tagContent, {
        format: 'code128',
        displayValue: false,
        width: 1.5,
        height: 40,
        margin: 0,
      });
    } catch (e) {
      console.error('Failed to generate barcode:', e);
    }
  }, [tagContent]);

  return (
    <div
      ref={containerRef}
      className="label-card"
      style={{
        width: `${pxWidth}px`,
        height: `${pxHeight}px`,
        border: '1px solid #e5e7eb',
        padding: '4px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        alignItems: 'center',
        backgroundColor: '#ffffff',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        boxSizing: 'border-box',
        overflow: 'hidden',
        pageBreakInside: 'avoid',
      }}
    >
      {/* QR Code */}
      <div style={{ width: '100%', display: 'flex', justifyContent: 'center', marginBottom: '2px' }}>
        {qrDataUrl ? (
          <div
            style={{
              width: '60px',
              height: '60px',
              backgroundImage: `url(${qrDataUrl})`,
              backgroundSize: 'contain',
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'center',
            }}
          />
        ) : (
          <div style={{ width: '60px', height: '60px', backgroundColor: '#f3f4f6' }} />
        )}
      </div>

      {/* Barcode */}
      <div style={{ width: '100%', display: 'flex', justifyContent: 'center', marginBottom: '2px' }}>
        <svg
          ref={svgRef}
          style={{
            maxWidth: '100%',
            height: 'auto',
          }}
        />
      </div>

      {/* Asset Info */}
      <div
        style={{
          width: '100%',
          textAlign: 'center',
          fontSize: '7px',
          lineHeight: '1',
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          wordBreak: 'break-word',
        }}
      >
        <div style={{ fontWeight: 'bold', marginBottom: '1px' }}>
          {asset.name.substring(0, 15)}
        </div>
        <div style={{ fontSize: '6px', color: '#6b7280' }}>
          {category}
        </div>
      </div>
    </div>
  );
}
