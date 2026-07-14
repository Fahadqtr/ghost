import "server-only";
import { resolveProvider, type VideoProviderId } from "./routing";
import { floraConfigured, submitFloraRun, getFloraRun } from "./flora";
import { submitReelJob, getReelJob } from "@/lib/social/higgsfield";
import { REEL_NEGATIVE_PROMPT } from "@/lib/social/reel-request-compute";

// Unified product-video entry point. Routes to FLORA (primary for product
// videos) or Higgsfield (talking/UGC, or the fallback when FLORA isn't set up
// yet). The requestId returned is tagged with the provider so polling routes
// back to the right engine — and a bare id is treated as Higgsfield for
// backward-compatibility with clips queued before this router existed.

export interface SubmitResult { ok: boolean; provider?: VideoProviderId; requestId?: string; error?: string; note?: string; }

export async function submitProductVideo(opts: { imageUrl: string; prompt: string; kind?: string | null }): Promise<SubmitResult> {
  let provider = resolveProvider(opts.kind, process.env.VIDEO_PROVIDER);
  let note: string | undefined;
  // Product kinds prefer FLORA; if it isn't configured yet, fall back to
  // Higgsfield so generation still works (and say so).
  if (provider === "flora" && !floraConfigured()) {
    provider = "higgsfield";
    note = "FLORA غير مهيأ بعد — استُخدم Higgsfield مؤقتًا. أضف FLORA_API_KEY و FLORA_TECHNIQUE_SLUG لتفعيل محرك المنتجات.";
  }
  if (provider === "flora") {
    const r = await submitFloraRun(opts.imageUrl, opts.prompt, REEL_NEGATIVE_PROMPT);
    if (!r.ok || !r.runId) return { ok: false, provider, error: r.error };
    return { ok: true, provider, requestId: `flora:${r.runId}`, note };
  }
  const r = await submitReelJob(opts.imageUrl, opts.prompt);
  if (!r.ok || !r.requestId) return { ok: false, provider, error: r.error };
  return { ok: true, provider, requestId: `hf:${r.requestId}`, note };
}

export interface PollResult { ok: boolean; status: "pending" | "completed" | "failed" | "unknown"; videoUrl?: string; error?: string; }

export async function pollProductVideo(requestId: string): Promise<PollResult> {
  const raw = String(requestId || "");
  if (raw.startsWith("flora:")) return getFloraRun(raw.slice("flora:".length));
  const id = raw.startsWith("hf:") ? raw.slice("hf:".length) : raw; // bare id = legacy Higgsfield
  return getReelJob(id);
}
