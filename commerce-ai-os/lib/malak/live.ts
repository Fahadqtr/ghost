// Malak's LIVE browser. Unlike browse_web/browser_action (server-side
// screenshots, no audio), this spins up a Hyperbeam virtual-browser session and
// returns an embeddable URL. The client drops it into an <iframe> so the user
// gets a real, interactive browser WITH AUDIO streamed to their device (WebRTC),
// which a CDP screenshot/screencast pipeline can't do.
//
// Env-gated: set HYPERBEAM_API_KEY (https://hyperbeam.com — free tier available).
// Without it, callers degrade gracefully to a clear "not configured" message.
import { assertSafeBrowseUrl } from "@/lib/net/safeImage";

const HB_ENGINE = "https://engine.hyperbeam.com/v0/vm";
const TIMEOUT_MS = 20_000;

export function liveConfigured(): boolean {
  return Boolean((process.env.HYPERBEAM_API_KEY || "").trim());
}

export interface LiveSession {
  ok: boolean;
  embedUrl?: string;
  sessionId?: string;
  error?: string;
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
    return { ok: true, embedUrl, sessionId: json?.session_id || json?.sessionId };
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "انتهت مهلة إنشاء المتصفح الحي." : "تعذّر الاتصال بخدمة المتصفح الحي.";
    return { ok: false, error: msg };
  } finally {
    clearTimeout(t);
  }
}
