// Malak browser bridge. Two entry points, both require a signed-in user:
//   GET  ?url=...          → live PNG screenshot of the page (for the <img> in
//                            the popup "browser screen" on the Malak page).
//   POST { url }           → { ok, title, text } rendered page content (handy
//                            for manual calls / debugging; the brain reaches the
//                            same helper directly via the browse_web tool).
// The heavy lifting runs on an external Browserless-compatible service so this
// stays Vercel-safe (no bundled Chromium). See lib/malak/browser.ts.
import { createClient } from "@/lib/supabase/server";
import { fetchScreenshot, fetchPageContent, browserConfigured } from "@/lib/malak/browser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { data: { user } } = await createClient().auth.getUser();
  if (!user) return Response.json({ error: "غير مسجّل الدخول." }, { status: 401 });

  const url = new URL(req.url).searchParams.get("url") || "";
  if (!url) return Response.json({ error: "أضف ?url=" }, { status: 400 });
  if (!browserConfigured())
    return Response.json({ error: "خدمة المتصفح غير مهيأة على الخادم." }, { status: 503 });

  const shot = await fetchScreenshot(url, { fullPage: false });
  if (!shot.ok) return Response.json({ error: shot.error }, { status: 502 });

  return new Response(new Uint8Array(shot.bytes), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=60",
    },
  });
}

export async function POST(req: Request) {
  const { data: { user } } = await createClient().auth.getUser();
  if (!user) return Response.json({ error: "غير مسجّل الدخول." }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "صيغة غير صحيحة." }, { status: 400 }); }
  const url = typeof body?.url === "string" ? body.url : "";
  if (!url) return Response.json({ error: "أضف url." }, { status: 400 });

  const out = await fetchPageContent(url);
  return Response.json(out, { status: out.ok ? 200 : 200 });
}
