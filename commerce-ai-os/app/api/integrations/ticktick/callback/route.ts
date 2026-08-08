// GET /api/integrations/ticktick/callback — owner-only OAuth callback (Option B).
// Validation/authorization-flow ONLY: it verifies the CSRF state, then shows the
// owner the short-lived authorization code plus a placeholder curl to run the
// token exchange EXTERNALLY. The app never exchanges the code, never touches the
// client secret here, never receives/handles an access token, and logs nothing
// (no code / secret / token in logs). No DB, no admin client, no service role.
import { cookies } from "next/headers";
import { requireOwner } from "@/lib/malak/authz";
import {
  parseCallbackParams,
  validateState,
  oauthMessage,
  tokenExchangeCurl,
  type OAuthMessageCode,
} from "@/lib/integrations/ticktick/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_COOKIE = "tt_oauth_state";

/** HTML-escape any dynamic value before it enters the page. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function html(body: string, status: number): Response {
  const doc = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ربط TickTick</title></head><body style="font-family:system-ui,sans-serif;padding:2rem;max-width:720px;margin:auto;color:#2b2b2b;line-height:1.7">${body}</body></html>`;
  return new Response(doc, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

function fail(code: OAuthMessageCode, status: number): Response {
  return html(`<p>${oauthMessage(code)}</p>`, status);
}

export async function GET(req: Request) {
  const owner = await requireOwner();
  if (!owner.ok) return html(`<p>${esc(owner.error)}</p>`, owner.status);

  // Read + clear the one-time CSRF state cookie.
  const jar = await cookies();
  const cookieState = jar.get(STATE_COOKIE)?.value ?? "";
  jar.delete(STATE_COOKIE);

  const { code, state, error } = parseCallbackParams(new URL(req.url).searchParams);
  if (error) return fail("provider_error", 400); // the raw error param is never echoed
  if (!validateState(cookieState, state)) return fail("invalid_state", 400);
  if (!code) return fail("missing_code", 400);

  // Validation OK. Show the owner the code + the EXTERNAL exchange steps. The
  // authorization code is short-lived + single-use; it is displayed to the
  // authenticated owner only and is NOT logged (nothing here writes logs).
  const body = `
    <h1 style="font-size:1.25rem">تم التحقق من التفويض بنجاح ✅</h1>
    <p>أكمل الخطوات التالية <strong>مرة واحدة</strong> لإنهاء ربط TickTick. تبادل الرمز يتم <strong>خارج التطبيق</strong> — لن يظهر أو يُخزَّن أي Access Token هنا.</p>
    <h2 style="font-size:1rem">1) رمز التفويض (قصير العمر، يُستخدم مرة واحدة — انسخه الآن):</h2>
    <pre style="background:#f5ece1;padding:.75rem;border-radius:.5rem;overflow:auto"><code>${esc(code)}</code></pre>
    <h2 style="font-size:1rem">2) نفّذ هذا الأمر من جهازك (استبدل القيم النائبة بقيمك، وضع الرمز مكان &lt;AUTHORIZATION_CODE&gt;):</h2>
    <pre style="background:#f5ece1;padding:.75rem;border-radius:.5rem;overflow:auto"><code>${esc(tokenExchangeCurl())}</code></pre>
    <h2 style="font-size:1rem">3) انسخ قيمة access_token من ناتج الأمر، ثم أضِفها في Vercel:</h2>
    <p>Vercel → Project <strong>ghost</strong> → Settings → Environment Variables → Production، ثم أضِف:</p>
    <pre style="background:#f5ece1;padding:.75rem;border-radius:.5rem;overflow:auto"><code>TICKTICK_ACCESS_TOKEN=&lt;token&gt;</code></pre>
    <p style="color:#8a6d3b">لا تشارك «Client Secret» أو الـ Access Token مع أحد، ولا تضعهما في أي مكان عام.</p>
  `;
  return html(body, 200);
}
