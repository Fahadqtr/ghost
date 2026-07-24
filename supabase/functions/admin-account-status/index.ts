// Edge Function: admin-account-status
// تعطيل/إعادة تفعيل حساب عبر Supabase Auth Admin API (service-role على الخادم فقط).
// لا كتابة مباشرة إلى auth.users/auth.sessions من هذا المسار — Admin API يتكفّل بذلك،
// والمُشغّل sa_guard_no_orphan على auth.users يمنع ذرّيًا ترك النظام بلا مدير نظام.
//
// المصادقة: يستقبل Bearer token للمُنفِّذ، يتحقّق منه عبر GoTrue (يرفض المنتهي/anon)،
// ويتأكّد أنه «مدير نظام فعّال» عبر RPC is_superadmin() بسياق توكن المُنفِّذ (لا يثق
// بأي دور/هوية في جسم الطلب). service-role لا يُطبع ولا يُعاد ولا يُسجَّل.
//
// النشر ليس جزءًا من هذه المهمة (لا Deploy).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BAN_DURATION = "876000h"; // ~100 عام (قيمة حظر مدعومة من Admin API)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return json(401, { error: "missing_bearer_token" });
  }

  // عميل بسياق المُنفِّذ — يتحقّق GoTrue من التوكن ويرفض المنتهي/anon.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  const caller = userData?.user;
  if (userErr || !caller) return json(401, { error: "invalid_or_expired_token" });

  // مدير نظام فعّال فقط (is_superadmin يقرأ auth.uid() ويفحص التعطيل).
  const { data: isSA, error: saErr } = await userClient.rpc("is_superadmin");
  if (saErr) return json(500, { error: "authz_check_failed" });
  if (isSA !== true) return json(403, { error: "not_superadmin" });

  // جسم الطلب — لا نثق بأي role/team/dept فيه.
  let body: { target_user_id?: unknown; active?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const target = body?.target_user_id;
  const active = body?.active;
  if (typeof target !== "string" || !UUID_RE.test(target)) {
    return json(400, { error: "invalid_target_user_id" });
  }
  if (typeof active !== "boolean") {
    return json(400, { error: "invalid_active_flag" });
  }
  if (!active && target === caller.id) {
    return json(400, { error: "cannot_disable_self" });
  }

  // تحقّق/قفل تسلسلي بسياق المُنفِّذ (موجود؟ ليس النفس؟ ليس آخر مدير نظام؟).
  const { error: prepErr } = await userClient.rpc(
    "superadmin_prepare_account_active",
    { p_user_id: target, p_active: active },
  );
  if (prepErr) return json(409, { error: "precondition_failed", detail: prepErr.message });

  // service-role على الخادم فقط — لا يُعاد ولا يُطبع ولا يُسجَّل.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // الحظر الفعلي عبر Admin API. المُشغّل على auth.users يمنع ذرّيًا فقدان آخر
  // مدير نظام؛ إن رفض المُشغّل يعود الخطأ من updateUserById.
  const { error: banErr } = await admin.auth.admin.updateUserById(target, {
    ban_duration: active ? "none" : BAN_DURATION,
  });
  if (banErr) return json(409, { error: "apply_failed", detail: banErr.message });

  // تحقّق أفضل جهد أن الحالة أصبحت كما هو مقصود.
  const { data: after } = await admin.auth.admin.getUserById(target);
  const bannedUntil = (after?.user as { banned_until?: string | null } | undefined)
    ?.banned_until ?? null;
  const nowActive = !bannedUntil || new Date(bannedUntil).getTime() <= Date.now();
  if (nowActive !== active) {
    return json(500, { error: "verification_mismatch" });
  }

  // تدقيق آمن (service-role يتجاوز RLS وله صلاحية الإدراج). فشل التدقيق لا يُلغي
  // الحظر — الأفضل بقاء الحساب محجوبًا على فتحه دون قصد.
  try {
    await admin.from("audit_log").insert({
      actor_id: caller.id,
      actor_name: (caller.user_metadata as { full_name?: string } | undefined)?.full_name ?? null,
      actor_role: "superadmin",
      action: active ? "account_enable" : "account_disable",
      entity: "account",
      entity_id: target,
      summary: active ? "إعادة تفعيل حساب" : "تعطيل حساب",
      changed: { new: { active } },
      team: null,
    });
  } catch (_e) {
    // تُهمَل بأمان — الحظر مطبّق. (لا نطبع أي مفتاح.)
  }

  return json(200, { ok: true, target_user_id: target, active });
});
