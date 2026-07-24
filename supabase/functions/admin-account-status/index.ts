// Edge Function: admin-account-status
// تعطيل/إعادة تفعيل حساب عبر Supabase Auth Admin API (service-role على الخادم فقط).
// لا كتابة مباشرة إلى auth.users/auth.sessions من هذا المسار — Admin API يتكفّل بذلك،
// والمُشغّل sa_guard_no_orphan على auth.users يمنع ذرّيًا ترك النظام بلا مدير نظام.
//
// المصادقة: يستقبل Bearer token للمُنفِّذ، يتحقّق منه عبر GoTrue (يرفض المنتهي/anon)،
// ويتأكّد أنه «مدير نظام فعّال» عبر RPC is_superadmin() بسياق توكن المُنفِّذ (لا يثق
// بأي دور/هوية في جسم الطلب). service-role لا يُطبع ولا يُعاد ولا يُسجَّل.
//
// v2:
//  - idempotent: إن كان الحساب في الحالة المطلوبة أصلًا لا نستدعي Admin API ولا نُدقّق،
//    ونعيد 200 مع changed=false, idempotent=true (بدل 500 verification_mismatch).
//  - تدقيق موثوق عبر RPC superadmin_audit_account_status (يُفحص خطؤها صراحةً؛ لا ابتلاع).
//    فشل التدقيق لا يقلب النجاح إلى 500؛ يُعاد 200 مع audit_recorded=false فقط.

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

function isActiveFromBannedUntil(bannedUntil: string | null | undefined): boolean {
  return !bannedUntil || new Date(bannedUntil).getTime() <= Date.now();
}

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

  // service-role على الخادم فقط — لا يُعاد ولا يُطبع ولا يُسجَّل.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // الحالة الراهنة (لتحديد idempotency وللتأكد من وجود الحساب).
  const { data: before, error: beforeErr } = await admin.auth.admin.getUserById(target);
  if (beforeErr || !before?.user) return json(409, { error: "account_not_found" });
  const currentActive = isActiveFromBannedUntil(
    (before.user as { banned_until?: string | null }).banned_until,
  );

  // لا تغيير مطلوب: أعِد النجاح دون استدعاء Admin API ودون تدقيق (لا شيء يُسجَّل).
  if (currentActive === active) {
    return json(200, {
      ok: true,
      target_user_id: target,
      active,
      changed: false,
      idempotent: true,
      audit_recorded: false,
    });
  }

  // تحقّق/قفل تسلسلي بسياق المُنفِّذ (موجود؟ ليس النفس؟ ليس آخر مدير نظام؟).
  const { error: prepErr } = await userClient.rpc(
    "superadmin_prepare_account_active",
    { p_user_id: target, p_active: active },
  );
  if (prepErr) return json(409, { error: "precondition_failed", detail: prepErr.message });

  // الحظر الفعلي عبر Admin API. المُشغّل على auth.users يمنع ذرّيًا فقدان آخر
  // مدير نظام؛ إن رفض المُشغّل يعود الخطأ من updateUserById.
  const { error: banErr } = await admin.auth.admin.updateUserById(target, {
    ban_duration: active ? "none" : BAN_DURATION,
  });
  if (banErr) return json(409, { error: "apply_failed", detail: banErr.message });

  // تحقّق أن الحالة أصبحت كما هو مقصود (فشل هنا يعني أن الكتابة لم تُثبَّت).
  const { data: after } = await admin.auth.admin.getUserById(target);
  const nowActive = isActiveFromBannedUntil(
    (after?.user as { banned_until?: string | null } | undefined)?.banned_until,
  );
  if (nowActive !== active) {
    return json(500, { error: "verification_mismatch" });
  }

  // تدقيق موثوق عبر RPC (service_role فقط). يُفحص الخطأ صراحةً — لا ابتلاع.
  // فشل التدقيق لا يُلغي الحظر ولا يقلب النجاح إلى 500؛ يُعلَّم audit_recorded=false.
  let auditRecorded = true;
  const { error: auditErr } = await admin.rpc(
    "superadmin_audit_account_status",
    { p_actor_id: caller.id, p_target_id: target, p_active: active },
  );
  if (auditErr) {
    auditRecorded = false;
    // رمز مقتضب فقط إلى السجل — لا مفاتيح ولا توكنات.
    console.error("audit_write_failed", auditErr.code ?? "unknown");
  }

  return json(200, {
    ok: true,
    target_user_id: target,
    active,
    changed: true,
    idempotent: false,
    audit_recorded: auditRecorded,
  });
});
