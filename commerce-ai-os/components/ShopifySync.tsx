"use client";

import { useState, useTransition } from "react";
import { computeShopifyDiff, applyShopifyPrices, applyShopifyContent, syncShopifyInventory, pushProductsToShopify, importShopifyProducts, listShopifyMissingImages, pushShopifyImages, type ShopifyDiff } from "@/app/(app)/import-export/shopify-actions";
import { applySystemOutOfStockToShopify } from "@/app/(app)/import-export/availability-actions";

// One-tap live reconcile against the Shopify store: pull products over the
// Admin API, diff vs our catalog (source of truth), then push price fixes
// and/or title+status fixes for the rows the owner keeps selected.

const FIELD_AR: Record<string, string> = {
  price: "السعر", compare_at: "السعر قبل الخصم", title: "الاسم", status: "الحالة",
};

export default function ShopifySync() {
  const [diff, setDiff] = useState<ShopifyDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applyMsg, setApplyMsg] = useState("");
  const [invMsg, setInvMsg] = useState("");
  const [pushMsg, setPushMsg] = useState("");
  const [importMsg, setImportMsg] = useState("");
  const [imgMsg, setImgMsg] = useState("");
  const [busy, start] = useTransition();

  const run = () => {
    setError(null); setDiff(null); setApplyMsg("");
    start(async () => {
      const d = await computeShopifyDiff();
      if (!d.ok) { setError(d.error ?? "فشل الجلب."); return; }
      setDiff(d);
      setSelected(new Set(d.updated.map((u) => u.product_id)));
    });
  };

  const apply = () => {
    setApplyMsg("…يحدّث الأسعار في شوبي فاي");
    start(async () => {
      const r = await applyShopifyPrices([...selected]);
      if (!r.ok) { setApplyMsg(`❌ ${r.error}`); return; }
      setApplyMsg(`✅ تحدّث ${r.updated} منتج${r.failed.length ? ` — فشل ${r.failed.length}: ${r.failed.map((f) => f.name).join("، ").slice(0, 200)}` : ""}`);
    });
  };

  const applyContent = () => {
    setApplyMsg("…يزامن الأسماء والحالات في شوبي فاي");
    start(async () => {
      const r = await applyShopifyContent([...selected]);
      if (!r.ok) { setApplyMsg(`❌ ${r.error}`); return; }
      setApplyMsg(`✅ تزامن ${r.updated} منتج${r.failed.length ? ` — فشل ${r.failed.length}: ${r.failed.map((f) => f.name).join("، ").slice(0, 200)}` : ""} — اضغط «قارن الآن» للتحديث`);
    });
  };

  const [oosMsg, setOosMsg] = useState("");
  const applyOos = () => {
    if (!confirm("طبّق كل المنتجات النافدة المخزّنة في النظام (Pure Seoul · Talabat…) على Shopify؟\nيضبط مخزون 0 + يلغي الإدراج للنافد. لا يحتاج رفع ملف.")) return;
    setOosMsg("…يطبّق النافد على شوبي فاي");
    start(async () => {
      const r = await applySystemOutOfStockToShopify();
      if (r.error && !r.ok) { setOosMsg(`❌ ${r.error}`); return; }
      const s = r.shopify;
      setOosMsg(
        s.configured
          ? `✅ نافد النظام: ${r.outSkus} · دُفع لشوبي فاي ${s.pushed ?? 0}${s.failed ? ` · فشل ${s.failed}` : ""} · أُلغي إدراج ${r.channelRows}`
          : `أُلغي الإدراج بالنظام لـ ${r.channelRows} — لكن الدفع الحقيقي لشوبي فاي غير مفعّل: ${s.message ?? ""}`,
      );
    });
  };

  const syncInventory = () => {
    setInvMsg("…يزامن الكميات مع شوبي فاي (قد يأخذ دقيقة)");
    start(async () => {
      const r = await syncShopifyInventory();
      if (!r.ok) { setInvMsg(`❌ ${r.error}`); return; }
      const ordersBit = r.ordersProcessed
        ? ` · 🛍️ خُصم ${r.deducted ?? 0} قطعة من ${r.ordersProcessed} طلب جديد`
        : "";
      const noteBit = r.ordersNote ? ` · ${r.ordersNote}` : "";
      setInvMsg(
        (r.drift === 0
          ? `✅ الكميات متطابقة أصلًا (${r.matched} منتج)`
          : `✅ تحدّثت كميات ${r.updated} منتج${r.examples.length ? ` — مثل: ${r.examples.join("، ")}` : ""}`) + ordersBit + noteBit,
      );
    });
  };

  // Client-driven chunking (same pattern as the week plan) so every server
  // call stays inside the 60s route budget.
  const pushAll = () => {
    const ids = (diff?.onlyOurs ?? []).map((p) => p.product_id);
    if (!ids.length) return;
    setPushMsg(`…يرفع 0/${ids.length} لشوبي فاي — خلّ الصفحة مفتوحة`);
    start(async () => {
      let created = 0, skipped = 0, failed = 0, firstErr = "";
      for (let i = 0; i < ids.length; i += 8) {
        const r = await pushProductsToShopify(ids.slice(i, i + 8));
        if (!r.ok) { failed += Math.min(8, ids.length - i); if (!firstErr) firstErr = r.error ?? ""; }
        else {
          created += r.created; skipped += r.skipped; failed += r.failed.length;
          if (!firstErr && r.failed.length) firstErr = `${r.failed[0].name}: ${r.failed[0].error}`;
        }
        setPushMsg(`…يرفع ${Math.min(i + 8, ids.length)}/${ids.length} لشوبي فاي`);
      }
      setPushMsg(`✅ انرفع ${created} منتج${skipped ? ` · تخطى ${skipped} (موجود)` : ""}${failed ? ` · فشل ${failed}${firstErr ? ` — ${firstErr.slice(0, 120)}` : ""}` : ""} — اضغط «قارن الآن» لتحديث القوائم`);
    });
  };

  const importAll = () => {
    const ids = (diff?.onlyShopify ?? []).map((p) => p.shopify_id);
    if (!ids.length) return;
    setImportMsg(`…يستورد 0/${ids.length} للكتالوج`);
    start(async () => {
      let created = 0, skipped = 0, failed = 0, firstErr = "";
      for (let i = 0; i < ids.length; i += 40) {
        const r = await importShopifyProducts(ids.slice(i, i + 40));
        if (!r.ok) { failed += Math.min(40, ids.length - i); if (!firstErr) firstErr = r.error ?? ""; }
        else {
          created += r.created; skipped += r.skipped; failed += r.failed.length;
          if (!firstErr && r.failed.length) firstErr = `${r.failed[0].name}: ${r.failed[0].error}`;
        }
        setImportMsg(`…يستورد ${Math.min(i + 40, ids.length)}/${ids.length} للكتالوج`);
      }
      setImportMsg(`✅ انستورد ${created} منتج${skipped ? ` · تخطى ${skipped} (موجود)` : ""}${failed ? ` · فشل ${failed}${firstErr ? ` — ${firstErr.slice(0, 120)}` : ""}` : ""} — اضغط «قارن الآن» لتحديث القوائم`);
    });
  };

  // Store products without a picture get the matched catalog image — each
  // source image is probed server-side first, so broken files never ship.
  const pushImages = () => {
    setImgMsg("…يبحث عن منتجات المتجر بدون صور");
    start(async () => {
      const l = await listShopifyMissingImages();
      if (!l.ok) { setImgMsg(`❌ ${l.error}`); return; }
      if (!l.storeMissing) { setImgMsg("✅ كل منتجات المتجر عندها صور"); return; }
      if (!l.pairs.length) { setImgMsg(`⚠️ ${l.storeMissing} منتج بدون صورة في المتجر — وما عندنا صورة مطابقة لأي منها في الكتالوج`); return; }
      let pushed = 0, skipped = 0, failed = 0, firstNote = "";
      for (let i = 0; i < l.pairs.length; i += 10) {
        const r = await pushShopifyImages(l.pairs.slice(i, i + 10));
        if (!r.ok) { failed += Math.min(10, l.pairs.length - i); if (!firstNote) firstNote = r.error ?? ""; }
        else {
          pushed += r.pushed; skipped += r.skippedBroken.length; failed += r.failed.length;
          if (!firstNote && r.skippedBroken.length) firstNote = `${r.skippedBroken[0].title}: ${r.skippedBroken[0].reason}`;
          if (!firstNote && r.failed.length) firstNote = `${r.failed[0].title}: ${r.failed[0].error}`;
        }
        setImgMsg(`…يرفع الصور ${Math.min(i + 10, l.pairs.length)}/${l.pairs.length}`);
      }
      setImgMsg(`✅ انرفعت صور ${pushed} منتج${skipped ? ` · تخطى ${skipped} (صورة المصدر خربانة — أصلحها بالكتالوج أول)` : ""}${failed ? ` · فشل ${failed}` : ""}${firstNote ? ` — ${firstNote.slice(0, 120)}` : ""}`);
    });
  };

  const toggle = (id: string) =>
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">مقارنة حية مع متجر شوبي فاي</h3>
          <p className="text-xs text-muted">
            يسحب منتجات المتجر مباشرة عبر Admin API ويقارنها مع الكتالوج (المطابقة بالـ SKU ثم بالاسم الإنجليزي).
            المعاينة للقراءة فقط — ما يتغيّر شي إلا بزر التطبيق.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn text-sm disabled:opacity-50" onClick={run} disabled={busy}>
            {busy && !diff ? "…يقارن" : "🔄 قارن الآن"}
          </button>
          <button type="button" className="btn-ghost text-sm disabled:opacity-50" onClick={syncInventory} disabled={busy}>
            ↕️ زامن المخزون الآن
          </button>
          <button type="button" className="btn-ghost text-sm disabled:opacity-50" onClick={pushImages} disabled={busy}>
            🖼️ ارفع الصور الناقصة
          </button>
          <button type="button" className="btn-ghost text-sm disabled:opacity-50" onClick={applyOos} disabled={busy}>
            🚫 طبّق النافد (من النظام)
          </button>
        </div>
        <p className="text-xs text-muted">مزامنة المخزون تصير تلقائيًا كل ليلة (3 فجرًا) — الزر للتزامن الفوري. طلبات المتجر الجديدة تُخصم من مخزون الكتالوج أولًا قبل الدفع.</p>
        {invMsg ? <p className="text-xs text-muted">{invMsg}</p> : null}
        {oosMsg ? <p className="text-xs text-muted">{oosMsg}</p> : null}
        {imgMsg ? <p className="text-xs text-muted">{imgMsg}</p> : null}
        {error ? <pre className="whitespace-pre-wrap rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</pre> : null}
      </div>

      {diff?.ok ? (
        <>
          <div className="card grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-4">
            {([["في الكتالوج", diff.counts.ours], ["في شوبي فاي", diff.counts.shopify], ["متطابق", diff.counts.matched], ["يحتاج تحديث", diff.counts.updated], ["بدون تغيير", diff.counts.unchanged], ["في شوبي فاي فقط", diff.counts.onlyShopify], ["في الكتالوج فقط", diff.counts.onlyOurs]] as const).map(([label, n]) => (
              <div key={label} className="rounded-lg bg-[#faf6f0] p-2">
                <div className="text-lg font-bold text-ink">{n}</div>
                <div className="text-muted">{label}</div>
              </div>
            ))}
          </div>

          {diff.duplicates.length ? (
            <div className="card space-y-2 border-amber-200 bg-amber-50">
              <h3 className="text-sm font-semibold text-amber-900">⚠️ منتجات مكررة في الكتالوج ({diff.counts.duplicates})</h3>
              <p className="text-xs text-amber-800">
                كل مجموعة تحتها تشير لنفس المنتج في شوبي فاي — احذف الصف المكرر من الكتالوج (أو وحّد حالة الاعتماد)
                وإلا تتعارض المزامنة. المكرر مستثنى من المزامنة تلقائيًا.
              </p>
              <div className="max-h-48 space-y-2 overflow-y-auto text-xs">
                {diff.duplicates.map((d) => (
                  <div key={d.shopify_id} className="rounded-lg bg-white/70 p-2">
                    <span className="font-semibold text-ink">{d.title}</span>
                    <span className="mt-0.5 block text-muted">صفوف الكتالوج: {d.names.join(" · ")}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {diff.updated.length ? (
            <div className="card space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-ink">تغييرات معلّقة ({diff.updated.length})</h3>
                <div className="flex flex-wrap justify-end gap-2">
                  <button type="button" className="btn text-xs disabled:opacity-50" onClick={apply} disabled={busy || selected.size === 0}>
                    💾 حدّث أسعار المحدد ({selected.size})
                  </button>
                  <button type="button" className="btn-ghost text-xs disabled:opacity-50" onClick={applyContent} disabled={busy || selected.size === 0}>
                    🏷️ زامن أسماء/حالات المحدد
                  </button>
                </div>
              </div>
              {applyMsg ? <p className="text-xs text-muted">{applyMsg}</p> : null}
              <div className="max-h-96 space-y-2 overflow-y-auto">
                {diff.updated.map((u) => (
                  <label key={u.product_id} className="flex items-start gap-2 rounded-lg border border-[#efe3d6] bg-white/60 p-2 text-xs">
                    <input
                      type="checkbox"
                      checked={selected.has(u.product_id)}
                      onChange={() => toggle(u.product_id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="font-semibold text-ink">{u.name_en}</span>
                      <span className="mt-0.5 block space-y-0.5">
                        {u.changes.map((c, i) => (
                          <span key={i} className="block text-muted">
                            {FIELD_AR[c.field] ?? c.field}: <s>{c.old || "—"}</s> ← <b className="text-ink">{c.new || "—"}</b>
                          </span>
                        ))}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}

          {diff.onlyShopify.length ? (
            <details className="card">
              <summary className="cursor-pointer text-sm font-semibold text-ink">في شوبي فاي وليس في الكتالوج ({diff.onlyShopify.length})</summary>
              <div className="mt-2 space-y-2">
                <button type="button" className="btn text-xs disabled:opacity-50" onClick={importAll} disabled={busy}>
                  ⬇️ استورد الكل للكتالوج ({diff.onlyShopify.length})
                </button>
                {importMsg ? <p className="text-xs text-muted">{importMsg}</p> : null}
                <div className="max-h-60 space-y-1 overflow-y-auto text-xs text-muted">
                  {diff.onlyShopify.map((p) => <div key={p.shopify_id}>{p.title} <span className="text-[10px]">({p.status})</span></div>)}
                </div>
              </div>
            </details>
          ) : null}

          {diff.onlyOurs.length ? (
            <details className="card">
              <summary className="cursor-pointer text-sm font-semibold text-ink">في الكتالوج وليس في شوبي فاي ({diff.onlyOurs.length})</summary>
              <div className="mt-2 space-y-2">
                <button type="button" className="btn text-xs disabled:opacity-50" onClick={pushAll} disabled={busy}>
                  ⬆️ ارفع الكل لشوبي فاي ({diff.onlyOurs.length})
                </button>
                <p className="text-[11px] text-muted">ينرفع بصورته وسعره ووصفه وكميته — المعتمد يظهر ACTIVE والمرفوض DRAFT.</p>
                {pushMsg ? <p className="text-xs text-muted">{pushMsg}</p> : null}
                <div className="max-h-60 space-y-1 overflow-y-auto text-xs text-muted">
                  {diff.onlyOurs.map((p) => <div key={p.product_id}>{p.name_en || p.product_id}</div>)}
                </div>
              </div>
            </details>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
