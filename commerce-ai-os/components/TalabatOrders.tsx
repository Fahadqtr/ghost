"use client";

import { useEffect, useState } from "react";
import { listTalabatOrders, talabatWebhookUrl, type TalabatOrderRow } from "@/app/(app)/import-export/talabat-orders/actions";

// Talabat order-webhook viewer: shows the URL to register in the Vendor Portal
// and the orders received so far (raw payload captured server-side).
export default function TalabatOrders({ locale = "ar" }: { locale?: "ar" | "en" }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);

  const [url, setUrl] = useState<{ configured: boolean; url?: string } | null>(null);
  const [ready, setReady] = useState(true);
  const [orders, setOrders] = useState<TalabatOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    try { setUrl(await talabatWebhookUrl()); } catch { /* optional */ }
    try { const r = await listTalabatOrders(); setReady(r.ready); setOrders(r.orders); } catch { /* ignore */ }
    setLoading(false);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, []);

  const copy = async () => { if (!url?.url) return; try { await navigator.clipboard.writeText(url.url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } };

  const statusColor = (s: string | null) => {
    const v = String(s || "").toUpperCase();
    if (v.includes("CANCEL")) return "bg-red-100 text-red-700";
    if (v.includes("DELIVER")) return "bg-emerald-100 text-emerald-700";
    if (v.includes("READY") || v.includes("DISPATCH")) return "bg-amber-100 text-amber-800";
    return "bg-slate-100 text-slate-600";
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-ink">{L("طلبات Talabat", "Talabat orders")}</h2>
        <p className="text-sm text-muted">{L("الطلبات الواردة من Talabat عبر Webhook. سجّل الرابط في بوابة التاجر (Order Webhook).", "Orders received from Talabat via webhook. Register the URL in the Vendor Portal (Order Webhook).")}</p>
      </div>

      {/* Webhook URL to register */}
      <div className="card space-y-2">
        <p className="text-sm font-semibold text-ink">🔗 {L("رابط الـ Webhook", "Webhook URL")}</p>
        {url?.configured && url.url ? (
          <>
            <div className="flex items-center gap-2">
              <input readOnly value={url.url} dir="ltr" onFocus={(e) => e.target.select()}
                className="w-full truncate rounded-lg border border-[#efe3d6] bg-white px-2 py-1 font-mono text-[10px]" />
              <button onClick={copy} className="btn-ghost shrink-0 px-2 py-1 text-[11px]">{copied ? L("نُسخ ✓", "Copied ✓") : L("نسخ", "Copy")}</button>
            </div>
            <p className="text-[10px] text-muted">{L("في بوابة Talabat: Settings → API → Order Webhook Settings → الصق الرابط.", "In the Talabat portal: Settings → API → Order Webhook Settings → paste this URL.")}</p>
          </>
        ) : (
          <p className="text-[11px] text-amber-800" dir="ltr">Set <code>TALABAT_WEBHOOK_TOKEN</code> (any random secret) in Vercel + Redeploy, then register the URL shown here.</p>
        )}
      </div>

      {/* Orders list */}
      {!ready ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          {L("شغّل", "Run")} <code className="rounded bg-white px-1">supabase/talabat_orders.sql</code> {L("مرة وحدة في Supabase، ثم حدّث.", "once in Supabase, then refresh.")}
        </div>
      ) : loading ? (
        <div className="card text-sm text-muted">{L("يحمّل…", "Loading…")}</div>
      ) : orders.length === 0 ? (
        <div className="card text-sm text-muted">{L("ما وصل أي طلب بعد. سجّل الرابط في بوابة Talabat وأرسل طلب تجريبي.", "No orders yet. Register the URL in the Talabat portal and send a test order.")}</div>
      ) : (
        <div className="space-y-2">
          {orders.map((o) => (
            <div key={o.id} className="card space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-bold text-ink">{o.order_code || "—"}</span>
                <span className={`badge ${statusColor(o.status)}`}>{o.status || "—"}</span>
                {o.total != null ? <span className="text-xs text-muted">{o.total} {o.currency || "QAR"}</span> : null}
                <span className="ms-auto text-[10px] text-muted" dir="ltr">{o.received_at ? new Date(o.received_at).toLocaleString() : ""}</span>
              </div>
              {o.customer_name ? <p className="text-xs text-ink">👤 {o.customer_name}</p> : null}
              {Array.isArray(o.items) && o.items.length ? (
                <ul className="text-[11px] text-muted">
                  {o.items.map((it, i) => (
                    <li key={i} dir="auto">• {it.quantity ?? 1}× {it.name || it.sku || "—"}{it.sku ? ` (${it.sku})` : ""}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
