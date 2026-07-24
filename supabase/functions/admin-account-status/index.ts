// Edge Function: admin-account-status
// idempotent + reliable audit. State read from SQL-truth RPC. Bounded retries
// tolerate intermittent GoTrue admin JWT-verify failures (ES256 kid) safely.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BAN_DURATION = "876000h";

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

type AccountRow = { user_id: string; active: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readState(
  client: ReturnType<typeof createClient>,
  target: string,
): Promise<{ ok: true; row: { active: boolean } | null } | { ok: false }> {
  for (let i = 0; i < 3; i++) {
    const { data, error } = await client.rpc("superadmin_list_accounts");
    if (!error) {
      const rows = (Array.isArray(data) ? data : []) as AccountRow[];
      const row = rows.find((r) => r.user_id === target) ?? null;
      return { ok: true, row: row ? { active: row.active === true } : null };
    }
    await sleep(300 * (i + 1));
  }
  return { ok: false };
}

async function applyBan(
  admin: ReturnType<typeof createClient>,
  target: string,
  active: boolean,
): Promise<{ message: string } | null> {
  let last: { message: string } | null = null;
  for (let i = 0; i < 3; i++) {
    const { error } = await admin.auth.admin.updateUserById(target, {
      ban_duration: active ? "none" : BAN_DURATION,
    });
    if (!error) return null;
    last = { message: error.message };
    await sleep(300 * (i + 1));
  }
  return last;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const contentType = req.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return json(415, { error: "unsupported_media_type" });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return json(401, { error: "missing_bearer_token" });
  }

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  const caller = userData?.user;
  if (userErr || !caller) return json(401, { error: "invalid_or_expired_token" });

  const { data: isSA, error: saErr } = await userClient.rpc("is_superadmin");
  if (saErr) return json(500, { error: "authz_check_failed" });
  if (isSA !== true) return json(403, { error: "not_superadmin" });

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

  const before = await readState(userClient, target);
  if (!before.ok) return json(500, { error: "state_read_failed" });
  if (!before.row) return json(409, { error: "account_not_found" });

  if (before.row.active === active) {
    return json(200, {
      ok: true,
      target_user_id: target,
      active,
      changed: false,
      idempotent: true,
      audit_recorded: false,
    });
  }

  const { error: prepErr } = await userClient.rpc(
    "superadmin_prepare_account_active",
    { p_user_id: target, p_active: active },
  );
  if (prepErr) return json(409, { error: "precondition_failed", detail: prepErr.message });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const banErr = await applyBan(admin, target, active);
  if (banErr) return json(409, { error: "apply_failed", detail: banErr.message });

  const after = await readState(userClient, target);
  if (!after.ok) return json(500, { error: "verify_read_failed" });
  if (!after.row || after.row.active !== active) {
    return json(500, { error: "verification_mismatch" });
  }

  let auditRecorded = true;
  const { error: auditErr } = await admin.rpc(
    "superadmin_audit_account_status",
    { p_actor_id: caller.id, p_target_id: target, p_active: active },
  );
  if (auditErr) {
    auditRecorded = false;
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
