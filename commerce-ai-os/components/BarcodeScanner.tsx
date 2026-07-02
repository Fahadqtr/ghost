"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Camera barcode scanner using the native BarcodeDetector API (zero-dependency).
 * Works on Android Chrome/Edge and other Chromium browsers over HTTPS.
 * Gracefully reports when the browser doesn't support it (e.g. iOS Safari).
 */
export default function BarcodeScanner({
  onDetected,
  onClose,
}: {
  onDetected: (code: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    const Detector = (typeof window !== "undefined" && (window as any).BarcodeDetector) || null;

    async function start() {
      if (!Detector) {
        setError(
          "This browser can’t scan barcodes (try Chrome on Android, or type the SKU manually). iOS Safari isn’t supported yet."
        );
        return;
      }
      try {
        const detector = new Detector({
          formats: ["ean_13", "ean_8", "code_128", "upc_a", "upc_e", "code_39", "qr_code"],
        });
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (stopped) return;
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play();
        setReady(true);

        const tick = async () => {
          if (stopped) return;
          try {
            const codes = await detector.detect(video);
            if (codes && codes.length) {
              const value = String(codes[0].rawValue || "").trim();
              if (value) {
                onDetected(value);
                return; // parent closes us
              }
            }
          } catch {
            /* transient detect errors are fine */
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch (e: any) {
        setError(
          e?.name === "NotAllowedError"
            ? "Camera permission was denied. Allow camera access and try again."
            : `Couldn’t start the camera: ${e?.message ?? "unknown error"}`
        );
      }
    }

    start();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-md overflow-hidden rounded-xl bg-black">
        <div className="relative aspect-4/3 w-full">
          <video ref={videoRef} className="h-full w-full object-cover" playsInline muted />
          {/* aiming frame */}
          {ready && !error && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="h-28 w-3/4 rounded-lg border-2 border-white/80" />
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-white">
              {error}
            </div>
          )}
        </div>
      </div>
      <p className="mt-3 text-center text-sm text-white/80">
        {error ? "" : "Point the camera at the product barcode…"}
      </p>
      <button className="mt-3 rounded-lg bg-white px-4 py-2 text-sm font-medium text-slate-800" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}
