"use client";

import { useEffect, useState, useTransition } from "react";
import { scanCatalogImages, auditImageQuality, type ImageProblem, type ImageQualityIssue } from "@/app/(app)/import-export/image-health-actions";

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

const QUALITY_AR: Record<string, string> = {
  cropped: "✂️ مقصوصة",
  corrupt: "🧩 مشوهة/تالفة",
  blurry: "🌫️ غير واضحة",
  placeholder: "🖼️ بدون منتج حقيقي",
  watermark: "🏷️ عليها علامة مائية",
  dark: "🌑 مظلمة",
  wrong: "❓ مو صورة منتج",
};

// The AI pass runs 20+ minutes — phones kill the tab long before that. Every
// chunk is checkpointed to localStorage so a crash/lock loses nothing: on the
// next visit the button turns into "resume from N".
const AUDIT_LS = "malika.imageAudit.v1";
interface SavedAudit { offset: number; total: number; found: ImageQualityIssue[]; done: boolean; at: number }
const loadSavedAudit = (): SavedAudit | null => {
  try {
    const raw = localStorage.getItem(AUDIT_LS);
    if (!raw) return null;
    const j = JSON.parse(raw) as SavedAudit;
    return typeof j?.offset === "number" && Array.isArray(j?.found) ? j : null;
  } catch { return null; }
};
const saveAudit = (v: SavedAudit) => { try { localStorage.setItem(AUDIT_LS, JSON.stringify(v)); } catch { /* full/blocked */ } };

export default function ImageHealth() {
  const [msg, setMsg] = useState("");
  const [problems, setProblems] = useState<ImageProblem[] | null>(null);
  const [scannedOk, setScannedOk] = useState(0);
  const [qMsg, setQMsg] = useState("");
  const [issues, setIssues] = useState<ImageQualityIssue[] | null>(null);
  const [saved, setSaved] = useState<SavedAudit | null>(null);
  const [busy, start] = useTransition();

  // Restore the last checkpoint (results of a finished run, or the resume
  // point of an interrupted one) — localStorage only exists client-side.
  useEffect(() => {
    // Deferred a tick: restoring the checkpoint synchronously inside the
    // effect would cascade renders (react-hooks/set-state-in-effect).
    const t = setTimeout(() => {
      const j = loadSavedAudit();
      if (!j) return;
      setSaved(j);
      if (j.done) {
        setIssues(j.found);
        setQMsg(j.found.length
          ? `⚠️ آخر فحص (محفوظ): ${j.found.length} صورة فيها مشكلة بصرية (من ${j.offset})`
          : `✅ آخر فحص (محفوظ): كل الصور سليمة بصريًا (${j.offset})`);
      } else if (j.offset > 0) {
        setIssues(j.found);
        setQMsg(`⏸️ فحص سابق متوقف عند ${j.offset}/${j.total} — «استأنف» يكمّل من مكانه.`);
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);

  // Deep AI pass: Gemini LOOKS at every image (10 per server call) — slow but
  // catches what a link check can't: cropped, glitched, blurry, wrong photos.
  const audit = (resume: boolean) => {
    const prior = resume ? loadSavedAudit() : null;
    const found: ImageQualityIssue[] = prior && !prior.done ? [...prior.found] : [];
    let offset = prior && !prior.done ? prior.offset : 0;
    setIssues(found.length ? found : null);
    setQMsg(offset ? `…يستأنف من ${offset}` : "…يبدأ الفحص البصري");
    start(async () => {
      let total = prior?.total ?? 0;
      for (;;) {
        const r = await auditImageQuality(offset, 10);
        if (!r.ok) { setQMsg(`❌ ${r.error} — تقدر تستأنف من ${offset} بنفس الزر.`); saveAudit({ offset, total, found, done: false, at: Date.now() }); setSaved(loadSavedAudit()); return; }
        total = r.total || total;
        found.push(...r.flagged);
        offset += r.checked;
        saveAudit({ offset, total, found, done: false, at: Date.now() });
        setIssues([...found]);
        setQMsg(`…يشوف الصور ${Math.min(offset, total)}/${total} — ${found.length} صورة معلّمة حتى الآن (التقدم محفوظ)`);
        if (!r.checked || (total && offset >= total)) break;
      }
      saveAudit({ offset, total, found, done: true, at: Date.now() });
      setSaved(loadSavedAudit());
      setIssues(found);
      setQMsg(found.length
        ? `⚠️ اكتمل: ${found.length} صورة فيها مشكلة بصرية (من ${offset})`
        : `✅ اكتمل: كل الصور سليمة بصريًا (${offset})`);
    });
  };

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

      <div className="flex items-center justify-between gap-3 border-t border-[#efe3d6] pt-3">
        <p className="text-xs text-muted">
          <span className="font-semibold text-ink">🔎 الفحص البصري (AI):</span> يشوف كل صورة فعليًا ويعلّم
          المقصوصة والمشوهة وغير الواضحة — أدق وأبطأ (يمكن ياخذ ٢٠+ دقيقة، خلّ الصفحة مفتوحة).
        </p>
        <div className="flex shrink-0 flex-col gap-1">
          <button type="button" className="btn-ghost whitespace-nowrap text-sm disabled:opacity-50" onClick={() => audit(true)} disabled={busy}>
            {saved && !saved.done && saved.offset > 0 ? `🔎 استأنف (${saved.offset}/${saved.total})` : "🔎 افحص الجودة"}
          </button>
          {saved && !saved.done && saved.offset > 0 ? (
            <button type="button" className="text-[10px] text-muted underline disabled:opacity-50" onClick={() => audit(false)} disabled={busy}>
              ابدأ من البداية
            </button>
          ) : null}
        </div>
      </div>
      {qMsg ? <p className="text-xs text-muted">{qMsg}</p> : null}

      {issues?.length ? (
        <div className="max-h-96 space-y-2 overflow-y-auto">
          {issues.map((p) => (
            <div key={p.product_id} className="flex items-center gap-2 rounded-xl border border-[#efe3d6] bg-white/60 p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.image_url} alt="" loading="lazy" className="h-12 w-12 shrink-0 rounded-lg border border-[#efe3d6] bg-white object-cover" />
              <div className="min-w-0 flex-1 text-xs">
                <p className="truncate font-semibold text-ink">{p.name_en || p.product_id}{p.sku ? ` — ${p.sku}` : ""}</p>
                <p className="mt-0.5 text-muted">
                  {p.problems.map((k) => QUALITY_AR[k] ?? k).join(" · ")}{p.note ? ` — ${p.note}` : ""}
                </p>
              </div>
              <a href={`/products/${p.product_id}`} target="_blank" rel="noreferrer" className="btn-ghost shrink-0 px-2 py-1 text-xs">✏️ تعديل</a>
            </div>
          ))}
        </div>
      ) : null}

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
