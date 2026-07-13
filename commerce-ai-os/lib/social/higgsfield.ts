import "server-only";

// Higgsfield image-to-video (DoP) — turns a product photo into a short vertical
// reel clip. Env-gated: needs HIGGSFIELD_API_KEY (Key ID) + HIGGSFIELD_API_SECRET.
// Auth is `Authorization: Key <KEY_ID>:<SECRET>` per the official SDK. Async:
// submit a job → poll /requests/{id}/status until it returns a video url.
//
// NOTE: the exact response shapes vary across Higgsfield API versions, so the
// parsers below accept several field names and surface the raw error on
// mismatch — the first live call confirms the contract.

const BASE = (process.env.HIGGSFIELD_API_BASE || "https://platform.higgsfield.ai").replace(/\/$/, "");

function clean(v: string | undefined): string {
  return String(v ?? "").trim().replace(/^["']|["']$/g, "").trim();
}
function creds(): string | null {
  const id = clean(process.env.HIGGSFIELD_API_KEY);
  const secret = clean(process.env.HIGGSFIELD_API_SECRET);
  return id && secret ? `${id}:${secret}` : null;
}
export function higgsfieldConfigured(): boolean {
  return creds() !== null;
}
function authHeaders(): Record<string, string> {
  return { Authorization: `Key ${creds()}`, "User-Agent": "higgsfield-server-js/2.0" };
}

const pick = (o: any, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = k.split(".").reduce((a: any, p) => (a == null ? a : a[p]), o);
    if (v) return String(v);
  }
  return undefined;
};

export interface HfSubmit { ok: boolean; requestId?: string; error?: string; }

/** Submit an image→video job. Returns a request id to poll. */
export async function submitReelJob(imageUrl: string, prompt: string): Promise<HfSubmit> {
  if (!higgsfieldConfigured()) return { ok: false, error: "Higgsfield غير مهيأ (HIGGSFIELD_API_KEY / HIGGSFIELD_API_SECRET)." };
  try {
    const r = await fetch(`${BASE}/v1/image2video/dop`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        model: "dop-turbo",
        prompt,
        aspect_ratio: "9:16",
        input_images: [{ type: "image_url", image_url: imageUrl }],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await r.json().catch(() => null)) as any;
    if (!r.ok) return { ok: false, error: pick(j, "detail", "error", "message") || `HTTP ${r.status}` };
    const id = pick(j, "id", "request_id", "requestId", "request.id", "data.id");
    if (!id) return { ok: false, error: "ما رجع request_id من Higgsfield." };
    return { ok: true, requestId: id };
  } catch (e: any) {
    return { ok: false, error: e?.message || "فشل إرسال طلب التوليد." };
  }
}

export interface HfStatus { ok: boolean; status: "pending" | "completed" | "failed" | "unknown"; videoUrl?: string; error?: string; }

/** Poll a job. When done, videoUrl is the public mp4. */
export async function getReelJob(requestId: string): Promise<HfStatus> {
  if (!higgsfieldConfigured()) return { ok: false, status: "failed", error: "Higgsfield غير مهيأ." };
  try {
    const r = await fetch(`${BASE}/requests/${encodeURIComponent(requestId)}/status`, {
      headers: authHeaders(), cache: "no-store", signal: AbortSignal.timeout(20_000),
    });
    const j = (await r.json().catch(() => null)) as any;
    if (!r.ok) return { ok: false, status: "failed", error: pick(j, "detail", "error", "message") || `HTTP ${r.status}` };
    const url = pick(j, "video.url", "results.raw.url", "jobs.0.results.raw.url", "result_url", "output.url");
    const raw = (pick(j, "status", "state") || "").toLowerCase();
    const status: HfStatus["status"] = url || raw.includes("complet") || raw.includes("success")
      ? "completed"
      : raw.includes("fail") || raw.includes("error") ? "failed"
      : "pending";
    return { ok: true, status, videoUrl: url, error: status === "failed" ? (pick(j, "error", "detail") || "فشل التوليد عند Higgsfield") : undefined };
  } catch (e: any) {
    return { ok: false, status: "unknown", error: e?.message };
  }
}
