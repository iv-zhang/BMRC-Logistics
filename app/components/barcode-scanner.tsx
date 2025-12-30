"use client";
import React, { useEffect, useRef, useState } from 'react';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button } from '@heroui/react';

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onDetected: (value: string) => void;
};

export default function BarcodeScanner({ isOpen, onClose, onDetected }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [scanning, setScanning] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let stop = false;
    const start = async () => {
      try {
        const hasBarcode = (window as any).BarcodeDetector !== undefined;
        setSupported(!!hasBarcode);
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        videoRef.current?.play();
        setScanning(true);

        if (hasBarcode) {
          const detector = new (window as any).BarcodeDetector({ formats: ['qr_code', 'data_matrix', 'code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e'] });
          const poll = async () => {
            if (stop) return;
            try {
              const img = videoRef.current as HTMLVideoElement;
              const result = await detector.detect(img);
              if (result && result.length) {
                const raw = result[0].rawValue || result[0].displayValue;
                if (raw) {
                  onDetected(raw.toString());
                  stop = true;
                  setScanning(false);
                  try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}
                  onClose();
                  return;
                }
              }
            } catch (e) {
              // ignore detection errors
            }
            requestAnimationFrame(poll);
          };
          poll();
        }
      } catch (err) {
        console.error('camera error', err);
        setScanning(false);
      }
    };
    start();
    return () => {
      stop = true;
      setScanning(false);
      try { streamRef.current?.getTracks().forEach(t => t.stop()); } catch (e) {}
    };
  }, [isOpen, onClose, onDetected]);

  return (
    <Modal isOpen={isOpen} onOpenChange={(v) => { if (!v) onClose(); }}>
      <ModalContent>
        <ModalHeader>Scan Barcode</ModalHeader>
        <ModalBody>
          <div className="w-full h-64 bg-black flex items-center justify-center">
            <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
          </div>
          {supported === false && (
            <div className="mt-2 text-sm text-gray-500">BarcodeDetector not supported in this browser. You can type/paste the barcode instead, or upload an image below.</div>
          )}
          <div className="mt-3">
            <label className="block text-sm mb-1">Or upload an image with a barcode</label>
            <input type="file" accept="image/*" onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setMessage('Processing image...');
              try {
                // create image bitmap
                const imgBitmap = await createImageBitmap(f as any);
                // try native BarcodeDetector on image
                if ((window as any).BarcodeDetector) {
                  try {
                    const detector = new (window as any).BarcodeDetector();
                    const results = await detector.detect(imgBitmap as any);
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
                    // fallthrough to zxing
                  }
                }

                // dynamic import ZXing if available (optional dependency)
                try {
                  const ZXing = await import('@zxing/library');
                  const { BrowserQRCodeReader, BrowserMultiFormatReader, BinaryBitmap, HybridBinarizer, RGBLuminanceSource } = ZXing;
                  // Use BrowserMultiFormatReader decodeFromImage
                  const reader = new (ZXing as any).BrowserMultiFormatReader();
                  // create temporary img element
                  const img = document.createElement('img');
                  img.src = URL.createObjectURL(f);
                  await new Promise((res) => { img.onload = res; });
                  const result = await reader.decodeFromImageElement(img);
                  if (result && result.getText) {
                    onDetected(result.getText());
                    setMessage(null);
                    onClose();
                    return;
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
          <Button variant="light" onPress={onClose}>Close</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
