// Self-serve diagnostic for the live browser. Open this URL while signed in and
// it returns JSON showing EXACTLY which services are configured and what each
// returns when you try to open a session — so we can fix the live browser
// without needing server logs. Never exposes secret values, only key presence.
import { createClient } from "@/lib/supabase/server";
import { liveConfigured, createLiveSession } from "@/lib/malak/live";
import { browserConfigured, openLiveURL } from "@/lib/malak/browser";
import { browserbaseConfigured, openBrowserbase } from "@/lib/malak/browserbase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const present = (name: string) => Boolean((process.env[name] || "").trim());

export async function GET() {
  const { data: { user } } = await createClient().auth.getUser();
  if (!user) return Response.json({ error: "غير مسجّل الدخول." }, { status: 401 });

  const out: any = {
    env_present: {
      HYPERBEAM_API_KEY: present("HYPERBEAM_API_KEY"),
      HYPERBEAM_REGION: (process.env.HYPERBEAM_REGION || "(default EU)"),
      BROWSERLESS_URL: present("BROWSERLESS_URL"),
      BROWSERLESS_TOKEN: present("BROWSERLESS_TOKEN"),
      BROWSERBASE_API_KEY: present("BROWSERBASE_API_KEY"),
      BROWSERBASE_PROJECT_ID: present("BROWSERBASE_PROJECT_ID"),
    },
    hyperbeam: { configured: liveConfigured() },
    browserless_liveurl: { configured: browserConfigured() },
    browserbase: { configured: browserbaseConfigured() },
  };

  // Try Hyperbeam (audio).
  if (liveConfigured()) {
    try {
      const s = await createLiveSession("https://example.com");
      out.hyperbeam.try = s.ok ? { ok: true, hasEmbed: Boolean(s.embedUrl), profileUsed: s.profileUsed } : { ok: false, error: s.error };
    } catch (e: any) { out.hyperbeam.try = { ok: false, error: String(e?.message || e).slice(0, 200) }; }
  }

  // Try Browserless liveURL (fast, no audio).
  if (browserConfigured()) {
    try {
      const lu = await openLiveURL("https://example.com");
      out.browserless_liveurl.try = lu.ok ? { ok: true, hasUrl: Boolean(lu.liveUrl) } : { ok: false, error: lu.error };
    } catch (e: any) { out.browserless_liveurl.try = { ok: false, error: String(e?.message || e).slice(0, 200) }; }
  }

  // Try Browserbase (if configured).
  if (browserbaseConfigured()) {
    try {
      const bb = await openBrowserbase("https://example.com");
      out.browserbase.try = bb.ok ? { ok: true, hasUrl: Boolean(bb.liveUrl) } : { ok: false, error: bb.error };
    } catch (e: any) { out.browserbase.try = { ok: false, error: String(e?.message || e).slice(0, 200) }; }
  }

  return Response.json(out, { headers: { "Cache-Control": "no-store" } });
}
