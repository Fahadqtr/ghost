"use client";

import { Fragment, useDeferredValue, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import BarcodeScanner from "@/components/BarcodeScanner";
import { CATEGORIES } from "@/lib/constants";
import { setProductApproval, createAddToPlatformTasks } from "@/app/(app)/products/actions";
import { archiveAndDeleteProducts } from "@/app/(app)/products/archive/actions";
import ProductQuickView from "@/components/ProductQuickView";
import BulkImageUpload from "@/components/BulkImageUpload";
import { priceRangeLabel, type EffectivePrice } from "@/lib/products/price-compute";
import { isAvailable } from "@/lib/availability/read";
import type { Locale } from "@/lib/i18n";

const PAGE_SIZE = 50;
const CHANNELS = ["Shopify", "Snoonu", "Talabat", "Rafeeq"] as const;
const qar = (n: number) => `${n} QAR`;

// Manual platforms an employee adds products to by hand (the «حوّل لمهام» flow).
// Each task's footer lists exactly the ones picked, each with a tick-box. The
// stored label is Arabic (tasks are Arabic-facing); the picker shows both.
const ADD_PLATFORMS = [
  { label: "سنونو مليكاز", en: "Snoonu Malikas" },
  { label: "سنونو بيور سيول", en: "Snoonu Pure Seoul" },
  { label: "طلبات", en: "Talabat" },
  { label: "رفيق", en: "Rafeeq" },
  { label: "شوبي فاي", en: "Shopify" },
] as const;

export interface ProductRow {
  id: string;
  image_url: string | null;
  sku: string | null;
  snoonu_id: string | null;
  barcode: string | null;
  name_en: string | null;
  name_ar: string | null;
  main_category: string | null;
  approval: string | null;
  rejection_reason: string | null;
  platform_status: string | null;
  notes: string | null;
  price: number | null;
  discount_price: number | null;
  // Effective price — computed on the server from the variants when the product
  // has priced options; falls back to the parent price otherwise.
  priceEff?: EffectivePrice;
  stock: number | null;
  stock_status: string | null; // INV.2F — explicit product availability
  variant_count: number;
  variants?: { name: string | null; barcode: string }[];
  channels: Record<string, string>;
}

// Price to SHOW: a range drawn from the options when they carry prices,
// otherwise the parent price (+ its discount). Used on card + table + quick view.
export function PriceCell({ p, en }: { p: ProductRow; en: boolean }) {
  const ep = p.priceEff;
  if (ep?.fromVariants) {
    return (
      <span className="text-slate-600 tabular-nums">
        {priceRangeLabel(ep, qar)}
        <span className="ms-1 rounded bg-violet-100 px-1 py-0.5 text-[10px] font-medium text-violet-700 tabular-nums">
          🎚️ {en ? "from options" : "من الخيارات"}
        </span>
      </span>
    );
  }
  return (
    <span className="text-slate-600 tabular-nums">
      {p.price != null ? qar(p.price) : "—"}
      {p.discount_price != null ? <span className="ml-1 text-green-700">→ {p.discount_price}</span> : null}
    </span>
  );
}

function Thumb({ url, alt }: { url: string | null; alt: string }) {
  // Fixed-size BOX owns the dimensions; the img fills it at 100% (never relies
  // on intrinsic size or height:auto, so a 1:1 image fills the 48x48 square).
  return (
    <div className="h-12 w-12 shrink-0 overflow-hidden rounded-sm bg-slate-100 ring-1 ring-slate-200">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={alt} width={48} height={48} loading="lazy"
          className="block h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-slate-300" title="No image">📦</div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status?: string }) {
  const s = status ?? "—";
  const cls =
    s === "Active" ? "bg-green-100 text-green-700"
    : s === "Draft" ? "bg-amber-100 text-amber-700"
    : s === "Not Listed" ? "bg-slate-100 text-slate-500"
    : "bg-transparent text-slate-300";
  return <span className={`badge ${cls}`}>{s}</span>;
}

const apprCls = (s: string) =>
  s === "Approved" ? "bg-green-100 text-green-700"
  : s === "Rejected" ? "bg-red-100 text-red-700"
  : s === "SentAI" ? "bg-amber-100 text-amber-700"
  : "bg-slate-100 text-slate-400";

// Inline approve/reject straight from the list — no need to open the product.
// Controlled by the parent's override map so the card + quick-view card stay in
// sync. stopPropagation keeps the row-click (navigate to detail) from firing.
function RowApproval({ id, value, en, onChanged }: { id: string; value: string | null; en: boolean; onChanged: (v: string) => void }) {
  const L = (ar: string, e: string) => (en ? e : ar);
  const [busy, start] = useTransition();
  return (
    <select
      value={value ?? ""}
      disabled={busy}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        e.stopPropagation();
        const v = e.target.value;
        const prev = value ?? "";
        onChanged(v);
        start(async () => {
          const res = await setProductApproval(id, v);
          if (res?.error) { onChanged(prev); alert(res.error); }
        });
      }}
      className={`badge cursor-pointer border-0 outline-hidden ${apprCls(value ?? "")} ${busy ? "opacity-50" : ""}`}
      title={L("غيّر حالة الاعتماد", "Change approval status")}
    >
      <option value="">{L("بدون", "None")}</option>
      <option value="Approved">{L("معتمد", "Approved")}</option>
      <option value="Rejected">{L("مرفوض", "Rejected")}</option>
      <option value="SentAI">SentAI</option>
    </select>
  );
}

export default function ProductTable({ products, locale = "ar", initialGroup = "", simpleMode = false }: { products: ProductRow[]; locale?: Locale; initialGroup?: string; simpleMode?: boolean }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const router = useRouter();
  const [q, setQ] = useState("");
  // Filtering thousands of products on every keystroke blocks the main thread
  // (Speed Insights flagged ~276ms INP). Defer the query used for the heavy
  // filter so the input itself stays instant; the list catches up in an
  // interruptible render.
  const dq = useDeferredValue(q);
  const [scanning, setScanning] = useState(false);
  const [cat, setCat] = useState("");
  const [appr, setAppr] = useState("");
  const [stk, setStk] = useState("");
  const [plat, setPlat] = useState("");
  const [grp, setGrp] = useState(initialGroup);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [busyDel, startDel] = useTransition();
  const [delNote, setDelNote] = useState("");
  const [refreshing, startRefresh] = useTransition();
  const [showFilters, setShowFilters] = useState(false);
  const [quickId, setQuickId] = useState<string | null>(null);
  // Live edits (approval/status/availability) made from the list or the quick
  // card — kept here so both surfaces reflect the change without a full reload.
  const [apprOv, setApprOv] = useState<Record<string, string>>({});
  const [statOv, setStatOv] = useState<Record<string, string>>({});
  // INV.2F — quantity overrides are no longer produced from this surface
  // (availability moved to availOv); effStock just reflects the server value.
  const [stockOv] = useState<Record<string, number>>({});
  const [availOv, setAvailOv] = useState<Record<string, string>>({}); // INV.2F explicit availability override
  const [imgOv, setImgOv] = useState<Record<string, string>>({});
  const [bulkImg, setBulkImg] = useState(false);
  // "Convert to manual tasks" modal: pick which platforms an employee should add
  // the selected products to (one task per product, carrying full details).
  const [taskModal, setTaskModal] = useState(false);
  const [taskPlats, setTaskPlats] = useState<Set<string>>(new Set());
  const [busyTask, startTask] = useTransition();
  const effAppr = (p: ProductRow) => (p.id in apprOv ? apprOv[p.id] : p.approval);
  const effImg = (p: ProductRow) => (p.id in imgOv ? imgOv[p.id] : p.image_url);
  const effStatus = (p: ProductRow) => (p.id in statOv ? statOv[p.id] : p.platform_status);
  const effStock = (p: ProductRow): number | null => (p.id in stockOv ? stockOv[p.id] : p.stock);
  // INV.2F — explicit availability (products.stock_status), with a live override.
  const effAvail = (p: ProductRow): string | null => (p.id in availOv ? availOv[p.id] : p.stock_status);
  const toggleExpand = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const toggleSel = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const filtered = useMemo(() => {
    const needle = dq.trim().toLowerCase();
    return products.filter((p) => {
      const matchesQ =
        !needle ||
        (p.name_en ?? "").toLowerCase().includes(needle) ||
        (p.name_ar ?? "").toLowerCase().includes(needle) ||
        (p.sku ?? "").toLowerCase().includes(needle) ||
        (p.barcode ?? "").toLowerCase().includes(needle) ||
        (p.variants ?? []).some(
          (v) => v.barcode.toLowerCase().includes(needle) || (v.name ?? "").toLowerCase().includes(needle)
        );
      const ap = p.id in apprOv ? apprOv[p.id] : p.approval;
      const ps = p.id in statOv ? statOv[p.id] : p.platform_status;
      const st = p.id in stockOv ? stockOv[p.id] : p.stock;
      const matchesCat = !cat || p.main_category === cat;
      const matchesAppr = !appr || (appr === "none" ? !ap : ap === appr);
      const n = Number(st);
      // INV.2F — in simple mode In/Out come from EXPLICIT availability, not quantity.
      const av = isAvailable(p.id in availOv ? availOv[p.id] : p.stock_status);
      const matchesStk = !stk
        || (stk === "out" ? (simpleMode ? !av : !(n > 0))
          : stk === "low" ? (n > 0 && n < 10)
          : stk === "in" ? (simpleMode ? av : n >= 10) : true);
      const matchesPlat = !plat || (plat === "active" ? ps === "Active" : ps !== "Active");
      const rr = p.rejection_reason ?? "";
      const img = p.id in imgOv ? imgOv[p.id] : p.image_url;
      const noImage = !img || img.trim() === "";
      const matchesGrp = !grp || (
        grp === "no_image" ? noImage
        : grp === "new" ? (p.notes ?? "").startsWith("Imported from Snoonu sync")
        // Respect the live approval override so an approved product leaves the
        // "pending" group immediately, without a full reload.
        : grp === "staff_pending" ? (!ap && (p.notes ?? "").startsWith("staff-new"))
        : grp === "image" ? rr.includes("صورة")
        : grp === "unavail" ? rr.includes("غير متاح")
        : grp === "variants" ? p.variant_count > 0
        : true);
      return !removed.has(p.id) && matchesQ && matchesCat && matchesAppr && matchesStk && matchesPlat && matchesGrp;
    });
  }, [products, dq, cat, appr, stk, plat, grp, removed, simpleMode, apprOv, statOv, stockOv, availOv, imgOv]);

  const anyFilter = !!(q || cat || appr || stk || plat || grp);
  const clearFilters = () => { setQ(""); setCat(""); setAppr(""); setStk(""); setPlat(""); setGrp(""); };

  // Select every product in the current filtered results (across all pages), and
  // copy the results as a plain, paste-able list (SKU — EN — AR, one per line).
  const [copyNote, setCopyNote] = useState("");
  const selectAllFiltered = () => setSel(new Set(filtered.map((p) => p.id)));
  const copyResults = async () => {
    const text = filtered.map((p) => [p.sku, p.name_en, p.name_ar].filter(Boolean).join(" — ")).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopyNote(L(`📋 نُسخت ${filtered.length} منتج`, `📋 Copied ${filtered.length} products`));
    } catch {
      setCopyNote(L("تعذّر النسخ — انسخ يدويًا من القائمة.", "Copy failed — select the text manually."));
    }
  };

  useEffect(() => { setPage(1); }, [q, cat, appr, stk, plat, grp]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  const start = (current - 1) * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);

  // Select-all toggles the current page's rows.
  const pageIds = visible.map((p) => p.id);
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => sel.has(id));
  const toggleSelPage = () =>
    setSel((s) => {
      const n = new Set(s);
      if (allOnPageSelected) pageIds.forEach((id) => n.delete(id));
      else pageIds.forEach((id) => n.add(id));
      return n;
    });

  const deleteSelected = () => {
    const ids = Array.from(sel);
    if (!ids.length) return;
    if (!confirm(L(`أرشفة وحذف ${ids.length} منتج من الكتالوج؟ تنحفظ نسخة في الأرشيف وتقدر تسترجعها.`, `Archive & delete ${ids.length} product(s)? A copy is kept in the archive and can be restored.`))) return;
    setDelNote("");
    startDel(async () => {
      const r = await archiveAndDeleteProducts(ids);
      if (r && "error" in r) { setDelNote(r.error); return; }
      const done = ids.filter((id) => !r.failed.includes(id));
      setRemoved((s) => { const n = new Set(s); done.forEach((id) => n.add(id)); return n; });
      setSel(new Set());
      setDelNote(L(`🗑 حُذف ${r.archived} منتج${r.failed.length ? ` · فشل ${r.failed.length}` : ""} (محفوظ في الأرشيف)`, `🗑 Deleted ${r.archived}${r.failed.length ? ` · ${r.failed.length} failed` : ""} (kept in archive)`));
      router.refresh();
    });
  };

  // الخيار(ات) اللي باركودها يطابق نص البحث الحالي — لإظهار أي خيار «ضربت» عليه
  const matchedVariants = (p: ProductRow) => {
    const n = q.trim().toLowerCase();
    if (!n) return [] as { name: string | null; barcode: string }[];
    return (p.variants ?? []).filter((v) => v.barcode.toLowerCase().includes(n));
  };
  const VariantHits = ({ p }: { p: ProductRow }) => {
    const hits = matchedVariants(p);
    if (hits.length === 0) return null;
    return (
      <div className="mt-1 flex flex-wrap gap-1">
        {hits.map((v, i) => (
          <span key={i} className="inline-block rounded-sm bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800">
            🎯 {L("خيار", "Option")}: {v.name || "—"} · <span className="font-mono">{v.barcode}</span>
          </span>
        ))}
      </div>
    );
  };

  // المنتج «مفتوح» إذا وسّعه المستخدم أو طابق البحث أحد باركودات خياراته
  const isOpen = (p: ProductRow) => expanded.has(p.id) || matchedVariants(p).length > 0;
  // قائمة خيارات المنتج (اسم + باركود) تُعرض داخل القائمة بدون فتح المنتج
  const VariantList = ({ p }: { p: ProductRow }) => {
    const n = q.trim().toLowerCase();
    const vs = p.variants ?? [];
    if (vs.length === 0) return <div className="px-2 py-1 text-xs text-slate-400">{L("لا توجد خيارات لهذا المنتج.", "No options for this product.")}</div>;
    return (
      <div className="space-y-1">
        {vs.map((v, i) => {
          const hit = !!n && v.barcode.toLowerCase().includes(n);
          return (
            <div
              key={i}
              className={`flex items-center justify-between gap-3 rounded-sm px-2 py-1 text-xs ${hit ? "bg-emerald-100 font-medium text-emerald-800" : "text-slate-600"}`}
            >
              <span className="truncate">{hit ? "🎯 " : ""}{v.name || L(`خيار ${i + 1}`, `Option ${i + 1}`)}</span>
              <span className="flex-none font-mono">{v.barcode || "—"}</span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {scanning && (
        <BarcodeScanner
          onDetected={(code) => {
            setQ(code.trim());
            setScanning(false);
          }}
          onClose={() => setScanning(false)}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex w-full sm:max-w-xs">
          <input
            className="input w-full pr-9"
            placeholder={L("ابحث بالاسم (عربي/إنجليزي) أو SKU أو الباركود (شامل الخيارات)…", "Search name (EN/AR), SKU, barcode (incl. variants)…")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button
            type="button"
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded-sm p-1 text-base leading-none hover:bg-slate-100"
            title={L("امسح الباركود بالكاميرا", "Scan barcode with camera")}
            aria-label={L("مسح الباركود", "Scan barcode")}
            onClick={() => setScanning(true)}
          >
            📷
          </button>
        </div>
        <button type="button" onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}
          className="btn-ghost shrink-0 whitespace-nowrap px-3 py-2 text-sm sm:hidden">
          🎛️ {L("فلاتر", "Filters")} {showFilters ? "▴" : "▾"}
        </button>
        {anyFilter ? (
          <button type="button" onClick={clearFilters} className="btn-ghost shrink-0 whitespace-nowrap px-3 py-2 text-sm text-red-600">
            ✕ {L("مسح الفلاتر", "Clear filters")}
          </button>
        ) : null}
        {/* Re-fetch from the DB so edits made elsewhere (or that changed a
            product's group) show up without a full page reload. */}
        <button type="button" onClick={() => startRefresh(() => router.refresh())} disabled={refreshing}
          title={L("تحديث القائمة من قاعدة البيانات", "Refresh the list from the database")}
          className="btn-ghost shrink-0 whitespace-nowrap px-3 py-2 text-sm disabled:opacity-50">
          {refreshing ? "…" : `↻ ${L("تحديث", "Refresh")}`}
        </button>
        {filtered.length > 0 ? (
          <>
            <button type="button" onClick={selectAllFiltered}
              title={L("تحديد كل النتائج", "Select all results")}
              className="btn-ghost shrink-0 whitespace-nowrap px-3 py-2 text-sm">
              ☑️ {L("تحديد الكل", "Select all")} ({filtered.length})
            </button>
            <button type="button" onClick={copyResults}
              title={L("نسخ قائمة النتائج (SKU والأسماء)", "Copy results (SKU + names)")}
              className="btn-ghost shrink-0 whitespace-nowrap px-3 py-2 text-sm">
              📋 {L("نسخ", "Copy")}
            </button>
          </>
        ) : null}
        <span className="ms-auto whitespace-nowrap text-sm text-muted">
          {filtered.length === products.length ? L(`${products.length} منتج`, `${products.length} products`) : L(`${filtered.length} من ${products.length}`, `${filtered.length} of ${products.length}`)}
        </span>
      </div>

      <div className={`${showFilters ? "flex" : "hidden"} flex-col gap-2 sm:flex sm:flex-row sm:flex-wrap sm:items-center`}>
        <select className="input sm:max-w-xs" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">{L("كل الفئات", "All categories")}</option>
          {CATEGORIES.map((c) => (<option key={c} value={c}>{c}</option>))}
        </select>
        <select className="input sm:max-w-48" value={appr} onChange={(e) => setAppr(e.target.value)}>
          <option value="">{L("كل الحالات", "All statuses")}</option>
          <option value="Approved">{L("معتمد", "Approved")}</option>
          <option value="Rejected">{L("مرفوض", "Rejected")}</option>
          <option value="SentAI">SentAI</option>
          <option value="none">{L("بدون حالة", "No status")}</option>
        </select>
        <select className="input sm:max-w-56" value={grp} onChange={(e) => setGrp(e.target.value)}>
          <option value="">{L("كل المجموعات", "All groups")}</option>
          <option value="no_image">{L("📷 بدون صورة", "📷 No image")}</option>
          <option value="staff_pending">{L("🆕 من الموظفين · بانتظار الاعتماد", "🆕 From staff · pending approval")}</option>
          <option value="variants">{L("🎚️ له خيارات", "🎚️ Has variants")}</option>
          <option value="new">{L("🆕 جديد · من سنونو", "🆕 New · from Snoonu")}</option>
          <option value="image">{L("🚫 مرفوض · بسبب الصورة", "🚫 Rejected · image issue")}</option>
          <option value="unavail">{L("⛔ مرفوض · غير متاح على سنونو", "⛔ Rejected · unavailable on Snoonu")}</option>
        </select>
        <select className="input sm:max-w-48" value={stk} onChange={(e) => setStk(e.target.value)}>
          <option value="">{L("كل المخزون", "All stock")}</option>
          <option value="out">{L("نافد", "Out of stock")}</option>
          {simpleMode ? null : <option value="low">{L("منخفض (1-9)", "Low (1-9)")}</option>}
          <option value="in">{simpleMode ? L("متوفّر", "In stock") : L("متوفّر (10+)", "In stock (10+)")}</option>
        </select>
        <select className="input sm:max-w-48" value={plat} onChange={(e) => setPlat(e.target.value)}>
          <option value="">{L("مفعّل + غير مفعّل", "Active + inactive")}</option>
          <option value="active">{L("مفعّل", "Active")}</option>
          <option value="inactive">{L("غير مفعّل", "Draft")}</option>
        </select>
      </div>

      {/* Bulk action bar (appears when rows are selected) */}
      {sel.size > 0 ? (
        <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2">
          <span className="text-sm font-semibold text-violet-900">{L(`${sel.size} محدّد`, `${sel.size} selected`)}</span>
          <div className="flex items-center gap-2">
            <button onClick={() => setSel(new Set())} className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50">{L("إلغاء التحديد", "Clear")}</button>
            <button onClick={() => setBulkImg(true)} className="rounded-md bg-brand px-3 py-1.5 text-xs font-bold text-white">{L(`📷 أضف صور (${sel.size})`, `📷 Add images (${sel.size})`)}</button>
            <button onClick={() => { setTaskPlats(new Set()); setTaskModal(true); }} className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-bold text-white">{L(`🗂 حوّل لمهام (${sel.size})`, `🗂 To tasks (${sel.size})`)}</button>
            <button disabled={busyDel} onClick={deleteSelected} className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">{busyDel ? "…" : L(`🗑 حذف المحدّد (${sel.size})`, `🗑 Delete selected (${sel.size})`)}</button>
          </div>
        </div>
      ) : null}
      {delNote ? <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{delNote}</div> : null}
      {copyNote ? <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{copyNote}</div> : null}

      {/* Cards (mobile) */}
      <div className="space-y-3 md:hidden">
        {filtered.length === 0 ? (
          <div className="card text-center text-sm text-slate-400">{L("لا توجد منتجات.", "No products found.")}</div>
        ) : (
          visible.map((p) => (
            <div
              key={p.id}
              onClick={() => router.push(`/products/${p.id}`)}
              onMouseEnter={() => router.prefetch(`/products/${p.id}`)}
              className="card flex cursor-pointer gap-3 p-3"
            >
              <input
                type="checkbox"
                checked={sel.has(p.id)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => { e.stopPropagation(); toggleSel(p.id); }}
                className="mt-1 h-4 w-4 shrink-0"
                aria-label={L("تحديد", "Select")}
              />
              <button type="button" aria-label={L("افتح بطاقة المنتج", "Open product card")}
                onClick={(e) => { e.stopPropagation(); setQuickId(p.id); }} className="shrink-0">
                <Thumb url={effImg(p)} alt={p.name_en ?? p.sku ?? "product"} />
              </button>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-ink">{p.name_en ?? "—"}</div>
                    {p.name_ar ? <div className="truncate text-xs text-muted" dir="rtl">{p.name_ar}</div> : null}
                    <VariantHits p={p} />
                  </div>
                  <RowApproval id={p.id} value={effAppr(p)} en={en} onChanged={(v) => setApprOv((s) => ({ ...s, [p.id]: v }))} />
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  {p.sku ? <span>SKU {p.sku}</span> : null}
                  {p.main_category ? <span>{p.main_category}</span> : null}
                  {p.variant_count > 0 ? (
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleExpand(p.id); }}
                      className="font-medium text-brand"
                    >
                      {p.variant_count} {L("خيار", "options")} {isOpen(p) ? "▴" : "▾"}
                    </button>
                  ) : null}
                </div>
                {isOpen(p) && (p.variants?.length ?? 0) > 0 ? (
                  <div onClick={(e) => e.stopPropagation()} className="rounded-lg bg-slate-50 p-2">
                    <VariantList p={p} />
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <PriceCell p={p} en={en} />
                  {(() => {
                    // INV.2F — simple mode: In/Out from EXPLICIT availability.
                    if (simpleMode) {
                      return isAvailable(effAvail(p))
                        ? <span className="badge bg-emerald-100 text-emerald-700">{L("متوفر", "In")}</span>
                        : <span className="badge bg-red-100 text-red-700">{L("نافد", "Out")}</span>;
                    }
                    const s = effStock(p);
                    return s == null ? null
                      : Number(s) <= 0 ? <span className="badge bg-red-100 text-red-700">{L("نافد", "Out")}</span>
                      : Number(s) < 10 ? <span className="text-amber-700 tabular-nums">{L("مخزون", "stock")} {s}</span>
                      : <span className="text-slate-600 tabular-nums">{L("مخزون", "stock")} {s}</span>;
                  })()}
                  <span className={`badge ${effStatus(p) === "Active" ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"}`}>
                    {effStatus(p) === "Active" ? L("مفعّل", "Active") : L("غير مفعّل", "Draft")}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {CHANNELS.map((c) => (
                    <span key={c} className="text-[10px]">
                      <span className="text-slate-400">{c}:</span> <StatusBadge status={p.channels[c]} />
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Table (desktop / tablet) */}
      <div className="card hidden overflow-x-auto p-0 md:block">
        <table className="w-full min-w-[1200px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase text-muted">
              <th className="px-3 py-3 font-medium">
                <input type="checkbox" checked={allOnPageSelected} onChange={toggleSelPage} className="h-4 w-4" aria-label={L("تحديد الكل", "Select all")} />
              </th>
              <th className="px-3 py-3 font-medium"></th>
              <th className="px-3 py-3 font-medium">{L("الاسم (EN)", "Name EN")}</th>
              <th className="px-3 py-3 font-medium">{L("الاسم (AR)", "Name AR")}</th>
              <th className="px-3 py-3 font-medium">SKU</th>
              <th className="px-3 py-3 font-medium">{L("معرّف سنونو", "Snoonu ID")}</th>
              <th className="px-3 py-3 font-medium">{L("الباركود", "Barcode")}</th>
              <th className="px-3 py-3 font-medium">{L("الفئة", "Category")}</th>
              <th className="px-3 py-3 font-medium">{L("الاعتماد", "Approval")}</th>
              <th className="px-3 py-3 font-medium">{L("السعر", "Price")}</th>
              <th className="px-3 py-3 font-medium">{L("خصم", "Disc.")}</th>
              <th className="px-3 py-3 font-medium">{L("المخزون", "Stock")}</th>
              <th className="px-3 py-3 font-medium">{L("خيارات", "Var.")}</th>
              {CHANNELS.map((c) => (<th key={c} className="px-3 py-3 font-medium">{c}</th>))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={17} className="px-4 py-8 text-center text-slate-400">{L("لا توجد منتجات.", "No products found.")}</td></tr>
            ) : (
              visible.map((p) => (
                <Fragment key={p.id}>
                <tr
                  onClick={() => router.push(`/products/${p.id}`)}
                  onMouseEnter={() => router.prefetch(`/products/${p.id}`)}
                  className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                >
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={sel.has(p.id)} onChange={() => toggleSel(p.id)} className="h-4 w-4" aria-label={L("تحديد", "Select")} />
                  </td>
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <button type="button" aria-label={L("افتح بطاقة المنتج", "Open product card")} onClick={() => setQuickId(p.id)}>
                      <Thumb url={effImg(p)} alt={p.name_en ?? p.sku ?? "product"} />
                    </button>
                  </td>
                  <td className="px-3 py-3 font-medium text-ink">{p.name_en ?? "—"}<VariantHits p={p} /></td>
                  <td className="px-3 py-3 text-slate-600" dir="rtl">{p.name_ar ?? "—"}</td>
                  <td className="px-3 py-3 text-slate-600">{p.sku ?? "—"}</td>
                  <td className="px-3 py-3 font-mono text-xs text-slate-500" title={p.snoonu_id ?? ""}>
                    {p.snoonu_id ? p.snoonu_id.slice(0, 8) + "…" : "—"}
                  </td>
                  <td className="px-3 py-3 text-slate-600">{p.barcode ?? "—"}</td>
                  <td className="px-3 py-3 text-slate-600">{p.main_category ?? "—"}</td>
                  <td className="px-3 py-3"><RowApproval id={p.id} value={effAppr(p)} en={en} onChanged={(v) => setApprOv((s) => ({ ...s, [p.id]: v }))} /></td>
                  <td className="px-3 py-3">
                    {p.priceEff?.fromVariants
                      ? <span className="text-slate-600 tabular-nums">{priceRangeLabel(p.priceEff, qar)}</span>
                      : <span className="text-slate-600">{p.price ?? "—"}</span>}
                  </td>
                  <td className="px-3 py-3 text-slate-600">
                    {p.priceEff?.fromVariants
                      ? <span className="text-[11px] text-violet-700">{L("من الخيارات", "from options")}</span>
                      : (p.discount_price ?? "—")}
                  </td>
                  <td className="px-3 py-3">
                    {(() => {
                      // INV.2F — simple mode: In/Out from EXPLICIT availability.
                      if (simpleMode) {
                        return isAvailable(effAvail(p))
                          ? <span className="badge bg-emerald-100 text-emerald-700">{L("متوفر", "In")}</span>
                          : <span className="badge bg-red-100 text-red-700">{L("نافد", "Out")}</span>;
                      }
                      const s = effStock(p);
                      return s == null ? <span className="text-slate-400">—</span>
                        : Number(s) <= 0 ? <span className="badge bg-red-100 text-red-700">{L("نافد", "Out")}</span>
                        : Number(s) < 10 ? <span className="text-amber-700 tabular-nums">{s}</span>
                        : <span className="text-slate-600 tabular-nums">{s}</span>;
                    })()}
                  </td>
                  <td className="px-3 py-3 text-slate-600">
                    {p.variant_count > 0 ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleExpand(p.id); }}
                        className="font-medium text-brand hover:underline"
                        title={L("عرض الخيارات", "Show options")}
                      >
                        {p.variant_count} {isOpen(p) ? "▴" : "▾"}
                      </button>
                    ) : "—"}
                  </td>
                  {CHANNELS.map((c) => (
                    <td key={c} className="px-3 py-3"><StatusBadge status={p.channels[c]} /></td>
                  ))}
                </tr>
                {isOpen(p) && (p.variants?.length ?? 0) > 0 ? (
                  <tr className="border-b border-slate-100 bg-slate-50/60">
                    <td colSpan={17} className="px-6 py-2">
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{L("خيارات المنتج", "Product options")}</div>
                      <VariantList p={p} />
                    </td>
                  </tr>
                ) : null}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>

      {filtered.length > PAGE_SIZE ? (
        <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
          <span className="text-sm text-muted">
            {L(`عرض ${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} من ${filtered.length}`, `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} of ${filtered.length}`)}
          </span>
          <div className="flex items-center gap-2">
            <button className="btn-ghost px-3 py-1.5 text-sm disabled:opacity-40" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={current <= 1}>{L("السابق →", "← Prev")}</button>
            <span className="text-sm text-slate-600">{L(`صفحة ${current} / ${totalPages}`, `Page ${current} / ${totalPages}`)}</span>
            <button className="btn-ghost px-3 py-1.5 text-sm disabled:opacity-40" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={current >= totalPages}>{L("← التالي", "Next →")}</button>
          </div>
        </div>
      ) : null}

      {bulkImg ? (
        <BulkImageUpload
          locale={locale}
          products={products.filter((p) => sel.has(p.id)).map((p) => ({ id: p.id, name: p.name_en ?? p.name_ar, sku: p.sku }))}
          onClose={() => setBulkImg(false)}
          onSaved={(urls) => setImgOv((s) => ({ ...s, ...urls }))}
        />
      ) : null}

      {taskModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !busyTask && setTaskModal(false)}>
          <div className="w-full max-w-md space-y-4 rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div>
              <h3 className="text-base font-bold text-ink">{L(`🗂 حوّل ${sel.size} منتج لمهام`, `🗂 ${sel.size} products → tasks`)}</h3>
              <p className="mt-1 text-sm text-muted">{L("اختَر المنصّات اللي لازم الموظف يضيف المنتجات فيها يدويًا. تنفتح مهمة لكل منتج بكل تفاصيله.", "Pick the platforms an employee must add these to by hand. One task per product opens, with full details.")}</p>
            </div>
            <div className="space-y-1.5">
              {ADD_PLATFORMS.map((o) => {
                const on = taskPlats.has(o.label);
                return (
                  <label key={o.label} className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm ${on ? "border-violet-300 bg-violet-50" : "border-slate-200 bg-white"}`}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => setTaskPlats((s) => { const n = new Set(s); if (n.has(o.label)) n.delete(o.label); else n.add(o.label); return n; })}
                      className="h-4 w-4"
                    />
                    <span className="font-medium text-ink" dir="rtl">{o.label}</span>
                    <span className="text-xs text-muted">{o.en}</span>
                  </label>
                );
              })}
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button onClick={() => setTaskModal(false)} disabled={busyTask} className="btn-ghost px-3 py-2 text-sm disabled:opacity-50">{L("إلغاء", "Cancel")}</button>
              <button
                disabled={busyTask || taskPlats.size === 0}
                onClick={() => {
                  const ids = [...sel];
                  const plats = [...taskPlats];
                  startTask(async () => {
                    const res = await createAddToPlatformTasks(ids, plats);
                    if (res.error) { setDelNote(res.error); return; }
                    setTaskModal(false);
                    setSel(new Set());
                    setDelNote(L(`✅ فُتحت ${res.created} مهمة إضافة — تلقاها في صفحة المهام.`, `✅ Opened ${res.created} add-tasks — see the Tasks page.`));
                  });
                }}
                className="rounded-md bg-violet-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
              >
                {busyTask ? "…" : L(`افتح المهام (${sel.size})`, `Open tasks (${sel.size})`)}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {quickId ? (() => {
        const p = products.find((x) => x.id === quickId);
        if (!p) return null;
        return (
          <ProductQuickView
            product={p} locale={locale} simpleMode={simpleMode}
            approval={effAppr(p)} status={effStatus(p)} stock={effStock(p)} stock_status={effAvail(p)}
            onClose={() => setQuickId(null)}
            onApproval={(v) => setApprOv((s) => ({ ...s, [p.id]: v }))}
            onStatus={(v) => setStatOv((s) => ({ ...s, [p.id]: v }))}
            onAvailability={(inStock) => setAvailOv((s) => ({ ...s, [p.id]: inStock ? "In Stock" : "Out of Stock" }))}
          />
        );
      })() : null}
    </div>
  );
}
