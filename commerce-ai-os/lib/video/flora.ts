import "server-only";
import { buildFloraInputs, floraStatus, firstFloraOutputUrl, parseMissingImageInputId } from "./flora-compute";
import type { FloraInputField } from "./flora-compute";

// FLORA image→video client. Runs a saved canvas "technique" by slug.
// Env-gated: FLORA_API_KEY (sk_live_…) + FLORA_TECHNIQUE_SLUG (the technique you
// build+save on the FLORA canvas, e.g. malikas-product-commercial-v1).
// Optional: FLORA_API_BASE (default https://app.flora.ai), and the technique's
// input field ids if they differ from the defaults.
// Ref: docs.flora.ai — POST /api/v1/techniques/{slug}/runs ; GET …/runs/{runId}.

function clean(v: string | undefined): string { return String(v ?? "").trim().replace(/^["']|["']$/g, "").trim(); }
function apiKey(): string { return clean(process.env.FLORA_API_KEY); }
function slug(): string { return clean(process.env.FLORA_TECHNIQUE_SLUG); }
function base(): string { return (clean(process.env.FLORA_API_BASE) || "https://app.flora.ai").replace(/\/$/, ""); }
function fieldIds() {
  return {
    image: clean(process.env.FLORA_INPUT_IMAGE_ID) || undefined,
    prompt: clean(process.env.FLORA_INPUT_PROMPT_ID) || undefined,
    negative: clean(process.env.FLORA_INPUT_NEGATIVE_ID) || undefined,
  };
}
export function floraConfigured(): boolean { return !!apiKey() && !!slug(); }

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" };
}

const pick = (o: any, ...keys: string[]): string | undefined => {
  for (const k of keys) { const v = k.split(".").reduce((a: any, p) => (a == null ? a : a[p]), o); if (v && typeof v !== "object") return String(v); }
  return undefined;
};

export interface FloraSubmit { ok: boolean; runId?: string; error?: string; }

function parseJson(t: string): any { try { return JSON.parse(t); } catch { return null; } }

/** The FLORA workspace id (ws_…) required by the asset API — env or first workspace. */
async function floraWorkspaceId(): Promise<string | null> {
  const env = clean(process.env.FLORA_WORKSPACE_ID);
  if (env) return env;
  try {
    const r = await fetch(`${base()}/api/v1/workspaces`, { headers: authHeaders(), cache: "no-store", signal: AbortSignal.timeout(15_000) });
    const t = await r.text();
    console.error("[flora:asset] workspaces", r.status, t.slice(0, 400));
    if (!r.ok) return null;
    const j = parseJson(t);
    const arr: any[] = Array.isArray(j) ? j : (Array.isArray(j?.data) ? j.data : (Array.isArray(j?.workspaces) ? j.workspaces : []));
    for (const w of arr) { const id = pick(w, "id", "workspaceId", "workspace_id"); if (id && String(id).startsWith("ws_")) return String(id); }
    return arr[0] ? (pick(arr[0], "id", "workspaceId") || null) : null;
  } catch (e: any) { console.error("[flora:asset] workspaces threw", e?.message || e); return null; }
}

/** Fetch the source image bytes (our Supabase public URL is server-side fetchable). */
async function fetchSourceImage(imageUrl: string): Promise<{ bytes: Buffer; contentType: string; filename: string } | null> {
  try {
    const r = await fetch(imageUrl, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if (!r.ok) { console.error("[flora:asset] source fetch HTTP", r.status); return null; }
    const bytes = Buffer.from(await r.arrayBuffer());
    const ct = (r.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
    return { bytes, contentType: ct, filename: `studio-product.${ext}` };
  } catch (e: any) { console.error("[flora:asset] source fetch threw", e?.message || e); return null; }
}

/**
 * Upload an image to FLORA and return a FLORA-hosted URL usable as an imageUrl
 * input. FLORA rejects arbitrary external URLs at import (SSRF policy), so runs
 * driven by an external URL fail at $0 — the image must live on FLORA's storage.
 * Presigned pattern: POST /assets → PUT bytes → POST /assets/{id}/complete →
 * GET /assets/{id}. Endpoint is undocumented, so responses are parsed defensively
 * and each step is logged; returns null on any failure (caller falls back).
 */
export async function uploadFloraAsset(imageUrl: string): Promise<string | null> {
  const img = await fetchSourceImage(imageUrl);
  if (!img) return null;
  try {
    const workspaceId = await floraWorkspaceId();
    // 1) initiate a signed-url upload (FLORA rejects non-allowlisted source URLs,
    // so we upload the bytes ourselves). workspace_id (ws_…) is required.
    const initBody = {
      source: "signed-url", workspace_id: workspaceId, workspaceId,
      filename: img.filename, name: img.filename, fileName: img.filename,
      contentType: img.contentType, mimeType: img.contentType, mimetype: img.contentType,
      size: img.bytes.length, byteSize: img.bytes.length, fileSize: img.bytes.length, type: "image",
    };
    const initR = await fetch(`${base()}/api/v1/assets`, {
      method: "POST", headers: authHeaders(), body: JSON.stringify(initBody),
      cache: "no-store", signal: AbortSignal.timeout(30_000),
    });
    const initT = await initR.text();
    console.error("[flora:asset] init", initR.status, initT.slice(0, 600));
    if (!initR.ok) return null;
    const ij = parseJson(initT);
    const assetId = pick(ij, "id", "assetId", "asset_id", "data.id", "data.assetId", "asset.id");
    const uploadUrl = pick(ij, "uploadUrl", "upload_url", "presignedUrl", "signedUrl", "url", "data.uploadUrl", "data.url");
    const uploadMethod = (pick(ij, "method", "uploadMethod", "data.method") || "PUT").toUpperCase();
    if (!assetId) { console.error("[flora:asset] no assetId in init"); return null; }

    // 2) upload the bytes to the presigned destination (if one was returned).
    if (uploadUrl) {
      const putR = await fetch(uploadUrl, {
        method: uploadMethod === "POST" ? "POST" : "PUT",
        headers: { "Content-Type": img.contentType }, body: img.bytes as any,
        signal: AbortSignal.timeout(60_000),
      });
      console.error("[flora:asset] upload", putR.status);
    }

    // 3) complete
    const compR = await fetch(`${base()}/api/v1/assets/${encodeURIComponent(assetId)}/complete`, {
      method: "POST", headers: authHeaders(), body: JSON.stringify({}),
      cache: "no-store", signal: AbortSignal.timeout(30_000),
    });
    const compT = await compR.text();
    console.error("[flora:asset] complete", compR.status, compT.slice(0, 600));

    // 4) resolve the hosted URL (from complete, else GET the asset).
    const urlKeys = ["url", "publicUrl", "downloadUrl", "cdnUrl", "signedUrl", "src", "asset.url", "data.url", "data.publicUrl", "data.downloadUrl"];
    let finalUrl = pick(parseJson(compT), ...urlKeys);
    if (!finalUrl) {
      const getR = await fetch(`${base()}/api/v1/assets/${encodeURIComponent(assetId)}`, {
        headers: authHeaders(), cache: "no-store", signal: AbortSignal.timeout(20_000),
      });
      const getT = await getR.text();
      console.error("[flora:asset] get", getR.status, getT.slice(0, 600));
      finalUrl = pick(parseJson(getT), ...urlKeys);
    }
    console.error("[flora:asset] finalUrl", finalUrl || "(none)");
    return finalUrl || null;
  } catch (e: any) { console.error("[flora:asset] threw", e?.message || e); return null; }
}

/** POST a technique run with the given inputs; returns the raw response + parsed body. */
async function postFloraRun(inputs: FloraInputField[]): Promise<{ r: Response; body: string; j: any }> {
  const r = await fetch(`${base()}/api/v1/techniques/${encodeURIComponent(slug())}/runs`, {
    method: "POST", headers: authHeaders(), body: JSON.stringify({ inputs, mode: "async" }),
    cache: "no-store", signal: AbortSignal.timeout(30_000),
  });
  const body = await r.text();
  const j = ((): any => { try { return JSON.parse(body); } catch { return null; } })();
  return { r, body, j };
}

/** Submit a technique run for an image→video product clip. */
export async function submitFloraRun(imageUrl: string, prompt: string, negativePrompt?: string): Promise<FloraSubmit> {
  if (!floraConfigured()) return { ok: false, error: "FLORA غير مهيأ — أضف FLORA_API_KEY و FLORA_TECHNIQUE_SLUG في Vercel." };
  try {
    // Only send a prompt/negative input when the technique actually declares one
    // (opt-in via env). A technique whose only input is the product image would
    // reject unknown inputs, so image-only is the safe default.
    const sendPrompt = clean(process.env.FLORA_SEND_PROMPT).toLowerCase() === "true";
    const sendNeg = clean(process.env.FLORA_SEND_NEGATIVE).toLowerCase() === "true";
    // FLORA rejects external image URLs at import, so host the image on FLORA
    // first and pass that URL. On upload failure, fall back to the original URL
    // (no regression). Disable with FLORA_UPLOAD_IMAGE=false.
    let effectiveImageUrl = imageUrl;
    if (clean(process.env.FLORA_UPLOAD_IMAGE).toLowerCase() !== "false") {
      const hosted = await uploadFloraAsset(imageUrl);
      if (hosted) effectiveImageUrl = hosted;
      else console.error("[flora] asset upload failed — falling back to source URL");
    }
    const build = (imageId?: string): FloraInputField[] => buildFloraInputs({
      imageUrl: effectiveImageUrl,
      prompt: sendPrompt ? prompt : null,
      negativePrompt: sendNeg ? negativePrompt : null,
      fieldIds: { ...fieldIds(), ...(imageId ? { image: imageId } : {}) },
    });
    let { r, body, j } = await postFloraRun(build());
    // Self-heal the image input id: FLORA auto-generates it from the canvas node
    // and it changes every time the technique is rebuilt. If the run is rejected
    // for a missing image input, read the required id from the error and retry
    // once — so we never depend on a hard-coded FLORA_INPUT_IMAGE_ID.
    if (!r.ok && r.status === 400) {
      const wantId = parseMissingImageInputId(body);
      if (wantId) ({ r, body, j } = await postFloraRun(build(wantId)));
    }
    if (!r.ok) { console.error("[flora] submit HTTP", r.status, body.slice(0, 400)); return { ok: false, error: `FLORA HTTP ${r.status} — ${body.slice(0, 200)}` }; }
    const runId = pick(j, "runId", "run_id", "id", "data.runId", "data.id");
    if (!runId) return { ok: false, error: `FLORA لم يرجع runId — ${body.slice(0, 200)}` };
    return { ok: true, runId };
  } catch (e: any) {
    console.error("[flora] submit threw", e?.message || e);
    return { ok: false, error: e?.message || "فشل إرسال طلب FLORA." };
  }
}

export interface FloraStatusResult { ok: boolean; status: "pending" | "completed" | "failed" | "unknown"; videoUrl?: string; error?: string; }

/** Poll a technique run; when done, videoUrl is the output mp4. */
export async function getFloraRun(runId: string): Promise<FloraStatusResult> {
  if (!floraConfigured()) return { ok: false, status: "failed", error: "FLORA غير مهيأ." };
  try {
    const r = await fetch(`${base()}/api/v1/techniques/${encodeURIComponent(slug())}/runs/${encodeURIComponent(runId)}`, {
      headers: authHeaders(), cache: "no-store", signal: AbortSignal.timeout(20_000),
    });
    const body = await r.text();
    const j = ((): any => { try { return JSON.parse(body); } catch { return null; } })();
    if (!r.ok) return { ok: false, status: "failed", error: `FLORA HTTP ${r.status} — ${body.slice(0, 200)}` };
    const url = firstFloraOutputUrl(j?.outputs);
    const status = floraStatus(pick(j, "status", "state"), !!url);
    return { ok: true, status, videoUrl: url, error: status === "failed" ? (pick(j, "error", "error_message") || "فشل توليد FLORA") : undefined };
  } catch (e: any) {
    return { ok: false, status: "unknown", error: e?.message };
  }
}
