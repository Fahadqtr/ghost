// Malak's "hands on the web". Vercel serverless functions cannot run a full
// Chromium (size + cold-start limits), so the actual browser lives in an
// EXTERNAL, Browserless-compatible service and we drive it over its REST API.
// This keeps the deploy small (zero browser binaries, zero new npm deps — just
// fetch) and the feature degrades gracefully: if the service env vars are not
// set, every call returns a clear "not configured" result instead of throwing.
//
// Configure with:
//   BROWSERLESS_URL    e.g. https://production-sfo.browserless.io  (or self-hosted)
//   BROWSERLESS_TOKEN  API token for that service
//
// Works with browserless.io (cloud or self-hosted). The same REST shape
// (/content, /screenshot) is what we depend on.
import { assertSafeBrowseUrl } from "@/lib/net/safeImage";

const TIMEOUT_MS = 25_000;

export function browserConfigured(): boolean {
  return Boolean(base() && token());
}

function base(): string {
  return (process.env.BROWSERLESS_URL || "").trim().replace(/\/+$/, "");
}
function token(): string {
  return (process.env.BROWSERLESS_TOKEN || "").trim();
}

function endpoint(path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${base()}${path}${sep}token=${encodeURIComponent(token())}`;
}

async function withTimeout<T>(p: (signal: AbortSignal) => Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await p(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

/** Strip a fetched HTML document down to a readable plain-text summary. */
function htmlToText(html: string): { title: string | null; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim().slice(0, 200) : null;
  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
  return { title, text };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(Number(n)); } catch { return ""; }
    });
}

export interface BrowseContent {
  ok: boolean;
  url: string;
  title: string | null;
  text: string;
  error?: string;
}

/** Open a URL in the remote browser and return its rendered title + text. */
export async function fetchPageContent(rawUrl: string, maxChars = 3500): Promise<BrowseContent> {
  let url: string;
  try { url = assertSafeBrowseUrl(rawUrl); }
  catch (e: any) { return { ok: false, url: rawUrl, title: null, text: "", error: e?.message || "رابط غير صالح." }; }

  if (!browserConfigured())
    return { ok: false, url, title: null, text: "", error: "خدمة المتصفح غير مهيأة على الخادم (BROWSERLESS_URL / BROWSERLESS_TOKEN)." };

  try {
    const html = await withTimeout(async (signal) => {
      const res = await fetch(endpoint("/content"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, gotoOptions: { waitUntil: "networkidle2", timeout: 20000 } }),
        signal,
      });
      if (!res.ok) throw new Error(`browser service ${res.status}`);
      return await res.text();
    });
    const { title, text } = htmlToText(html);
    return { ok: true, url, title, text: text.slice(0, maxChars) };
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "انتهت مهلة فتح الصفحة." : "تعذّر فتح الصفحة عبر خدمة المتصفح.";
    return { ok: false, url, title: null, text: "", error: msg };
  }
}

/** Open a URL in the remote browser and return a PNG screenshot (Buffer). */
export async function fetchScreenshot(
  rawUrl: string,
  opts: { fullPage?: boolean } = {}
): Promise<{ ok: true; bytes: Buffer; url: string } | { ok: false; error: string; url: string }> {
  let url: string;
  try { url = assertSafeBrowseUrl(rawUrl); }
  catch (e: any) { return { ok: false, url: rawUrl, error: e?.message || "رابط غير صالح." }; }

  if (!browserConfigured())
    return { ok: false, url, error: "خدمة المتصفح غير مهيأة على الخادم." };

  try {
    const bytes = await withTimeout(async (signal) => {
      const res = await fetch(endpoint("/screenshot"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          options: { fullPage: Boolean(opts.fullPage), type: "png" },
          gotoOptions: { waitUntil: "networkidle2", timeout: 20000 },
          viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
        }),
        signal,
      });
      if (!res.ok) throw new Error(`browser service ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    });
    return { ok: true, bytes, url };
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "انتهت مهلة التقاط الصورة." : "تعذّر التقاط صورة الصفحة.";
    return { ok: false, url, error: msg };
  }
}

// ---- Interactive control ---------------------------------------------------
// Real clicking/typing/selecting on a page, driven by a STRUCTURED step list
// (never model-authored JS — the interpreter below is a fixed, trusted script
// that runs on the remote browser via Browserless's /function endpoint, and the
// model only supplies data: {action, text, selector, ...}).
export type ActionStep = {
  action: "goto" | "click" | "type" | "press" | "select" | "scroll" | "wait" | "waitFor";
  url?: string;
  text?: string;
  selector?: string;
  key?: string;
  value?: string;
  to?: string | number;
  ms?: number;
};

export interface ActionResult {
  ok: boolean;
  url: string;
  title: string | null;
  text: string;
  shotDataUrl: string | null; // data:image/png;base64,... (kept out of the model loop)
  log: string[];
  error?: string;
}

// Fixed interpreter executed on the remote browser. Reads context.{url,steps}.
const ACTION_CODE = `export default async function ({ page, context }) {
  const { url, steps } = context;
  const log = [];
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  if (url) { await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 }); log.push('فتح ' + url); }
  for (const s of (steps || [])) {
    try {
      if (s.action === 'goto') { await page.goto(s.url, { waitUntil: 'networkidle2', timeout: 25000 }); }
      else if (s.action === 'click') {
        if (s.selector) { await page.click(s.selector); }
        else if (s.text) {
          const ok = await page.evaluate((t) => {
            const q = (t || '').trim().toLowerCase();
            const els = Array.from(document.querySelectorAll('a,button,[role=button],input[type=submit],[role=link],div,span,li,td'));
            const el = els.find((e) => ((e.innerText || e.value || e.getAttribute('aria-label') || '').trim().toLowerCase()).includes(q));
            if (el) { el.scrollIntoView({ block: 'center' }); el.click(); return true; }
            return false;
          }, s.text);
          if (!ok) throw new Error('ما لقيت عنصر فيه: ' + s.text);
        }
      }
      else if (s.action === 'type') {
        if (s.selector) { await page.click(s.selector).catch(() => {}); await page.type(s.selector, String(s.text || ''), { delay: 25 }); }
        else { await page.keyboard.type(String(s.text || ''), { delay: 25 }); }
      }
      else if (s.action === 'press') { await page.keyboard.press(s.key || 'Enter'); }
      else if (s.action === 'select') { await page.select(s.selector, String(s.value || '')); }
      else if (s.action === 'scroll') {
        await page.evaluate((to) => {
          if (to === 'bottom') window.scrollTo(0, document.body.scrollHeight);
          else if (to === 'top') window.scrollTo(0, 0);
          else window.scrollBy(0, Number(to) || 600);
        }, s.to);
      }
      else if (s.action === 'wait') { await pause(Math.min(Number(s.ms) || 1000, 8000)); }
      else if (s.action === 'waitFor') {
        if (s.selector) await page.waitForSelector(s.selector, { timeout: 15000 });
        else if (s.text) await page.waitForFunction((t) => (document.body.innerText || '').toLowerCase().includes((t || '').toLowerCase()), { timeout: 15000 }, s.text);
      }
      log.push('تم: ' + s.action + (s.text ? ' "' + s.text + '"' : '') + (s.selector ? ' ' + s.selector : ''));
      await pause(450);
    } catch (e) { log.push('فشل: ' + s.action + ' — ' + (e && e.message ? e.message : e)); }
  }
  const shot = await page.screenshot({ type: 'png', encoding: 'base64', fullPage: false });
  const title = await page.title().catch(() => '');
  const text = (await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '')).replace(/\\s+/g, ' ').trim().slice(0, 3000);
  return { data: JSON.stringify({ title, text, shot, finalUrl: page.url(), log }), type: 'application/json' };
}`;

/** Run a structured action sequence on a page; returns final screenshot + text. */
export async function runBrowserActions(rawUrl: string, steps: ActionStep[]): Promise<ActionResult> {
  let url = "";
  if (rawUrl) {
    try { url = assertSafeBrowseUrl(rawUrl); }
    catch (e: any) { return { ok: false, url: rawUrl, title: null, text: "", shotDataUrl: null, log: [], error: e?.message || "رابط غير صالح." }; }
  }
  // Validate any goto steps too (SSRF: every navigation target must be public).
  for (const s of steps || []) {
    if (s.action === "goto" && s.url) {
      try { s.url = assertSafeBrowseUrl(s.url); }
      catch (e: any) { return { ok: false, url, title: null, text: "", shotDataUrl: null, log: [], error: e?.message || "رابط غير صالح في الخطوات." }; }
    }
  }
  if (!browserConfigured())
    return { ok: false, url, title: null, text: "", shotDataUrl: null, log: [], error: "خدمة المتصفح غير مهيأة على الخادم." };

  try {
    const json: any = await withTimeout(async (signal) => {
      const res = await fetch(endpoint("/function"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: ACTION_CODE, context: { url, steps: (steps || []).slice(0, 20) } }),
        signal,
      });
      if (!res.ok) throw new Error(`browser service ${res.status}`);
      return res.json();
    }, 50_000);
    const shotDataUrl = json?.shot ? `data:image/png;base64,${json.shot}` : null;
    return {
      ok: true,
      url: json?.finalUrl || url,
      title: json?.title ?? null,
      text: String(json?.text ?? ""),
      shotDataUrl,
      log: Array.isArray(json?.log) ? json.log : [],
    };
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "انتهت مهلة تنفيذ الإجراءات." : "تعذّر تنفيذ الإجراءات في المتصفح.";
    return { ok: false, url, title: null, text: "", shotDataUrl: null, log: [], error: msg };
  }
}
