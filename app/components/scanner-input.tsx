'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { ScanBarcode, Keyboard, X, Check, AlertTriangle } from 'lucide-react';
import { Button, Input, Chip } from '@heroui/react';
import { useBarcodeScanner } from '@/app/hooks/useBarcodeScanner';

interface ScannerInputProps {
  /** Called when a barcode is successfully scanned or entered */
  onScan: (code: string) => void;
  /** Placeholder text for manual input */
  placeholder?: string;
  /** Allow camera-based scanning. Default: true */
  allowCamera?: boolean;
  /** Allow manual text input. Default: true */
  allowManual?: boolean;
  /** Auto-focus the manual input. Default: false */
  autoFocus?: boolean;
  /** If true, scanner stays open for batch scanning. Default: false */
  continuous?: boolean;
  /** Minimum barcode length. Default: 3 */
  minLength?: number;
  /** Label above the input */
  label?: string;
  /** Compact mode for inline use. Default: false */
  compact?: boolean;
  /** Show the last scanned code. Default: true */
  showLastScan?: boolean;
  /** Optional className for the wrapper */
  className?: string;
  /** Validation status of the last scan */
  scanStatus?: 'success' | 'error' | 'warning' | null;
  /** Status message to show below scanner */
  statusMessage?: string;
  /** Whether the input is disabled */
  isDisabled?: boolean;
}

/**
 * Unified barcode scanner input component.
 * Drop-in replacement for all inline scanning UIs across the app.
 *
 * Supports:
 * - Camera-based scanning with viewfinder
 * - Manual text/paste input
 * - USB/Bluetooth scanner input (auto-captured in manual mode)
 * - Continuous mode for batch operations
 * - Status feedback (success/error/warning)
 */
export default function ScannerInput({
  onScan,
  placeholder = 'Scan or type barcode...',
  allowCamera = true,
  allowManual = true,
  autoFocus = false,
  continuous = false,
  minLength = 3,
  label,
  compact = false,
  showLastScan = true,
  className = '',
  scanStatus = null,
  statusMessage,
  isDisabled = false,
}: ScannerInputProps) {
  const [manualValue, setManualValue] = useState('');
  const [showCamera, setShowCamera] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDetected = useCallback((code: string) => {
    onScan(code);
    setManualValue('');
    if (!continuous) {
      setShowCamera(false);
    }
  }, [onScan, continuous]);

  const {
    isScanning,
    lastCode,
    videoRef,
    startScan,
    stopScan,
    error: scanError,
  } = useBarcodeScanner({
    onDetected: handleDetected,
    minLength,
    continuous,
  });

  // Start/stop camera when showCamera changes
  useEffect(() => {
    if (showCamera) {
      startScan();
    } else {
      stopScan();
    }
  }, [showCamera, startScan, stopScan]);

  const handleManualSubmit = useCallback(() => {
    const trimmed = manualValue.trim();
    if (!trimmed || trimmed.length < minLength) return;
    handleDetected(trimmed);
  }, [manualValue, minLength, handleDetected]);

  // Handle USB scanner input (rapid keypresses ending with Enter)
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleManualSubmit();
    }
  }, [handleManualSubmit]);

  // Auto-focus on mount if requested
  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
    }
  }, [autoFocus]);

  const statusColor = scanStatus === 'success' ? 'success' :
    scanStatus === 'error' ? 'danger' :
    scanStatus === 'warning' ? 'warning' : 'default';

  const StatusIcon = scanStatus === 'success' ? Check :
    scanStatus === 'error' ? X :
    scanStatus === 'warning' ? AlertTriangle : null;

  return (
    <div className={`space-y-2 ${className}`}>
      {label && <label className="text-sm font-medium">{label}</label>}

      {/* Camera viewfinder */}
      {showCamera && allowCamera && (
        <div className="relative">
          <div className={`bg-black rounded-lg overflow-hidden flex items-center justify-center ${compact ? 'h-40' : 'h-56'}`}>
            <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
            {isScanning && (
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-40 h-40 border-2 border-primary rounded-lg opacity-50" />
              </div>
            )}
          </div>
          {isScanning && (
            <div className="flex items-center gap-2 mt-1">
              <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
              <span className="text-xs text-gray-500">
                {continuous ? 'Continuous scanning — hold items to viewfinder' : 'Hold barcode steady in viewfinder'}
              </span>
            </div>
          )}
          {scanError && (
            <Chip color="warning" variant="flat" size="sm" className="mt-1">{scanError}</Chip>
          )}
          <Button
            size="sm"
            variant="flat"
            className="absolute top-2 right-2"
            isIconOnly
            onPress={() => setShowCamera(false)}
          >
            <X size={14} />
          </Button>
        </div>
      )}

      {/* Input row */}
      <div className="flex gap-2">
        {allowManual && (
          <Input
            ref={inputRef}
            placeholder={placeholder}
            value={manualValue}
            onValueChange={setManualValue}
            onKeyDown={handleKeyDown}
            size={compact ? 'sm' : 'md'}
            classNames={{ input: 'font-mono' }}
            isDisabled={isDisabled}
            isClearable
            onClear={() => setManualValue('')}
            endContent={
              manualValue.trim().length >= minLength ? (
                <Button
                  size="sm"
                  variant="flat"
                  color="primary"
                  isIconOnly
                  onPress={handleManualSubmit}
                  className="min-w-6 h-6"
                >
                  <Check size={14} />
                </Button>
              ) : undefined
            }
          />
        )}

        {allowCamera && !showCamera && (
          <Button
            size={compact ? 'sm' : 'md'}
            variant="flat"
            color="primary"
            isIconOnly={compact}
            startContent={!compact ? <ScanBarcode size={16} /> : undefined}
            onPress={() => setShowCamera(true)}
            isDisabled={isDisabled}
          >
            {compact ? <ScanBarcode size={16} /> : 'Scan'}
          </Button>
        )}
      </div>

      {/* Status feedback */}
      {(scanStatus || statusMessage) && (
        <div className={`flex items-center gap-2 text-sm ${
          scanStatus === 'success' ? 'text-success' :
          scanStatus === 'error' ? 'text-danger' :
          scanStatus === 'warning' ? 'text-warning' : 'text-default-500'
        }`}>
          {StatusIcon && <StatusIcon size={14} />}
          <span>{statusMessage}</span>
        </div>
      )}

      {/* Last scanned display */}
      {showLastScan && lastCode && !statusMessage && (
        <Chip
          variant="flat"
          color={statusColor}
          size="sm"
          startContent={<ScanBarcode size={12} />}
        >
          Last scanned: {lastCode}
        </Chip>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Convenience: Inline scanner button that opens a modal
// ---------------------------------------------------------------------------

interface ScanButtonProps {
  onScan: (code: string) => void;
  label?: string;
  size?: 'sm' | 'md' | 'lg';
  color?: 'primary' | 'secondary' | 'default';
  variant?: 'solid' | 'flat' | 'light' | 'ghost';
  isDisabled?: boolean;
  continuous?: boolean;
  className?: string;
}

/**
 * Compact button that opens the barcode scanner modal.
 * Use when you just need a "Scan" button without an inline input.
 */
export function ScanButton({
  onScan,
  label = 'Scan',
  size = 'sm',
  color = 'primary',
  variant = 'flat',
  isDisabled = false,
  className = '',
}: ScanButtonProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <Button
        size={size}
        color={color}
        variant={variant}
        startContent={<ScanBarcode size={14} />}
        onPress={() => setIsOpen(true)}
        isDisabled={isDisabled}
        className={className}
      >
        {label}
      </Button>

      {isOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setIsOpen(false); }}>
          <div className="bg-content1 rounded-xl p-4 w-full max-w-md shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold flex items-center gap-2">
                <ScanBarcode size={20} /> Scan Barcode
              </h3>
              <Button size="sm" variant="light" isIconOnly onPress={() => setIsOpen(false)}>
                <X size={16} />
              </Button>
            </div>
            <ScannerInput
              onScan={(code) => {
                onScan(code);
                setIsOpen(false);
              }}
              allowCamera
              allowManual
              autoFocus
              placeholder="Scan or type barcode..."
            />
          </div>
        </div>
      )}
    </>
  );
}
