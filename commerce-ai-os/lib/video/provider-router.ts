import "server-only";
import { resolveProvider, type VideoProviderId } from "./routing";
import { getProvider, FloraProvider } from "./providers";
import { REEL_NEGATIVE_PROMPT } from "@/lib/social/reel-request-compute";

// Unified product-video entry point. Routes to a provider from the registry
// (FLORA primary for product videos; Higgsfield for talking/UGC or as the
// fallback until FLORA is configured). The requestId is tagged with the provider
// id so polling routes back to the right engine; a bare/`hf:` id is treated as
// Higgsfield for backward-compatibility with clips queued before this router.

export interface SubmitResult { ok: boolean; provider?: VideoProviderId; requestId?: string; error?: string; note?: string }

export async function submitProductVideo(opts: { imageUrl: string; prompt: string; kind?: string | null }): Promise<SubmitResult> {
  let provider = getProvider(resolveProvider(opts.kind, process.env.VIDEO_PROVIDER));
  let note: string | undefined;
  // Product kinds prefer FLORA; if it isn't set up yet, fall back to Higgsfield.
  if (provider.id === "flora" && !FloraProvider.configured()) {
    provider = getProvider("higgsfield");
    note = "FLORA غير مهيأ بعد — استُخدم Higgsfield مؤقتًا. أضف FLORA_API_KEY و FLORA_TECHNIQUE_SLUG لتفعيل محرك المنتجات.";
  }
  const r = await provider.submit({ imageUrl: opts.imageUrl, prompt: opts.prompt, negativePrompt: REEL_NEGATIVE_PROMPT });
  if (!r.ok || !r.runId) return { ok: false, provider: provider.id, error: r.error };
  return { ok: true, provider: provider.id, requestId: `${provider.id}:${r.runId}`, note };
}

export interface PollResult { ok: boolean; status: "pending" | "completed" | "failed" | "unknown"; videoUrl?: string; error?: string }

export async function pollProductVideo(requestId: string): Promise<PollResult> {
  const raw = String(requestId || "");
  const i = raw.indexOf(":");
  const tag = i >= 0 ? raw.slice(0, i) : "";
  const runId = i >= 0 ? raw.slice(i + 1) : raw;
  const id: VideoProviderId = tag === "flora" ? "flora" : "higgsfield"; // "hf"/bare = legacy Higgsfield
  return getProvider(id).poll(runId);
}
