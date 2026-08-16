// OPS.3 — Channel Command Center (PRESENTATIONAL). A Server Component: it takes
// the pre-composed, read-only view (built server-side from the SAME aggregated
// read the main operations page performs) and renders the storefront-first cards,
// per-storefront detail, the unified alert feed, filtered queues, recent activity,
// filters, global search and quick-action links. It holds NO data client, issues
// NO queries and performs NO writes — it only orchestrates navigation to the
// EXISTING workflows (via next/link) and a native GET search form.

import Link from "next/link";
import type {
  StorefrontStatus,
  AlertLevel,
  StorefrontCard,
  ChannelAlert,
  ChannelQueue,
  ChannelCenterModel,
  ChannelFilters,
  SearchResult,
} from "@/lib/operations/channels/channel-center";
import {
  STOREFRONT_STATUS_LABEL,
  HEALTH_REASON_LABEL,
  ROUTES,
} from "@/lib/operations/channels/channel-center";

const STATUS_TONE: Record<StorefrontStatus, string> = {
  HEALTHY: "border-emerald-200 bg-emerald-50 text-emerald-700",
  WARNING: "border-amber-200 bg-amber-50 text-amber-700",
  ACTION_REQUIRED: "border-rose-200 bg-rose-50 text-rose-700",
  OPERATIONALLY_BLOCKED: "border-slate-300 bg-slate-100 text-slate-600",
  UNKNOWN: "border-slate-200 bg-slate-50 text-slate-500",
};
const ALERT_TONE: Record<AlertLevel, string> = {
  info: "border-sky-200 bg-sky-50 text-sky-700",
  warning: "border-amber-200 bg-amber-50 text-amber-700",
  action: "border-rose-200 bg-rose-50 text-rose-700",
};

const GRAIN_LABEL: Record<StorefrontCard["listingGrain"], string> = {
  product: "على مستوى المنتج",
  variant: "على مستوى المتغيّر",
};

function fmtDate(at: string | null): string {
  if (!at) return "—";
  return at.slice(0, 10);
}

function num(v: number | null): string {
  return v === null ? "—" : String(v);
}

function StorefrontDetail({ card }: { card: StorefrontCard }) {
  return (
    <div className={`rounded-xl border p-3 ${STATUS_TONE[card.status]}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-bold">{card.label}</div>
          <div className="text-[11px] opacity-80">
            {card.key} · {GRAIN_LABEL[card.listingGrain]} · {card.identityType}
          </div>
        </div>
        <span className="shrink-0 rounded-lg border border-current/20 bg-white/60 px-2 py-0.5 text-[11px] font-bold">
          {STOREFRONT_STATUS_LABEL[card.status]}
        </span>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-1.5 text-center sm:grid-cols-5">
        <Metric label="مرتبط" value={num(card.mapped)} />
        <Metric label="بحاجة ربط" value={num(card.missingMappings)} />
        <Metric label="مراجعة" value={num(card.needsReview)} />
        <Metric label="انحراف" value={num(card.availabilityDrift)} />
        <Metric label="صور ناقصة" value={num(card.missingImages)} />
      </div>

      {card.grainNote && <p className="mt-2 text-[11px] font-medium opacity-90">⚠ {card.grainNote}</p>}

      {card.reasons.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[11px] opacity-90">
          {card.reasons.map((r) => (
            <li key={r}>• {HEALTH_REASON_LABEL[r]}</li>
          ))}
        </ul>
      )}

      <div className="mt-2 text-[11px] opacity-70">آخر لقطة/مزامنة: {fmtDate(card.lastSyncAt)}</div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {card.actions.map((a) => (
          <Link
            key={a.key}
            href={a.href}
            className="rounded-lg border border-current/20 bg-white/70 px-2 py-1 text-[11px] font-semibold hover:bg-white"
          >
            {a.label} ↗
          </Link>
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-current/15 bg-white/50 px-1.5 py-1">
      <div className="text-sm font-bold">{value}</div>
      <div className="text-[10px] opacity-70">{label}</div>
    </div>
  );
}

function AlertRow({ alert }: { alert: ChannelAlert }) {
  return (
    <li>
      <Link href={alert.href} className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${ALERT_TONE[alert.level]}`}>
        <span>
          <span className="font-semibold">[{alert.type}]</span> {alert.reason}
        </span>
        <span className="opacity-70">↗</span>
      </Link>
    </li>
  );
}

function QueueCard({ queue }: { queue: ChannelQueue }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold text-slate-700">{queue.label}</h3>
        <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-bold text-slate-600">
          {queue.count === null ? "↗" : queue.count}
        </span>
      </div>
      {queue.entryPoint ? (
        <p className="mt-1 text-[11px] text-muted">يُحسب داخل مسار العمل المرتبط.</p>
      ) : queue.rows.length === 0 ? (
        <p className="mt-1 text-[11px] text-muted">لا عناصر.</p>
      ) : (
        <ul className="mt-1 space-y-0.5 text-[11px] text-slate-600">
          {queue.rows.map((r) => (
            <li key={`${queue.key}:${r.id}`} className="truncate">
              {r.sku ? `${r.sku} — ` : ""}
              {r.name ?? r.id}
              {r.storefront ? <span className="opacity-60"> · {r.storefront}</span> : null}
            </li>
          ))}
        </ul>
      )}
      <Link href={queue.href} className="mt-2 inline-block text-[11px] font-semibold text-sky-700 hover:underline">
        فتح المسار ↗
      </Link>
    </div>
  );
}

function activeFilterList(filters: ChannelFilters): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  if (filters.channel) out.push({ key: "channel", value: filters.channel });
  if (filters.storefront) out.push({ key: "storefront", value: filters.storefront });
  if (filters.status) out.push({ key: "status", value: filters.status });
  if (filters.issueType) out.push({ key: "issue", value: filters.issueType });
  if (filters.brand) out.push({ key: "brand", value: filters.brand });
  if (filters.category) out.push({ key: "category", value: filters.category });
  return out;
}

export default function ChannelCommandCenter({
  model,
  filtered,
  filters,
  search,
  degraded,
}: {
  model: ChannelCenterModel;
  filtered: { storefronts: StorefrontCard[]; alerts: ChannelAlert[]; queues: ChannelQueue[] };
  filters: ChannelFilters;
  search: SearchResult | null;
  degraded: boolean;
}) {
  const active = activeFilterList(filters);
  return (
    <section className="space-y-4">
      {degraded && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700" role="status">
          بعض المصادر تعذّرت قراءتها — بعض الأرقام قد تكون غير مكتملة (لا يُعتبر ذلك «ناقصًا»).
        </div>
      )}

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-slate-700">مركز قيادة القنوات</h2>
          <p className="text-[11px] text-muted">
            {model.counts.storefronts} واجهات · {model.counts.alerts} تنبيه · {model.counts.blocked} معطّلة تشغيليًا · متوسط الجاهزية {model.readinessAverage}%
          </p>
        </div>
        <span className={`rounded-lg border px-2.5 py-1 text-xs font-bold ${STATUS_TONE[model.overallStatus]}`}>
          الحالة العامة: {STOREFRONT_STATUS_LABEL[model.overallStatus]}
        </span>
      </div>

      {/* Global search (native GET — no client JS, no writes) */}
      <form action="/v2/operations/channels" method="get" className="flex flex-wrap gap-2">
        <input
          type="search"
          name="q"
          defaultValue={search?.query ?? ""}
          placeholder="بحث: SKU · باركود · اسم · SPI · Shopify GID · Rafeeq ID"
          className="min-w-[16rem] flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
        />
        <button type="submit" className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">
          بحث
        </button>
      </form>

      {search && (
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <h3 className="text-xs font-bold text-slate-700">نتائج البحث: «{search.query}»</h3>
          {search.local.length === 0 && search.external.length === 0 ? (
            <p className="mt-1 text-[11px] text-muted">لا نتائج مطابقة (بحث دقيق فقط — بدون تخمين).</p>
          ) : (
            <ul className="mt-1 space-y-0.5 text-[11px] text-slate-600">
              {[...search.local, ...search.external].map((m) => (
                <li key={`${m.matchedOn}:${m.id}`} className="truncate">
                  {m.sku ? `${m.sku} — ` : ""}
                  {m.name ?? m.id}
                  <span className="opacity-60"> · {m.matchedOn === "external" ? `هوية خارجية (${m.storefront})` : m.matchedOn}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Active filters */}
      {active.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="text-muted">المرشّحات:</span>
          {active.map((f) => (
            <span key={f.key} className="rounded-md bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-600">
              {f.key}: {f.value}
            </span>
          ))}
          <Link href={ROUTES.channels} className="text-sky-700 hover:underline">
            مسح ✕
          </Link>
        </div>
      )}

      {/* Filter chips (channel / storefront / status) — GET links, no client JS */}
      <div className="flex flex-wrap gap-1.5">
        {model.filters.channels.map((c) => (
          <Link key={`ch:${c}`} href={`${ROUTES.channels}?channel=${encodeURIComponent(c)}`} className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50">
            {c}
          </Link>
        ))}
        {model.filters.statuses.map((s) => (
          <Link key={`st:${s}`} href={`${ROUTES.channels}?status=${s}`} className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-500 hover:bg-slate-50">
            {STOREFRONT_STATUS_LABEL[s]}
          </Link>
        ))}
      </div>

      {/* Storefront-first cards */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {filtered.storefronts.map((card) => (
          <StorefrontDetail key={card.key} card={card} />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Alerts */}
        <div className="card space-y-2">
          <h2 className="text-sm font-bold text-slate-700">التنبيهات الموحّدة</h2>
          {filtered.alerts.length === 0 ? (
            <p className="text-xs text-muted">لا تنبيهات — كل شيء على ما يرام.</p>
          ) : (
            <ul className="space-y-1.5">
              {filtered.alerts.map((a) => (
                <AlertRow key={a.key} alert={a} />
              ))}
            </ul>
          )}
        </div>

        {/* Recent activity */}
        <div className="card space-y-2">
          <h2 className="text-sm font-bold text-slate-700">النشاط الأخير (لقطات)</h2>
          <ul className="space-y-1 text-xs text-slate-600">
            {model.activity.map((e) => (
              <li key={e.storefront} className="flex items-center justify-between border-t border-slate-100 py-1 first:border-0">
                <span>{e.label}</span>
                <span className="opacity-70">{fmtDate(e.at)}</span>
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-muted">
            المصدر الموثوق الوحيد المشترك حاليًا هو وقت اللقطة لكل واجهة — سجل الأحداث التفصيلي عبر القنوات مؤجّل إلى OPS.4.
          </p>
        </div>
      </div>

      {/* Queues */}
      <div className="space-y-2">
        <h2 className="text-sm font-bold text-slate-700">قوائم العمل</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.queues.map((q) => (
            <QueueCard key={q.key} queue={q} />
          ))}
        </div>
      </div>

      {/* Quick actions */}
      <div className="flex flex-wrap gap-2">
        {model.quickActions.map((a) => (
          <Link key={a.key} href={a.href} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">
            {a.label} ↗
          </Link>
        ))}
      </div>
    </section>
  );
}
