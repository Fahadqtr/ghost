import "server-only";

// Higgsfield image-to-video — turns a product photo into a short vertical reel
// clip. Env-gated: needs HIGGSFIELD_API_KEY (Key ID) + HIGGSFIELD_API_SECRET.
// The model is chosen by HIGGSFIELD_VIDEO_MODEL (default "dop"; "kling" /
// "seedance" for richer motion). Async: POST the model endpoint → the response
// carries a request id / polling_url → poll /requests/{id}/status until a video
// url appears.
//
// NOTE: the exact response shapes vary across Higgsfield API versions, so the
// parsers below accept several field names and surface the raw error on
// mismatch. Note Marketing-Studio (talking-avatar) reels are NOT in the public
// API — those come in via the manual paste-URL flow.

const BASE = (process.env.HIGGSFIELD_API_BASE || "https://platform.higgsfield.ai").replace(/\/$/, "");

function clean(v: string | undefined): string {
  return String(v ?? "").trim().replace(/^["']|["']$/g, "").trim();
}
function creds(): { id: string; secret: string } | null {
  const id = clean(process.env.HIGGSFIELD_API_KEY);
  const secret = clean(process.env.HIGGSFIELD_API_SECRET);
  return id && secret ? { id, secret } : null;
}
export function higgsfieldConfigured(): boolean {
  return creds() !== null;
}
// Higgsfield auth. The public REST docs use `Authorization: Key <id>:<secret>`;
// the SDK uses `hf-api-key` + `hf-secret`. Sending all three is harmless and
// works across both surfaces (the proven DoP call succeeded with the SDK pair).
function authHeaders(): Record<string, string> {
  const c = creds();
  return {
    Authorization: `Key ${c?.id ?? ""}:${c?.secret ?? ""}`,
    "hf-api-key": c?.id ?? "",
    "hf-secret": c?.secret ?? "",
    "User-Agent": "higgsfield-server-js/2.0",
  };
}

// Video model registry. The auto-generate button uses HIGGSFIELD_VIDEO_MODEL
// (default "dop" — the proven, cheap camera-motion model). "kling"/"seedance"
// give richer motion (and possibly native audio) via the documented path-based
// endpoints. The manual Marketing-Studio paste flow is unaffected by this.
interface VideoModel { path: string; body: (imageUrl: string, prompt: string) => unknown; }
const DURATION = Math.max(3, Math.min(15, Number(process.env.HIGGSFIELD_VIDEO_SECONDS) || 5));
const VIDEO_MODELS: Record<string, VideoModel> = {
  // Proven surface: /v1/image2video/dop with the options under a `params` wrapper.
  dop: {
    path: "v1/image2video/dop",
    body: (imageUrl, prompt) => ({
      params: { model: "dop-turbo", prompt, aspect_ratio: "9:16", input_images: [{ type: "image_url", image_url: imageUrl }] },
    }),
  },
  // Documented path-based endpoints with a flat body (image_url/prompt/duration).
  kling: {
    path: "kling-video/v2.1/pro/image-to-video",
    body: (imageUrl, prompt) => ({ image_url: imageUrl, prompt, duration: DURATION, aspect_ratio: "9:16" }),
  },
  seedance: {
    path: "bytedance/seedance/v1/pro/image-to-video",
    body: (imageUrl, prompt) => ({ image_url: imageUrl, prompt, duration: DURATION, aspect_ratio: "9:16" }),
  },
};
function selectedModel(): { key: string; model: VideoModel } {
  const key = clean(process.env.HIGGSFIELD_VIDEO_MODEL).toLowerCase() || "dop";
  return { key, model: VIDEO_MODELS[key] ?? VIDEO_MODELS.dop };
}

const pick = (o: any, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = k.split(".").reduce((a: any, p) => (a == null ? a : a[p]), o);
    if (v && typeof v !== "object") return String(v);
  }
  return undefined;
};

// Build a readable error string from an API error body. Higgsfield/FastAPI
// return `detail` as a string, an object, or an array of {loc,msg,type} — the
// naive String() of those becomes "[object Object]", hiding the real reason.
function errText(j: any, status: number): string {
  const d = j?.detail ?? j?.error ?? j?.message ?? j;
  const one = (x: any): string =>
    x == null ? "" : typeof x === "string" ? x : (x.msg || x.message || x.detail || JSON.stringify(x));
  let msg = "";
  if (Array.isArray(d)) msg = d.map(one).filter(Boolean).join(" · ");
  else msg = one(d);
  msg = (msg || "").trim();
  if (!msg || msg === "{}") msg = j ? JSON.stringify(j).slice(0, 300) : "";
  return `HTTP ${status}${msg ? ` — ${msg}` : ""}`;
}

export interface HfSubmit { ok: boolean; requestId?: string; error?: string; }

/** Submit an image→video job. Returns a request id to poll. */
export async function submitReelJob(imageUrl: string, prompt: string): Promise<HfSubmit> {
  if (!higgsfieldConfigured()) return { ok: false, error: "Higgsfield غير مهيأ (HIGGSFIELD_API_KEY / HIGGSFIELD_API_SECRET)." };
  const { key, model } = selectedModel();
  try {
    const r = await fetch(`${BASE}/${model.path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(model.body(imageUrl, prompt)),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await r.text();
    const j = ((): any => { try { return JSON.parse(body); } catch { return null; } })();
    if (!r.ok) {
      console.error(`[higgsfield] submit(${key}) HTTP ${r.status}:`, body.slice(0, 500));
      return { ok: false, error: j ? errText(j, r.status) : `HTTP ${r.status} — ${body.slice(0, 300)}` };
    }
    const id = pick(j, "id", "request_id", "requestId", "request.id", "data.id", "data.request_id");
    if (!id) {
      console.error("[higgsfield] submit ok but no id. body:", body.slice(0, 500));
      return { ok: false, error: `ما رجع request_id من Higgsfield — الرد: ${body.slice(0, 300)}` };
    }
    // Prefer the server-provided polling URL when present; getReelJob accepts a
    // full URL or a bare id. This carries the poll target through the existing
    // single-string channel without threading a second value to the client.
    const pollUrl = pick(j, "polling_url", "poll_url", "data.polling_url", "links.status");
    return { ok: true, requestId: pollUrl || id };
  } catch (e: any) {
    console.error("[higgsfield] submit threw:", e?.message || e);
    return { ok: false, error: e?.message || "فشل إرسال طلب التوليد." };
  }
}

export interface HfStatus { ok: boolean; status: "pending" | "completed" | "failed" | "unknown"; videoUrl?: string; error?: string; }

/** Poll a job. `ref` is either a full polling URL (returned by submit) or a
 *  bare request id. When done, videoUrl is the public mp4. */
export async function getReelJob(ref: string): Promise<HfStatus> {
  if (!higgsfieldConfigured()) return { ok: false, status: "failed", error: "Higgsfield غير مهيأ." };
  try {
    const statusUrl = /^https?:\/\//i.test(ref)
      ? ref
      : `${BASE}/requests/${encodeURIComponent(ref)}/status`;
    const r = await fetch(statusUrl, {
      headers: authHeaders(), cache: "no-store", signal: AbortSignal.timeout(20_000),
    });
    const body = await r.text();
    const j = ((): any => { try { return JSON.parse(body); } catch { return null; } })();
    if (!r.ok) {
      console.error(`[higgsfield] status HTTP ${r.status}:`, body.slice(0, 500));
      return { ok: false, status: "failed", error: j ? errText(j, r.status) : `HTTP ${r.status} — ${body.slice(0, 300)}` };
    }
    const url = pick(j, "video.url", "results.raw.url", "jobs.0.results.raw.url", "result_url", "output.url");
    const raw = (pick(j, "status", "state") || "").toLowerCase();
    const status: HfStatus["status"] = url || raw.includes("complet") || raw.includes("success")
      ? "completed"
      : raw.includes("fail") || raw.includes("error") ? "failed"
      : "pending";
    return { ok: true, status, videoUrl: url, error: status === "failed" ? (errText(j, r.status) || "فشل التوليد عند Higgsfield") : undefined };
  } catch (e: any) {
    return { ok: false, status: "unknown", error: e?.message };
  }
}
