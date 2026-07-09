"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth/requireUser";
import { sendInstagramDm, insertDmMessage } from "@/lib/dm/inbox";

// Owner's DM inbox actions — read the conversations «ملاك» is handling, jump
// in with a manual reply (clears the needs-human flag), and flip auto-reply
// per conversation.

export interface DmConversationRow {
  id: string;
  channel: string;
  external_id: string;
  username: string | null;
  auto_reply: boolean;
  needs_human: boolean;
  last_message_at: string | null;
  last_preview: string | null;
}

export interface DmMessageRow {
  id: string;
  direction: "in" | "out";
  body: string | null;
  ai: boolean;
  created_at: string | null;
}

const NO_DB = "الخادم غير مهيأ (SUPABASE_SERVICE_ROLE_KEY غير مضبوط).";

function adminClient(): any | null {
  try { return createAdminClient(); } catch { return null; }
}

export async function listDmConversations(): Promise<{ ok: boolean; ready: boolean; items: DmConversationRow[]; error?: string }> {
  const unauth = await requireUser();
  if (unauth) return { ok: false, ready: true, items: [], error: unauth.error };
  const admin = adminClient();
  if (!admin) return { ok: false, ready: true, items: [], error: NO_DB };
  const { data, error } = await admin
    .from("dm_conversations")
    .select("id, channel, external_id, username, auto_reply, needs_human, last_message_at, last_preview")
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(200);
  if (error) {
    if ((error as any).code === "42P01" || /dm_conversations/i.test(error.message)) return { ok: true, ready: false, items: [] };
    return { ok: false, ready: true, items: [], error: error.message };
  }
  return {
    ok: true, ready: true,
    items: ((data ?? []) as any[]).map((c) => ({
      id: String(c.id), channel: String(c.channel ?? "instagram"), external_id: String(c.external_id ?? ""),
      username: c.username ?? null, auto_reply: c.auto_reply !== false, needs_human: c.needs_human === true,
      last_message_at: c.last_message_at ?? null, last_preview: c.last_preview ?? null,
    })),
  };
}

export async function dmThread(conversationId: string): Promise<{ ok: boolean; items: DmMessageRow[]; error?: string }> {
  const unauth = await requireUser();
  if (unauth) return { ok: false, items: [], error: unauth.error };
  const admin = adminClient();
  if (!admin) return { ok: false, items: [], error: NO_DB };
  const { data, error } = await admin
    .from("dm_messages")
    .select("id, direction, body, ai, created_at")
    .eq("conversation_id", String(conversationId))
    .order("created_at", { ascending: true })
    .limit(300);
  if (error) return { ok: false, items: [], error: error.message };
  return {
    ok: true,
    items: ((data ?? []) as any[]).map((m) => ({
      id: String(m.id), direction: m.direction === "out" ? "out" : "in",
      body: m.body ?? null, ai: m.ai === true, created_at: m.created_at ?? null,
    })),
  };
}

export async function sendDmReply(conversationId: string, text: string): Promise<{ ok: true } | { error: string }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const admin = adminClient();
  if (!admin) return { error: NO_DB };
  const body = String(text ?? "").trim();
  if (!body) return { error: "اكتب الرد أولًا." };

  const { data: convo } = await admin
    .from("dm_conversations").select("id, channel, external_id").eq("id", String(conversationId)).maybeSingle();
  if (!convo) return { error: "المحادثة غير موجودة." };
  if (String(convo.channel) !== "instagram") return { error: "القناة غير مدعومة بعد." };

  const sent = await sendInstagramDm(String(convo.external_id), body);
  if (!sent.ok) return { error: `تعذّر الإرسال: ${sent.error ?? ""} — غالبًا نافذة الـ٢٤ ساعة انتهت أو التوكن يحتاج صلاحية الرسائل.` };
  await insertDmMessage(admin, { conversationId: String(convo.id), direction: "out", body, ai: false });
  await admin.from("dm_conversations").update({ needs_human: false }).eq("id", String(convo.id));
  return { ok: true as const };
}

export async function toggleDmAuto(conversationId: string, on: boolean): Promise<{ ok: true } | { error: string }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const admin = adminClient();
  if (!admin) return { error: NO_DB };
  const { error } = await admin.from("dm_conversations").update({ auto_reply: on }).eq("id", String(conversationId));
  if (error) return { error: error.message };
  return { ok: true as const };
}

export async function resolveDmHuman(conversationId: string): Promise<{ ok: true } | { error: string }> {
  const unauth = await requireUser();
  if (unauth) return unauth;
  const admin = adminClient();
  if (!admin) return { error: NO_DB };
  const { error } = await admin.from("dm_conversations").update({ needs_human: false }).eq("id", String(conversationId));
  if (error) return { error: error.message };
  return { ok: true as const };
}
