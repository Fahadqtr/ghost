// Resolve a song/query to a YouTube video id WITHOUT an API key, by fetching
// YouTube's search-results HTML and pulling the first videoId out of the
// embedded ytInitialData. A CONSENT cookie + desktop UA avoids the EU consent
// interstitial. This is far more reliable than hoping a web-search result
// happens to be a /watch URL.
const TIMEOUT_MS = 12_000;

export interface YtHit { id: string; title: string }

export async function youtubeSearchId(query: string): Promise<YtHit | null> {
  const q = String(query || "").trim();
  if (!q) return null;
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=ar&gl=QA`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "ar,en;q=0.9",
        Cookie: "CONSENT=YES+1; SOCS=CAISEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const html = await res.text();
    // First real video result. videoRenderer entries carry videoId + a title.
    const m = html.match(/"videoRenderer":\{"videoId":"([\w-]{11})"[\s\S]{0,600}?"title":\{"runs":\[\{"text":"([^"]+)"/);
    if (m) return { id: m[1], title: decodeUnicode(m[2]) };
    // Fallback: any videoId at all.
    const m2 = html.match(/"videoId":"([\w-]{11})"/);
    return m2 ? { id: m2[1], title: "" } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// YouTube's JSON escapes non-ASCII as \uXXXX; turn it back into readable text.
function decodeUnicode(s: string): string {
  try {
    return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  } catch {
    return s;
  }
}
