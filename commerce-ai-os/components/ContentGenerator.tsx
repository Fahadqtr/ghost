"use client";

import { useMemo, useState, useTransition } from "react";
import { generateCaption, generateMedia, saveGeneratedContent, type CaptionResult } from "@/app/(app)/content/actions";
import type { Locale } from "@/lib/i18n";

export type PickProduct = {
  sku: string;
  name_en: string | null;
  name_ar: string | null;
  price: number | null;
  category: string | null;
  image_url: string | null;
};

export default function ContentGenerator({ items, locale = "ar" }: { items: PickProduct[]; locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<PickProduct | null>(null);
  const [caption, setCaption] = useState<CaptionResult | null>(null);
  const [mediaMsg, setMediaMsg] = useState<string>("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<"" | "caption" | "image" | "video" | "save">("");

  const matches = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return [];
    return items
      .filter(
        (p) =>
          (p.name_en ?? "").toLowerCase().includes(n) ||
          (p.name_ar ?? "").includes(q.trim()) ||
          p.sku.toLowerCase().includes(n)
      )
      .slice(0, 8);
  }, [q, items]);

  function pick(p: PickProduct) {
    setSelected(p);
    setQ("");
    setCaption(null);
    setMediaMsg("");
    setMsg(null);
  }

  function doCaption() {
    if (!selected) return;
    setBusy("caption");
    startTransition(async () => {
      const res = await generateCaption(selected.sku);
      setBusy("");
      if ("error" in res) {
        setMsg({ kind: "err", text: res.error });
        return;
      }
      setCaption(res);
    });
  }

  function doMedia(kind: "image" | "video") {
    if (!selected) return;
    setBusy(kind);
    startTransition(async () => {
      const res = await generateMedia(kind, selected.sku);
      setBusy("");
      setMediaMsg(res.configured ? "" : res.message);
    });
  }

  function copy(text: string) {
    navigator.clipboard?.writeText(text).then(
      () => setMsg({ kind: "ok", text: L("تم النسخ ✓", "Copied ✓") }),
      () => setMsg({ kind: "err", text: L("فشل النسخ", "Copy failed") })
    );
  }

  function save() {
    if (!selected || !caption) return;
    setBusy("save");
    startTransition(async () => {
      const res = await saveGeneratedContent({
        sku: selected.sku,
        caption_ar: caption.caption_ar,
        caption_en: caption.caption_en,
        hashtags: caption.hashtags,
      });
      setBusy("");
      setMsg(
        res && "error" in res
          ? { kind: "err", text: L(`فشل الحفظ: ${res.error}`, `Save failed: ${res.error}`) }
          : { kind: "ok", text: L("تم الحفظ في generated_content ✓", "Saved to generated_content ✓") }
      );
    });
  }

  const hashtagText = caption?.hashtags.join(" ") ?? "";
  const fullAr = caption ? `${caption.caption_ar}\n\n${hashtagText}` : "";
  const fullEn = caption ? `${caption.caption_en}\n\n${hashtagText}` : "";

  return (
    <div className="space-y-4">
      {/* Product picker */}
      <div className="card space-y-3">
        {!selected ? (
          <div className="relative">
            <input
              className="input"
              placeholder={L("ابحث بالاسم أو SKU…", "Search by name or SKU…")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {matches.length > 0 && (
              <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
                {matches.map((p) => (
                  <button
                    key={p.sku}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50"
                    onClick={() => pick(p)}
                  >
                    <span className="min-w-0 truncate">{p.name_en ?? p.name_ar ?? p.sku}</span>
                    <span className="flex-none text-xs text-muted">{p.sku}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-3">
            {selected.image_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={selected.image_url} alt="" className="h-16 w-16 flex-none rounded-lg object-cover" />
            ) : (
              <div className="h-16 w-16 flex-none rounded-lg bg-slate-100" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-ink">{selected.name_en ?? selected.sku}</div>
              {selected.name_ar ? <div className="truncate text-sm text-muted" dir="rtl">{selected.name_ar}</div> : null}
              <div className="text-xs text-muted">
                {selected.sku} · {selected.price != null ? `${selected.price} QAR` : "—"} · {selected.category ?? "—"}
              </div>
            </div>
            <button className="btn-ghost flex-none px-3 py-1 text-xs" onClick={() => { setSelected(null); setCaption(null); }}>
              {L("تغيير", "Change")}
            </button>
          </div>
        )}

        {selected && (
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary px-4 py-1.5 text-sm disabled:opacity-50" disabled={pending} onClick={doCaption}>
              {busy === "caption" ? L("جاري التوليد…", "Generating…") : caption ? L("↻ إعادة توليد الكابشن", "↻ Regenerate caption") : L("✨ توليد الكابشن", "✨ Generate caption")}
            </button>
            <button className="btn-ghost px-4 py-1.5 text-sm disabled:opacity-50" disabled={pending} onClick={() => doMedia("image")}>
              {busy === "image" ? "…" : L("🖼️ صورة", "🖼️ Image")}
            </button>
            <button className="btn-ghost px-4 py-1.5 text-sm disabled:opacity-50" disabled={pending} onClick={() => doMedia("video")}>
              {busy === "video" ? "…" : L("🎬 فيديو", "🎬 Video")}
            </button>
            {caption && (
              <button className="btn-ghost px-4 py-1.5 text-sm disabled:opacity-50" disabled={pending} onClick={save}>
                {busy === "save" ? "…" : L("💾 حفظ", "💾 Save")}
              </button>
            )}
          </div>
        )}

        {msg && (
          <div className={`text-sm ${msg.kind === "ok" ? "text-green-700" : "text-amber-700"}`}>{msg.text}</div>
        )}
        {mediaMsg && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{mediaMsg}</div>
        )}
      </div>

      {/* Caption output */}
      {caption && (
        <div className="grid gap-4 lg:grid-cols-2">
          <CaptionCard title={L("الكابشن العربي", "Arabic caption")} copyLabel={L("نسخ مع الهاشتاقات", "Copy with hashtags")} dir="rtl" text={caption.caption_ar} onCopy={() => copy(fullAr)} />
          <CaptionCard title={L("الكابشن الإنجليزي", "English caption")} copyLabel={L("نسخ مع الهاشتاقات", "Copy with hashtags")} dir="ltr" text={caption.caption_en} onCopy={() => copy(fullEn)} />
          <div className="card lg:col-span-2">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-ink">{L("الهاشتاقات", "Hashtags")} ({caption.hashtags.length})</h3>
              <button className="btn-ghost px-3 py-1 text-xs" onClick={() => copy(hashtagText)}>{L("نسخ", "Copy")}</button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {caption.hashtags.map((h) => (
                <span key={h} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">{h}</span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CaptionCard({ title, text, dir, onCopy, copyLabel }: { title: string; text: string; dir: "rtl" | "ltr"; onCopy: () => void; copyLabel: string }) {
  return (
    <div className="card">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <button className="btn-ghost px-3 py-1 text-xs" onClick={onCopy}>{copyLabel}</button>
      </div>
      <pre dir={dir} className="whitespace-pre-wrap wrap-break-word font-sans text-sm leading-relaxed text-slate-700">{text}</pre>
    </div>
  );
}
