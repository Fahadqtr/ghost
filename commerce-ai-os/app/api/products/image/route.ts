import { isSignedIn } from "@/lib/auth/requireUser";
import { safeImageUrlOrNull, safeFetchImage } from "@/lib/net/safeImage";

// Same-origin image proxy for the product page's copy/download buttons. Fetching
// a Shopify-CDN / Supabase-storage image straight from the browser is blocked by
// CORS (can't read the bytes to copy, and cross-origin `download` is ignored), so
// we stream it through here. Auth-gated + SSRF-guarded (safeFetchImage). Pass
// ?dl=1 to force a download; otherwise it's served inline (for clipboard copy).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif",
};

export async function GET(req: Request) {
  if (!(await isSignedIn())) return new Response("Unauthorized", { status: 401 });

  const u = new URL(req.url);
  const target = safeImageUrlOrNull(u.searchParams.get("url"));
  if (!target) return new Response("Bad image url", { status: 400 });

  let res: Response;
  try {
    res = await safeFetchImage(target);
  } catch {
    return new Response("Fetch failed", { status: 502 });
  }
  if (!res.ok || !res.body) return new Response("Upstream error", { status: 502 });

  const type = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
  if (!type.startsWith("image/")) return new Response("Not an image", { status: 415 });

  const headers = new Headers({ "Content-Type": type, "Cache-Control": "private, max-age=60" });
  if (u.searchParams.get("dl")) {
    const raw = (u.searchParams.get("name") || "product").replace(/[^\w.\-]+/g, "_").slice(0, 80) || "product";
    const base = raw.replace(/\.(png|jpe?g|webp|gif|avif)$/i, "");
    headers.set("Content-Disposition", `attachment; filename="${base}.${EXT[type] ?? "jpg"}"`);
  }
  return new Response(res.body, { status: 200, headers });
}
