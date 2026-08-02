// Read-only Order Operations console (Phase 2B.3B).
//
// A Server Component that renders a unified, PII-safe view of Shopify + Talabat
// order processing. It performs NO mutation, NO server action, NO API route, NO
// external fetch, NO RPC. It authenticates only through the existing (app) layout
// (which redirects unauthenticated users to /login) and reads through the
// validated Phase 2B.3A Supabase adapter + Phase 2B.2 data layer. On ANY
// unexpected failure it shows a single constant Arabic message — never an error
// message, stack, code, table, column, or raw JSON.

import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createSupabaseOrderOpsReadClient } from "@/lib/orders/order-ops-supabase";
import { loadOrderOpsData } from "@/lib/orders/order-ops-data";
import type { OrderOpsRow } from "@/lib/orders/order-ops-compute";
import {
  ATTENTION_OPTIONS,
  CHANNEL_OPTIONS,
  SOURCE_OPTIONS,
  STATUS_OPTIONS,
  filterOrderOpsRows,
  formatOrderOpsDate,
  getChannelLabel,
  getReasonLabel,
  getSignalKindLabel,
  getSignalStateLabel,
  getSourceLabel,
  getStatusLabel,
  isMalformedIdentity,
  parseOrderOpsViewFilters,
  sortOrderOpsRows,
  summarizeVisibleRows,
  visibleSignals,
} from "@/lib/orders/order-ops-view";

export const dynamic = "force-dynamic";

const LOAD_ERROR = "تعذر تحميل لوحة عمليات الطلبات.";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function OrderOperationsPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  // Data loading is isolated in try/catch; JSX is constructed only AFTER, outside
  // the try, so React rendering errors are never swallowed here (they surface to
  // the route's error boundary instead).
  let loaded: {
    result: Awaited<ReturnType<typeof loadOrderOpsData>>;
    filters: ReturnType<typeof parseOrderOpsViewFilters>;
    visibleRows: OrderOpsRow[];
    summary: ReturnType<typeof summarizeVisibleRows>;
  } | null = null;

  try {
    const params = searchParams ? await searchParams : {};
    const filters = parseOrderOpsViewFilters(params);

    // createClient() is used ONLY here (page boundary). The real Supabase SSR
    // client is passed, unmodified and un-cast, into the validated read adapter —
    // proving structural compatibility at build time.
    const supabase = createClient();
    const readClient = createSupabaseOrderOpsReadClient(supabase);
    const result = await loadOrderOpsData(readClient, { limit: 100 });

    const visibleRows = sortOrderOpsRows(filterOrderOpsRows(result.rows, filters));
    const summary = summarizeVisibleRows(visibleRows);
    loaded = { result, filters, visibleRows, summary };
  } catch {
    loaded = null;
  }

  if (loaded === null) {
    // Constant, PII-safe failure. No error message/stack/code/table/column/JSON,
    // no logging of the error, no fake success.
    return (
      <div dir="rtl" className="mx-auto w-full max-w-5xl space-y-4">
        <h2 className="text-lg font-semibold text-ink">عمليات الطلبات</h2>
        <div className="card border-red-200 bg-red-50 text-sm text-red-700">{LOAD_ERROR}</div>
      </div>
    );
  }

  const { result, filters, visibleRows, summary } = loaded;
  const anyRows = result.rows.length > 0;

  return (
    <div dir="rtl" className="mx-auto w-full max-w-5xl space-y-4">
        {/* Header */}
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-ink">عمليات الطلبات</h2>
            <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
              قراءة فقط
            </span>
          </div>
          <p className="text-sm text-muted">متابعة موحدة لطلبات Shopify وTalabat — قراءة فقط</p>
        </div>

        {/* Partial-result warning */}
        {result.scope === "partial" ? (
          <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
            النتائج جزئية لأن أحد مصادر الطلبات غير متاح.
          </div>
        ) : null}

        {/* Per-source cards */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {/* Talabat */}
          <div className="card space-y-1 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-ink">Talabat</span>
              <SourceStatusBadge ok={result.sources.talabat.status === "ok"} />
            </div>
            {result.sources.talabat.status === "ok" ? (
              <>
                <div className="text-muted">الطلبات المقروءة: {result.sources.talabat.returned}</div>
                {result.sources.talabat.hasMore ? (
                  <div className="text-xs text-amber-700">توجد نتائج إضافية غير معروضة ضمن هذه الصفحة.</div>
                ) : null}
              </>
            ) : (
              <div className="text-red-700">تعذر قراءة طلبات Talabat.</div>
            )}
          </div>

          {/* Shopify */}
          <div className="card space-y-1 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-ink">Shopify</span>
              <SourceStatusBadge ok={result.sources.shopify.status === "ok"} />
            </div>
            {result.sources.shopify.status === "ok" ? (
              <>
                <div className="text-muted">الطلبات المقروءة: {result.sources.shopify.returned}</div>
                <div className="text-xs text-muted">{shopifyLedgerLabel(result.sources.shopify)}</div>
                {result.sources.shopify.hasMore ? (
                  <div className="text-xs text-amber-700">توجد نتائج إضافية غير معروضة ضمن هذه الصفحة.</div>
                ) : null}
              </>
            ) : (
              <div className="text-red-700">تعذر قراءة سجل Shopify.</div>
            )}
          </div>
        </div>

        {/* Visible-rows summary */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <SummaryCard label="الطلبات الظاهرة" value={summary.visibleTotal} />
          <SummaryCard label="تحتاج متابعة" value={summary.needsAttention} />
          <SummaryCard label="مراجعة يدوية" value={summary.manualReview} />
          <SummaryCard label="فاشلة" value={summary.failed} />
          <SummaryCard label="محظورة" value={summary.blocked} />
        </div>

        {/* Filters (GET form — no client JS, no polling) */}
        <form method="get" className="card grid grid-cols-1 gap-2 p-3 sm:grid-cols-6">
          <FilterSelect name="source" label="المصدر" defaultValue={filters.source} options={SOURCE_OPTIONS} />
          <FilterSelect name="channel" label="القناة" defaultValue={filters.channel} options={CHANNEL_OPTIONS} />
          <FilterSelect name="status" label="الحالة" defaultValue={filters.status} options={STATUS_OPTIONS} />
          <FilterSelect name="attention" label="المتابعة" defaultValue={filters.attention} options={ATTENTION_OPTIONS} />
          <label className="flex flex-col gap-1 text-xs text-muted sm:col-span-2">
            بحث (رقم الطلب)
            <input
              type="search"
              name="query"
              defaultValue={filters.query}
              maxLength={80}
              placeholder="رقم الطلب أو المعرّف"
              className="rounded border border-slate-200 bg-white px-2 py-1 text-sm text-ink"
            />
          </label>
          <div className="flex items-end gap-2 sm:col-span-6">
            <button
              type="submit"
              className="rounded bg-brand px-3 py-1.5 text-sm font-semibold text-white"
            >
              تطبيق
            </button>
            <Link href="/order-operations" className="text-sm text-brand hover:underline">
              مسح الفلاتر
            </Link>
          </div>
        </form>

        {/* Rows */}
        {!anyRows ? (
          <div className="card text-center text-sm text-muted">لا توجد طلبات متاحة للعرض.</div>
        ) : visibleRows.length === 0 ? (
          <div className="card text-center text-sm text-muted">لا توجد نتائج مطابقة للفلاتر الحالية.</div>
        ) : (
          <div className="space-y-2">
            {visibleRows.map((row, i) => {
              const reason = getReasonLabel(row.reasonCode);
              const signals = visibleSignals(row);
              return (
                <div
                  key={`${row.source}:${row.sourceOrderId}:${row.displayOrderCode}:${i}`}
                  className="card space-y-1.5 p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-bold text-ink">{row.displayOrderCode}</span>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                        {getSourceLabel(row.source)}
                      </span>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                        {getChannelLabel(row.channel)}
                      </span>
                      {isMalformedIdentity(row) ? (
                        <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">
                          معرّف غير صالح
                        </span>
                      ) : null}
                    </span>
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                      {getStatusLabel(row.status)}
                    </span>
                  </div>

                  {reason ? <div className="text-xs text-muted">السبب: {reason}</div> : null}

                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                    <span>صفوف مخزون محدثة: {row.deductedRows === null ? "—" : row.deductedRows}</span>
                    <span>الإنشاء: {formatOrderOpsDate(row.createdAt)}</span>
                    <span>المعالجة: {formatOrderOpsDate(row.processedAt)}</span>
                  </div>

                  {signals.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {signals.map((s, j) => (
                        <span
                          key={`${s.kind}:${j}`}
                          className={
                            s.state === "flagged"
                              ? "rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-700"
                              : "rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600"
                          }
                        >
                          {getSignalKindLabel(s.kind)} · {getSignalStateLabel(s.state)}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
  );
}

function SourceStatusBadge({ ok }: { ok: boolean }) {
  return ok ? (
    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">متاح</span>
  ) : (
    <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">غير متاح</span>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="card p-3 text-center">
      <div className="text-xl font-bold text-ink">{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}

function FilterSelect<T extends string>({
  name,
  label,
  defaultValue,
  options,
}: {
  name: string;
  label: string;
  defaultValue: T;
  options: readonly { value: T; label: string }[];
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      {label}
      <select
        name={name}
        defaultValue={defaultValue}
        className="rounded border border-slate-200 bg-white px-2 py-1 text-sm text-ink"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// Fixed Shopify-ledger labels. NEVER infer OAuth / Cron / Token state.
function shopifyLedgerLabel(shopify: { ledger: "empty" | "populated" | "unavailable"; ledgerReasonCode: "no_synced_orders" | null }): string {
  if (shopify.ledger === "populated") return "سجل Shopify متوفر.";
  if (shopify.ledger === "empty" && shopify.ledgerReasonCode === "no_synced_orders") {
    return "لا توجد طلبات Shopify متزامنة.";
  }
  return "سجل Shopify غير متاح حاليًا.";
}
