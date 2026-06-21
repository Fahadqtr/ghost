"use client";

import { useEffect, useRef, useState } from "react";
import { recognizeProduct, type RecogCandidate } from "@/app/(app)/inventory/actions";
import type { PickItem } from "@/components/MovementForm";

type Phase = "camera" | "loading" | "results" | "error";

export default function PhotoIdentify({
  onPick,
  onClose,
}: {
  onPick: (item: PickItem) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [phase, setPhase] = useState<Phase>("camera");
  const [error, setError] = useState<string>("");
  const [candidates, setCandidates] = useState<RecogCandidate[]>([]);
  const [guess, setGuess] = useState<string>("");

  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      streamRef.current = stream;
      const v = videoRef.current;
      if (v) {
        v.srcObject = stream;
        await v.play();
      }
    } catch (e: any) {
      setError(
        e?.name === "NotAllowedError"
          ? "Camera permission was denied. Allow access and retry."
          : `Couldn’t start the camera: ${e?.message ?? "error"}`
      );
      setPhase("error");
    }
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  useEffect(() => {
    startCamera();
    return stopCamera;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function capture() {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const maxW = 800;
    const scale = Math.min(1, maxW / v.videoWidth);
    const w = Math.round(v.videoWidth * scale);
    const h = Math.round(v.videoHeight * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.6);
    stopCamera();
    setPhase("loading");
    try {
      const res = await Promise.race([
        recognizeProduct(dataUrl),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Timed out after 45s")), 45000)
        ),
      ]);
      if ("error" in res) {
        setError(res.error);
        setPhase("error");
        return;
      }
      setGuess(res.guess || "");
      setCandidates(res.candidates);
      setPhase("results");
    } catch (e: any) {
      setError(`Recognition failed: ${e?.message ?? "error"}. Try again or search manually.`);
      setPhase("error");
    }
  }

  async function retake() {
    setError("");
    setCandidates([]);
    setPhase("camera");
    await startCamera();
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-md overflow-hidden rounded-xl bg-black">
        {phase === "camera" && (
          <div className="relative aspect-[4/3] w-full">
            <video ref={videoRef} className="h-full w-full object-cover" playsInline muted />
          </div>
        )}

        {phase === "loading" && (
          <div className="flex aspect-[4/3] w-full items-center justify-center text-sm text-white">
            Identifying the product…
          </div>
        )}

        {phase === "error" && (
          <div className="flex aspect-[4/3] w-full items-center justify-center p-6 text-center text-sm text-white">
            {error}
          </div>
        )}

        {phase === "results" && (
          <div className="max-h-[70vh] overflow-y-auto bg-white">
            <div className="border-b border-slate-200 px-4 py-2 text-sm text-slate-600">
              {candidates.length > 0 ? (
                <>Closest matches{guess ? <> for <span className="font-medium text-ink">“{guess}”</span></> : null} — tap the right one:</>
              ) : (
                <>No catalog match found{guess ? <> for “{guess}”</> : null}. Retake or search manually.</>
              )}
            </div>
            {candidates.map((c) => (
              <button
                key={c.inventoryId}
                className="flex w-full items-center gap-3 border-b border-slate-100 px-4 py-3 text-left hover:bg-slate-50"
                onClick={() => {
                  stopCamera();
                  onPick({
                    inventoryId: c.inventoryId,
                    sku: c.sku,
                    name: c.name,
                    name_ar: c.name_ar,
                    barcode: c.barcode,
                    stock: c.stock,
                  });
                }}
              >
                {c.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.image_url} alt="" className="h-12 w-12 flex-none rounded object-cover" loading="lazy" />
                ) : (
                  <div className="h-12 w-12 flex-none rounded bg-slate-100" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">{c.name ?? c.sku}</div>
                  <div className="text-xs text-muted">{c.sku} · stock {c.stock}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3 flex gap-2">
        {phase === "camera" && (
          <button className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-slate-800" onClick={capture}>
            📸 Capture &amp; identify
          </button>
        )}
        {(phase === "results" || phase === "error") && (
          <button className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-slate-800" onClick={retake}>
            Retake
          </button>
        )}
        <button
          className="rounded-lg border border-white/40 px-4 py-2 text-sm font-medium text-white"
          onClick={() => {
            stopCamera();
            onClose();
          }}
        >
          Cancel
        </button>
      </div>
      {phase === "camera" && <p className="mt-2 text-center text-sm text-white/80">Fill the frame with the product, then capture.</p>}
    </div>
  );
}
