"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import * as XLSX from "xlsx";
import {
  computeSnoonuDiff, applySnoonuUpdates, addSnoonuNewProducts,
  type ApplyResult, type AddNewResult,
} from "@/app/(app)/import-export/snoonu-actions";
import { setProductApproval, setProductsApproval } from "@/app/(app)/products/actions";
import {
  SNOONU_SHEET, mapExportRows, type SnoonuDiff, type SnoonuExportRow,
} from "@/lib/snoonu-diff";

// Syncable columns shown as checkboxes. Descriptions are UNCHECKED by default
// (our DB descriptions are cleaner than Snoonu's keyword-appended ones).
const SYNC_FIELDS = [
  { col: "approval" }, { col: "is_promoted" }, { col: "is_featured" }, { col: "has_buy1get1" },
  { col: "price" }, { col: "discount_price" }, { col: "name_en" }, { col: "name_ar" },
  { col: "description_en" }, { col: "description_ar" },
];
const DEFAULT_SELECTED = SYNC_FIELDS.map((f) => f.col).filter((c) => !c.startsWith("description"));

export default function SnoonuSync() {
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState<SnoonuDiff | null>(null);
  const [rows, setRows] = useState<SnoonuExportRow[]>([]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null); setDiff(null);
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setBusy(true);
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      // Prefer the named sheet; otherwise use the first sheet (real Snoonu
      // "AllExportData" files name it "Sheet1").
      const sheetName = wb.SheetNames.includes(SNOONU_SHEET) ? SNOONU_SHEET : wb.SheetNames[0];
      if (!sheetName) { setError("The workbook has no sheets."); setBusy(false); return; }
      const raw: Record<string, unknown>[] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
      if (!raw.length) { setError(`Sheet "${sheetName}" has no rows.`); setBusy(false); return; }

      const { rows, hasId, headers } = mapExportRows(raw);
      if (!hasId) {
        setError(`No product-ID column found (need "SPI(UniqueIdentifier)" or "id"). Headers: ${headers.join(", ")}`);
        setBusy(false); return;
      }

      setRows(rows);
      const result = await computeSnoonuDiff(rows);
      if (!result.ok) setError(result.error ?? "Diff failed.");
      setDiff(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not parse the file.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">Upload Snoonu export</h3>
          <p className="text-xs text-muted">
            Upload the Snoonu “AllExportData” file. Matches by <code>SPI(UniqueIdentifier)</code> → <code>products.snoonu_id</code>
            and flags NEW products (in Snoonu, not in your catalog). This step is read-only — it only previews a diff.
          </p>
        </div>
        <input type="file" accept=".xlsx,.xls" onChange={onFile} disabled={busy} className="block text-sm" />
        {fileName ? <p className="text-xs text-muted">{fileName}{busy ? " · analyzing…" : ""}</p> : null}
        {error ? <pre className="whitespace-pre-wrap rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</pre> : null}
      </div>

      {diff?.ok ? <DiffReport diff={diff} rows={rows} /> : null}
    </div>
  );
}

function DiffReport({ diff, rows }: { diff: SnoonuDiff; rows: SnoonuExportRow[] }) {
  const c = diff.counts;
  const router = useRouter();
  const [applying, startApply] = useTransition();
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set(DEFAULT_SELECTED));

  // NEW-product import: review + select + confirm before creating them.
  const [selectedNew, setSelectedNew] = useState<Set<string>>(
    () => new Set(diff.newProducts.map((n) => n.id))
  );
  const [addingNew, startAddNew] = useTransition();
  const [addResult, setAddResult] = useState<AddNewResult | null>(null);

  // Rejected (in our catalog) products present in the upload — reviewable here.
  const [rejList, setRejList] = useState(diff.rejected);
  const [rejBusy, startRej] = useTransition();
  const [rejPending, setRejPending] = useState<string | null>(null);
  const approveRej = (productId: string) => {
    setRejPending(productId);
    startRej(async () => {
      const res = await setProductApproval(productId, "Approved");
      setRejPending(null);
      if (res?.error) alert(res.error);
      else setRejList((l) => l.filter((r) => r.product_id !== productId));
    });
  };

  // Unavailable on Snoonu (Availability=False in the file) — reviewable here,
  // with a one-click "reject in our catalog" to keep both sides in sync.
  const [unavList, setUnavList] = useState(diff.unavailable);
  const [unavBusy, startUnav] = useTransition();
  const rejectUnav = (productId: string) => {
    startUnav(async () => {
      const res = await setProductApproval(productId, "Rejected", "غير متاح على سنونو");
      if (res?.error) alert(res.error);
      else setUnavList((l) => l.filter((r) => r.product_id !== productId));
    });
  };
  const rejectAllUnav = () => {
    if (!confirm(`رفض ${unavList.length} منتج في كتالوجك (غير متاحة على سنونو)؟`)) return;
    const ids = unavList.map((r) => r.product_id);
    startUnav(async () => {
      const res = await setProductsApproval(ids, "Rejected", "غير متاح على سنونو");
      if (res?.error) alert(res.error);
      if (res?.ok || (res?.updated ?? 0) > 0) setUnavList([]);
    });
  };

  // MISSING from the export = removed/delisted on Snoonu → reject in our catalog.
  const [missList, setMissList] = useState(diff.missing);
  const [missBusy, startMiss] = useTransition();
  const rejectMiss = (productId: string) => {
    startMiss(async () => {
      const res = await setProductApproval(productId, "Rejected");
      if (res?.error) alert(res.error);
      else setMissList((l) => l.filter((r) => r.product_id !== productId));
    });
  };
  const rejectAllMiss = () => {
    if (!confirm(`رفض ${missList.length} منتج محذوفة من سنونو؟`)) return;
    const ids = missList.map((r) => r.product_id);
    startMiss(async () => {
      const res = await setProductsApproval(ids, "Rejected");
      if (res?.error) alert(res.error);
      if (res?.ok || (res?.updated ?? 0) > 0) setMissList([]);
    });
  };
  const toggleNew = (id: string) =>
    setSelectedNew((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  function addNew() {
    const ids = [...selectedNew];
    if (ids.length === 0) { alert("اختر منتجًا واحدًا على الأقل."); return; }
    if (!confirm(
      `إضافة ${ids.length} منتج جديد للكتالوج؟\n\n` +
      `بينضافون باسم/سعر/وصف من سنونو، فئة "Uncategorized"، SKU تلقائي بصيغة mk####، وباركود تلقائي فريد.\n` +
      `تقدر تكمّل الفئة/الصورة لاحقًا. الموجود أصلاً ما يتكرر.`
    )) return;
    setAddResult(null);
    startAddNew(async () => {
      const res = await addSnoonuNewProducts(rows, ids);
      setAddResult(res);
      if (res.ok) router.refresh();
    });
  }

  const toggle = (col: string) =>
    setSelected((s) => { const n = new Set(s); n.has(col) ? n.delete(col) : n.add(col); return n; });

  // Exact # of rows that have a change in at least one SELECTED field.
  const selectedRowCount = diff.changedColsPerProduct.filter(
    (cols) => cols.some((col) => selected.has(col))
  ).length;

  function apply() {
    const cols = [...selected];
    if (cols.length === 0) { alert("Select at least one field to sync."); return; }
    const desc = selected.has("description_en") || selected.has("description_ar");
    if (!confirm(
      `Apply Snoonu sync?\n\n` +
      `Rows affected: ${selectedRowCount}\n` +
      `Fields: ${cols.join(", ")}\n` +
      `Descriptions: ${desc ? "INCLUDED (will overwrite DB descriptions)" : "excluded"}\n\n` +
      `Writes matched rows only, only where the value genuinely differs. NEW/MISSING untouched.`
    )) return;
    setResult(null);
    startApply(async () => {
      const res = await applySnoonuUpdates(rows, cols);
      setResult(res);
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {/* summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Export rows" value={c.exportRows} />
        <Stat label="Matched" value={c.matched} />
        <Stat label="Will update" value={c.updated} accent="amber" />
        <Stat label="New (review)" value={c.newCount} accent="violet" />
        <Stat label="Missing (review)" value={c.missing} accent="slate" />
      </div>

      {/* PRICE DIFFERENCES — highlighted on upload (our price → Snoonu price) */}
      <Section title={`💰 اختلاف الأسعار — ${diff.fieldCounts.price ?? 0} منتج (سعرنا ← سعر سنونو)`}>
        {(() => {
          const priceRows = diff.updated
            .filter((u) => u.changes.some((ch) => ch.field === "price"))
            .map((u) => {
              const ch = u.changes.find((c) => c.field === "price")!;
              const oldN = Number(ch.old), newN = Number(ch.new);
              const dir = !isNaN(oldN) && !isNaN(newN) ? (newN > oldN ? "up" : newN < oldN ? "down" : "same") : "same";
              return { key: u.product_id, name: u.name_en, old: ch.old, new: ch.new, dir };
            });
          if (priceRows.length === 0) return <Empty text="ما في فرق بالأسعار بين سنونو والكتالوج. ✅" />;
          return (
            <div className="space-y-1">
              {priceRows.slice(0, 200).map((r) => (
                <div key={r.key} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-sm">
                  <span className="flex-1 text-ink">{r.name || "—"}</span>
                  <span className="text-slate-500">{r.old}</span>
                  <span className="text-slate-400">←</span>
                  <span className={r.dir === "up" ? "font-semibold text-red-600" : r.dir === "down" ? "font-semibold text-green-700" : "text-slate-700"}>
                    {r.new}{r.dir === "up" ? " ↑" : r.dir === "down" ? " ↓" : ""}
                  </span>
                </div>
              ))}
              {(diff.fieldCounts.price ?? 0) > priceRows.length ? (
                <p className="text-xs text-muted">…و {(diff.fieldCounts.price ?? 0) - priceRows.length} منتج آخر بفرق سعر.</p>
              ) : null}
              <p className="pt-1 text-xs text-muted">لتطبيق أسعار سنونو: فعّل <code>price</code> في «اختيار الحقول» بالأسفل واضغط Apply. (الأحمر = سنونو أغلى، الأخضر = أرخص.)</p>
            </div>
          );
        })()}
      </Section>

      {/* REJECTED — products live in this Snoonu file but Rejected in our catalog */}
      <Section title={`🚫 منتجات مرفوضة في كتالوجك (موجودة بملف سنونو) — ${diff.counts.rejected}`}>
        {rejList.length === 0 ? (
          <Empty text={diff.counts.rejected === 0 ? "ما في منتجات مرفوضة في هذا الملف. ✅" : "تمت مراجعة كل المرفوضة."} />
        ) : (
          <ul className="divide-y divide-red-100">
            {rejList.map((r) => (
              <li key={r.product_id} className="flex items-center justify-between gap-2 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-ink">{r.name_en ?? "—"}</span>
                <span className="shrink-0 font-mono text-xs text-muted">{r.sku ?? "—"}</span>
                <button
                  onClick={() => approveRej(r.product_id)}
                  disabled={rejBusy && rejPending === r.product_id}
                  className="shrink-0 rounded-lg bg-green-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                >
                  {rejBusy && rejPending === r.product_id ? "…" : "✓ اعتمد"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* UNAVAILABLE on Snoonu (Availability=False) — the real "rejected on Snoonu" */}
      {(() => {
        const inStock = unavList.filter((r) => (Number(r.stock) || 0) > 0).length;
        const outStock = unavList.length - inStock;
        return (
          <Section title={`⛔ غير متاحة على سنونو · Availability=False — ${diff.counts.unavailable}`}>
            {unavList.length === 0 ? (
              <Empty text={diff.counts.unavailable === 0 ? "كل المنتجات متاحة على سنونو. ✅" : "تمت مراجعة كل غير المتاحة."} />
            ) : (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-muted">
                    عمود Availability=False (مب بالضرورة «مرفوضة» — حالة الرفض مب بالتصدير؛ استخدم أداة اللصق فوق لها).
                    <span className="text-slate-700"> {inStock} عندها مخزون</span> · <span className="text-amber-700">{outStock} نافدة</span>.
                  </span>
                  <button onClick={rejectAllUnav} disabled={unavBusy} className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50">
                    {unavBusy ? "…" : `⛔ ارفض الكل عندنا (${unavList.length})`}
                  </button>
                </div>
                <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
                  {unavList.map((r) => {
                    const st = Number(r.stock) || 0;
                    return (
                      <li key={r.product_id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                        <span className="min-w-0 flex-1 truncate text-ink">{r.name_en ?? "—"}</span>
                        <span className={`badge shrink-0 ${st > 0 ? "bg-slate-100 text-slate-600" : "bg-amber-100 text-amber-700"}`}>
                          {st > 0 ? `مخزون ${st}` : "نافد"}
                        </span>
                        <span className="shrink-0 font-mono text-xs text-muted">{r.sku ?? "—"}</span>
                        <button onClick={() => rejectUnav(r.product_id)} disabled={unavBusy} className="shrink-0 rounded-lg border border-red-200 px-2 py-0.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50">
                          ارفض عندنا
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </Section>
        );
      })()}

      {/* OUT OF STOCK on Snoonu (Stock=0) — informational (Snoonu's stock ≠ ours) */}
      <Section title={`📦 نافد على سنونو · Stock=0 — ${diff.counts.outOfStock}`}>
        {diff.outOfStock.length === 0 ? (
          <Empty text="ما في منتجات نافدة على سنونو. ✅" />
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted">مخزونها 0 في سنونو (للعلم — مخزون سنونو منفصل عن مخزونك. راجعها لو تبي تعيد تعبئتها.)</p>
            <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
              {diff.outOfStock.map((m) => (
                <li key={m.product_id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                  <a href={`/products/${m.product_id}`} className="min-w-0 flex-1 truncate text-ink hover:underline">{m.name_en ?? "—"}</a>
                  <span className="badge shrink-0 bg-amber-100 text-amber-700">نافد</span>
                  <span className="shrink-0 font-mono text-xs text-muted">{m.sku ?? "—"}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      {diff.missingOptionalCols.length ? (
        <div className="card border-amber-200 bg-amber-50 text-sm text-amber-800">
          <strong>Note:</strong> these export fields have no matching DB column yet, so they’re excluded from the diff/sync:{" "}
          <code>{diff.missingOptionalCols.join(", ")}</code>. Add the columns to sync them.
        </div>
      ) : null}

      {/* UPDATED */}
      <Section title={`UPDATED — ${c.updated} product(s) with changed fields`}>
        {diff.updated.length === 0 ? <Empty text="Nothing to update." /> : (
          <div className="space-y-2">
            {diff.updated.slice(0, 200).map((u) => (
              <div key={u.product_id} className="rounded-lg border border-slate-200 p-3">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-sm font-medium text-ink">{u.name_en || "—"}</span>
                  <span className="font-mono text-[10px] text-muted">{u.snoonu_id}</span>
                </div>
                <ul className="space-y-0.5 text-xs">
                  {u.changes.map((ch, i) => {
                    const w = diffWindow(ch.old, ch.new);
                    return (
                      <li key={i} className="flex flex-wrap gap-1">
                        <span className="font-medium text-slate-600">{ch.field}:</span>
                        <span className="text-red-600 line-through">{w.old}</span>
                        <span className="text-slate-400">→</span>
                        <span className="text-green-700">{w.new}</span>
                        {ch.field.startsWith("description") ? (
                          <span className="text-[10px] text-slate-400">(len {ch.old.length}→{ch.new.length})</span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            {c.updated > diff.updated.length ? <p className="text-xs text-muted">…and {c.updated - diff.updated.length} more.</p> : null}
          </div>
        )}
      </Section>

      {/* NEW — review, select, then confirm to add into the catalog */}
      <Section title={`NEW on Snoonu — ${c.newCount} (راجعها واختر، ثم أضفها بموافقتك)`}>
        {diff.newProducts.length === 0 ? <Empty text="No new products." /> : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <button type="button" onClick={() => setSelectedNew(new Set(diff.newProducts.map((n) => n.id)))} className="btn-ghost px-2 py-1">تحديد الكل</button>
              <button type="button" onClick={() => setSelectedNew(new Set())} className="btn-ghost px-2 py-1">إلغاء الكل</button>
              <span className="text-muted">محدد: {selectedNew.size} من {diff.newProducts.length}</span>
            </div>
            <ul className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
              {diff.newProducts.slice(0, 200).map((n) => (
                <li key={n.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-2 py-1.5 hover:bg-slate-50">
                    <input type="checkbox" checked={selectedNew.has(n.id)} onChange={() => toggleNew(n.id)} className="h-4 w-4" />
                    <span className="flex-1 text-slate-700">{n.name_en || "—"}</span>
                    <span className="font-mono text-[10px] text-muted">{n.id.slice(-6)}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="flex flex-col gap-2 border-t border-slate-100 pt-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-muted">
                بينضافون بـ SKU تلقائي <code>mk####</code> + باركود فريد، وفئة <code>Uncategorized</code> — تشوفهم ملاك والكتالوج فورًا، وتكمّل تفاصيلهم بعدين.
              </p>
              <button onClick={addNew} disabled={addingNew || selectedNew.size === 0} className="btn-primary disabled:opacity-50">
                {addingNew ? "جاري الإضافة…" : `➕ أضف ${selectedNew.size} منتج جديد`}
              </button>
            </div>
            {addResult ? (
              addResult.ok ? (
                <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
                  ✓ أُضيف <strong>{addResult.added}</strong> منتج{addResult.skipped ? ` · تخطّى ${addResult.skipped} موجود` : ""}{addResult.failed ? ` · فشل ${addResult.failed}` : ""}. أعد رفع ملف سنونو لتحديث الفرق.
                </div>
              ) : (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">فشل الإضافة: {addResult.error}</div>
              )
            ) : null}
          </div>
        )}
      </Section>

      {/* MISSING */}
      <Section title={`🙈 محذوفة من إكسل سنونو — ${c.missing} (موجودة عندك، أزالها سنونو = غير متوفرة)`}>
        {missList.length === 0 ? (
          <Empty text={c.missing === 0 ? "كل منتجاتك موجودة في تصدير سنونو. ✅" : "تمت مراجعة كل المحذوفة."} />
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted">لها snoonu_id (كانت على سنونو) لكنها اختفت من التصدير — يعني سنونو أزالها.</span>
              <button onClick={rejectAllMiss} disabled={missBusy} className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50">
                {missBusy ? "…" : `⛔ ارفض الكل (${missList.length})`}
              </button>
            </div>
            <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
              {missList.map((m) => (
                <li key={m.product_id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-ink">{m.name_en ?? "—"}</span>
                  <span className="shrink-0 font-mono text-xs text-muted">{m.sku ?? "—"}</span>
                  <button onClick={() => rejectMiss(m.product_id)} disabled={missBusy} className="shrink-0 rounded-lg border border-red-200 px-2 py-0.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50">
                    ارفض عندنا
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      {/* Apply — choose which fields to sync */}
      <div className="card space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">Apply — choose fields to sync</h3>
          <p className="text-xs text-muted">
            Writes matched rows only, only where the normalized value genuinely differs. NEW/MISSING are never created or deleted.
            Numbers show how many rows would change per field.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
          {SYNC_FIELDS.map((f) => {
            const count = diff.fieldCounts[f.col] ?? 0;
            return (
              <label key={f.col} className={`flex items-center gap-2 text-sm ${count === 0 ? "opacity-40" : ""}`}>
                <input
                  type="checkbox"
                  checked={selected.has(f.col)}
                  onChange={() => toggle(f.col)}
                  disabled={count === 0}
                />
                <span className="font-mono text-xs">{f.col}</span>
                <span className="text-xs text-muted">({count})</span>
              </label>
            );
          })}
        </div>

        <div className="flex flex-col gap-2 border-t border-slate-100 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-slate-600">
            <strong>{selectedRowCount}</strong> row(s) will be updated across {selected.size} selected field(s).
            {(selected.has("description_en") || selected.has("description_ar")) ? (
              <span className="text-amber-700"> Descriptions are included — DB descriptions will be overwritten.</span>
            ) : null}
          </p>
          <button
            onClick={apply}
            disabled={applying || selectedRowCount === 0 || selected.size === 0}
            className="btn-primary disabled:opacity-50"
          >
            {applying ? "Applying…" : `Apply to ${selectedRowCount} row(s)`}
          </button>
        </div>
      </div>

      {result ? (
        result.ok ? (
          <div className="card border-green-200 bg-green-50 text-sm text-green-800">
            ✓ Applied. Products updated: <strong>{result.productsUpdated}</strong> · field writes: {result.fieldWrites}
            {result.failed ? ` · failed: ${result.failed}` : ""} · columns: {result.columnsWritten.join(", ") || "—"}.
            <span className="block text-xs text-green-700">Matched {result.matched}, unchanged {result.unchanged}. Re-upload the export to see a clean diff.</span>
          </div>
        ) : (
          <div className="card border-red-200 bg-red-50 text-sm text-red-700">Apply failed: {result.error}</div>
        )
      ) : null}
    </div>
  );
}

// Show the region around the FIRST real difference so genuine (but deep) text
// changes aren't hidden behind an identical-looking truncated prefix.
function firstDiffIndex(a: string, b: string) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}
function diffWindow(oldS: string, newS: string): { old: string; new: string } {
  const i = firstDiffIndex(oldS, newS);
  if (i <= 60 && oldS.length <= 80 && newS.length <= 80) return { old: oldS, new: newS };
  const win = (sv: string) => {
    const start = Math.max(0, i - 20);
    return (start > 0 ? "…" : "") + sv.slice(start, i + 30) + (i + 30 < sv.length ? "…" : "");
  };
  return { old: win(oldS), new: win(newS) };
}
function Stat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  const color = accent === "amber" ? "text-amber-700" : accent === "violet" ? "text-brand-dark" : "text-ink";
  return <div className="card"><p className="text-xs text-muted">{label}</p><p className={`text-xl font-semibold ${color}`}>{value}</p></div>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="card"><h3 className="mb-3 text-sm font-semibold text-ink">{title}</h3>{children}</div>;
}
function Empty({ text }: { text: string }) { return <p className="text-sm text-slate-400">{text}</p>; }
