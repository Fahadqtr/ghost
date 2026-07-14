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
    const build = (imageId?: string): FloraInputField[] => buildFloraInputs({
      imageUrl,
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
