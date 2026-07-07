"use client";

import { useState, useTransition } from "react";
import { scanCatalogImages, type ImageProblem } from "@/app/(app)/import-export/image-health-actions";

// One-tap catalog image health scan: walks every product (30 per server call,
// same chunked pattern as the week plan), probes each image_url server-side,
// and lists everything a customer's browser would fail to see — with an edit
// link per product so the fix is one tap away.

const KIND_AR: Record<string, { label: string; icon: string }> = {
  no_image: { label: "بدون صورة", icon: "🕳️" },
  broken: { label: "رابط ميت", icon: "💔" },
  blocked: { label: "المصدر يحجب الصورة", icon: "🚫" },
  not_image: { label: "الرابط مو صورة", icon: "📄" },
  unsafe_url: { label: "رابط غير صالح", icon: "⚠️" },
};

export default function ImageHealth() {
  const [msg, setMsg] = useState("");
  const [problems, setProblems] = useState<ImageProblem[] | null>(null);
  const [scannedOk, setScannedOk] = useState(0);
  const [busy, start] = useTransition();

  const scan = () => {
    setProblems(null); setScannedOk(0);
    setMsg("…يبدأ الفحص");
    start(async () => {
      const found: ImageProblem[] = [];
      let okCount = 0, offset = 0, total = 0;
      for (;;) {
        const r = await scanCatalogImages(offset, 30);
        if (!r.ok) { setMsg(`❌ ${r.error}`); return; }
        total = r.total || total;
        found.push(...r.problems);
        okCount += r.okCount;
        offset += r.checked;
        setMsg(`…فحص ${Math.min(offset, total)}/${total} — ${found.length} مشكلة حتى الآن`);
        if (!r.checked || (total && offset >= total)) break;
      }
      setProblems(found);
      setScannedOk(okCount);
      setMsg(found.length
        ? `⚠️ اكتمل الفحص: ${found.length} منتج فيه مشكلة صورة (من ${offset})`
        : `✅ اكتمل الفحص: كل صور الكتالوج سليمة (${offset} منتج)`);
    });
  };

  const grouped = (problems ?? []).reduce<Record<string, ImageProblem[]>>((acc, p) => {
    (acc[p.kind] = acc[p.kind] ?? []).push(p);
    return acc;
  }, {});

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">🩺 فحص صور الكتالوج</h3>
          <p className="text-xs text-muted">
            يمر على كل منتج ويتأكد أن صورته تفتح فعلًا — يكشف الروابط الميتة والمحجوبة والملفات غير الصالحة.
            خلّ الصفحة مفتوحة، الفحص ياخذ دقائق.
          </p>
        </div>
        <button type="button" className="btn whitespace-nowrap text-sm disabled:opacity-50" onClick={scan} disabled={busy}>
          {busy ? "…يفحص" : "🩺 افحص الآن"}
        </button>
      </div>
      {msg ? <p className="text-xs text-muted">{msg}</p> : null}

      {problems?.length ? (
        <div className="space-y-3">
          <p className="text-[11px] text-muted">✅ {scannedOk} صورة سليمة — والمشاكل تحت مجمعة حسب النوع. اضغط ✏️ وارفع صورة جديدة (الرفع يستبدل الرابط المكسور).</p>
          {Object.entries(grouped).map(([kind, list]) => (
            <details key={kind} className="rounded-xl border border-[#efe3d6] bg-white/60 p-2" open={list.length <= 15}>
              <summary className="cursor-pointer text-xs font-semibold text-ink">
                {KIND_AR[kind]?.icon} {KIND_AR[kind]?.label ?? kind} ({list.length})
              </summary>
              <div className="mt-2 max-h-72 space-y-1.5 overflow-y-auto">
                {list.map((p) => (
                  <div key={p.product_id} className="flex items-center gap-2 text-xs">
                    <a href={`/products/${p.product_id}`} target="_blank" rel="noreferrer" className="btn-ghost shrink-0 px-2 py-0.5">✏️</a>
                    <span className="min-w-0 flex-1 truncate text-ink">{p.name_en || p.product_id}{p.sku ? ` — ${p.sku}` : ""}</span>
                    <span className="shrink-0 text-[10px] text-muted">{p.detail}</span>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      ) : null}
    </div>
  );
}
