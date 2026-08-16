"use client";

// CH.6F — Missing Products Discovery & Repair wizard.
//
// SCAN → CLASSIFY → PREVIEW → SELECT → CONFIRM → APPLY. The scan is read-only;
// ECL repair + product import are writer-gated inside the server actions. This
// component never writes and never holds a DB client — it calls the actions,
// which route writes through the approved ECL insert boundary / create core.
// Only deterministic MISSING_ECL rows and import-eligible EXTERNAL_ONLY rows are
// selectable; conflicts/needs-review are shown for transparency but never
// actionable in bulk (no "Fix All" for conflicts).

import { useMemo, useState, useTransition } from "react";
import {
  scanMissingProductsAction,
  applyEclRepairsAction,
  importExternalOnlyAction,
} from "@/app/(v2)/v2/operations/missing-products-actions";
import type { ScanResult, ApplyResult, ImportSelection } from "@/lib/missing-products/discovery.server";
import type { GapItem } from "@/lib/missing-products/discovery-plan";
import { STATUS_LABEL_AR, type GapStatus } from "@/lib/missing-products/discovery-model";

type Storefront = { key: string; label: string };
type Tab = "internal" | "external" | "problems";

const CONFLICT: GapStatus[] = ["IDENTITY_CONFLICT", "SKU_CONFLICT", "BARCODE_CONFLICT", "VARIANT_CONFLICT"];
const PROBLEM_TAB: GapStatus[] = [...CONFLICT, "NEEDS_REVIEW", "ARCHIVED_INTERNAL"];
const INTERNAL_TAB: GapStatus[] = ["MAPPED_OK", "INTERNAL_ONLY", "MISSING_ECL"];

const STATUS_TONE: Record<string, string> = {
  MAPPED_OK: "border-emerald-200 bg-emerald-50 text-emerald-700",
  INTERNAL_ONLY: "border-sky-200 bg-sky-50 text-sky-700",
  EXTERNAL_ONLY: "border-indigo-200 bg-indigo-50 text-indigo-700",
  MISSING_ECL: "border-amber-200 bg-amber-50 text-amber-700",
  NEEDS_REVIEW: "border-slate-200 bg-slate-50 text-slate-600",
  ARCHIVED_INTERNAL: "border-slate-200 bg-slate-50 text-slate-500",
};
const conflictTone = "border-rose-200 bg-rose-50 text-rose-700";
const toneFor = (s: string) => STATUS_TONE[s] ?? conflictTone;

const REASON_AR: Record<string, string> = {
  ecl_active: "هوية ECL نشطة",
  external_evidence_present: "دليل خارجي موجود",
  no_active_ecl: "لا توجد هوية ECL نشطة",
  no_listing_for_storefront: "لا يوجد إدراج على هذه الواجهة",
  multiple_active_ecl: "أكثر من هوية نشطة",
  ecl_needs_review: "هوية محل نزاع/مراجعة",
  parent_level_mapping_hides_variant: "ربط على مستوى المنتج يُخفي خيارًا ناقصًا",
  external_present_no_identity: "موجود خارجيًا بلا هوية حتمية",
  ecl_points_to_missing_product: "هوية تشير إلى منتج غير موجود (مؤرشف)",
  no_internal_match: "لا مطابقة داخلية",
  ambiguous_external_match: "مطابقة خارجية غامضة",
  insufficient_data: "بيانات غير كافية",
  internal_archived: "مؤرشف داخليًا",
};
const EVIDENCE_AR: Record<string, string> = {
  ecl_active: "هوية ECL نشطة",
  external_id: "معرّف خارجي مطابق",
  sku: "SKU مطابق",
  barcode: "باركود مطابق",
  variant_sku: "SKU خيار مطابق",
  none: "—",
};

function Stat({ label, value, tone, active, onClick }: { label: string; value: number; tone: string; active?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border px-3 py-2 text-center transition ${tone} ${active ? "ring-2 ring-offset-1 ring-slate-400" : ""}`}
    >
      <div className="text-lg font-bold">{value}</div>
      <div className="text-[11px] font-medium opacity-80">{label}</div>
    </button>
  );
}

export default function MissingProducts({
  canWrite,
  storefronts,
  categories,
}: {
  canWrite: boolean;
  storefronts: Storefront[];
  categories: string[];
}) {
  const [storefront, setStorefront] = useState<string>(storefronts[0]?.key ?? "");
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [tab, setTab] = useState<Tab>("internal");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [skuFilter, setSkuFilter] = useState<string>("");
  const [selectedEcl, setSelectedEcl] = useState<Set<string>>(new Set());
  const [selectedImport, setSelectedImport] = useState<Set<string>>(new Set());
  const [importCategory, setImportCategory] = useState<string>("");
  const [results, setResults] = useState<ApplyResult | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const items = useMemo(() => scan?.items ?? [], [scan]);

  function reset() {
    setScan(null); setResults(null); setSelectedEcl(new Set()); setSelectedImport(new Set()); setMsg(null); setStatusFilter(""); setSkuFilter("");
  }

  function runScan() {
    reset();
    startTransition(async () => {
      const res = await scanMissingProductsAction(storefront);
      if ("error" in res) { setMsg({ ok: false, text: res.error }); return; }
      setScan(res);
      if (res.provenance.externalSourceState === "session_required") {
        setMsg({ ok: true, text: "لا يوجد مصدر إدراج خارجي مفعّل — اكتشاف \"خارجي فقط\" معطّل حتى تفعيل مصدر رسمي (آمن). النتائج تعتمد على ECL واللقطات المحفوظة." });
      }
    });
  }

  const filtered = useMemo(() => {
    const tabStatuses = tab === "internal" ? INTERNAL_TAB : tab === "external" ? (["EXTERNAL_ONLY"] as GapStatus[]) : PROBLEM_TAB;
    const sku = skuFilter.trim().toLowerCase();
    return items.filter((it) => {
      if (!tabStatuses.includes(it.status)) return false;
      if (statusFilter && it.status !== statusFilter) return false;
      if (sku && !`${it.sku ?? ""} ${it.externalSku ?? ""}`.toLowerCase().includes(sku)) return false;
      return true;
    });
  }, [items, tab, statusFilter, skuFilter]);

  const eclCandidates = useMemo(() => items.filter((it) => it.status === "MISSING_ECL" && it.confidence === "DETERMINISTIC"), [items]);
  const importCandidates = useMemo(() => items.filter((it) => it.status === "EXTERNAL_ONLY" && it.importEligibility === "IMPORT_ELIGIBLE"), [items]);

  const s = scan?.summary.byStatus;
  const conflictCount = s ? CONFLICT.reduce((n, k) => n + (s[k] ?? 0), 0) : 0;

  function toggle(set: Set<string>, key: string, setter: (v: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    setter(next);
  }

  function applyEcl() {
    if (!canWrite || selectedEcl.size === 0) return;
    setResults(null); setMsg(null);
    startTransition(async () => {
      const res = await applyEclRepairsAction(storefront, [...selectedEcl]);
      if ("error" in res) { setMsg({ ok: false, text: res.error }); return; }
      setResults(res);
      setMsg({ ok: true, text: `تم: ربط ${res.summary.mapped} · دون تغيير ${res.summary.unchanged} · قديم ${res.summary.stale} · فشل ${res.summary.failed}` });
      runScanSilent();
    });
  }

  function applyImport() {
    if (!canWrite || selectedImport.size === 0) return;
    if (!importCategory) { setMsg({ ok: false, text: "اختر تصنيفًا للمنتجات المستوردة أولًا." }); return; }
    const selections: ImportSelection[] = importCandidates
      .filter((it) => selectedImport.has(it.key))
      .map((it) => ({ key: it.key, title: it.externalTitle, sku: it.externalSku, barcode: it.externalBarcode, externalId: it.externalId, price: null }));
    setResults(null); setMsg(null);
    startTransition(async () => {
      const res = await importExternalOnlyAction(storefront, importCategory, "", selections);
      if ("error" in res) { setMsg({ ok: false, text: res.error }); return; }
      setResults(res);
      setMsg({ ok: true, text: `تم الاستيراد: أنشئ ${res.summary.created} · قديم ${res.summary.stale} · فشل ${res.summary.failed}` });
      runScanSilent();
    });
  }

  function runScanSilent() {
    startTransition(async () => {
      const res = await scanMissingProductsAction(storefront);
      if (!("error" in res)) { setScan(res); setSelectedEcl(new Set()); setSelectedImport(new Set()); }
    });
  }

  return (
    <div className="space-y-4">
      {/* Step 1 — storefront */}
      <section className="card space-y-2">
        <div className="text-xs font-semibold text-slate-500">الخطوة 1 — اختر القناة/الواجهة</div>
        <div className="flex flex-wrap gap-2">
          {storefronts.map((sf) => (
            <button
              key={sf.key}
              type="button"
              onClick={() => { setStorefront(sf.key); reset(); }}
              className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${storefront === sf.key ? "border-slate-800 bg-slate-800 text-white" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
            >
              {sf.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 pt-1">
          <button type="button" onClick={runScan} disabled={isPending || !storefront} className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {isPending ? "جارٍ الفحص…" : "الخطوة 2 — فحص"}
          </button>
          {scan && <span className="text-xs text-muted">إجمالي: {scan.summary.total} · منتج {scan.summary.productGrainTotal} · خيار {scan.summary.variantGrainTotal}</span>}
        </div>
      </section>

      {msg && (
        <div className={`card text-sm ${msg.ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}`} role={msg.ok ? "status" : "alert"}>
          {msg.text}
        </div>
      )}

      {scan && s && (
        <>
          {/* Step 3 — summary */}
          <section className="space-y-2">
            <div className="text-xs font-semibold text-slate-500">الخطوة 3 — الملخّص</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="مرتبط" value={s.MAPPED_OK} tone={STATUS_TONE.MAPPED_OK} active={statusFilter === "MAPPED_OK"} onClick={() => setStatusFilter(statusFilter === "MAPPED_OK" ? "" : "MAPPED_OK")} />
              <Stat label="داخلي فقط" value={s.INTERNAL_ONLY} tone={STATUS_TONE.INTERNAL_ONLY} active={statusFilter === "INTERNAL_ONLY"} onClick={() => setStatusFilter(statusFilter === "INTERNAL_ONLY" ? "" : "INTERNAL_ONLY")} />
              <Stat label="خارجي فقط" value={s.EXTERNAL_ONLY} tone={STATUS_TONE.EXTERNAL_ONLY} active={statusFilter === "EXTERNAL_ONLY"} onClick={() => setStatusFilter(statusFilter === "EXTERNAL_ONLY" ? "" : "EXTERNAL_ONLY")} />
              <Stat label="ربط ناقص" value={s.MISSING_ECL} tone={STATUS_TONE.MISSING_ECL} active={statusFilter === "MISSING_ECL"} onClick={() => setStatusFilter(statusFilter === "MISSING_ECL" ? "" : "MISSING_ECL")} />
              <Stat label="تعارضات" value={conflictCount} tone={conflictTone} />
              <Stat label="بحاجة لمراجعة" value={s.NEEDS_REVIEW} tone={STATUS_TONE.NEEDS_REVIEW} active={statusFilter === "NEEDS_REVIEW"} onClick={() => setStatusFilter(statusFilter === "NEEDS_REVIEW" ? "" : "NEEDS_REVIEW")} />
            </div>
            <ProvenanceBanner scan={scan} />
          </section>

          {/* tabs + filters */}
          <section className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <TabButton tab="internal" current={tab} onClick={setTab} label="داخلي ← قناة" />
              <TabButton tab="external" current={tab} onClick={setTab} label="قناة ← كتالوج" />
              <TabButton tab="problems" current={tab} onClick={setTab} label="مشاكل الربط" />
              <input
                value={skuFilter}
                onChange={(e) => setSkuFilter(e.target.value)}
                placeholder="بحث بالـ SKU"
                className="ms-auto w-40 rounded-lg border border-slate-200 px-2 py-1 text-xs"
              />
            </div>

            {/* batch bars */}
            {tab === "internal" && eclCandidates.length > 0 && (
              <BatchBar
                canWrite={canWrite}
                count={selectedEcl.size}
                total={eclCandidates.length}
                onSelectAll={() => setSelectedEcl(new Set(eclCandidates.map((it) => it.key)))}
                onClear={() => setSelectedEcl(new Set())}
                onApply={applyEcl}
                pending={isPending}
                label="إنشاء روابط ECL المحددة"
              />
            )}
            {tab === "external" && importCandidates.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                <select value={importCategory} onChange={(e) => setImportCategory(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1 text-xs">
                  <option value="">— اختر تصنيف الاستيراد —</option>
                  {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <BatchBar
                  canWrite={canWrite}
                  count={selectedImport.size}
                  total={importCandidates.length}
                  onSelectAll={() => setSelectedImport(new Set(importCandidates.map((it) => it.key)))}
                  onClear={() => setSelectedImport(new Set())}
                  onApply={applyImport}
                  pending={isPending}
                  label="استيراد المنتجات المؤهّلة المحددة"
                  inline
                />
              </div>
            )}

            {/* item list */}
            <div className="space-y-1.5">
              {filtered.length === 0 && <div className="card text-sm text-muted">لا عناصر مطابقة.</div>}
              {filtered.slice(0, 500).map((it) => (
                <ItemRow
                  key={it.key}
                  item={it}
                  canWrite={canWrite}
                  selectedEcl={selectedEcl.has(it.key)}
                  selectedImport={selectedImport.has(it.key)}
                  onToggleEcl={() => toggle(selectedEcl, it.key, setSelectedEcl)}
                  onToggleImport={() => toggle(selectedImport, it.key, setSelectedImport)}
                />
              ))}
              {filtered.length > 500 && <div className="text-center text-xs text-muted">عرض أول 500 من {filtered.length}</div>}
            </div>
          </section>

          {results && (
            <section className="card space-y-1">
              <div className="text-xs font-semibold text-slate-500">نتائج التنفيذ</div>
              <div className="text-xs text-muted">
                إجمالي {results.summary.total} · ربط {results.summary.mapped} · إنشاء {results.summary.created} · دون تغيير {results.summary.unchanged} · قديم {results.summary.stale} · متجاوَز {results.summary.skipped} · فشل {results.summary.failed} · مراجعة {results.summary.needsReview}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function TabButton({ tab, current, onClick, label }: { tab: Tab; current: Tab; onClick: (t: Tab) => void; label: string }) {
  return (
    <button
      type="button"
      onClick={() => onClick(tab)}
      className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${current === tab ? "border-slate-800 bg-slate-800 text-white" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
    >
      {label}
    </button>
  );
}

function BatchBar({ canWrite, count, total, onSelectAll, onClear, onApply, pending, label, inline }: {
  canWrite: boolean; count: number; total: number; onSelectAll: () => void; onClear: () => void; onApply: () => void; pending: boolean; label: string; inline?: boolean;
}) {
  return (
    <div className={inline ? "flex items-center gap-2" : "flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"}>
      <span className="text-xs text-muted">محدد {count} / {total} حتمي</span>
      <button type="button" onClick={onSelectAll} className="rounded-lg border border-slate-200 px-2 py-1 text-xs hover:bg-white">تحديد الكل</button>
      <button type="button" onClick={onClear} className="rounded-lg border border-slate-200 px-2 py-1 text-xs hover:bg-white">مسح</button>
      <button
        type="button"
        onClick={onApply}
        disabled={!canWrite || pending || count === 0}
        title={canWrite ? undefined : "للقراءة فقط — لا تملك صلاحية التعديل"}
        className="rounded-lg bg-slate-800 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
      >
        {canWrite ? label : "🔒 " + label}
      </button>
    </div>
  );
}

function ProvenanceBanner({ scan }: { scan: ScanResult }) {
  const p = scan.provenance;
  const bits: string[] = [];
  if (p.snapshotLastCapturedAt) bits.push(`آخر لقطة: ${new Date(p.snapshotLastCapturedAt).toLocaleString("ar")}`);
  if (p.eclDegraded) bits.push("تعذّر قراءة ECL (منقوص)");
  if (p.snapshotDegraded) bits.push("تعذّر قراءة اللقطات (منقوص)");
  if (p.internalDegraded) bits.push("تعذّر قراءة الكتالوج كاملًا (منقوص)");
  if (bits.length === 0) return null;
  return <div className="text-[11px] text-muted">{bits.join(" · ")}</div>;
}

function ItemRow({ item, canWrite, selectedEcl, selectedImport, onToggleEcl, onToggleImport }: {
  item: GapItem; canWrite: boolean; selectedEcl: boolean; selectedImport: boolean; onToggleEcl: () => void; onToggleImport: () => void;
}) {
  const isEcl = item.status === "MISSING_ECL" && item.confidence === "DETERMINISTIC";
  const isImport = item.status === "EXTERNAL_ONLY" && item.importEligibility === "IMPORT_ELIGIBLE";
  const name = item.nameAr ?? item.nameEn ?? item.externalTitle ?? "—";
  return (
    <div className="flex items-start gap-2 rounded-xl border border-slate-100 bg-white px-3 py-2">
      {(isEcl || isImport) && (
        <input
          type="checkbox"
          className="mt-1"
          disabled={!canWrite}
          checked={isEcl ? selectedEcl : selectedImport}
          onChange={isEcl ? onToggleEcl : onToggleImport}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${toneFor(item.status)}`}>{STATUS_LABEL_AR[item.status]}</span>
          <span className="truncate text-sm font-medium text-slate-800">{name}</span>
          {item.sku && <span className="text-[11px] text-muted">SKU {item.sku}</span>}
          {item.grain === "variant" && <span className="rounded bg-slate-100 px-1 text-[10px] text-slate-500">خيار</span>}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted">
          {item.externalId && <span>معرّف خارجي: {item.externalId}</span>}
          {item.externalSku && <span>SKU خارجي: {item.externalSku}</span>}
          <span>الدليل: {EVIDENCE_AR[item.matchedBy]}</span>
          {item.confidence === "DETERMINISTIC" && <span className="text-emerald-600">حتمي</span>}
          {item.sourceType && <span>المصدر: {item.sourceType}</span>}
          {item.importEligibility && <span>الاستيراد: {item.importEligibility}</span>}
          {item.publishReadiness && <span>الجاهزية: {item.publishReadiness}{item.readinessBlockers.length ? ` (${item.readinessBlockers.join("، ")})` : ""}</span>}
        </div>
        {item.reasons.length > 0 && (
          <div className="mt-0.5 text-[11px] text-slate-400">{item.reasons.map((r) => REASON_AR[r] ?? r).join(" · ")}</div>
        )}
      </div>
    </div>
  );
}
