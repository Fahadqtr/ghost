"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  matchProductsByText, setProductsApproval, extractRejectedFromImages,
  type MatchedProduct,
} from "@/app/(app)/products/actions";

// Read a File as { media_type, base64 data } for the vision call.
function fileToImage(file: File): Promise<{ media_type: string; data: string }> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || "");
      const data = s.includes(",") ? s.slice(s.indexOf(",") + 1) : s;
      resolve({ media_type: file.type || "image/jpeg", data });
    };
    r.onerror = () => reject(new Error("read failed"));
    r.readAsDataURL(file);
  });
}

// Paste the products a marketplace rejected (names or SKUs) → match to our
// catalog → reject the selected ones in one click. The rejection status isn't in
// the export, so this bridges that gap. Reused for Snoonu (Malika) and Pure Seoul
// via props — same matching + bulk-reject flow, different labels/reason.
export default function RejectByPaste({
  title = "رفض المرفوضة من سنونو (لصق القائمة)",
  description = "حالة «Rejected» في سنونو مب موجودة بالتصدير. الصق أسماء المنتجات المرفوضة (أو SKU)، سطر لكل منتج — نطابقها بكتالوجك وترفضها دفعة. (تقدر تنسخها من قسم Drafts & Approvals في تطبيق سنونو.)",
  uploadLabel = "📷 ارفع صورة شاشة من سنونو",
  defaultReason = "بسبب الصورة",
}: {
  title?: string;
  description?: string;
  uploadLabel?: string;
  defaultReason?: string;
} = {}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [matched, setMatched] = useState<MatchedProduct[] | null>(null);
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [matching, startMatch] = useTransition();
  const [rejecting, startReject] = useTransition();
  const [reading, startRead] = useTransition();
  const [reason, setReason] = useState(defaultReason);
  const [done, setDone] = useState<string | null>(null);

  const onPickImages = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setDone(null);
    startRead(async () => {
      try {
        const images = await Promise.all(files.map(fileToImage));
        const res = await extractRejectedFromImages(images);
        if (res.error) { alert(res.error); return; }
        if (res.names.length === 0) { alert("ما لقيت منتجات مرفوضة في الصورة."); return; }
        setText((prev) => (prev.trim() ? prev.trim() + "\n" : "") + res.names.join("\n"));
      } catch {
        alert("تعذّر قراءة الصورة.");
      }
    });
  };

  const match = () => {
    setDone(null);
    startMatch(async () => {
      const res = await matchProductsByText(text);
      if (res.error) { alert(res.error); return; }
      setMatched(res.matched);
      setUnmatched(res.unmatched);
      setSel(new Set(res.matched.map((m) => m.id))); // all selected by default
    });
  };

  const toggle = (id: string) =>
    setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const reject = () => {
    const ids = [...sel];
    if (ids.length === 0) { alert("اختر منتجًا واحدًا على الأقل."); return; }
    if (!confirm(`رفض ${ids.length} منتج في كتالوجك${reason.trim() ? ` (السبب: ${reason.trim()})` : ""}؟`)) return;
    startReject(async () => {
      const res = await setProductsApproval(ids, "Rejected", reason);
      if (res.error) { alert(res.error); return; }
      setDone(`✓ تم رفض ${res.updated} منتج${res.failed ? ` · فشل ${res.failed}` : ""}${reason.trim() ? ` — السبب: ${reason.trim()}` : ""}.`);
      setMatched((m) => (m ? m.filter((x) => !sel.has(x.id)) : m));
      setSel(new Set());
      router.refresh();
    });
  };

  return (
    <div className="card space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <p className="text-xs text-muted">{description}</p>
      </div>

      {/* Screenshot → auto-extract rejected names (vision). */}
      <div className="flex flex-col gap-2 rounded-lg border border-dashed border-slate-300 p-3 sm:flex-row sm:items-center">
        <label className={`btn-ghost inline-flex cursor-pointer items-center gap-1 ${reading ? "pointer-events-none opacity-60" : ""}`}>
          {reading ? "جاري قراءة الصورة…" : uploadLabel}
          <input type="file" accept="image/*" multiple onChange={onPickImages} disabled={reading} className="hidden" />
        </label>
        <span className="text-xs text-muted">يقرأ الأسماء المرفوضة من الصورة ويعبّيها تحت تلقائيًا.</span>
      </div>

      <textarea
        className="input min-h-28 font-mono text-xs"
        placeholder={"الصق الأسماء هنا، أو ارفع صورة فوق…\nRolex Submariner Men's Watch\nmk935"}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button onClick={match} disabled={matching || !text.trim()} className="btn-primary disabled:opacity-50">
        {matching ? "جاري المطابقة…" : "🔎 طابق"}
      </button>

      {matched ? (
        <div className="space-y-3 border-t border-slate-100 pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-slate-600">طابق <strong>{matched.length}</strong> منتج · محدد {sel.size}</span>
            <div className="flex gap-2 text-xs">
              <button type="button" onClick={() => setSel(new Set(matched.map((m) => m.id)))} className="btn-ghost px-2 py-1">تحديد الكل</button>
              <button type="button" onClick={() => setSel(new Set())} className="btn-ghost px-2 py-1">إلغاء</button>
            </div>
          </div>

          {matched.length > 0 ? (
            <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
              {matched.map((m) => (
                <li key={m.id}>
                  <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50">
                    <input type="checkbox" checked={sel.has(m.id)} onChange={() => toggle(m.id)} className="h-4 w-4" />
                    <span className="min-w-0 flex-1 truncate text-ink">{m.name_en ?? "—"}</span>
                    {m.approval === "Rejected" ? <span className="badge shrink-0 bg-red-100 text-red-700">مرفوض مسبقًا</span> : null}
                    <span className="shrink-0 font-mono text-xs text-muted">{m.sku ?? "—"}</span>
                  </label>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-slate-400">ما في تطابق.</p>}

          {unmatched.length > 0 ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              ⚠ ما لقيت تطابق لـ {unmatched.length} سطر: {unmatched.slice(0, 10).join("، ")}{unmatched.length > 10 ? "…" : ""}
            </div>
          ) : null}

          {matched.length > 0 ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <label className="text-xs text-muted">سبب الرفض:</label>
              <input
                className="input sm:max-w-[14rem]"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="بسبب الصورة"
              />
              <button onClick={reject} disabled={rejecting || sel.size === 0} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">
                {rejecting ? "جاري الرفض…" : `⛔ ارفض المحدد (${sel.size})`}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {done ? <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{done}</p> : null}
    </div>
  );
}
