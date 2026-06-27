// Malak's faster live browser for NON-audio sites (shopping, general browsing).
// Browserbase streams a lighter, snappier interactive view than Hyperbeam's full
// WebRTC video — but with NO audio, so YouTube/music still route to Hyperbeam.
//
// We drive it entirely over REST + raw CDP (Node's global WebSocket), so there's
// no playwright dependency to bundle. Env-gated; if unset, callers fall back to
// Hyperbeam.
import { assertSafeBrowseUrl } from "@/lib/net/safeImage";

const BB_API = "https://api.browserbase.com/v1";
const TIMEOUT_MS = 20_000;

function key(): string { return (process.env.BROWSERBASE_API_KEY || "").trim(); }
function projectId(): string { return (process.env.BROWSERBASE_PROJECT_ID || "").trim(); }
export function browserbaseConfigured(): boolean { return Boolean(key() && projectId()); }

export interface BbSession { ok: boolean; liveUrl?: string; sessionId?: string; connectUrl?: string; error?: string }

async function api(path: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${BB_API}${path}`, {
      ...init,
      headers: { "X-BB-API-Key": key(), "Content-Type": "application/json", ...(init.headers || {}) },
      signal: ctrl.signal,
    });
  } finally { clearTimeout(t); }
}

/** Open a Browserbase session, navigate to startUrl, return its live-view URL. */
export async function openBrowserbase(startUrl?: string, viewport?: { w?: number; h?: number }): Promise<BbSession> {
  if (!browserbaseConfigured()) return { ok: false, error: "خدمة المتصفح السريع غير مهيأة (BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID)." };

  let start: string | undefined;
  if (startUrl && startUrl.trim()) {
    try { start = assertSafeBrowseUrl(startUrl); }
    catch (e: any) { return { ok: false, error: e?.message || "رابط غير صالح." }; }
  }
  const even = (n: number) => Math.round(n) - (Math.round(n) % 2);
  const width = viewport?.w && viewport.w > 0 ? even(Math.max(360, Math.min(1920, viewport.w))) : 1280;
  const height = viewport?.h && viewport.h > 0 ? even(Math.max(600, Math.min(1080, viewport.h))) : 800;

  try {
    const cRes = await api("/sessions", {
      method: "POST",
      body: JSON.stringify({ projectId: projectId(), browserSettings: { viewport: { width, height } }, keepAlive: false }),
    });
    if (!cRes.ok) {
      const body = await cRes.text().catch(() => "");
      return { ok: false, error: `تعذّر إنشاء جلسة المتصفح (Browserbase HTTP ${cRes.status}${body ? `: ${body.slice(0, 120)}` : ""}).` };
    }
    const session: any = await cRes.json();
    const sessionId = session?.id;
    const connectUrl = session?.connectUrl;
    if (!sessionId || !connectUrl) return { ok: false, error: "رد Browserbase ناقص (id/connectUrl)." };

    if (start) { try { await cdpNavigate(connectUrl, start); } catch { /* best-effort; user can navigate in the view */ } }

    const dRes = await api(`/sessions/${sessionId}/debug`, { method: "GET" });
    if (!dRes.ok) return { ok: false, error: `تعذّر جلب العرض الحي (Browserbase HTTP ${dRes.status}).`, sessionId, connectUrl };
    const dbg: any = await dRes.json();
    const liveUrl = dbg?.debuggerFullscreenUrl || dbg?.debuggerUrl;
    if (!liveUrl) return { ok: false, error: "رد Browserbase بدون رابط عرض حي.", sessionId, connectUrl };
    return { ok: true, liveUrl, sessionId, connectUrl };
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "انتهت مهلة فتح المتصفح السريع." : "تعذّر الاتصال بخدمة المتصفح السريع.";
    return { ok: false, error: msg };
  }
}

/** Navigate a session's page to a URL via raw CDP (no Playwright dependency). */
export async function cdpNavigate(connectUrl: string, rawUrl: string): Promise<void> {
  const url = assertSafeBrowseUrl(rawUrl);
  // Node 22 ships a global WebSocket.
  const ws: any = new (globalThis as any).WebSocket(connectUrl);
  let nextId = 1;
  const pending = new Map<number, (m: any) => void>();
  const send = (method: string, params?: any, sessionId?: string) =>
    new Promise<any>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params: params || {}, ...(sessionId ? { sessionId } : {}) }));
    });

  try {
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("ws timeout")), 10_000);
      ws.onopen = () => { clearTimeout(to); resolve(); };
      ws.onerror = () => { clearTimeout(to); reject(new Error("ws error")); };
    });
    ws.onmessage = (ev: any) => {
      try {
        const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
      } catch { /* ignore */ }
    };
    const targets = await send("Target.getTargets");
    const page = (targets?.result?.targetInfos || []).find((t: any) => t.type === "page");
    if (!page) return;
    const attached = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    const sessionId = attached?.result?.sessionId;
    await send("Page.navigate", { url }, sessionId);
    await new Promise((r) => setTimeout(r, 600));
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }
}
