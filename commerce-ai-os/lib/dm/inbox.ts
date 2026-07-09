import "server-only";
import { buildDmPrompt, parseDmReply, dmSearchTokens, matchDmProducts, type DmProduct, type DmTurn } from "./respond-compute";
import { STORE_INFO } from "./store-info";

// DM engine: store the incoming message, let «ملاك» answer from the catalog
// + store facts, send the reply, and flag anything she can't handle for a
// human. Called from the Meta webhook — every step is defensive; a failure
// flags the conversation instead of dropping the customer.

const GRAPH = "https://graph.facebook.com/v21.0";

export function dmToken(): string {
  return process.env.META_MESSAGING_TOKEN || process.env.INSTAGRAM_ACCESS_TOKEN || "";
}

/** Send one Instagram DM (Messenger platform, page-linked IG account). */
export async function sendInstagramDm(recipientId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const token = dmToken();
  if (!token) return { ok: false, error: "INSTAGRAM_ACCESS_TOKEN غير مضبوط" };
  try {
    const r = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text: text.slice(0, 900) } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      console.error("[dm-send]", r.status, detail);
      return { ok: false, error: `Graph ${r.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "send failed" };
  }
}

/** Find or create the conversation row for this sender. */
export async function upsertDmConversation(admin: any, channel: string, externalId: string): Promise<{ id: string; auto_reply: boolean } | null> {
  const { data: found } = await admin
    .from("dm_conversations").select("id, auto_reply")
    .eq("channel", channel).eq("external_id", externalId).maybeSingle();
  if (found) return { id: String(found.id), auto_reply: found.auto_reply !== false };
  const { data: made, error } = await admin
    .from("dm_conversations")
    .insert({ channel, external_id: externalId })
    .select("id, auto_reply")
    .single();
  if (error || !made) { console.error("[dm-conv]", error?.message); return null; }
  return { id: String(made.id), auto_reply: made.auto_reply !== false };
}

/** Store a message; returns false when `mid` was already seen (webhook retry). */
export async function insertDmMessage(admin: any, opts: {
  conversationId: string; direction: "in" | "out"; body: string; mid?: string | null; ai?: boolean;
}): Promise<boolean> {
  const { error } = await admin.from("dm_messages").insert({
    conversation_id: opts.conversationId,
    direction: opts.direction,
    body: opts.body.slice(0, 4000),
    mid: opts.mid || null,
    ai: opts.ai ?? false,
  });
  if (error) {
    if (/dm_messages_mid_idx|duplicate/i.test(error.message)) return false; // retry — already handled
    console.error("[dm-msg]", error.message);
    return false;
  }
  await admin.from("dm_conversations").update({
    last_message_at: new Date().toISOString(),
    last_preview: `${opts.direction === "in" ? "" : "↩︎ "}${opts.body.slice(0, 120)}`,
  }).eq("id", opts.conversationId);
  return true;
}

/** Approved catalog rows for matching (name/sku/price/stock). */
async function loadCatalog(admin: any): Promise<DmProduct[]> {
  const out: DmProduct[] = [];
  for (let from = 0; from < 4000; from += 1000) {
    const { data, error } = await admin
      .from("products")
      .select("sku, name_en, name_ar, price, discount_price, approval, inventory(stock_quantity)")
      .eq("approval", "Approved")
      .range(from, from + 999);
    if (error) break;
    for (const p of (data ?? []) as any[]) {
      out.push({
        sku: p.sku ?? null, name_en: p.name_en ?? null, name_ar: p.name_ar ?? null,
        price: p.price ?? null, discount_price: p.discount_price ?? null,
        stock: p.inventory?.[0]?.stock_quantity ?? null,
      });
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

/**
 * The full auto-reply turn: history → catalog match → «ملاك» → send → log.
 * needs_human is set on handoff, on model/send failure, and when auto-reply
 * is switched off for the conversation.
 */
export async function autoReplyDm(admin: any, convo: { id: string; auto_reply: boolean }, externalId: string): Promise<void> {
  const flag = () => admin.from("dm_conversations").update({ needs_human: true }).eq("id", convo.id);
  try {
    if (!convo.auto_reply) { await flag(); return; }
    if (!process.env.ANTHROPIC_API_KEY) { await flag(); return; }

    const { data: hist } = await admin
      .from("dm_messages")
      .select("direction, body")
      .eq("conversation_id", convo.id)
      .order("created_at", { ascending: false })
      .limit(10);
    const history: DmTurn[] = ((hist ?? []) as any[])
      .reverse()
      .map((m) => ({ direction: m.direction === "out" ? "out" as const : "in" as const, body: String(m.body ?? "") }));
    const lastIn = [...history].reverse().find((t) => t.direction === "in")?.body ?? "";

    const catalog = await loadCatalog(admin);
    const products = matchDmProducts(catalog, dmSearchTokens(lastIn));

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const resp: any = await client.messages.create({
      model: process.env.DM_MODEL || process.env.STAFF_MALAK_MODEL || "claude-sonnet-5",
      max_tokens: 500,
      messages: [{ role: "user", content: buildDmPrompt({ history, products, storeInfo: STORE_INFO }) }],
    });
    const text = (resp.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const verdict = parseDmReply(text);
    if (!verdict) { await flag(); return; }

    const sent = await sendInstagramDm(externalId, verdict.reply);
    if (!sent.ok) { await flag(); return; }
    await insertDmMessage(admin, { conversationId: convo.id, direction: "out", body: verdict.reply, ai: true });
    if (verdict.handoff) await flag();
  } catch (e) {
    console.error("[dm-auto]", e instanceof Error ? e.message : e);
    await flag();
  }
}
