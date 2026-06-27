// Web search for Malak. Scraping Google/Bing/DuckDuckGo from a datacenter IP
// (the browser service) trips their CAPTCHA / "unusual traffic" wall, so we use
// a proper search API instead — it returns clean JSON results with no CAPTCHA.
// Provider-flexible and env-gated; if no key is set, callers degrade gracefully.
//
// Configure ONE of:
//   BRAVE_SEARCH_TOKEN   Brave Search API (free tier ~2k queries/mo)
//   TAVILY_API_KEY       Tavily (AI-search, free tier ~1k/mo)
const TIMEOUT_MS = 15_000;

export interface SearchResult { title: string; url: string; snippet: string }
export interface SearchOutput {
  ok: boolean;
  query: string;
  provider: string | null;
  results: SearchResult[];
  error?: string;
}

function brave(): string { return (process.env.BRAVE_SEARCH_TOKEN || "").trim(); }
function tavily(): string { return (process.env.TAVILY_API_KEY || "").trim(); }

export function searchConfigured(): boolean {
  return Boolean(brave() || tavily());
}

async function withTimeout<T>(p: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try { return await p(ctrl.signal); } finally { clearTimeout(t); }
}

export async function webSearch(rawQuery: string, limit = 6): Promise<SearchOutput> {
  const query = String(rawQuery || "").trim().slice(0, 400);
  if (!query) return { ok: false, query: "", provider: null, results: [], error: "ما فيه كلمات بحث." };
  if (!searchConfigured())
    return {
      ok: false, query, provider: null, results: [],
      error: "خدمة البحث غير مهيأة على الخادم (BRAVE_SEARCH_TOKEN أو TAVILY_API_KEY).",
    };

  const provider = brave() ? "brave" : "tavily";
  try {
    const out = brave() ? await searchBrave(query, limit) : await searchTavily(query, limit);
    console.log(`[malak][search] provider=${provider} q="${query.slice(0, 80)}" results=${out.results.length}`);
    return out;
  } catch (e: any) {
    // Surface the REAL reason (HTTP status / provider error) so it shows in the
    // server log AND degrades into a message Malak can relay verbatim.
    const detail = e?.name === "AbortError" ? "timeout" : (e?.message || "unknown");
    console.error(`[malak][search] provider=${provider} FAILED q="${query.slice(0, 80)}" reason=${detail}`);
    const msg = e?.name === "AbortError"
      ? "انتهت مهلة البحث."
      : `تعذّر تنفيذ البحث (${detail}).`;
    return { ok: false, query, provider, results: [], error: msg };
  }
}

async function searchBrave(query: string, limit: number): Promise<SearchOutput> {
  const u = new URL("https://api.search.brave.com/res/v1/web/search");
  u.searchParams.set("q", query);
  u.searchParams.set("count", String(Math.min(Math.max(limit, 1), 20)));
  const json: any = await withTimeout(async (signal) => {
    const res = await fetch(u.toString(), {
      headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": brave() },
      signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`brave HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`);
    }
    return res.json();
  });
  const results: SearchResult[] = (json?.web?.results ?? []).slice(0, limit).map((r: any) => ({
    title: String(r?.title ?? "").slice(0, 200),
    url: String(r?.url ?? ""),
    snippet: String(r?.description ?? "").replace(/<[^>]+>/g, "").slice(0, 400),
  }));
  return { ok: true, query, provider: "brave", results };
}

async function searchTavily(query: string, limit: number): Promise<SearchOutput> {
  const json: any = await withTimeout(async (signal) => {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: tavily(), query, max_results: Math.min(Math.max(limit, 1), 20), search_depth: "basic" }),
      signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`tavily HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`);
    }
    return res.json();
  });
  const results: SearchResult[] = (json?.results ?? []).slice(0, limit).map((r: any) => ({
    title: String(r?.title ?? "").slice(0, 200),
    url: String(r?.url ?? ""),
    snippet: String(r?.content ?? "").replace(/\s+/g, " ").slice(0, 400),
  }));
  return { ok: true, query, provider: "tavily", results };
}
