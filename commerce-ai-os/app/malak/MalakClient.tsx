"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { Component, useCallback, useEffect, useRef, useState } from "react";

// مشهد المكتب 3D (Three.js) — ثقيل، يُحمَّل فقط على المتصفح وعند الحاجة.
const Office3D = dynamic(() => import("./Office3D"), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-0 flex-1 items-center justify-center text-white/40">
      <p className="text-sm">…يُحمّل مقر ملاك 3D</p>
    </div>
  ),
});

// In-app error boundary: instead of the white "Application error" screen, show
// the actual error text (visible on mobile, no console needed) + a reload.
class UIErrorBoundary extends Component<{ children: React.ReactNode }, { err: Error | null }> {
  state: { err: Error | null } = { err: null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  componentDidCatch(err: Error, info: unknown) {
    console.error("[malak-ui] crash:", err, info);
  }
  render() {
    if (this.state.err) {
      return (
        <div dir="rtl" className="min-h-screen overflow-auto bg-[#060814] p-5 text-right text-white">
          <p className="mb-2 text-sm font-bold text-rose-300">خطأ في الواجهة (تشخيص):</p>
          <pre className="mb-3 whitespace-pre-wrap break-words rounded-lg bg-black/40 p-3 text-[12px] text-amber-200">
            {String(this.state.err?.message || this.state.err)}
          </pre>
          <pre className="mb-4 whitespace-pre-wrap break-words rounded-lg bg-black/40 p-3 text-[10px] text-white/50">
            {String(this.state.err?.stack || "").slice(0, 1000)}
          </pre>
          <button
            onClick={() => location.reload()}
            className="rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 px-5 py-2.5 text-sm font-bold"
          >
            إعادة التحميل
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ---- Agent team -----------------------------------------------------------
type AgentId = "malak" | "noor" | "bayan" | "reem" | "siraj" | "razan" | "rashid" | "latifa" | "salem" | "faisal";

interface AgentDef {
  id: AgentId;
  name: string; // Arabic display name
  role: string; // Arabic role
  color: string; // accent hex
}

const AGENTS: AgentDef[] = [
  { id: "malak", name: "ملاك", role: "المديرة العامة", color: "#4f8bff" },
  { id: "noor", name: "نور", role: "الكتالوج", color: "#38bdf8" },
  { id: "bayan", name: "بيان", role: "المحتوى", color: "#a855f7" },
  { id: "reem", name: "ريم", role: "الصور", color: "#ec4899" },
  { id: "siraj", name: "سراج", role: "التواصل والنشر", color: "#22d3ee" },
  { id: "razan", name: "رزان", role: "التسعير", color: "#34d399" },
  { id: "rashid", name: "راشد", role: "التقارير", color: "#fbbf24" },
  { id: "latifa", name: "لطيفة", role: "العملاء", color: "#fb7185" },
  { id: "salem", name: "سالم", role: "العمليات", color: "#818cf8" },
  { id: "faisal", name: "فيصل", role: "التقني والتطوير", color: "#14b8a6" },
];

// The 8 specialists shown on the rail (Malak herself is the orb).
const RAIL = AGENTS.filter((a) => a.id !== "malak");
const agentById = (id: string): AgentDef => AGENTS.find((a) => a.id === id) ?? AGENTS[0];

type OrbState = "idle" | "listening" | "thinking" | "speaking";

// Coerce ANY value to a safe React-renderable string. Guards against React
// error #31 (rendering an object child) when a server/API value that should be
// text turns out to be an object (e.g. an OpenAI/Supabase error {code,message,…}).
const txt = (v: any): string =>
  v == null ? ""
  : typeof v === "string" ? v
  : typeof v === "number" || typeof v === "boolean" ? String(v)
  : typeof v?.message === "string" ? v.message
  : typeof v?.error === "string" ? v.error
  : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();

interface PanelData {
  type: "products" | "stats" | "post" | "tiktok" | "confirm" | "image_request" | "briefing" | "tech";
  items?: any[];
  item?: any;
}

interface Turn {
  role: "user" | "malak";
  text: string;
}

const QUICK_PROMPTS = [
  "تقرير حالة الكتالوج",
  "اعرض منتجات Medicube",
  "كم منتج مرفوض؟",
  "اكتب وصف عربي وإنجليزي لـ Anua Toner",
  "اعمل محتوى تيك توك لمنتج كوري",
];

// ---- Energy orb (canvas) ---------------------------------------------------
function Orb({ state, color, size = 200 }: { state: OrbState; color: string; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  const colorRef = useRef(color);
  stateRef.current = state;
  colorRef.current = color;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cx = size / 2;
    const cy = size / 2;
    const scale = size / 280; // internals were tuned for a 280px orb

    let raf = 0;
    let t = 0;

    const hexToRgb = (h: string) => {
      const n = parseInt(h.replace("#", ""), 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    };

    const render = () => {
      const s = stateRef.current;
      const { r, g, b } = hexToRgb(colorRef.current);
      t += s === "thinking" ? 0.06 : s === "speaking" ? 0.09 : s === "listening" ? 0.05 : 0.02;

      ctx.clearRect(0, 0, size, size);

      const baseR = size * 0.25;
      const pulse =
        (s === "speaking" ? 12 * Math.sin(t * 3) + 6 * Math.sin(t * 7)
        : s === "listening" ? 10 * Math.sin(t * 2.2)
        : s === "thinking" ? 6 * Math.sin(t * 1.5)
        : 5 * Math.sin(t)) * scale;
      const radius = baseR + pulse;

      // Outer glow
      const glow = ctx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, radius * 2.2);
      glow.addColorStop(0, `rgba(${r},${g},${b},0.45)`);
      glow.addColorStop(0.5, `rgba(${r},${g},${b},0.12)`);
      glow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, size, size);

      // Core
      const core = ctx.createRadialGradient(cx - radius * 0.3, cy - radius * 0.3, radius * 0.1, cx, cy, radius);
      core.addColorStop(0, `rgba(255,255,255,0.95)`);
      core.addColorStop(0.35, `rgba(${r},${g},${b},0.95)`);
      core.addColorStop(1, `rgba(${Math.round(r * 0.4)},${Math.round(g * 0.4)},${Math.round(b * 0.6)},0.9)`);
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = core;
      ctx.fill();

      // Orbiting energy rings / particles
      const rings = s === "thinking" ? 3 : s === "speaking" ? 5 : 2;
      for (let i = 0; i < rings; i++) {
        const a = t * (1 + i * 0.4) + (i * Math.PI * 2) / rings;
        const rr = radius + (18 + i * 10 + Math.sin(t * 2 + i) * 5) * scale;
        const px = cx + Math.cos(a) * rr;
        const py = cy + Math.sin(a) * rr;
        ctx.beginPath();
        ctx.arc(px, py, 3.5 * scale, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r},${g},${b},0.8)`;
        ctx.shadowColor = `rgba(${r},${g},${b},0.9)`;
        ctx.shadowBlur = 12 * scale;
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      // Listening ripple ring
      if (s === "listening") {
        const ripple = (t * 30 * scale) % (60 * scale);
        ctx.beginPath();
        ctx.arc(cx, cy, radius + ripple, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${r},${g},${b},${0.5 * (1 - ripple / (60 * scale))})`;
        ctx.lineWidth = 2 * scale;
        ctx.stroke();
      }

      raf = requestAnimationFrame(render);
    };
    render();
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size }}
      className="select-none"
      aria-hidden
    />
  );
}

// ---- Panels ----------------------------------------------------------------
function ProductsPanel({ items }: { items: any[] }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3">
      {items.map((p, i) => (
        <div
          key={p.sku ?? i}
          className="overflow-hidden rounded-2xl border border-white/10 bg-white/5 backdrop-blur"
        >
          <div className="aspect-square w-full overflow-hidden bg-black/30">
            {p.image_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={p.image_url}
                alt={p.name ?? ""}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-3xl opacity-40">🧴</div>
            )}
          </div>
          <div className="space-y-1 p-2.5 text-right">
            <p className="line-clamp-2 text-[13px] font-medium leading-snug text-white/90">{txt(p.name)}</p>
            {p.brand ? <p className="text-[11px] text-white/50">{txt(p.brand)}</p> : null}
            <div className="flex items-center justify-between pt-1">
              <span className="text-sm font-bold text-cyan-300">{p.price != null ? `${p.price} ر.ق` : "—"}</span>
              {p.status ? (
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] ${
                    p.status === "Approved"
                      ? "bg-emerald-500/20 text-emerald-300"
                      : p.status === "Rejected"
                      ? "bg-rose-500/20 text-rose-300"
                      : "bg-amber-500/20 text-amber-300"
                  }`}
                >
                  {txt(p.status)}
                </span>
              ) : null}
            </div>
            {p.sku ? <p className="font-mono text-[10px] text-white/30">{txt(p.sku)}</p> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function StatsPanel({ items }: { items: any[] }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3">
      {items.map((s, i) => (
        <div key={i} className="rounded-2xl border border-white/10 bg-white/5 p-4 text-right backdrop-blur">
          <p className="text-2xl font-extrabold text-white">{txt(s.value)}</p>
          <p className="mt-1 text-sm text-white/70">{txt(s.label)}</p>
          {s.sub ? <p className="mt-0.5 text-[11px] text-white/40">{txt(s.sub)}</p> : null}
        </div>
      ))}
    </div>
  );
}

function PostPanel({ item }: { item: any }) {
  return (
    <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-3 text-right backdrop-blur sm:p-4">
      {item.product ? <p className="text-sm font-semibold text-cyan-300">{item.product}</p> : null}
      {item.caption_ar ? (
        <div>
          <p className="mb-1 text-[11px] text-white/40">عربي</p>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-white/90">{item.caption_ar}</p>
        </div>
      ) : null}
      {item.caption_en ? (
        <div dir="ltr" className="text-left">
          <p className="mb-1 text-[11px] text-white/40">English</p>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-white/90">{item.caption_en}</p>
        </div>
      ) : null}
      {Array.isArray(item.hashtags) && item.hashtags.length ? (
        <div className="flex flex-wrap gap-1.5">
          {item.hashtags.map((h: string, i: number) => (
            <span key={i} className="rounded-full bg-purple-500/20 px-2 py-0.5 text-[11px] text-purple-200">
              {h.startsWith("#") ? h : `#${h}`}
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-3 text-[11px] text-white/50">
        {Array.isArray(item.platforms) && item.platforms.length ? <span>📱 {item.platforms.join("، ")}</span> : null}
        {item.schedule ? <span>🗓️ {item.schedule}</span> : null}
      </div>
    </div>
  );
}

function TiktokPanel({ item }: { item: any }) {
  return (
    <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-3 text-right backdrop-blur sm:p-4">
      {item.hook ? (
        <div className="rounded-xl bg-pink-500/15 p-3">
          <p className="text-[11px] text-pink-300">الخطّاف (Hook)</p>
          <p className="text-sm font-semibold text-white/90">{item.hook}</p>
        </div>
      ) : null}
      {Array.isArray(item.scenes) && item.scenes.length ? (
        <ol className="space-y-2">
          {item.scenes.map((sc: any, i: number) => (
            <li key={i} className="flex gap-2 rounded-xl bg-white/5 p-2.5">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-cyan-500/30 text-xs font-bold text-cyan-200">
                {i + 1}
              </span>
              <div>
                {sc.shot ? <p className="text-[11px] text-white/40">{sc.shot}</p> : null}
                {sc.text ? <p className="text-sm text-white/90">{sc.text}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      <div className="flex flex-wrap gap-3 text-[11px] text-white/50">
        {item.audio ? <span>🎵 {item.audio}</span> : null}
        {item.cta ? <span>👉 {item.cta}</span> : null}
      </div>
      {Array.isArray(item.hashtags) && item.hashtags.length ? (
        <div className="flex flex-wrap gap-1.5">
          {item.hashtags.map((h: string, i: number) => (
            <span key={i} className="rounded-full bg-cyan-500/20 px-2 py-0.5 text-[11px] text-cyan-200">
              {h.startsWith("#") ? h : `#${h}`}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Phase 2B — mandatory confirmation card for any WRITE. The actual write only
// happens when the user taps [أكّد], which posts the signed token to
// /api/malak/commit. Nothing is written before that.
function ConfirmPanel({
  item,
  onDone,
  onCancel,
}: {
  item: any;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [status, setStatus] = useState<"idle" | "working" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  const [auditWarn, setAuditWarn] = useState(""); // literal audit failure text
  // Synchronous guard: blocks a double-tap from firing two commits before the
  // disabled state re-renders (idempotency, client side).
  const busyRef = useRef(false);

  const confirm = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setStatus("working");
    try {
      const res = await fetch("/api/malak/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: item.token }),
      });
      const data = await res.json();
      if (data?.ok) {
        // audit is best-effort on the server; surface the literal failure text.
        setAuditWarn(typeof data.audit === "string" && data.audit.startsWith("failed") ? data.audit : "");
        setStatus("done");
        setMsg(txt(data.message) || "تم التنفيذ.");
        onDone(txt(data.message) || "تم التنفيذ.");
        // leave busyRef true on success → no further submits for this card.
      } else {
        setStatus("error");
        setMsg(txt(data?.error) || "تعذّر التنفيذ.");
        busyRef.current = false; // allow retry
      }
    } catch {
      setStatus("error");
      setMsg("تعذّر الاتصال بالخادم.");
      busyRef.current = false; // allow retry
    }
  };

  const changes: { label: string; old?: any; new: any }[] = Array.isArray(item.changes) ? item.changes : [];

  return (
    <div className="space-y-3 rounded-2xl border border-amber-400/30 bg-amber-500/5 p-3 text-right backdrop-blur sm:p-4">
      <div className="flex items-center justify-between">
        <span className="rounded-full bg-amber-500/20 px-2.5 py-0.5 text-[11px] font-semibold text-amber-200">
          ⚠️ تأكيد مطلوب
        </span>
        <p className="text-sm font-bold text-white">{txt(item.title)}</p>
      </div>

      <div>
        <p className="text-[13px] text-white/80">{txt(item.operation)}</p>
        {item.name ? <p className="mt-0.5 text-sm font-semibold text-cyan-300">{txt(item.name)}</p> : null}
        {item.sku ? <p className="font-mono text-[11px] text-white/40">{txt(item.sku)}</p> : null}
      </div>

      {item.warning ? (
        <p className="rounded-xl border border-orange-400/40 bg-orange-500/15 px-3 py-2 text-sm font-medium text-orange-200">
          🤔 {txt(item.warning)}
        </p>
      ) : null}

      {item.note ? (
        <p className="rounded-xl border border-sky-400/30 bg-sky-500/10 px-3 py-2 text-[13px] text-sky-200">
          ℹ️ {txt(item.note)}
        </p>
      ) : null}

      {item.imageUrl ? (
        <div className="overflow-hidden rounded-xl border border-white/10 bg-black/30">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={item.imageUrl} alt="معاينة" className="mx-auto max-h-48 w-auto object-contain" />
        </div>
      ) : null}

      <div className="divide-y divide-white/10 overflow-hidden rounded-xl border border-white/10">
        {changes.map((c, i) => (
          <div key={i} className="flex items-center justify-between gap-3 bg-white/5 px-3 py-2 text-sm">
            <span className="flex items-center gap-2">
              {c.old !== undefined ? (
                <>
                  <span className="text-rose-300/80 line-through">{String(c.old)}</span>
                  <span className="text-white/40">←</span>
                </>
              ) : null}
              <span className="font-semibold text-emerald-300">{String(c.new)}</span>
            </span>
            <span className="text-[12px] text-white/50">{c.label}</span>
          </div>
        ))}
      </div>

      {status === "done" ? (
        <div className="space-y-1.5">
          <p className="rounded-xl bg-emerald-500/15 px-3 py-2 text-sm text-emerald-200">✅ {msg}</p>
          {auditWarn ? (
            <p className="rounded-xl bg-amber-500/15 px-3 py-2 text-[12px] text-amber-200">
              ⚠️ تم التنفيذ لكن لم يُسجَّل في malak_audit.
              <br />
              <span className="break-words font-mono text-[11px] text-amber-300/80">{auditWarn}</span>
            </p>
          ) : null}
        </div>
      ) : status === "error" ? (
        <div className="space-y-2">
          <p className="rounded-xl bg-rose-500/15 px-3 py-2 text-sm text-rose-200">⚠️ {msg}</p>
          <button
            onClick={confirm}
            className="w-full rounded-xl bg-white/10 py-2 text-sm font-semibold text-white/80 transition hover:bg-white/20"
          >
            إعادة المحاولة
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            onClick={confirm}
            disabled={status === "working"}
            className="flex-1 rounded-xl bg-gradient-to-br from-emerald-500 to-green-600 py-2.5 text-sm font-bold text-white transition disabled:opacity-50"
          >
            {status === "working" ? "جارٍ التنفيذ…" : item.confirmLabel || "أكّد"}
          </button>
          <button
            onClick={onCancel}
            disabled={status === "working"}
            className="flex-1 rounded-xl border border-white/15 bg-white/5 py-2.5 text-sm font-semibold text-white/70 transition hover:bg-white/10 disabled:opacity-50"
          >
            {item.cancelLabel || "إلغاء"}
          </button>
        </div>
      )}
    </div>
  );
}

// Step 1 of image generation: the "ولّد الصورة" card. Tapping the button calls
// /api/malak/generate-image (slow), then hands the returned preview confirm
// panel back to the page via onGenerated. No product write happens here.
function ImageRequestPanel({
  item,
  onGenerated,
  onCancel,
}: {
  item: any;
  onGenerated: (panel: PanelData) => void;
  onCancel: () => void;
}) {
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [msg, setMsg] = useState("");
  const busyRef = useRef(false);

  const generate = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setStatus("working");
    try {
      const res = await fetch("/api/malak/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: item.token }),
      });
      const data = await res.json();
      if (data?.ok && data?.panel) {
        onGenerated(data.panel as PanelData);
      } else {
        setStatus("error");
        setMsg(txt(data?.error) || "تعذّر توليد الصورة.");
        busyRef.current = false;
      }
    } catch {
      setStatus("error");
      setMsg("تعذّر الاتصال بالخادم.");
      busyRef.current = false;
    }
  };

  return (
    <div className="space-y-3 rounded-2xl border border-amber-400/30 bg-amber-500/5 p-3 text-right backdrop-blur sm:p-4">
      <div className="flex items-center justify-between">
        <span className="rounded-full bg-amber-500/20 px-2.5 py-0.5 text-[11px] font-semibold text-amber-200">
          ✨ توليد صورة
        </span>
        <p className="text-sm font-bold text-white">{txt(item.title)}</p>
      </div>

      <div>
        {item.name ? <p className="text-sm font-semibold text-cyan-300">{txt(item.name)}</p> : null}
        {item.sku ? <p className="font-mono text-[11px] text-white/40">{txt(item.sku)}</p> : null}
        <p className="mt-1 text-[13px] text-white/70">
          النمط: {item.style === "lifestyle" ? "لايف ستايل" : "هيرو (خلفية نظيفة)"}
          {item.currentImage ? " · تحسين الصورة الحالية مع الحفاظ على العلبة" : " · توليد من اسم المنتج"}
        </p>
      </div>

      {item.currentImage ? (
        <div className="overflow-hidden rounded-xl border border-white/10 bg-black/30">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={item.currentImage} alt="الحالية" className="mx-auto max-h-40 w-auto object-contain opacity-80" />
        </div>
      ) : null}

      {status === "error" ? (
        <p className="rounded-xl bg-rose-500/15 px-3 py-2 text-sm text-rose-200">⚠️ {msg}</p>
      ) : null}

      <div className="flex gap-2">
        <button
          onClick={generate}
          disabled={status === "working"}
          className="flex-1 rounded-xl bg-gradient-to-br from-fuchsia-500 to-purple-600 py-2.5 text-sm font-bold text-white transition disabled:opacity-50"
        >
          {status === "working" ? "جارٍ التوليد… (قد يأخذ نصف دقيقة)" : "✨ ولّد الصورة"}
        </button>
        <button
          onClick={onCancel}
          disabled={status === "working"}
          className="rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white/70 transition hover:bg-white/10 disabled:opacity-50"
        >
          إلغاء
        </button>
      </div>
    </div>
  );
}

// Spoken summary text for the briefing (shared by auto-speak + the listen button).
function briefSummary(d: any): string {
  const greet = new Date().getHours() < 12 ? "صباح الخير" : "مساء الخير";
  return (
    `مرحبا، معاك راشد من قسم التقارير. ${greet} فهد. عندك ${d.total} منتج، ${d.rejected} مرفوض و ${d.lowStock} ستوك منخفض و ${d.missingImages} بدون صورة. ` +
    `الأولوية اليوم ${d.priority}.`
  );
}

// Morning briefing card (Rashid) — auto store status when /malak opens.
function BriefingPanel({
  item,
  onQuick,
  onListen,
}: {
  item: any;
  onQuick: (q: string) => void;
  onListen: (text: string) => void;
}) {
  const hr = new Date().getHours();
  const greet = hr < 12 ? "صباح الخير" : "مساء الخير";
  const rows: { icon: string; label: string; value: number; tone?: string }[] = [
    { icon: "📦", label: "منتج إجمالي", value: item.total ?? 0 },
    { icon: "🖼️", label: "بدون صور", value: item.missingImages ?? 0, tone: "text-sky-300" },
    { icon: "📉", label: "ستوك منخفض", value: item.lowStock ?? 0, tone: "text-amber-300" },
    { icon: "⛔", label: "مرفوض", value: item.rejected ?? 0, tone: "text-rose-300" },
  ];
  if ((item.suspiciousPrice ?? 0) > 0)
    rows.push({ icon: "💸", label: "سعر ناقص/صفر", value: item.suspiciousPrice, tone: "text-orange-300" });

  return (
    <div className="space-y-3 rounded-2xl border border-amber-400/25 bg-gradient-to-br from-amber-500/10 to-purple-500/10 p-3 text-right backdrop-blur sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={() => onListen(briefSummary(item))}
          className="shrink-0 rounded-full border border-amber-400/40 bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-amber-200 transition hover:bg-amber-500/25"
        >
          ▶ استمع
        </button>
        <p className="text-base font-extrabold text-white">{greet} فهد</p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center justify-between rounded-xl bg-white/5 px-3 py-2">
            <span className={`text-lg font-extrabold ${r.tone ?? "text-white"}`}>{r.value}</span>
            <span className="text-[12px] text-white/70">
              {r.icon} {r.label}
            </span>
          </div>
        ))}
      </div>

      {item.priority ? (
        <p className="rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[13px] font-medium text-amber-100">
          ← الأولوية اليوم: {item.priority}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => onQuick("اعرض المنتجات المرفوضة")}
          className="rounded-full border border-rose-400/30 bg-rose-500/10 px-3 py-1.5 text-[12px] text-rose-200 transition hover:bg-rose-500/20"
        >
          اعرض المرفوضين
        </button>
        <button
          onClick={() => onQuick("اعرض المنتجات بدون صورة")}
          className="rounded-full border border-sky-400/30 bg-sky-500/10 px-3 py-1.5 text-[12px] text-sky-200 transition hover:bg-sky-500/20"
        >
          اعرض بدون صور
        </button>
        <button
          onClick={() => onQuick("اعرض المنتجات منخفضة المخزون")}
          className="rounded-full border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-[12px] text-amber-200 transition hover:bg-amber-500/20"
        >
          اعرض ستوك منخفض
        </button>
      </div>
    </div>
  );
}

// فيصل (التقني) — مقترح تقني للقراءة/المراجعة فقط. لا ينفّذ شيئًا؛ التطبيق يدوي بعد اعتماد فهد.
function TechPanel({ item }: { item: any }) {
  const steps: string[] = Array.isArray(item.steps) ? item.steps.map(txt) : [];
  const files: string[] = Array.isArray(item.files) ? item.files.map(txt) : [];
  const risk = txt(item.risk);
  const riskTone = risk.includes("عال")
    ? "text-rose-300 border-rose-400/40 bg-rose-500/10"
    : risk.includes("متوسط")
      ? "text-amber-300 border-amber-400/40 bg-amber-500/10"
      : "text-emerald-300 border-emerald-400/40 bg-emerald-500/10";
  return (
    <div className="space-y-3 rounded-2xl border border-teal-400/25 bg-gradient-to-br from-teal-500/10 to-sky-500/10 p-3 text-right backdrop-blur sm:p-4">
      <div className="flex items-center justify-between gap-2">
        {risk ? (
          <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${riskTone}`}>
            مخاطرة: {risk}
          </span>
        ) : <span />}
        <p className="text-base font-extrabold text-white">🛠️ {txt(item.title) || "مقترح تقني"}</p>
      </div>

      {item.summary ? <p className="text-[13px] leading-relaxed text-white/80">{txt(item.summary)}</p> : null}

      {steps.length ? (
        <div className="rounded-xl bg-white/5 p-3">
          <p className="mb-1.5 text-[12px] font-semibold text-teal-200">الخطوات</p>
          <ol className="list-decimal space-y-1 pr-4 text-[13px] text-white/80">
            {steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
        </div>
      ) : null}

      {files.length ? (
        <p className="text-[12px] text-white/60">📁 الملفات المتأثّرة: {files.join("، ")}</p>
      ) : null}

      {item.code ? (
        <pre dir="ltr" className="max-h-72 overflow-auto rounded-xl bg-black/40 p-3 text-left text-[11px] leading-relaxed text-teal-100">
          <code>{txt(item.code)}</code>
        </pre>
      ) : null}

      {item.sql ? (
        <pre dir="ltr" className="max-h-72 overflow-auto rounded-xl bg-black/40 p-3 text-left text-[11px] leading-relaxed text-sky-100">
          <code>{txt(item.sql)}</code>
        </pre>
      ) : null}

      <p className="rounded-xl border border-teal-400/30 bg-teal-500/10 px-3 py-2 text-[12px] font-medium text-teal-100">
        ⚠️ اقتراح فقط — يحتاج مراجعتك واعتمادك قبل التنفيذ. فيصل ما ينفّذ ولا ينشر تلقائيًا.
      </p>
    </div>
  );
}

function Panel({
  data,
  onConfirmDone,
  onConfirmCancel,
  onGenerated,
  onQuick,
  onListen,
}: {
  data: PanelData;
  onConfirmDone?: (message: string) => void;
  onConfirmCancel?: () => void;
  onGenerated?: (panel: PanelData) => void;
  onQuick?: (q: string) => void;
  onListen?: (text: string) => void;
}) {
  if (data.type === "products" && Array.isArray(data.items)) return <ProductsPanel items={data.items} />;
  if (data.type === "stats" && Array.isArray(data.items)) return <StatsPanel items={data.items} />;
  if (data.type === "post" && data.item) return <PostPanel item={data.item} />;
  if (data.type === "tiktok" && data.item) return <TiktokPanel item={data.item} />;
  if (data.type === "tech" && data.item) return <TechPanel item={data.item} />;
  if (data.type === "briefing" && data.item)
    return <BriefingPanel item={data.item} onQuick={(q) => onQuick?.(q)} onListen={(t) => onListen?.(t)} />;
  if (data.type === "image_request" && data.item)
    return (
      <ImageRequestPanel
        item={data.item}
        onGenerated={(p) => onGenerated?.(p)}
        onCancel={() => onConfirmCancel?.()}
      />
    );
  if (data.type === "confirm" && data.item)
    return (
      <ConfirmPanel
        item={data.item}
        onDone={(m) => onConfirmDone?.(m)}
        onCancel={() => onConfirmCancel?.()}
      />
    );
  return null;
}

// ---- Main page -------------------------------------------------------------
export default function MalakPage() {
  return (
    <UIErrorBoundary>
      <MalakInner />
    </UIErrorBoundary>
  );
}

function MalakInner() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [panel, setPanel] = useState<PanelData | null>(null);
  const [input, setInput] = useState("");
  const [state, setState] = useState<OrbState>("idle");
  const [activeAgent, setActiveAgent] = useState<AgentId>("malak");
  const [listening, setListening] = useState(false);
  const [typed, setTyped] = useState(""); // typewriter buffer for latest malak turn
  const [micSupported, setMicSupported] = useState(true);
  const [orbSize, setOrbSize] = useState(160); // responsive; set on mount
  const [view, setView] = useState<"orb" | "office">("orb"); // الأورب أو مشهد المكتب
  const [pendingImage, setPendingImage] = useState<File | null>(null); // Phase 2C attachment
  const fileInputRef = useRef<HTMLInputElement>(null);

  const recognitionRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  // Audio playback. Chrome blocks HTMLAudio.play() that runs after async work
  // (our TTS arrives after a fetch). The robust fix is the Web Audio API: an
  // AudioContext resumed inside a user gesture can play buffers at any later
  // time without per-play activation. HTMLAudio is kept only as a fallback.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const srcNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const getCtx = (): AudioContext | null => {
    if (typeof window === "undefined") return null;
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return null;
      audioCtxRef.current = new Ctx();
    }
    return audioCtxRef.current;
  };

  const getPlayer = () => {
    if (!audioRef.current) {
      const el = new Audio();
      el.preload = "auto";
      audioRef.current = el;
    }
    return audioRef.current;
  };

  // Must be called from inside a user gesture (click/tap/submit): resume the
  // AudioContext so later programmatic playback is allowed by the autoplay
  // policy. Also primes the HTMLAudio fallback element.
  const unlockAudio = useCallback(() => {
    try {
      const ctx = getCtx();
      if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
    } catch {
      /* ignore */
    }
    try {
      const el = getPlayer();
      el.muted = true;
      el.src =
        "data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBIAAAABAAEAQB8AAEAfAAABAAgAAABmYWN0BAAAAAAAAABkYXRhAAAAAA==";
      Promise.resolve(el.play())
        .then(() => {
          el.pause();
          el.muted = false;
        })
        .catch(() => {
          el.muted = false;
        });
    } catch {
      /* ignore */
    }
  }, []);

  const accent = agentById(activeAgent).color;

  // Responsive orb: small on phones, larger on wide screens. Caps by viewport
  // height too so it never crowds out the transcript on short screens.
  useEffect(() => {
    const calc = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      // Much smaller on phones so it never crowds the chat/panels.
      const byW = w < 360 ? 84 : w < 480 ? 100 : w < 640 ? 128 : 200;
      setOrbSize(Math.round(Math.min(byW, h * 0.18)));
    };
    calc();
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, []);

  // Auto-scroll transcript.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, typed, panel]);

  // ---- TTS ----
  // Stop any in-flight audio / browser speech before starting something new.
  const stopAudio = useCallback(() => {
    try {
      if (srcNodeRef.current) {
        srcNodeRef.current.onended = null;
        srcNodeRef.current.stop();
        srcNodeRef.current = null;
      }
    } catch {
      /* ignore */
    }
    try {
      // Pause but KEEP the element (it's primed) so we can reuse it.
      audioRef.current?.pause();
    } catch {
      /* ignore */
    }
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* ignore */
    }
  }, []);

  // Fallback: the browser's built-in Arabic voice (used if ElevenLabs is
  // unavailable, not configured, or playback is blocked). IMPORTANT: only speak
  // if the system actually has an Arabic voice — otherwise the browser would
  // read Arabic text with an English voice (the "ملاك تتكلم إنجليزي" bug on a
  // PC with no Arabic TTS). In that case we stay silent; the reply is shown.
  const browserSpeak = useCallback((text: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setState("idle");
      return;
    }
    try {
      const voices = window.speechSynthesis.getVoices();
      const ar = voices.find((v) => v.lang?.toLowerCase().startsWith("ar"));
      if (!ar) {
        setState("idle");
        return;
      }
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ar-SA";
      u.voice = ar;
      u.rate = 1;
      u.pitch = 1;
      u.onstart = () => setState("speaking");
      u.onend = () => setState("idle");
      window.speechSynthesis.speak(u);
    } catch {
      setState("idle");
    }
  }, []);

  // Primary: ElevenLabs voice via the server route. Falls back to the browser
  // voice on 204 (not configured), 502 (API error), or playback failure.
  const speak = useCallback(
    async (text: string, agent?: string) => {
      const clean = text.trim();
      if (!clean) return;
      stopAudio();
      try {
        const res = await fetch("/api/malak/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ speak: clean, agent }),
        });
        const ct = res.headers.get("content-type") || "";
        if (res.ok && ct.includes("audio")) {
          const buf = await res.arrayBuffer();

          // Primary path: Web Audio API. A gesture-resumed AudioContext plays
          // buffers reliably even though we're now well past the user gesture.
          const ctx = getCtx();
          if (ctx) {
            try {
              if (ctx.state === "suspended") await ctx.resume();
              // decodeAudioData detaches its input, so hand it a copy.
              const audioBuf = await ctx.decodeAudioData(buf.slice(0));
              const node = ctx.createBufferSource();
              node.buffer = audioBuf;
              node.connect(ctx.destination);
              node.onended = () => {
                if (srcNodeRef.current === node) {
                  srcNodeRef.current = null;
                  setState("idle");
                }
              };
              srcNodeRef.current = node;
              setState("speaking");
              node.start(0);
              return;
            } catch {
              /* fall through to the HTMLAudio element */
            }
          }

          // Fallback path: HTMLAudio element (primed in unlockAudio).
          const url = URL.createObjectURL(new Blob([buf], { type: "audio/mpeg" }));
          const audio = getPlayer();
          audio.onplay = () => setState("speaking");
          audio.onended = () => {
            setState("idle");
            URL.revokeObjectURL(url);
          };
          audio.onerror = () => {
            URL.revokeObjectURL(url);
            browserSpeak(clean);
          };
          audio.src = url;
          try {
            await audio.play();
          } catch {
            // Still blocked → at least don't read Arabic in an English voice.
            URL.revokeObjectURL(url);
            browserSpeak(clean);
          }
          return;
        }
      } catch {
        /* fall through to browser voice */
      }
      browserSpeak(clean);
    },
    [stopAudio, browserSpeak]
  );

  // ---- Typewriter for Malak's reply ----
  const typewriter = useCallback(
    (text: string) => {
      setTyped("");
      let i = 0;
      const step = () => {
        i += 1;
        setTyped(text.slice(0, i));
        if (i < text.length) {
          setTimeout(step, 18);
        } else {
          // commit to transcript
          setTurns((prev) => [...prev, { role: "malak", text }]);
          setTyped("");
        }
      };
      step();
    },
    []
  );

  // ---- Send a message to the Malak brain ----
  const send = useCallback(
    async (text: string) => {
      const clean = text.trim();
      const img = pendingImage;
      if ((!clean && !img) || busyRef.current) return;
      // Runs inside the click/submit gesture → bless the audio element now so
      // the TTS (which arrives after async work) is allowed to play.
      unlockAudio();
      busyRef.current = true;
      stopAudio();

      const userText = clean || "أرفقت صورة لمنتج.";
      const nextTurns: Turn[] = [...turns, { role: "user", text: img ? `📎 ${userText}` : userText }];
      setTurns(nextTurns);
      setInput("");
      setPendingImage(null);
      setPanel(null);
      setState("thinking");

      // Build API message history from committed turns.
      const apiMessages = nextTurns.map((t) => ({
        role: t.role === "user" ? "user" : "assistant",
        content: t.text,
      }));

      try {
        // If an image is attached, upload it first (Storage) → get its URL, then
        // pass it to the brain which forces set_image (a confirm card).
        let imageUrl: string | null = null;
        if (img) {
          const fd = new FormData();
          fd.append("file", img);
          const up = await fetch("/api/malak/upload", { method: "POST", body: fd });
          const upData = await up.json();
          if (upData?.ok && upData.url) {
            imageUrl = upData.url;
          } else {
            typewriter(upData?.error || "فشل رفع الصورة.");
            setState("idle");
            busyRef.current = false;
            return;
          }
        }
        const res = await fetch("/api/malak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: apiMessages, imageUrl }),
        });
        const data = await res.json();
        const ag: AgentId = (AGENTS.some((a) => a.id === data?.agent) ? data.agent : "malak") as AgentId;
        setActiveAgent(ag);
        const speakText = typeof data?.speak === "string" ? data.speak : "تم.";
        if (data?.panel?.type) setPanel(data.panel as PanelData);
        typewriter(speakText);
        speak(speakText, ag);
      } catch {
        const err = "ما قدرت أوصل للخادم، جرّب مرة ثانية.";
        typewriter(err);
        setState("idle");
      } finally {
        busyRef.current = false;
      }
    },
    [turns, typewriter, speak, stopAudio, unlockAudio, pendingImage]
  );

  // ---- Morning briefing: auto store status ONCE per session on open --------
  const briefedRef = useRef(false);
  useEffect(() => {
    if (briefedRef.current) return;
    if (typeof window === "undefined") return;
    if (sessionStorage.getItem("malak_briefed")) return;
    briefedRef.current = true;
    sessionStorage.setItem("malak_briefed", "1");
    (async () => {
      try {
        const res = await fetch("/api/malak/briefing");
        const d = await res.json();
        if (!d || d.error) return;
        setActiveAgent("rashid");
        setPanel({ type: "briefing", item: d });
        // Best-effort voice (may be blocked by autoplay until first interaction;
        // the [▶ استمع] button on the card always works).
        speak(briefSummary(d), "rashid");
      } catch {
        /* briefing is best-effort */
      }
    })();
  }, [speak]);

  // ---- Mic (Web Speech) ----
  useEffect(() => {
    if (typeof window === "undefined") return;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setMicSupported(false);
      return;
    }
    const rec = new SR();
    rec.lang = "ar-SA";
    rec.continuous = false;
    rec.interimResults = false;
    rec.onresult = (e: any) => {
      const transcript = e.results[0][0].transcript;
      setInput("");
      send(transcript);
    };
    rec.onend = () => {
      setListening(false);
      setState((s) => (s === "listening" ? "idle" : s));
    };
    rec.onerror = () => {
      setListening(false);
      setState((s) => (s === "listening" ? "idle" : s));
    };
    recognitionRef.current = rec;
    return () => {
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [send]);

  const toggleMic = () => {
    const rec = recognitionRef.current;
    if (!rec) return;
    // Mic tap is a user gesture → prime audio so the spoken reply can play.
    unlockAudio();
    if (listening) {
      rec.stop();
      setListening(false);
      setState("idle");
    } else {
      try {
        stopAudio();
        rec.start();
        setListening(true);
        setState("listening");
      } catch {
        /* already started */
      }
    }
  };

  const activeDef = agentById(activeAgent);

  return (
    <div
      className="fixed inset-0 flex flex-col overflow-hidden bg-[#060814] text-white"
      style={{
        backgroundImage:
          "radial-gradient(circle at 20% 10%, rgba(79,139,255,0.18), transparent 40%), radial-gradient(circle at 85% 90%, rgba(168,85,247,0.18), transparent 45%)",
      }}
    >
      {/* Top bar */}
      <header className="flex items-center justify-between px-3 py-2 sm:px-6 sm:py-3">
        <Link
          href="/dashboard"
          className="shrink-0 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[12px] text-white/70 backdrop-blur transition hover:bg-white/10 sm:px-3 sm:py-1.5 sm:text-sm"
        >
          ← لوحة التحكم
        </Link>
        <div className="text-center">
          <h1 className="text-base font-extrabold tracking-tight sm:text-lg">ملاك</h1>
          <p className="text-[10px] text-white/40 sm:text-[11px]">المديرة العامة الذكية · v2N</p>
        </div>
        <button
          onClick={() => setView((v) => (v === "orb" ? "office" : "orb"))}
          className="shrink-0 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[12px] text-white/70 backdrop-blur transition hover:bg-white/10 sm:px-3 sm:py-1.5 sm:text-sm"
        >
          {view === "orb" ? "🏢 المكتب" : "✨ ملاك"}
        </button>
      </header>

      {/* Agent rail (horizontal scroll, touch-friendly, compact height) */}
      <div className="flex shrink-0 gap-1 overflow-x-auto px-2 pb-1 pt-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:justify-center sm:gap-1.5 sm:px-6">
        {RAIL.map((a) => {
          const on = a.id === activeAgent;
          return (
            <div
              key={a.id}
              className={`flex shrink-0 flex-col items-center gap-0.5 rounded-xl px-1.5 py-1 transition ${
                on ? "bg-white/10" : "opacity-55"
              }`}
              style={on ? { boxShadow: `0 0 0 1px ${a.color}66, 0 0 14px ${a.color}44` } : undefined}
            >
              <span
                className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition"
                style={{
                  background: on ? a.color : `${a.color}33`,
                  color: on ? "#0b1020" : a.color,
                }}
              >
                {a.name.slice(0, 1)}
              </span>
              <span className="text-[10px] font-medium leading-none text-white/75">{a.name}</span>
              <span className="max-w-[60px] truncate text-center text-[8px] leading-tight text-white/40">
                {a.role}
              </span>
            </div>
          );
        })}
      </div>

      {/* Orb / Office view (toggled from the header) */}
      {view === "orb" ? (
        <div className="relative flex shrink-0 flex-col items-center justify-center py-0.5 sm:py-1">
          <Orb state={state} color={accent} size={orbSize} />
          <div className="-mt-2 text-center sm:-mt-3">
            <p className="text-[13px] font-semibold sm:text-sm" style={{ color: accent }}>
              {activeDef.name}
            </p>
            <p className="text-[10px] text-white/40 sm:text-[11px]">
              {state === "listening"
                ? "أستمع…"
                : state === "thinking"
                ? "أفكّر…"
                : state === "speaking"
                ? "أتحدّث…"
                : activeDef.role}
            </p>
          </div>
        </div>
      ) : (
        <Office3D agents={AGENTS} activeAgent={activeAgent} state={state} />
      )}

      {/* Transcript + panel (scrollable — gets priority for vertical space) */}
      <div ref={scrollRef} className="mx-auto min-h-0 w-full max-w-3xl flex-1 space-y-2.5 overflow-y-auto px-3 py-2.5 sm:space-y-3 sm:px-6 sm:py-3">
        {turns.length === 0 && !typed && panel?.type !== "briefing" ? (
          <div className="mx-auto max-w-md pt-4 text-center text-sm text-white/50">
            أهلًا فهد 👋 أنا ملاك وفريقي جاهزين. اسألني عن الكتالوج، الأسعار، أو خلّني أكتب لك محتوى.
          </div>
        ) : null}

        {turns.map((t, i) => (
          <div key={i} className={`flex ${t.role === "user" ? "justify-start" : "justify-end"}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                t.role === "user"
                  ? "bg-white/10 text-white/90"
                  : "bg-gradient-to-br from-blue-500/25 to-purple-500/25 text-white"
              }`}
            >
              {t.text}
            </div>
          </div>
        ))}

        {typed ? (
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl bg-gradient-to-br from-blue-500/25 to-purple-500/25 px-4 py-2.5 text-sm leading-relaxed text-white">
              {typed}
              <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-white/70 align-middle" />
            </div>
          </div>
        ) : null}

        {panel ? (
          <div className="pt-1">
            <Panel
              data={panel}
              onConfirmDone={(m) => {
                // Record the result in the transcript and speak it; leave the
                // card showing its success state.
                setTurns((prev) => [...prev, { role: "malak", text: m }]);
                speak(m, activeAgent);
              }}
              onConfirmCancel={() => {
                setPanel(null);
                setTurns((prev) => [...prev, { role: "malak", text: "تمام، ألغيت العملية." }]);
              }}
              onGenerated={(p) => {
                // Image generated → swap the request card for the preview card.
                setPanel(p);
              }}
              onQuick={(q) => send(q)}
              onListen={(text) => {
                // Button click is a user gesture → unlock + play (no autoplay block).
                unlockAudio();
                speak(text, "rashid");
              }}
            />
          </div>
        ) : null}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-white/10 bg-black/20 px-4 py-3 backdrop-blur sm:px-6">
       <div className="mx-auto w-full max-w-3xl">
        {/* Quick prompts */}
        <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
          {QUICK_PROMPTS.map((q) => (
            <button
              key={q}
              onClick={() => send(q)}
              className="shrink-0 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white/70 transition hover:bg-white/10"
            >
              {q}
            </button>
          ))}
        </div>

        {/* Attached image preview (Phase 2C) */}
        {pendingImage ? (
          <div className="mb-2 flex items-center gap-2 rounded-xl border border-pink-400/30 bg-pink-500/10 px-2.5 py-1.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={URL.createObjectURL(pendingImage)}
              alt="مرفق"
              className="h-9 w-9 rounded-md object-cover"
            />
            <span className="flex-1 truncate text-[12px] text-white/70">📎 {pendingImage.name}</span>
            <span className="text-[11px] text-white/40">اكتب الـSKU وأرسل</span>
            <button
              type="button"
              onClick={() => setPendingImage(null)}
              aria-label="إزالة الصورة"
              className="flex h-6 w-6 items-center justify-center rounded-full bg-white/10 text-white/70 hover:bg-white/20"
            >
              ×
            </button>
          </div>
        ) : null}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            if (f) setPendingImage(f);
            e.target.value = ""; // allow re-selecting the same file
          }}
        />

        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="flex items-center gap-2"
        >
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label="إرفاق صورة"
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-lg transition ${
              pendingImage ? "bg-pink-500 text-white" : "bg-white/10 text-white/80 hover:bg-white/20"
            }`}
          >
            📎
          </button>
          <button
            type="button"
            onClick={toggleMic}
            disabled={!micSupported}
            aria-label="ميكروفون"
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-lg transition disabled:opacity-30 ${
              listening ? "bg-rose-500 text-white" : "bg-white/10 text-white/80 hover:bg-white/20"
            }`}
            style={listening ? { boxShadow: "0 0 18px rgba(244,63,94,0.6)" } : undefined}
          >
            {listening ? "■" : "🎤"}
          </button>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="اكتب لملاك… (أو استخدم الميكروفون)"
            className="h-11 flex-1 rounded-full border border-white/10 bg-white/5 px-4 text-sm text-white placeholder:text-white/30 focus:border-white/30 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!input.trim()}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-purple-600 text-lg text-white transition disabled:opacity-30"
          >
            ↑
          </button>
        </form>
       </div>
      </div>
    </div>
  );
}
