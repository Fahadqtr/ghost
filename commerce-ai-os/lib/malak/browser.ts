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

async function withTimeout<T>(p: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
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
