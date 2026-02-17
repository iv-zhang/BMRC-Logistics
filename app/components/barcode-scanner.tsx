"use client";
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ScanBarcode, Keyboard, Upload } from 'lucide-react';
// Minimal ambient types to avoid `any` when interacting with optional browser APIs
declare global {
  interface BarcodeDetectionResult {
    rawValue?: string;
    displayValue?: string;
  }
  interface BarcodeDetectorConstructor {
    new (options?: { formats?: string[] }): {
      detect(target: ImageBitmap | HTMLVideoElement | HTMLImageElement): Promise<BarcodeDetectionResult[]>;
    };
  }
  interface Window {
    BarcodeDetector?: BarcodeDetectorConstructor;
  }
}
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Input, Divider, Chip } from '@heroui/react';

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onDetected: (value: string) => void;
  /** Minimum barcode length to accept (prevents partial/garbage reads). Default: 3 */
  minLength?: number;
};

export default function BarcodeScanner({ isOpen, onClose, onDetected, minLength = 3 }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [scanning, setScanning] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [manualValue, setManualValue] = useState('');
  const [lastScannedRaw, setLastScannedRaw] = useState<string | null>(null);
  const [mode, setMode] = useState<'camera' | 'manual'>('camera');
  // Consecutive-read confirmation: require the same value to be read multiple times
  const consecutiveRef = useRef<{ value: string; count: number }>({ value: '', count: 0 });
  const CONFIRM_READS = 2; // Number of consecutive identical reads required before accepting

  const handleConfirmedDetection = useCallback((value: string) => {
    const trimmed = value.trim();
    if (trimmed.length < minLength) {
      setMessage(`Scanned value "${trimmed}" is too short (min ${minLength} chars). Try again or enter manually.`);
      return;
    }
    setLastScannedRaw(trimmed);
    onDetected(trimmed);
  }, [minLength, onDetected]);

  useEffect(() => {
    if (!isOpen || mode !== 'camera') return;
    let stop = false;
    consecutiveRef.current = { value: '', count: 0 };
    const start = async () => {
      try {
        const hasBarcode = typeof window.BarcodeDetector !== 'undefined';
        setSupported(!!hasBarcode);
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        try {
          await videoRef.current?.play();
        } catch (playErr: any) {
          if (playErr && playErr.name === 'AbortError') {
            console.warn('video play aborted (ignored)');
          } else {
            console.warn('video play failed', playErr);
          }
        }
        setScanning(true);

        if (hasBarcode && window.BarcodeDetector) {
          const Detector = window.BarcodeDetector;
          const detector = new Detector({ formats: ['qr_code', 'data_matrix', 'code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39', 'code_93', 'codabar', 'itf'] });
          const poll = async () => {
            if (stop) return;
            try {
              const img = videoRef.current as HTMLVideoElement;
              if (img.readyState < 2) {
                requestAnimationFrame(poll);
                return;
              }
              const result = await detector.detect(img);
              if (result && result.length) {
                const raw = (result[0].rawValue || result[0].displayValue || '').toString().trim();
                if (raw && raw.length >= minLength) {
                  // Require consecutive identical reads to prevent misreads
                  if (consecutiveRef.current.value === raw) {
                    consecutiveRef.current.count++;
                  } else {
                    consecutiveRef.current = { value: raw, count: 1 };
                  }
                  if (consecutiveRef.current.count >= CONFIRM_READS) {
                    handleConfirmedDetection(raw);
                    stop = true;
                    setScanning(false);
                    try { stream.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
                    onClose();
                    return;
                  }
                }
              }
            } catch {
              // ignore detection errors
            }
            requestAnimationFrame(poll);
          };
          poll();
        }
      } catch (err) {
        console.error('camera error', err);
        setScanning(false);
        setMode('manual');
        setMessage('Camera not available. Please type the barcode manually.');
      }
    };
    start();
    return () => {
      stop = true;
      setScanning(false);
      try { streamRef.current?.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
      try { if (videoRef.current) videoRef.current.srcObject = null; } catch { /* ignore */ }
    };
  }, [isOpen, mode, onClose, handleConfirmedDetection, minLength]);

  // Reset state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setManualValue('');
      setLastScannedRaw(null);
      setMessage(null);
      setMode('camera');
    }
  }, [isOpen]);

  const handleManualSubmit = () => {
    const trimmed = manualValue.trim();
    if (!trimmed) return;
    if (trimmed.length < minLength) {
      setMessage(`Barcode must be at least ${minLength} characters.`);
      return;
    }
    onDetected(trimmed);
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={(v) => { if (!v) onClose(); }} size="lg">
      <ModalContent>
        <ModalHeader className="flex items-center gap-2">
          <ScanBarcode size={20} />
          Scan or Enter Barcode
        </ModalHeader>
        <ModalBody>
          {/* Mode toggle */}
          <div className="flex gap-2 mb-3">
            <Button
              size="sm"
              variant={mode === 'camera' ? 'solid' : 'flat'}
              color={mode === 'camera' ? 'primary' : 'default'}
              startContent={<ScanBarcode size={14} />}
              onPress={() => setMode('camera')}
            >
              Camera
            </Button>
            <Button
              size="sm"
              variant={mode === 'manual' ? 'solid' : 'flat'}
              color={mode === 'manual' ? 'primary' : 'default'}
              startContent={<Keyboard size={14} />}
              onPress={() => setMode('manual')}
            >
              Type / Paste
            </Button>
          </div>

          {mode === 'camera' && (
            <>
              <div className="w-full h-64 bg-black rounded-lg overflow-hidden flex items-center justify-center relative">
                <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
                {scanning && (
                  <div className="absolute inset-0 pointer-events-none">
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-48 h-48 border-2 border-primary rounded-lg opacity-50" />
                  </div>
                )}
              </div>
              {scanning && (
                <div className="flex items-center gap-2 mt-2">
                  <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                  <span className="text-sm text-gray-500">Scanning... hold barcode steady in the viewfinder</span>
                </div>
              )}
              {supported === false && (
                <Chip color="warning" variant="flat" size="sm" className="mt-2">
                  Camera scanning not supported in this browser. Use manual entry instead.
                </Chip>
              )}
            </>
          )}

          {mode === 'manual' && (
            <div className="space-y-3">
              <p className="text-sm text-gray-500">
                Type or paste the barcode value from the physical tag. You can also use a USB/Bluetooth barcode scanner — just focus this field and scan.
              </p>
              <Input
                label="Barcode Value"
                placeholder="e.g. BMRC-AED-001 or 4902778..."
                value={manualValue}
                onValueChange={setManualValue}
                autoFocus
                isClearable
                onClear={() => setManualValue('')}
                onKeyDown={(e: any) => { if (e.key === 'Enter') handleManualSubmit(); }}
                size="lg"
                classNames={{ input: 'font-mono text-lg' }}
              />
              <Button
                color="primary"
                className="w-full"
                isDisabled={!manualValue.trim() || manualValue.trim().length < minLength}
                onPress={handleManualSubmit}
              >
                Assign This Barcode
              </Button>
            </div>
          )}

          <Divider className="my-2" />

          {/* Image upload fallback */}
          <div>
            <p className="text-sm text-gray-500 mb-2 flex items-center gap-1">
              <Upload size={14} /> Or upload a photo of the barcode
            </p>
            <input type="file" accept="image/*" className="text-sm" onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setMessage('Processing image...');
              try {
                // create image bitmap
                const imgBitmap = await createImageBitmap(f as Blob);
                // try native BarcodeDetector on image
                if (window.BarcodeDetector) {
                  try {
                    const detector = new window.BarcodeDetector();
                    const results = await detector.detect(imgBitmap);
                    if (results && results.length) {
                      const raw = results[0].rawValue || results[0].displayValue;
                      if (raw) {
                        onDetected(raw.toString());
                        setMessage(null);
                        onClose();
                        return;
                      }
                    }
                  } catch (e) {
                    void e;
                    // fallthrough to zxing
                  }
                }

                // dynamic import ZXing if available (optional dependency)
                try {
                  const ZXingModule = await import('@zxing/library');
                  const ZXing = ZXingModule as unknown as {
                    BrowserMultiFormatReader?: new () => { decodeFromImageElement: (el: HTMLImageElement) => Promise<unknown> };
                    BrowserQRCodeReader?: new () => { decodeFromImageElement: (el: HTMLImageElement) => Promise<unknown> };
                  };
                  const ReaderCtor = ZXing.BrowserMultiFormatReader || ZXing.BrowserQRCodeReader;
                  if (ReaderCtor) {
                    const reader = new ReaderCtor() as { decodeFromImageElement: (el: HTMLImageElement) => Promise<unknown> };
                    const img = document.createElement('img');
                    const objUrl = URL.createObjectURL(f);
                    img.src = objUrl;
                    await new Promise((res) => { img.onload = res; });
                    const result = await reader.decodeFromImageElement(img);
                    if (result && typeof result === 'object' && result !== null) {
                      const r = result as Record<string, unknown>;
                      const maybeGetText = r['getText'];
                      const maybeText = r['text'];
                      if (typeof maybeGetText === 'function') {
                        const fn = maybeGetText as (...args: unknown[]) => unknown;
                        const text = String(fn.call(r));
                        onDetected(text);
                        setMessage(null);
                        onClose();
                        return;
                      } else if (typeof maybeText === 'string') {
                        onDetected(maybeText);
                        setMessage(null);
                        onClose();
                        return;
                      }
                    }
                    try { URL.revokeObjectURL(objUrl); } catch {}
                  }
                } catch (zxE) {
                  console.warn('ZXing decode failed or not installed', zxE);
                }

                setMessage('No barcode detected. Try a clearer photo or use the manual input.');
              } catch (err) {
                console.error('image decode error', err);
                setMessage('Failed to process image.');
              }
            }} />
            {message && <div className="mt-2 text-sm text-red-500">{message}</div>}
          </div>
        </ModalBody>
        <ModalFooter>
          {mode === 'camera' && (
            <Button variant="flat" size="sm" onPress={() => setMode('manual')} startContent={<Keyboard size={14} />}>
              Type Manually Instead
            </Button>
          )}
          <Button variant="light" onPress={onClose}>Close</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
