import "server-only";
import { buildComposeSource, type ComposeInput } from "./compose-compute";

// Creatomate render: layer the product video + Arabic voiceover + logo + CTA
// into the final reel. Env-gated: CREATOMATE_API_KEY (+ MALIKA_LOGO_URL for the
// brand mark). Async — submit returns a render id/url; poll until it succeeds.

const BASE = "https://api.creatomate.com/v1";
function apiKey(): string { return String(process.env.CREATOMATE_API_KEY ?? "").trim().replace(/^["']|["']$/g, ""); }
export function composeConfigured(): boolean { return !!apiKey(); }
/**
 * Read a URL env var defensively: trim, strip quotes, tolerate an accidental
 * "KEY = value" paste, and only accept a real http(s) URL (else "" so the
 * render skips that layer instead of failing on an invalid URL).
 */
function cleanUrl(v: string | undefined): string {
  let s = String(v ?? "").trim().replace(/^["']|["']$/g, "").trim();
  const m = /^[A-Za-z0-9_]+\s*=\s*(\S.*)$/.exec(s); // "MALIKA_LOGO_URL = https://…"
  if (m) s = m[1].trim().replace(/^["']|["']$/g, "").trim();
  return /^https?:\/\//i.test(s) ? s : "";
}
export function malikaLogoUrl(): string { return cleanUrl(process.env.MALIKA_LOGO_URL); }
export function reelsMusicUrl(): string { return cleanUrl(process.env.REELS_MUSIC_URL); }

const pick = (o: any, ...keys: string[]): string | undefined => {
  for (const k of keys) { const v = o?.[k]; if (v && typeof v !== "object") return String(v); }
  return undefined;
};

export interface ComposeSubmit { ok: boolean; renderId?: string; url?: string; error?: string; }

/** Submit a compose render. May return a final url immediately, else a renderId to poll. */
export async function submitCompose(opts: ComposeInput): Promise<ComposeSubmit> {
  if (!composeConfigured()) return { ok: false, error: "Creatomate غير مهيأ (CREATOMATE_API_KEY)." };
  try {
    const source = buildComposeSource({
      ...opts,
      logoUrl: opts.logoUrl ?? (malikaLogoUrl() || null),
      musicUrl: opts.musicUrl ?? (reelsMusicUrl() || null),
    });
    const r = await fetch(`${BASE}/renders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ source }),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await r.text();
    const j = ((): any => { try { return JSON.parse(body); } catch { return null; } })();
    if (!r.ok) { console.error("[compose] submit HTTP", r.status, body.slice(0, 400)); return { ok: false, error: `Creatomate HTTP ${r.status} — ${body.slice(0, 200)}` }; }
    const one = Array.isArray(j) ? j[0] : j;
    const url = pick(one, "url");
    const id = pick(one, "id");
    const status = (pick(one, "status") || "").toLowerCase();
    if (url && (status === "succeeded" || status === "")) return { ok: true, url };
    if (id) return { ok: true, renderId: id };
    return { ok: false, error: `رد Creatomate غير متوقع: ${body.slice(0, 200)}` };
  } catch (e: any) {
    console.error("[compose] threw", e?.message || e);
    return { ok: false, error: e?.message || "فشل إرسال التركيب." };
  }
}

export interface ComposeStatus { ok: boolean; status: "pending" | "completed" | "failed" | "unknown"; url?: string; error?: string; }

/** Poll a compose render until the final mp4 is ready. */
export async function getCompose(renderId: string): Promise<ComposeStatus> {
  if (!composeConfigured()) return { ok: false, status: "failed", error: "Creatomate غير مهيأ." };
  try {
    const r = await fetch(`${BASE}/renders/${encodeURIComponent(renderId)}`, {
      headers: { Authorization: `Bearer ${apiKey()}` }, cache: "no-store", signal: AbortSignal.timeout(20_000),
    });
    const body = await r.text();
    const j = ((): any => { try { return JSON.parse(body); } catch { return null; } })();
    if (!r.ok) return { ok: false, status: "failed", error: `HTTP ${r.status} — ${body.slice(0, 200)}` };
    const raw = (pick(j, "status") || "").toLowerCase();
    const url = pick(j, "url");
    const status: ComposeStatus["status"] = raw.includes("succeed") || (url && !raw.includes("fail"))
      ? "completed"
      : raw.includes("fail") || raw.includes("error") ? "failed"
      : "pending";
    return { ok: true, status, url, error: status === "failed" ? (pick(j, "error_message", "error") || "فشل التركيب") : undefined };
  } catch (e: any) {
    return { ok: false, status: "unknown", error: e?.message };
  }
}
