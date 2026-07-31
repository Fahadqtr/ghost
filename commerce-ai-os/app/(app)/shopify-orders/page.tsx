import Link from "next/link";
import { shopifyConfigured, fetchRecentShopifyOrders } from "@/lib/shopify/admin";
import { ordersSummary, ordersWithin, classifyShopifyOrderChannel } from "@/lib/shopify/orders-compute";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const QAT = "Asia/Qatar";
const fmtTime = (iso: string) =>
  new Intl.DateTimeFormat("ar", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: QAT }).format(new Date(iso));

const FIN_AR: Record<string, string> = { PAID: "مدفوع", PENDING: "بانتظار الدفع", REFUNDED: "مسترجع", PARTIALLY_REFUNDED: "مسترجع جزئيًا", AUTHORIZED: "مفوَّض" };
const FUL_AR: Record<string, string> = { FULFILLED: "مُجهَّز", UNFULFILLED: "غير مُجهَّز", PARTIALLY_FULFILLED: "مُجهَّز جزئيًا", SCHEDULED: "مجدول", ON_HOLD: "معلّق" };

// Impure clock reads live outside the component render (react-hooks/purity).
async function loadOrders() {
  const now = new Date();
  const since = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
  const { orders, error } = await fetchRecentShopifyOrders(since, 100);
  const list = orders ?? [];
  return { list, error, day: ordersSummary(ordersWithin(list, 24, now)), week: ordersSummary(list) };
}

export default async function ShopifyOrdersPage() {
  if (!shopifyConfigured()) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <h2 className="text-lg font-semibold text-ink">🛍️ طلبات شوبي فاي</h2>
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          شوبي فاي غير مربوط — أكمل الربط من /api/shopify/install.
        </div>
      </div>
    );
  }

  const { list, error, day, week } = await loadOrders();

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <div>
        <Link href="/import-export/shopify-sync" className="text-sm text-brand hover:underline">↔ Shopify Sync</Link>
        <h2 className="text-lg font-semibold text-ink">🛍️ طلبات شوبي فاي</h2>
        <p className="text-sm text-muted">آخر 7 أيام مباشرة من المتجر — يظهر ملخصها أيضًا في تنبيه الصباح.</p>
      </div>

      {error ? <div className="card border-red-200 bg-red-50 text-sm text-red-700">{error}</div> : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {([["طلبات اليوم", day.count], ["مبيعات اليوم", `${day.revenue.toFixed(0)} ر.ق`], ["طلبات الأسبوع", week.count], ["مبيعات الأسبوع", `${week.revenue.toFixed(0)} ر.ق`]] as const).map(([label, v]) => (
          <div key={label} className="card p-3 text-center">
            <div className="text-xl font-bold text-ink">{v}</div>
            <div className="text-xs text-muted">{label}</div>
          </div>
        ))}
      </div>

      {list.length === 0 && !error ? (
        <div className="card text-center text-sm text-muted">ما في طلبات خلال آخر 7 أيام 💤</div>
      ) : (
        <div className="space-y-2">
          {list.map((o) => (
            <div key={o.id} className="card space-y-1.5 p-3" dir="rtl">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-sm font-bold text-ink">
                  {o.name} {o.customer ? `· ${o.customer}` : ""}
                  {classifyShopifyOrderChannel(o.paymentGatewayNames) === "talabat" ? (
                    <span className="rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-semibold text-orange-700">Talabat</span>
                  ) : (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">Shopify</span>
                  )}
                </span>
                <span className="text-sm font-semibold text-ink">{Number.isFinite(o.total) ? `${o.total.toFixed(2)} ${o.currency}` : "—"}</span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                <span>
                  <span className={o.financial === "PAID" ? "text-green-700" : "text-amber-700"}>{FIN_AR[o.financial] ?? o.financial}</span>
                  {" · "}
                  <span className={o.fulfillment === "FULFILLED" ? "text-green-700" : "text-amber-700"}>{FUL_AR[o.fulfillment] ?? o.fulfillment}</span>
                </span>
                <span>{fmtTime(o.createdAt)}</span>
              </div>
              {o.items.length ? (
                <div className="text-xs text-muted">{o.items.map((i) => `${i.title} ×${i.qty}`).join("، ")}</div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
