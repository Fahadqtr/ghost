"use client";

import { useState, useTransition } from "react";
import { computeShopifyDiff, applyShopifyPrices, syncShopifyInventory, pushProductsToShopify, importShopifyProducts, type ShopifyDiff } from "@/app/(app)/import-export/shopify-actions";

// One-tap live reconcile against the Shopify store: pull products over the
// Admin API, diff vs our catalog (source of truth), then push price fixes for
// the rows the owner keeps selected. Titles/status are shown read-only.

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
  const [busy, start] = useTransition();

  const run = () => {
    setError(null); setDiff(null); setApplyMsg("");
    start(async () => {
      const d = await computeShopifyDiff();
      if (!d.ok) { setError(d.error ?? "فشل الجلب."); return; }
      setDiff(d);
      setSelected(new Set(d.updated.filter((u) => u.changes.some((c) => c.field === "price" || c.field === "compare_at")).map((u) => u.product_id)));
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

  const syncInventory = () => {
    setInvMsg("…يزامن الكميات مع شوبي فاي (قد يأخذ دقيقة)");
    start(async () => {
      const r = await syncShopifyInventory();
      if (!r.ok) { setInvMsg(`❌ ${r.error}`); return; }
      setInvMsg(
        r.drift === 0
          ? `✅ الكميات متطابقة أصلًا (${r.matched} منتج)`
          : `✅ تحدّثت كميات ${r.updated} منتج${r.examples.length ? ` — مثل: ${r.examples.join("، ")}` : ""}`,
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
        </div>
        <p className="text-xs text-muted">مزامنة المخزون تصير تلقائيًا كل ليلة (3 فجرًا) — الزر للتزامن الفوري.</p>
        {invMsg ? <p className="text-xs text-muted">{invMsg}</p> : null}
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

          {diff.updated.length ? (
            <div className="card space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-ink">تغييرات معلّقة ({diff.updated.length})</h3>
                <button type="button" className="btn text-xs disabled:opacity-50" onClick={apply} disabled={busy || selected.size === 0}>
                  💾 حدّث أسعار المحدد ({selected.size})
                </button>
              </div>
              {applyMsg ? <p className="text-xs text-muted">{applyMsg}</p> : null}
              <div className="max-h-96 space-y-2 overflow-y-auto">
                {diff.updated.map((u) => (
                  <label key={u.product_id} className="flex items-start gap-2 rounded-lg border border-[#efe3d6] bg-white/60 p-2 text-xs">
                    <input
                      type="checkbox"
                      checked={selected.has(u.product_id)}
                      onChange={() => toggle(u.product_id)}
                      disabled={!u.changes.some((c) => c.field === "price" || c.field === "compare_at")}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="font-semibold text-ink">{u.name_en}</span>
                      <span className="mt-0.5 block space-y-0.5">
                        {u.changes.map((c, i) => (
                          <span key={i} className="block text-muted">
                            {FIELD_AR[c.field] ?? c.field}: <s>{c.old || "—"}</s> ← <b className="text-ink">{c.new || "—"}</b>
                            {c.field === "title" || c.field === "status" ? " (للعرض فقط حاليًا)" : ""}
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
