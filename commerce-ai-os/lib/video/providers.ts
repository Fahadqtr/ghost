import "server-only";
import type { VideoProviderId } from "./routing";
import { floraConfigured, submitFloraRun, getFloraRun } from "./flora";
import { higgsfieldConfigured, submitReelJob, getReelJob } from "@/lib/social/higgsfield";

// Pluggable video-provider registry. Each provider wraps its own low-level
// client behind one small interface, so adding a new engine later is just one
// more object in VIDEO_PROVIDERS — the router and studio never change.

export type VideoStatus = "pending" | "completed" | "failed" | "unknown";

export interface ProviderSubmit { ok: boolean; runId?: string; error?: string }
export interface ProviderPoll { ok: boolean; status: VideoStatus; videoUrl?: string; error?: string }

export interface VideoProvider {
  id: VideoProviderId;
  labelAr: string;
  labelEn: string;
  configured(): boolean;
  submit(opts: { imageUrl: string; prompt: string; negativePrompt?: string | null }): Promise<ProviderSubmit>;
  poll(runId: string): Promise<ProviderPoll>;
}

/** FLORA — primary engine for product videos (image→video technique). */
export const FloraProvider: VideoProvider = {
  id: "flora",
  labelAr: "فلورا (FLORA)",
  labelEn: "FLORA",
  configured: floraConfigured,
  async submit({ imageUrl, prompt, negativePrompt }) {
    const r = await submitFloraRun(imageUrl, prompt, negativePrompt ?? undefined);
    return { ok: r.ok, runId: r.runId, error: r.error };
  },
  poll: getFloraRun,
};

/** Higgsfield — talking/UGC reels, and the fallback until FLORA is configured. */
export const HiggsfieldProvider: VideoProvider = {
  id: "higgsfield",
  labelAr: "هيقسفيلد (Higgsfield)",
  labelEn: "Higgsfield",
  configured: higgsfieldConfigured,
  async submit({ imageUrl, prompt }) {
    const r = await submitReelJob(imageUrl, prompt);
    return { ok: r.ok, runId: r.requestId, error: r.error };
  },
  async poll(runId) {
    const s = await getReelJob(runId);
    return { ok: s.ok, status: s.status, videoUrl: s.videoUrl, error: s.error };
  },
};

export const VIDEO_PROVIDERS: VideoProvider[] = [FloraProvider, HiggsfieldProvider];

export function getProvider(id: VideoProviderId): VideoProvider {
  return VIDEO_PROVIDERS.find((p) => p.id === id) ?? HiggsfieldProvider;
}
