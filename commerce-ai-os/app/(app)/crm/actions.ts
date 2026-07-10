"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth/requireUser";
import { revalidatePath } from "next/cache";
import { shopifyConfigured, fetchShopifyCustomers, fetchShopifyCustomerOrders, type ShopifyCustomerOrder } from "@/lib/shopify/admin";
import { computeSegment, segmentCounts, type CustomerSegment } from "@/lib/crm/customer-compute";

// CRM — a unified customer directory built on read from two sources: Shopify
// buyers (name/phone/spend/orders) and DM contacts (Instagram/WhatsApp). Only
// notes + manual tags are persisted (crm_customers); everything else is live.

function admin(): any | null {
  try { return createAdminClient(); } catch { return null; }
}
const NO_DB = "الخادم غير مهيأ (SUPABASE_SERVICE_ROLE_KEY).";
const EMPTY_COUNTS: Record<CustomerSegment, number> = { vip: 0, repeat: 0, new: 0, lapsed: 0, lead: 0 };

export type CrmCustomer = {
  source: "shopify" | "dm";
  sourceId: string;
  name: string;
  phone: string;
  instagram: string;
  email: string;
  orders: number;
  spent: number;
  currency: string;
  lastActivityAt: string | null; // last order (shopify) or last message (dm)
  segment: CustomerSegment;
  needsHuman: boolean;           // dm flag
  channel: string;               // dm channel ("" for shopify)
  tags: string[];
  hasNote: boolean;
};

export async function listCustomers(): Promise<{ error?: string; shopifyNote?: string; rows: CrmCustomer[]; counts: Record<CustomerSegment, number> }> {
  const guard = await requireUser();
  if (guard) return { error: guard.error, rows: [], counts: EMPTY_COUNTS };
  const sb = admin();
  if (!sb) return { error: NO_DB, rows: [], counts: EMPTY_COUNTS };
  const now = new Date();

  // 1) Shopify buyers (highest spend first).
  let shopRows: CrmCustomer[] = [];
  let shopifyNote: string | undefined;
  if (shopifyConfigured()) {
    const { customers, error } = await fetchShopifyCustomers(250);
    if (error) {
      shopifyNote = /access|scope|permission|read_customers/i.test(error)
        ? "لعرض عملاء المتجر: فعّل صلاحية read_customers في تطبيق شوبي فاي ثم أعد الربط."
        : error;
    } else {
      shopRows = (customers ?? []).map((c) => ({
        source: "shopify" as const, sourceId: c.id, name: c.name || "عميل", phone: c.phone, instagram: "", email: c.email,
        orders: c.orders, spent: c.spent, currency: c.currency, lastActivityAt: c.lastOrderAt,
        segment: computeSegment({ orders: c.orders, spent: c.spent, lastOrderAt: c.lastOrderAt, now }),
        needsHuman: false, channel: "", tags: [], hasNote: false,
      }));
    }
  } else {
    shopifyNote = "شوبي فاي غير مربوط — تظهر جهات الدايركت فقط.";
  }

  // 2) DM contacts (leads / inquiries).
  const { data: convos } = await sb
    .from("dm_conversations")
    .select("id, channel, external_id, username, last_message_at, needs_human")
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(300);
  const dmRows: CrmCustomer[] = ((convos ?? []) as any[]).map((c) => ({
    source: "dm" as const, sourceId: String(c.id), name: String(c.username || "جهة دايركت"), phone: "",
    instagram: String(c.username || ""), email: "", orders: 0, spent: 0, currency: "QAR",
    lastActivityAt: c.last_message_at ?? null, segment: "lead" as const,
    needsHuman: !!c.needs_human, channel: String(c.channel || "instagram"), tags: [], hasNote: false,
  }));

  // 3) Overlay persisted notes/tags.
  const rows = [...shopRows, ...dmRows];
  const { data: crm } = await sb.from("crm_customers").select("source, source_id, notes, tags").limit(2000);
  const meta = new Map<string, { notes: string | null; tags: string[] }>();
  for (const m of (crm ?? []) as any[]) meta.set(`${m.source}:${m.source_id}`, { notes: m.notes, tags: m.tags ?? [] });
  for (const r of rows) {
    const m = meta.get(`${r.source}:${r.sourceId}`);
    if (m) { r.tags = m.tags ?? []; r.hasNote = !!(m.notes && String(m.notes).trim()); }
  }

  return { rows, counts: segmentCounts(rows), shopifyNote };
}

export type CrmDetail = {
  error?: string;
  notes: string;
  tags: string[];
  orders?: ShopifyCustomerOrder[];
  messages?: { direction: string; body: string; ai: boolean; created_at: string }[];
};

export async function getCustomerDetail(source: "shopify" | "dm", sourceId: string): Promise<CrmDetail> {
  const guard = await requireUser();
  if (guard) return { error: guard.error, notes: "", tags: [] };
  const sb = admin();
  if (!sb) return { error: NO_DB, notes: "", tags: [] };

  const { data: c } = await sb.from("crm_customers").select("notes, tags").eq("source", source).eq("source_id", sourceId).maybeSingle();
  const notes = String(c?.notes ?? "");
  const tags = (c?.tags ?? []) as string[];

  if (source === "shopify") {
    const { orders, error } = await fetchShopifyCustomerOrders(sourceId);
    if (error) return { notes, tags, error };
    return { notes, tags, orders: orders ?? [] };
  }
  const { data: msgs } = await sb
    .from("dm_messages")
    .select("direction, body, ai, created_at")
    .eq("conversation_id", sourceId)
    .order("created_at", { ascending: false })
    .limit(30);
  return { notes, tags, messages: ((msgs ?? []) as any[]).reverse() };
}

type Identity = { name?: string; phone?: string; instagram?: string; email?: string };

async function upsertCustomer(source: string, sourceId: string, patch: Record<string, unknown>, identity?: Identity) {
  const sb = admin();
  if (!sb) return { error: NO_DB };
  const payload = {
    source, source_id: sourceId,
    name: identity?.name ?? null, phone: identity?.phone ?? null,
    instagram: identity?.instagram ?? null, email: identity?.email ?? null,
    ...patch, updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from("crm_customers").upsert(payload, { onConflict: "source,source_id" });
  if (error) {
    const hint = /crm_customers/.test(error.message) ? " — شغّل supabase/crm_customers.sql مرة وحدة." : "";
    return { error: error.message + hint };
  }
  revalidatePath("/crm");
  return { ok: true as const };
}

export async function saveCustomerNote(source: "shopify" | "dm", sourceId: string, notes: string, identity?: Identity): Promise<{ ok?: true; error?: string }> {
  const guard = await requireUser();
  if (guard) return { error: guard.error };
  return upsertCustomer(source, sourceId, { notes: String(notes ?? "").slice(0, 4000) }, identity);
}

export async function setCustomerTags(source: "shopify" | "dm", sourceId: string, tags: string[], identity?: Identity): Promise<{ ok?: true; error?: string }> {
  const guard = await requireUser();
  if (guard) return { error: guard.error };
  const clean = Array.from(new Set((tags ?? []).map((t) => String(t).trim()).filter(Boolean))).slice(0, 12);
  return upsertCustomer(source, sourceId, { tags: clean }, identity);
}
