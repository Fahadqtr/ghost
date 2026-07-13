import "server-only";

// Higgsfield image-to-video (DoP) — turns a product photo into a short vertical
// reel clip. Env-gated: needs HIGGSFIELD_API_KEY (Key ID) + HIGGSFIELD_API_SECRET.
// Auth is two headers per the official SDK: `hf-api-key` + `hf-secret`. Async:
// POST /v1/image2video/dop with the options under a `params` wrapper → the
// response carries a request id / polling_url → poll until a video url appears.
//
// NOTE: the exact response shapes vary across Higgsfield API versions, so the
// parsers below accept several field names and surface the raw error on
// mismatch.

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
// Higgsfield auth is two separate headers (per the official SDK): the API key
// id and the secret — NOT a combined Authorization bearer.
function authHeaders(): Record<string, string> {
  const c = creds();
  return {
    "hf-api-key": c?.id ?? "",
    "hf-secret": c?.secret ?? "",
    "User-Agent": "higgsfield-server-js/2.0",
  };
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
  try {
    const r = await fetch(`${BASE}/v1/image2video/dop`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      // The DoP endpoint wraps the generation options in a `params` object.
      body: JSON.stringify({
        params: {
          model: "dop-turbo",
          prompt,
          aspect_ratio: "9:16",
          input_images: [{ type: "image_url", image_url: imageUrl }],
        },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await r.text();
    const j = ((): any => { try { return JSON.parse(body); } catch { return null; } })();
    if (!r.ok) return { ok: false, error: j ? errText(j, r.status) : `HTTP ${r.status} — ${body.slice(0, 300)}` };
    const id = pick(j, "id", "request_id", "requestId", "request.id", "data.id", "data.request_id");
    if (!id) return { ok: false, error: `ما رجع request_id من Higgsfield — الرد: ${body.slice(0, 300)}` };
    // Prefer the server-provided polling URL when present; getReelJob accepts a
    // full URL or a bare id. This carries the poll target through the existing
    // single-string channel without threading a second value to the client.
    const pollUrl = pick(j, "polling_url", "poll_url", "data.polling_url", "links.status");
    return { ok: true, requestId: pollUrl || id };
  } catch (e: any) {
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
    if (!r.ok) return { ok: false, status: "failed", error: j ? errText(j, r.status) : `HTTP ${r.status} — ${body.slice(0, 300)}` };
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
