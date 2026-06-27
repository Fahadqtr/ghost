// Malak's LIVE browser. Unlike browse_web/browser_action (server-side
// screenshots, no audio), this spins up a Hyperbeam virtual-browser session and
// returns an embeddable URL. The client drops it into an <iframe> so the user
// gets a real, interactive browser WITH AUDIO streamed to their device (WebRTC),
// which a CDP screenshot/screencast pipeline can't do.
//
// Env-gated: set HYPERBEAM_API_KEY (https://hyperbeam.com — free tier available).
// Without it, callers degrade gracefully to a clear "not configured" message.
import crypto from "node:crypto";
import { assertSafeBrowseUrl } from "@/lib/net/safeImage";

const HB_ENGINE = "https://engine.hyperbeam.com/v0/vm";
const TIMEOUT_MS = 20_000;
export const LIVE_TTL_SEC = 1800; // matches the Hyperbeam session absolute timeout

export function liveConfigured(): boolean {
  return Boolean((process.env.HYPERBEAM_API_KEY || "").trim());
}

export interface LiveSession {
  ok: boolean;
  embedUrl?: string;
  sessionId?: string;
  adminToken?: string;
  error?: string;
}

// ---- Persisted session (signed cookie) -------------------------------------
// We keep ONE live session per user across turns so a login the user performs
// in the window survives. The admin token never reaches the client — it lives
// only inside this HMAC-signed cookie value (httpOnly on the response).
export interface LiveSessionData { sid: string; embedUrl: string; adminToken: string; ts: number }

function secret(): string {
  const s = process.env.MALAK_SIGNING_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!s) throw new Error("Missing signing secret (set MALAK_SIGNING_SECRET).");
  return s;
}
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Buffer {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return Buffer.from(t, "base64");
}
export function encodeLive(data: LiveSessionData): string {
  const payload = b64url(Buffer.from(JSON.stringify(data)));
  const mac = b64url(crypto.createHmac("sha256", secret()).update(payload).digest());
  return `${payload}.${mac}`;
}
export function decodeLive(token: unknown, maxAgeMs = LIVE_TTL_SEC * 1000): LiveSessionData | null {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = b64url(crypto.createHmac("sha256", secret()).update(payload).digest());
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(b64urlDecode(payload).toString("utf8")) as LiveSessionData;
    if (!d?.embedUrl || !d?.adminToken) return null;
    if (typeof d.ts !== "number" || Date.now() - d.ts > maxAgeMs) return null;
    return d;
  } catch { return null; }
}

/** Create a live virtual-browser session; returns an embeddable URL (with audio). */
export async function createLiveSession(startUrl?: string): Promise<LiveSession> {
  const key = (process.env.HYPERBEAM_API_KEY || "").trim();
  if (!key) return { ok: false, error: "خدمة المتصفح الحي غير مهيأة على الخادم (HYPERBEAM_API_KEY)." };

  let start: string | undefined;
  if (startUrl && startUrl.trim()) {
    try { start = assertSafeBrowseUrl(startUrl); }
    catch (e: any) { return { ok: false, error: e?.message || "رابط غير صالح." }; }
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(HB_ENGINE, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(start ? { start_url: start } : {}),
        width: 1280,
        height: 720,
        fps: 24,
        ublock: true,
        // Reclaim idle/forgotten sessions so the free tier isn't burned.
        timeout: { absolute: 1800, inactive: 180, warning: 30, offline: 60 },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `تعذّر إنشاء الجلسة (Hyperbeam HTTP ${res.status}${body ? `: ${body.slice(0, 140)}` : ""}).` };
    }
    const json: any = await res.json();
    const embedUrl = json?.embed_url || json?.embedUrl;
    if (!embedUrl) return { ok: false, error: "رد Hyperbeam بدون embed_url." };
    return { ok: true, embedUrl, sessionId: json?.session_id || json?.sessionId, adminToken: json?.admin_token || json?.adminToken };
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "انتهت مهلة إنشاء المتصفح الحي." : "تعذّر الاتصال بخدمة المتصفح الحي.";
    return { ok: false, error: msg };
  } finally {
    clearTimeout(t);
  }
}

// Drive an existing (logged-in) session to a new URL via Hyperbeam's
// programmatic tab control. The control base is the embed URL without its
// ?token query; auth is the admin token. Tries tabs.update (reuse the open tab)
// then tabs.create (new tab) so a search keeps the same authenticated session.
export async function liveNavigate(embedUrl: string, adminToken: string, rawUrl: string): Promise<{ ok: boolean; error?: string }> {
  let url: string;
  try { url = assertSafeBrowseUrl(rawUrl); }
  catch (e: any) { return { ok: false, error: e?.message || "رابط غير صالح." }; }

  let base: string;
  try { const u = new URL(embedUrl); base = `${u.origin}${u.pathname}`.replace(/\/$/, ""); }
  catch { return { ok: false, error: "رابط الجلسة غير صالح." }; }

  const call = async (method: string, body: any) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/${method}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const txt = await res.text().catch(() => "");
      console.log(`[malak][live] ${method} -> ${res.status}${res.ok ? "" : ` ${txt.slice(0, 120)}`}`);
      return res.ok;
    } catch (e: any) {
      console.warn(`[malak][live] ${method} failed: ${e?.message || e}`);
      return false;
    } finally { clearTimeout(t); }
  };

  // tabs.update on the first tab, else open a new active tab.
  if (await call("tabs.update", [1, { url, active: true }])) return { ok: true };
  if (await call("tabs.create", [{ url, active: true }])) return { ok: true };
  return { ok: false, error: "تعذّر توجيه الجلسة الحيّة للرابط (قد يكون الموقع يمنع ذلك)." };
}
