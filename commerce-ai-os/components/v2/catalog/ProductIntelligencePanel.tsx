// CAT.1E — Product Intelligence Panel (presentational, READ-ONLY). The single
// unified diagnostic surface for one product: Health · Evidence · Recommendations
// · Lifecycle · Channels · Export · AI · Timeline. It reuses the certified
// presentational cards and renders the composed intelligence model — it fetches
// nothing, mutates nothing, and executes nothing. Two-column on desktop, stacked
// on mobile (§11). Every derived conclusion references its evidence / rule /
// recommendation (§10).

import Link from "next/link";
import type { CatalogHealth } from "@/lib/catalog/health/health-model";
import type { EvidenceResult } from "@/lib/catalog/evidence/evidence-engine";
import type { Recommendation } from "@/lib/catalog/recommendations/recommendation-model";
import type { PlatformMatrixItem } from "@/lib/operations/platform-matrix";
import { MATRIX_STATE_LABELS } from "@/lib/operations/platform-matrix";
import type { ProductIntelligence } from "@/lib/catalog/intelligence/product-intelligence";
import CatalogHealthCard from "./CatalogHealthCard";
import EvidenceSection from "./EvidenceSection";
import RecommendationsPanel from "./RecommendationsPanel";

const EXPORT_TONE: Record<string, string> = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-700",
  blocked: "border-rose-200 bg-rose-50 text-rose-700",
  unknown: "border-slate-200 bg-slate-50 text-slate-500",
};
const EXPORT_LABEL: Record<string, string> = { ok: "جاهز للتصدير", blocked: "محجوب", unknown: "غير معروف" };
const AI_TONE: Record<string, string> = {
  ready: "border-emerald-200 bg-emerald-50 text-emerald-700",
  insufficient_facts: "border-amber-200 bg-amber-50 text-amber-700",
  unknown: "border-slate-200 bg-slate-50 text-slate-500",
};
const AI_LABEL: Record<string, string> = { ready: "حقائق كافية للإثراء", insufficient_facts: "حقائق غير كافية", unknown: "غير معروف" };

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="card space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {hint ? <span className="text-[11px] text-muted">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function LifecycleCard({ intel }: { intel: NonNullable<ProductIntelligence["lifecycle"]> }) {
  return (
    <Card title="دورة الحياة" hint="للقراءة فقط">
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-700">{intel.display}</span>
        <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-sky-700">الجاهزية {intel.readinessPercent}%</span>
        <span className={"rounded-full border px-2 py-0.5 " + (intel.approved ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700")}>
          {intel.approved ? "معتمد" : "غير معتمد"}
        </span>
        {intel.archived ? <span className="rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-slate-600">مؤرشف</span> : null}
        {intel.restoreAvailable ? <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-indigo-700">الاسترجاع متاح</span> : null}
      </div>
      {intel.blockingReasons.length > 0 ? (
        <ul className="space-y-1 text-xs text-muted">
          {intel.blockingReasons.map((r, i) => <li key={i}>• {r}</li>)}
        </ul>
      ) : null}
      <Link href="#lifecycle" className="inline-block text-xs text-brand hover:underline">إدارة دورة الحياة ↓</Link>
    </Card>
  );
}

function ChannelsCard({ channels }: { channels: PlatformMatrixItem }) {
  return (
    <Card title="القنوات" hint={channels.needsAttention ? `${channels.issueCount} بحاجة لمراجعة` : "متزامنة"}>
      <ul className="space-y-1.5">
        {channels.cells.map((c) => (
          <li key={c.platform} className="flex items-center justify-between gap-2 text-xs">
            <span className="text-ink">{c.label}</span>
            <span className="flex items-center gap-2">
              <span className="text-muted">{c.externalId ?? "—"}</span>
              <span className="rounded border border-[#e7d9c9] bg-white px-1.5 py-0.5 text-[11px] text-muted">{MATRIX_STATE_LABELS[c.state]}</span>
            </span>
          </li>
        ))}
      </ul>
      <Link href="#platforms" className="inline-block text-xs text-brand hover:underline">تفاصيل القنوات والربط ↓</Link>
    </Card>
  );
}

function ExportCard({ intel }: { intel: ProductIntelligence["export"] }) {
  return (
    <Card title="التصدير">
      <span className={"inline-block rounded-full border px-2 py-0.5 text-xs font-semibold " + (EXPORT_TONE[intel.status] ?? EXPORT_TONE.unknown)}>
        {EXPORT_LABEL[intel.status] ?? intel.status}
      </span>
      {intel.blockingIssues.length > 0 ? (
        <ul className="space-y-1 text-xs text-muted">
          {intel.blockingIssues.map((b, i) => <li key={i}>• {b}</li>)}
        </ul>
      ) : null}
      {intel.evidenceIds.length > 0 ? (
        <p className="text-[11px] text-muted">مبني على قاعدة التصدير المعتمدة (export_readiness.gate).</p>
      ) : null}
    </Card>
  );
}

function AiCard({ intel }: { intel: ProductIntelligence["ai"] }) {
  return (
    <Card title="الذكاء الاصطناعي" hint="حالة الجاهزية — للقراءة فقط">
      <span className={"inline-block rounded-full border px-2 py-0.5 text-xs font-semibold " + (AI_TONE[intel.status] ?? AI_TONE.unknown)}>
        {AI_LABEL[intel.status] ?? intel.status}
      </span>
      {intel.qualityNotes.length > 0 ? (
        <ul className="space-y-1 text-xs text-muted">
          {intel.qualityNotes.map((n, i) => <li key={i}>• {n}</li>)}
        </ul>
      ) : null}
      <Link href="/v2/operations/ai" className="inline-block text-xs text-brand hover:underline">مركز الذكاء (توليد/اعتماد) ↗</Link>
    </Card>
  );
}

export default function ProductIntelligencePanel({
  intelligence,
  health,
  evidence,
  recommendations,
  channels,
  timelineHref,
  timelineCount,
}: {
  intelligence: ProductIntelligence;
  health: CatalogHealth | null;
  evidence: EvidenceResult | null;
  recommendations: Recommendation[];
  channels: PlatformMatrixItem | null;
  timelineHref: string;
  timelineCount: number;
}) {
  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-slate-800">لوحة ذكاء المنتج</h2>
          <p className="text-xs text-muted">سطح تشخيصي موحّد للقراءة فقط — مدعوم بالكامل بالمحرّكات المعتمدة. كل استنتاج موضّح بأدلته وقواعده وتوصياته.</p>
        </div>
        <span className="text-xs font-medium text-ink">{intelligence.summary}</span>
      </div>

      {/* Two-column on desktop, stacked on mobile (§11). */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          {health ? <CatalogHealthCard health={health} /> : null}
          {evidence ? <EvidenceSection result={evidence} /> : null}
          {evidence ? <RecommendationsPanel recommendations={recommendations} evidence={evidence.evidence} /> : null}
        </div>
        <div className="space-y-4">
          {intelligence.lifecycle ? <LifecycleCard intel={intelligence.lifecycle} /> : null}
          {channels ? <ChannelsCard channels={channels} /> : null}
          <ExportCard intel={intelligence.export} />
          <AiCard intel={intelligence.ai} />
          <Card title="السجل" hint={`${timelineCount} حدث`}>
            <p className="text-xs text-muted">سجل موحّد لدورة الحياة والذكاء والتصدير والصحة والتوصيات.</p>
            <Link href={timelineHref} className="inline-block text-xs text-brand hover:underline">عرض النشاط الكامل ↓</Link>
          </Card>
        </div>
      </div>
    </div>
  );
}
