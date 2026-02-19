'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

interface UseBarcodeResult {
  /** Whether the camera viewfinder is actively scanning */
  isScanning: boolean;
  /** Last successfully scanned code */
  lastCode: string | null;
  /** Current input mode */
  mode: 'camera' | 'manual';
  /** Switch between camera and manual mode */
  setMode: (mode: 'camera' | 'manual') => void;
  /** The video ref to attach to a <video> element */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Start camera scanning */
  startScan: () => void;
  /** Stop camera scanning */
  stopScan: () => void;
  /** Submit a manual barcode value */
  submitManual: (value: string) => void;
  /** Reset state for a new scan */
  reset: () => void;
  /** Error message, if any */
  error: string | null;
  /** Whether native BarcodeDetector is supported */
  isNativeSupported: boolean | null;
}

interface UseBarcodeOptions {
  /** Callback when a barcode is confirmed */
  onDetected: (code: string) => void;
  /** Minimum barcode length to accept. Default: 3 */
  minLength?: number;
  /** Number of consecutive identical reads required. Default: 2 */
  confirmReads?: number;
  /** If true, scanner stays open after detection for batch mode. Default: false */
  continuous?: boolean;
}

/**
 * Unified barcode scanning hook.
 * Wraps native BarcodeDetector with consecutive-read confirmation,
 * manual fallback, and optional continuous (batch) mode.
 */
export function useBarcodeScanner({
  onDetected,
  minLength = 3,
  confirmReads = 2,
  continuous = false,
}: UseBarcodeOptions): UseBarcodeResult {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stopRef = useRef(false);
  const consecutiveRef = useRef<{ value: string; count: number }>({ value: '', count: 0 });

  const [isScanning, setIsScanning] = useState(false);
  const [lastCode, setLastCode] = useState<string | null>(null);
  const [mode, setMode] = useState<'camera' | 'manual'>('camera');
  const [error, setError] = useState<string | null>(null);
  const [isNativeSupported, setIsNativeSupported] = useState<boolean | null>(null);

  const handleDetection = useCallback((value: string) => {
    const trimmed = value.trim();
    if (trimmed.length < minLength) {
      setError(`Value too short (min ${minLength} characters)`);
      return;
    }
    setLastCode(trimmed);
    setError(null);
    onDetected(trimmed);

    if (!continuous) {
      // Stop scanning after detection in single mode
      stopRef.current = true;
      setIsScanning(false);
      try { streamRef.current?.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
    } else {
      // In continuous mode, reset consecutive counter for next scan
      consecutiveRef.current = { value: '', count: 0 };
    }
  }, [onDetected, minLength, continuous]);

  const stopScan = useCallback(() => {
    stopRef.current = true;
    setIsScanning(false);
    try { streamRef.current?.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
    try { if (videoRef.current) videoRef.current.srcObject = null; } catch { /* ignore */ }
  }, []);

  const startScan = useCallback(async () => {
    stopRef.current = false;
    consecutiveRef.current = { value: '', count: 0 };
    setError(null);

    try {
      const hasBarcode = typeof window !== 'undefined' && typeof window.BarcodeDetector !== 'undefined';
      setIsNativeSupported(!!hasBarcode);

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        try { await videoRef.current.play(); } catch { /* ignore AbortError */ }
      }
      setIsScanning(true);

      if (hasBarcode && window.BarcodeDetector) {
        const detector = new window.BarcodeDetector({
          formats: ['qr_code', 'data_matrix', 'code_128', 'ean_13', 'ean_8',
            'upc_a', 'upc_e', 'code_39', 'code_93', 'codabar', 'itf'],
        });

        const poll = async () => {
          if (stopRef.current) return;
          try {
            const video = videoRef.current;
            if (video && video.readyState >= 2) {
              const results = await detector.detect(video);
              if (results?.length) {
                const raw = (results[0].rawValue || results[0].displayValue || '').toString().trim();
                if (raw && raw.length >= minLength) {
                  if (consecutiveRef.current.value === raw) {
                    consecutiveRef.current.count++;
                  } else {
                    consecutiveRef.current = { value: raw, count: 1 };
                  }
                  if (consecutiveRef.current.count >= confirmReads) {
                    handleDetection(raw);
                    if (!continuous) return;
                  }
                }
              }
            }
          } catch { /* ignore detection errors */ }
          requestAnimationFrame(poll);
        };
        poll();
      }
    } catch {
      setError('Camera not available. Use manual entry.');
      setMode('manual');
      setIsScanning(false);
    }
  }, [minLength, confirmReads, continuous, handleDetection]);

  const submitManual = useCallback((value: string) => {
    handleDetection(value);
  }, [handleDetection]);

  const reset = useCallback(() => {
    setLastCode(null);
    setError(null);
    consecutiveRef.current = { value: '', count: 0 };
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopRef.current = true;
      try { streamRef.current?.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
    };
  }, []);

  return {
    isScanning,
    lastCode,
    mode,
    setMode,
    videoRef,
    startScan,
    stopScan,
    submitManual,
    reset,
    error,
    isNativeSupported,
  };
}
