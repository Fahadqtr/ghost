"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { staffLogin, staffLogout, staffLookup, recordStaffMovement, staffToday, type StaffItem, type StaffLogRow } from "./actions";
import { dirOf, type Locale } from "@/lib/i18n";

// Reason chips. The Arabic value is what gets stored (so existing data + the
// approvals page stay consistent); only the label is shown per locale.
const REASONS_IN = [
  { v: "شراء/توريد", en: "Purchase" },
  { v: "مرتجع", en: "Return" },
  { v: "تعديل جرد", en: "Stock adjust" },
];
const REASONS_OUT = [
  { v: "بيع", en: "Sale" },
  { v: "تالف", en: "Damaged" },
  { v: "مفقود", en: "Lost" },
  { v: "تحويل", en: "Transfer" },
];

function fmtTime(s: string | null, locale: Locale) {
  if (!s) return "";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

export default function StaffClient({ initialName, initialToday, locale = "ar" }: { initialName: string | null; initialToday: StaffLogRow[]; locale?: Locale }) {
  const [name, setName] = useState<string | null>(initialName);
  return name ? (
    <Desk name={name} initialToday={initialToday} locale={locale} onLogout={() => setName(null)} />
  ) : (
    <Gate locale={locale} onIn={(n) => setName(n)} />
  );
}

/* ── Code gate ─────────────────────────────────────────────────────────── */
function Gate({ onIn, locale }: { onIn: (name: string) => void; locale: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [nm, setNm] = useState("");
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [busy, start] = useTransition();
  useEffect(() => {
    try { setNm(localStorage.getItem("staff_name") || ""); } catch { /* ignore */ }
  }, []);
  const submit = () => {
    setErr("");
    start(async () => {
      const r = await staffLogin(nm, pin);
      if ("error" in r) { setErr(r.error); return; }
      try { localStorage.setItem("staff_name", r.name); } catch { /* ignore */ }
      onIn(r.name);
    });
  };
  return (
    <div dir={dirOf(locale)} className="mx-auto flex min-h-[100dvh] max-w-sm flex-col justify-center gap-4 p-6">
      <div className="text-center">
        <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-600 text-2xl text-white">📦</div>
        <h1 className="text-xl font-bold text-ink">{L("دخول وخروج المنتجات", "Stock in / out")}</h1>
        <p className="text-sm text-muted">{L("صفحة الموظفين", "Employees")} — Malika&apos;s Universe</p>
      </div>
      <label className="block text-sm font-medium text-ink">{L("رمزك", "Your code")}
        <input className="input mt-1 w-full tracking-[0.4em]" value={pin} onChange={(e) => setPin(e.target.value)}
          type="password" inputMode="numeric" placeholder="••••" autoFocus onKeyDown={(e) => e.key === "Enter" && submit()} />
      </label>
      <label className="block text-sm font-medium text-ink">{L("اسمك", "Your name")} <span className="font-normal text-muted">{L("(اختياري — يُملأ من رمزك)", "(optional — filled from your code)")}</span>
        <input className="input mt-1 w-full" value={nm} onChange={(e) => setNm(e.target.value)} placeholder={L("مثال: أحمد", "e.g. Ahmad")} />
      </label>
      {err ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p> : null}
      <button className="btn-primary w-full py-3 text-base disabled:opacity-50" disabled={busy || !pin} onClick={submit}>
        {busy ? "..." : L("دخول", "Sign in")}
      </button>
    </div>
  );
}

/* ── Main desk ─────────────────────────────────────────────────────────── */
function Desk({ name, initialToday, onLogout, locale }: { name: string; initialToday: StaffLogRow[]; onLogout: () => void; locale: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StaffItem[]>([]);
  const [picked, setPicked] = useState<StaffItem | null>(null);
  const [today, setToday] = useState<StaffLogRow[]>(initialToday);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  const scanRef = useRef<HTMLInputElement>(null);

  const focusScan = () => scanRef.current?.focus();
  useEffect(() => { focusScan(); }, [picked]);

  const flash = (ok: boolean, text: string) => { setToast({ ok, text }); setTimeout(() => setToast(null), 2600); };

  const lookup = (q: string) => {
    const term = q.trim();
    if (!term) return;
    start(async () => {
      const r = await staffLookup(term);
      if (r.error) { flash(false, r.error); return; }
      if (r.items.length === 1) { setPicked(r.items[0]); setResults([]); }
      else setResults(r.items);
      if (r.items.length === 0) flash(false, L("ما لقيت منتج بهالباركود/الاسم.", "No product for that barcode/name."));
      setQuery("");
    });
  };

  const refreshToday = () => start(async () => { const r = await staffToday(); if (!r.error) setToday(r.rows); });

  const logout = () => start(async () => { await staffLogout(); onLogout(); });

  return (
    <div dir={dirOf(locale)} className="mx-auto max-w-md space-y-3 p-3">
      {/* header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-base font-bold text-ink">📦 {L("دخول/خروج المنتجات", "Stock in / out")}</p>
          <p className="text-xs text-muted">{L("مرحبا", "Hi")} {name}</p>
        </div>
        <button onClick={logout} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50">{L("خروج", "Sign out")}</button>
      </div>

      {/* scan / search */}
      <form onSubmit={(e) => { e.preventDefault(); lookup(query); }} className="flex gap-2">
        <input ref={scanRef} autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
          className="input flex-1" placeholder={L("امسح الباركود أو اكتب الاسم/الكود…", "Scan barcode or type name / SKU…")} />
        <CameraButton onCode={(c) => lookup(c)} locale={locale} />
        <button type="submit" className="btn-primary px-4" disabled={busy}>{L("بحث", "Search")}</button>
      </form>

      {toast ? (
        <div className={`rounded-lg px-3 py-2 text-sm ${toast.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>{toast.text}</div>
      ) : null}

      {/* picked product → movement panel */}
      {picked ? (
        <MovePanel item={picked} busy={busy} locale={locale}
          onCancel={() => { setPicked(null); focusScan(); }}
          onDone={(dir, qty, reason) => start(async () => {
            const r = await recordStaffMovement({ inventoryId: picked.inventoryId, sku: picked.sku, type: dir, quantity: qty, reason });
            if ("error" in r) { flash(false, r.error); return; }
            const verb = dir === "in" ? L("أُدخل", "In") : L("أُخرج", "Out");
            flash(true, `${verb} ${qty} · ${picked.sku ?? picked.name} → ${L("المخزون", "stock")} ${r.after}`);
            setPicked(null); refreshToday(); focusScan();
          })}
        />
      ) : results.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs text-muted">{L("اختر المنتج:", "Pick the product:")}</p>
          {results.map((it) => (
            <button key={it.inventoryId} onClick={() => { setPicked(it); setResults([]); }}
              className="flex w-full items-center gap-3 rounded-xl border border-slate-200 bg-white p-2.5 text-start hover:bg-slate-50">
              <Thumb src={it.image} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">{it.name ?? it.sku}</span>
                <span className="block text-xs text-muted">{it.sku} · {L("مخزون", "stock")} {it.stock}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {/* today */}
      <div className="pt-2">
        <p className="mb-1 text-xs font-semibold text-muted">{L("حركات اليوم", "Today's movements")} ({today.length})</p>
        <div className="space-y-1">
          {today.length === 0 ? <p className="text-xs text-slate-400">{L("ما فيه حركات اليوم بعد.", "No movements today yet.")}</p> : null}
          {today.slice(0, 20).map((r, i) => (
            <div key={i} className="flex items-center justify-between rounded-lg border border-slate-100 bg-white px-2.5 py-1.5 text-xs">
              <span className={`rounded px-1.5 py-0.5 font-bold ${r.dir === "in" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                {r.dir === "in" ? "➕" : "➖"} {r.qty}
              </span>
              <span className="min-w-0 flex-1 px-2 font-mono text-slate-600 truncate">{r.sku ?? "—"}</span>
              <span className="text-slate-400">{(r.by ?? "").replace(/^staff:/, "")} · {fmtTime(r.at, locale)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Thumb({ src }: { src: string | null }) {
  return (
    <span className="h-11 w-11 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-slate-300">📦</span>
      )}
    </span>
  );
}

/* ── Movement panel (IN/OUT + qty + reason) ────────────────────────────── */
function MovePanel({ item, busy, onDone, onCancel, locale }: {
  item: StaffItem; busy: boolean;
  onDone: (dir: "in" | "out", qty: number, reason: string) => void;
  onCancel: () => void; locale: Locale;
}) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [dir, setDir] = useState<"in" | "out">("in");
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState(REASONS_IN[0].v);
  const reasons = dir === "in" ? REASONS_IN : REASONS_OUT;
  useEffect(() => { setReason(dir === "in" ? REASONS_IN[0].v : "بيع"); }, [dir]);

  return (
    <div className="space-y-3 rounded-2xl border border-violet-200 bg-white p-3 shadow-sm">
      <div className="flex items-center gap-3">
        <Thumb src={item.image} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-ink">{item.name ?? item.sku}</p>
          <p className="text-xs text-muted">{item.sku} · {L("المخزون الحالي", "current stock")} {item.stock}</p>
        </div>
        <button onClick={onCancel} className="text-slate-400 hover:text-slate-700">✕</button>
      </div>

      {/* IN / OUT */}
      <div className="grid grid-cols-2 gap-2">
        <button onClick={() => setDir("in")} className={`rounded-xl py-3 text-base font-bold ${dir === "in" ? "bg-emerald-600 text-white" : "bg-emerald-50 text-emerald-700"}`}>➕ {L("إدخال", "In")}</button>
        <button onClick={() => setDir("out")} className={`rounded-xl py-3 text-base font-bold ${dir === "out" ? "bg-amber-600 text-white" : "bg-amber-50 text-amber-700"}`}>➖ {L("إخراج", "Out")}</button>
      </div>

      {/* qty stepper */}
      <div className="flex items-center justify-center gap-3">
        <button onClick={() => setQty((q) => Math.max(1, q - 1))} className="h-11 w-11 rounded-full bg-slate-100 text-xl font-bold text-slate-700">−</button>
        <input value={qty} onChange={(e) => setQty(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
          inputMode="numeric" className="input w-20 text-center text-lg font-bold" />
        <button onClick={() => setQty((q) => q + 1)} className="h-11 w-11 rounded-full bg-slate-100 text-xl font-bold text-slate-700">+</button>
      </div>

      {/* reason chips */}
      <div className="flex flex-wrap justify-center gap-1.5">
        {reasons.map((r) => (
          <button key={r.v} onClick={() => setReason(r.v)}
            className={`rounded-full px-3 py-1 text-xs ${reason === r.v ? "bg-violet-600 text-white" : "bg-slate-100 text-slate-600"}`}>{en ? r.en : r.v}</button>
        ))}
      </div>

      <button disabled={busy} onClick={() => onDone(dir, qty, dir === "out" && reason === "بيع" ? "sale" : reason)}
        className={`w-full rounded-xl py-3 text-base font-bold text-white disabled:opacity-50 ${dir === "in" ? "bg-emerald-600" : "bg-amber-600"}`}>
        {busy ? "..." : `${L("تأكيد", "Confirm")} ${dir === "in" ? L("الإدخال", "in") : L("الإخراج", "out")} (${qty})`}
      </button>
    </div>
  );
}

/* ── Camera barcode scan (native BarcodeDetector; no dependency) ────────── */
function CameraButton({ onCode, locale }: { onCode: (code: string) => void; locale: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const runningRef = useRef(false);

  const stop = () => {
    runningRef.current = false;
    const v = videoRef.current;
    const s = v?.srcObject as MediaStream | null;
    s?.getTracks().forEach((t) => t.stop());
    if (v) v.srcObject = null;
    setOpen(false);
  };

  const start = async () => {
    setErr("");
    const Det = (typeof window !== "undefined" && (window as any).BarcodeDetector) || null;
    if (!Det) { setErr(L("الكاميرا غير مدعومة في هذا المتصفح — استخدم ماسح الباركود.", "Camera not supported in this browser — use a barcode scanner.")); setOpen(true); return; }
    setOpen(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      const v = videoRef.current!;
      v.srcObject = stream; await v.play();
      const detector = new Det();
      runningRef.current = true;
      const tick = async () => {
        if (!runningRef.current) return;
        try {
          const codes = await detector.detect(v);
          const val = codes?.[0]?.rawValue;
          if (val) { onCode(String(val)); stop(); return; }
        } catch { /* keep trying */ }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch {
      setErr(L("ما قدرت أفتح الكاميرا — تأكد من الإذن.", "Couldn't open the camera — check the permission."));
    }
  };

  return (
    <>
      <button type="button" onClick={start} title={L("امسح بالكاميرا", "Scan with camera")} className="rounded-lg border border-slate-200 px-3 text-lg hover:bg-slate-50">📷</button>
      {open ? (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/90 p-4" onClick={stop}>
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <video ref={videoRef} playsInline muted className="max-h-[70vh] w-full max-w-sm rounded-xl bg-black" />
            <div className="pointer-events-none absolute inset-x-8 top-1/2 h-0.5 -translate-y-1/2 bg-red-500/80" />
          </div>
          {err ? <p className="max-w-sm rounded-lg bg-white px-3 py-2 text-center text-sm text-red-700">{err}</p> : <p className="text-sm text-white/80">{L("وجّه الكاميرا على الباركود…", "Point the camera at the barcode…")}</p>}
          <button onClick={stop} className="rounded-xl bg-white px-6 py-2 font-bold text-slate-800">{L("إغلاق", "Close")}</button>
        </div>
      ) : null}
    </>
  );
}
