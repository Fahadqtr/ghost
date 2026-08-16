// /v2/analytics — Executive Dashboard (BI.2). The landing page for management.
//
// Server Component, READ-ONLY. It makes ONE analytics request (BI.1 loadAnalytics,
// via loadExecutiveDashboard) for the KPI header, Sales, Inventory, Catalog Quality
// and Operations Summary, then STREAMS the heavier operational widgets (Channel
// Overview, Platform Health + Alerts) through Suspense so the primary view paints
// immediately. It consumes the BI.1 analytics layer and the certified OPS read
// models only — it never queries a business table and never mutates anything.

import { Suspense } from "react";

import { loadExecutiveDashboard, getDashboardChannels, getDashboardHealth } from "@/lib/analytics/executive-dashboard.server";
import { parseSearchField, sanitizeQuery } from "@/lib/analytics/executive-dashboard";
import ExecutiveDashboard from "@/components/v2/analytics/ExecutiveDashboard";
import { ChannelOverview, HealthAndAlerts, PlatformHealthChip } from "@/components/v2/analytics/DashboardSections";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function CardSkeleton({ lines = 2 }: { lines?: number }) {
  return (
    <section className="card space-y-2" aria-busy="true">
      <div className="h-4 w-40 animate-pulse rounded bg-slate-200" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: lines * 3 }).map((_, i) => (
          <div key={i} className="h-14 animate-pulse rounded-lg bg-slate-100" />
        ))}
      </div>
    </section>
  );
}

// ── Streamed operational sections (reuse certified OPS read models) ──────────────

async function PlatformHealthSlot() {
  const health = await getDashboardHealth();
  if ("error" in health) return <PlatformHealthChip status="UNKNOWN" />;
  return <PlatformHealthChip status={health.model.overall.status} />;
}

async function ChannelSlot() {
  const channels = await getDashboardChannels();
  if ("error" in channels) {
    return (
      <section className="card text-xs text-amber-600" role="status">
        تعذّر تحميل نظرة القنوات الآن.
      </section>
    );
  }
  return <ChannelOverview cards={channels.filtered.storefronts} degraded={channels.degraded} />;
}

async function HealthSlot() {
  const health = await getDashboardHealth();
  if ("error" in health) {
    return (
      <section className="card text-xs text-amber-600" role="status">
        تعذّر تحميل صحة المنصّة الآن.
      </section>
    );
  }
  return <HealthAndAlerts model={health.model} degraded={health.degraded} />;
}

export default async function AnalyticsPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const searchField = parseSearchField(params.field);
  const searchQuery = sanitizeQuery(params.q);

  const view = await loadExecutiveDashboard();

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-lg font-bold text-slate-800">لوحة الإدارة التنفيذية</h1>
        <p className="text-sm text-muted">
          نظرة موحّدة للقراءة فقط لأصحاب العمل والمديرين: المبيعات، المخزون، القنوات، جودة الكتالوج، العمليات وصحة المنصّة.
          المؤشّرات غير المتوفّرة تُعرض كـ «—» ولا تُختلق. تعتمد اللوحة على طبقة التحليلات (BI.1) ومراكز العمليات المعتمدة فقط.
        </p>
      </header>

      <ExecutiveDashboard
        view={view}
        searchField={searchField}
        searchQuery={searchQuery}
        platformHealthSlot={
          <Suspense fallback={<div className="h-full min-h-[72px] animate-pulse rounded-xl bg-slate-100" />}>
            <PlatformHealthSlot />
          </Suspense>
        }
        channelSlot={
          <Suspense fallback={<CardSkeleton />}>
            <ChannelSlot />
          </Suspense>
        }
        healthSlot={
          <Suspense fallback={<CardSkeleton lines={3} />}>
            <HealthSlot />
          </Suspense>
        }
      />
    </div>
  );
}
