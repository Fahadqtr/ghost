"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { matchProductsForArchive, archiveAndDeleteProducts, restoreFromArchive, type MatchedForArchive, type ArchivedRow } from "./actions";
import type { Locale } from "@/lib/i18n";

function Thumb({ src }: { src: string | null }) {
  return (
    <span className="h-10 w-10 shrink-0 overflow-hidden rounded-md border border-slate-200 bg-slate-50">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="h-full w-full object-cover" />
      ) : <span className="flex h-full w-full items-center justify-center text-slate-300">📦</span>}
    </span>
  );
}

export default function ArchiveClient({ initialArchive, locale = "ar" }: { initialArchive: ArchivedRow[]; locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const router = useRouter();
  const [text, setText] = useState("");
  const [matched, setMatched] = useState<MatchedForArchive[]>([]);
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [archive, setArchive] = useState<ArchivedRow[]>(initialArchive);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();

  const flash = (ok: boolean, t: string) => { setNote({ ok, text: t }); setTimeout(() => setNote(null), 4000); };

  const match = () => {
    setNote(null);
    start(async () => {
      const r = await matchProductsForArchive(text);
      if (r.error) { flash(false, r.error); return; }
      setMatched(r.matched);
      setUnmatched(r.unmatched);
      setSel(new Set(r.matched.map((m) => m.id))); // preselect all
      if (r.matched.length === 0) flash(false, L("ما لقيت أي منتج بهالأرقام.", "No products matched those codes."));
    });
  };

  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const run = () => {
    const ids = matched.filter((m) => sel.has(m.id)).map((m) => m.id);
    if (!ids.length) return;
    if (!confirm(L(`أرشفة وحذف ${ids.length} منتج من الكتالوج؟ تنحفظ نسخة في الأرشيف وتقدر تسترجعها.`, `Archive & delete ${ids.length} product(s) from the catalog? A copy is kept in the archive and can be restored.`))) return;
    start(async () => {
      const r = await archiveAndDeleteProducts(ids);
      if (r && "error" in r) { flash(false, r.error); return; }
      flash(true, L(`✓ أُرشِف وحُذف ${r.archived} منتج${r.failed.length ? ` · فشل ${r.failed.length}` : ""}`, `✓ Archived & deleted ${r.archived}${r.failed.length ? ` · ${r.failed.length} failed` : ""}`));
      const done = new Set(ids);
      setMatched((ms) => ms.filter((m) => !done.has(m.id) || r.failed.includes(m.id)));
      setSel(new Set());
      setText("");
      router.refresh();
    });
  };

  const restore = (row: ArchivedRow) => {
    if (!confirm(L(`استرجاع «${row.name_en ?? row.name_ar ?? row.sku}» إلى الكتالوج؟`, `Restore "${row.name_en ?? row.name_ar ?? row.sku}" to the catalog?`))) return;
    start(async () => {
      const r = await restoreFromArchive(row.id);
      if (r && "error" in r) { flash(false, r.error); return; }
      setArchive((a) => a.filter((x) => x.id !== row.id));
      flash(true, L("✓ تم الاسترجاع", "✓ Restored"));
      router.refresh();
    });
  };

  const fmt = (s: string | null) => {
    if (!s) return "";
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(locale, { day: "2-digit", month: "short", year: "2-digit" });
  };

  return (
    <div className="space-y-4">
      {note ? <div className={`rounded-lg px-3 py-2 text-sm ${note.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>{note.text}</div> : null}

      {/* input */}
      <div className="card space-y-2">
        <p className="text-sm font-semibold text-ink">{L("١) الصق أرقام mk أو الباركود", "1) Paste mk codes or barcodes")}</p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className="input w-full font-mono text-sm"
          placeholder={L("mk1234, mk1235\n2001234567890 …", "mk1234, mk1235\n2001234567890 …")} dir="ltr" />
        <button onClick={match} disabled={busy || !text.trim()} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">{L("طابِق", "Match")}</button>
      </div>

      {/* matches */}
      {matched.length > 0 ? (
        <div className="card space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-ink">{L("٢) راجِع واختر", "2) Review & select")} ({sel.size}/{matched.length})</p>
            <button onClick={() => setSel((s) => s.size === matched.length ? new Set() : new Set(matched.map((m) => m.id)))} className="text-xs text-brand hover:underline">
              {sel.size === matched.length ? L("إلغاء الكل", "Deselect all") : L("تحديد الكل", "Select all")}
            </button>
          </div>
          <div className="space-y-1.5">
            {matched.map((m) => (
              <label key={m.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white p-2">
                <input type="checkbox" checked={sel.has(m.id)} onChange={() => toggle(m.id)} className="h-4 w-4" />
                <Thumb src={m.image_url} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">{(en ? m.name_en : m.name_ar) || m.name_en || m.sku || "—"}</span>
                  <span className="block text-[11px] text-muted">{m.sku ?? "—"}{m.barcode ? ` · ${m.barcode}` : ""}{m.stock != null ? ` · ${L("مخزون", "stock")} ${m.stock}` : ""}</span>
                </span>
              </label>
            ))}
          </div>
          <button onClick={run} disabled={busy || sel.size === 0} className="w-full rounded-lg bg-red-600 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">
            {L(`🗄️ أرشفة وحذف المحدد (${sel.size})`, `🗄️ Archive & delete selected (${sel.size})`)}
          </button>
        </div>
      ) : null}

      {unmatched.length > 0 ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {L("ما طابق:", "No match:")} <span className="font-mono">{unmatched.join(", ")}</span>
        </div>
      ) : null}

      {/* archived list */}
      <div className="space-y-2">
        <p className="text-sm font-semibold text-ink">{L("الأرشيف", "Archive")} ({archive.length})</p>
        {archive.length === 0 ? (
          <p className="text-xs text-slate-400">{L("ما فيه منتجات مؤرشفة بعد.", "No archived products yet.")}</p>
        ) : (
          <div className="space-y-1.5">
            {archive.map((row) => (
              <div key={row.id} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-2">
                <Thumb src={row.image_url} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">{(en ? row.name_en : row.name_ar) || row.name_en || row.sku || "—"}</span>
                  <span className="block text-[11px] text-muted">{row.sku ?? "—"}{row.barcode ? ` · ${row.barcode}` : ""} · {fmt(row.archived_at)}{row.archived_by ? ` · ${row.archived_by}` : ""}</span>
                </span>
                <button disabled={busy} onClick={() => restore(row)} className="shrink-0 rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                  {L("↩︎ استرجاع", "↩︎ Restore")}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
