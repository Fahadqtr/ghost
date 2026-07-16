"use server";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth/requireUser";

export interface TalabatOrderRow {
  id: string; received_at: string | null; order_code: string | null; status: string | null;
  customer_name: string | null; total: number | null; currency: string | null;
  placed_at: string | null; items: { sku?: string; name?: string; quantity?: number; price?: number }[] | null;
  event: string | null;
}

/** Recent orders received from the Talabat webhook (newest first). */
export async function listTalabatOrders(limit = 100): Promise<{ ready: boolean; orders: TalabatOrderRow[]; error?: string }> {
  const unauth = await requireUser();
  if (unauth) return { ready: true, orders: [], error: unauth.error };
  let admin: any;
  try { admin = createAdminClient(); } catch (e: any) { return { ready: true, orders: [], error: e?.message || "الخادم غير مهيأ." }; }
  const { data, error } = await admin
    .from("talabat_orders")
    .select("id, received_at, order_code, status, customer_name, total, currency, placed_at, items, event")
    .order("received_at", { ascending: false })
    .limit(limit);
  if (error) {
    if ((error as any).code === "42P01" || /talabat_orders/.test(error.message)) return { ready: false, orders: [] };
    return { ready: true, orders: [], error: error.message };
  }
  return { ready: true, orders: (data ?? []) as TalabatOrderRow[] };
}

/** The webhook URL to register in the Talabat Vendor Portal (Order Webhook). */
export async function talabatWebhookUrl(): Promise<{ configured: boolean; url?: string }> {
  const unauth = await requireUser();
  if (unauth) return { configured: false };
  const token = String(process.env.TALABAT_WEBHOOK_TOKEN ?? "").trim().replace(/^["']|["']$/g, "");
  if (!token) return { configured: false };
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "";
  const proto = h.get("x-forwarded-proto") || "https";
  return { configured: true, url: host ? `${proto}://${host}/api/webhooks/talabat/${token}` : undefined };
}
