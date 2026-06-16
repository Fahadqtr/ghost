"use client";

import dynamic from "next/dynamic";
import { Component, useCallback, useEffect, useRef, useState } from "react";
import type { MalakKpis } from "@/lib/dashboard";

// مشهد المكتب 3D (Three.js) — ثقيل، يُحمَّل فقط على المتصفح وعند الحاجة.
const Office3D = dynamic(() => import("./LabScene"), {
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
type AgentId = "malak" | "noor" | "reem" | "siraj" | "razan" | "rashid" | "latifa";

interface AgentDef {
  id: AgentId;
  name: string; // Arabic display name
  role: string; // Arabic role
  color: string; // accent hex
}

const AGENTS: AgentDef[] = [
  { id: "malak", name: "ملاك", role: "المديرة العامة", color: "#4f8bff" },
  { id: "noor", name: "نور", role: "الكتالوج", color: "#38bdf8" },
  { id: "reem", name: "ريم", role: "الصور", color: "#ec4899" },
  { id: "siraj", name: "سراج", role: "المزامنة والمنصّات", color: "#22d3ee" },
  { id: "razan", name: "رزان", role: "الأسعار والمخزون", color: "#34d399" },
  { id: "rashid", name: "راشد", role: "التسويق والتقارير", color: "#fbbf24" },
  { id: "latifa", name: "لطيفة", role: "العملاء", color: "#fb7185" },
];

// The 8 specialists shown on the rail (Malak herself is the orb).
const RAIL = AGENTS.filter((a) => a.id !== "malak");
const agentById = (id: string): AgentDef => AGENTS.find((a) => a.id === id) ?? AGENTS[0];

// Wake-word routing for hands-free mode: detect a called agent's name anywhere
// in the spoken phrase (tolerant of common spelling variants from the speech
// recognizer). Returns the matched agent id, or null when no name is heard.
const AGENT_NAME_PATTERNS: { id: AgentId; re: RegExp }[] = [
  { id: "malak", re: /ملاك|ملك/ },
  { id: "noor", re: /نور/ },
  { id: "reem", re: /ريم|ريما/ },
  { id: "siraj", re: /سراج|سيراج/ },
  { id: "razan", re: /رزان|روزان/ },
  { id: "rashid", re: /راشد|رشيد/ },
  { id: "latifa", re: /لطيفة|لطيفه/ },
];
function detectCalledAgent(text: string): AgentId | null {
  for (const a of AGENT_NAME_PATTERNS) if (a.re.test(text)) return a.id;
  return null;
}
// Remove the wake word / agent name (and a leading "يا") to see whether the
// caller actually said a command, or only the name (e.g. just "يا ملاك").
const STRIP_NAMES_RE = /\b(يا)\b|ملاك|ملك|نور|ريم|ريما|سراج|سيراج|رزان|روزان|راشد|رشيد|لطيفة|لطيفه/g;
function commandAfterWake(text: string): string {
  return text.replace(STRIP_NAMES_RE, " ").replace(/\s+/g, " ").trim();
}

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
  type: "products" | "stats" | "post" | "tiktok" | "confirm" | "image_request" | "briefing";
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
export default function MalakPage({ kpis }: { kpis?: MalakKpis }) {
  return (
    <UIErrorBoundary>
      <MalakInner kpis={kpis} />
    </UIErrorBoundary>
  );
}

function MalakInner({ kpis }: { kpis?: MalakKpis }) {
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
  // الوكيل المُخاطَب مباشرة عند النقر على غرفته في المكتب (يُمرَّر للعقل كـ targetAgent).
  const [directAgent, setDirectAgent] = useState<AgentId | null>(null);
  // تنبيه خطأ احترافي (التفاصيل التقنية تظهر فقط في وضع المطوّر ?dev=1).
  const [errorAlert, setErrorAlert] = useState<{ pretty: string; raw: string } | null>(null);
  const [devMode] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("dev") === "1"
  );
  const [pendingImage, setPendingImage] = useState<File | null>(null); // Phase 2C attachment
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFs, setIsFs] = useState(false);
  // CSS fallback fullscreen for devices without the Fullscreen API (iOS Safari
  // doesn't support requestFullscreen on elements). Fills the viewport via fixed
  // positioning instead.
  const [pseudoFs, setPseudoFs] = useState(false);
  // وضع النداء: استماع متواصل بدون زر — نادِ أي وكيل باسمه فيرد عليك.
  const [handsFree, setHandsFree] = useState(false);
  const handsFreeRef = useRef(false);
  handsFreeRef.current = handsFree;

  const recognitionRef = useRef<any>(null);
  const directAgentRef = useRef<AgentId | null>(null); // mirror of directAgent for the memoized send()
  const scrollRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  // TTS-active guard so the always-on mic doesn't transcribe Malak's own voice
  // (feedback loop). We drop recognition results while speaking and for a short
  // cooldown after.
  const speakingRef = useRef(false);
  const lastSpeakEndRef = useRef(0);
  // Wake-word: while listening, ignore speech until the wake word "ملاك" (or any
  // agent name) is heard. After waking we stay "awake" for a window so follow-up
  // commands don't need the name repeated.
  const awakeUntilRef = useRef(0);
  const AWAKE_MS = 15000;
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

  // Speak lifecycle (centralised) so the always-on mic can mute itself while
  // Malak talks and resume right after — avoiding a self-listening feedback loop.
  const onSpeakStart = useCallback(() => {
    speakingRef.current = true;
    setState("speaking");
    // Pause continuous recognition while Malak's voice is playing.
    if (handsFreeRef.current) { try { recognitionRef.current?.stop(); } catch { /* ignore */ } }
  }, []);
  const onSpeakEnd = useCallback(() => {
    speakingRef.current = false;
    lastSpeakEndRef.current = Date.now();
    setState("idle");
    // Keep the conversation awake after she answers, so a follow-up doesn't need
    // the wake word again.
    if (handsFreeRef.current) awakeUntilRef.current = Date.now() + AWAKE_MS;
    // Resume listening shortly after, past the audio tail / echo.
    if (handsFreeRef.current) {
      setTimeout(() => {
        if (!handsFreeRef.current || speakingRef.current) return;
        try { recognitionRef.current?.start(); setListening(true); setState("listening"); } catch { /* already running */ }
      }, 500);
    }
  }, []);

  // Fallback: the browser's built-in Arabic voice (used if ElevenLabs is
  // unavailable, not configured, or playback is blocked). IMPORTANT: only speak
  // if the system actually has an Arabic voice — otherwise the browser would
  // read Arabic text with an English voice (the "ملاك تتكلم إنجليزي" bug on a
  // PC with no Arabic TTS). In that case we stay silent; the reply is shown.
  const browserSpeak = useCallback((text: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      onSpeakEnd();
      return;
    }
    try {
      const voices = window.speechSynthesis.getVoices();
      const ar = voices.find((v) => v.lang?.toLowerCase().startsWith("ar"));
      if (!ar) {
        onSpeakEnd();
        return;
      }
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ar-SA";
      u.voice = ar;
      u.rate = 1;
      u.pitch = 1;
      u.onstart = () => onSpeakStart();
      u.onend = () => onSpeakEnd();
      window.speechSynthesis.speak(u);
    } catch {
      onSpeakEnd();
    }
  }, [onSpeakStart, onSpeakEnd]);

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
                  onSpeakEnd();
                }
              };
              srcNodeRef.current = node;
              onSpeakStart();
              node.start(0);
              return;
            } catch {
              /* fall through to the HTMLAudio element */
            }
          }

          // Fallback path: HTMLAudio element (primed in unlockAudio).
          const url = URL.createObjectURL(new Blob([buf], { type: "audio/mpeg" }));
          const audio = getPlayer();
          audio.onplay = () => onSpeakStart();
          audio.onended = () => {
            onSpeakEnd();
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
    [stopAudio, browserSpeak, onSpeakStart, onSpeakEnd]
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

  // Resume continuous listening after a turn that produced no spoken reply
  // (e.g. an error). When Malak does speak, onSpeakEnd handles the resume.
  const resumeHandsFree = useCallback(() => {
    if (!handsFreeRef.current || speakingRef.current) return;
    setTimeout(() => {
      if (!handsFreeRef.current || speakingRef.current || busyRef.current) return;
      try { recognitionRef.current?.start(); setListening(true); setState("listening"); } catch { /* already running */ }
    }, 400);
  }, []);

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
            resumeHandsFree();
            return;
          }
        }
        const res = await fetch("/api/malak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: apiMessages, imageUrl, targetAgent: directAgentRef.current }),
        });
        const data = await res.json();
        const ag: AgentId = (AGENTS.some((a) => a.id === data?.agent) ? data.agent : "malak") as AgentId;
        const speakText = typeof data?.speak === "string" ? data.speak : "تم.";
        // Technical/config errors → professional alert (raw hidden unless ?dev=1).
        if (/ANTHROPIC_API_KEY|SUPABASE_SERVICE_ROLE_KEY|Service role|صار خطأ تقني|غير مهيأ|not configured/i.test(speakText)) {
          setErrorAlert({ pretty: "تعذّر تنفيذ الطلب — إعدادات قاعدة البيانات غير مكتملة", raw: speakText });
          setState("idle");
          resumeHandsFree();
        } else {
          setActiveAgent(ag);
          if (data?.panel?.type) setPanel(data.panel as PanelData);
          typewriter(speakText);
          speak(speakText, ag);
        }
      } catch (e) {
        setErrorAlert({ pretty: "تعذّر الاتصال بالخادم — حاول مرة ثانية", raw: String((e as Error)?.message || e) });
        setState("idle");
        resumeHandsFree();
      } finally {
        busyRef.current = false;
      }
    },
    [turns, typewriter, speak, stopAudio, unlockAudio, pendingImage, resumeHandsFree]
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

  // ---- Mic (Web Speech) — push-to-talk button AND hands-free wake mode ----
  useEffect(() => {
    if (typeof window === "undefined") return;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setMicSupported(false);
      return;
    }
    const rec = new SR();
    rec.lang = "ar-SA";
    rec.interimResults = false;
    rec.onresult = (e: any) => {
      const transcript = String(e.results[e.results.length - 1][0].transcript || "").trim();
      if (!transcript) return;
      // Feedback-loop guard: drop anything heard while Malak is speaking, while a
      // request is in flight, or within a short cooldown after her voice ends
      // (otherwise the always-on mic transcribes her own reply).
      if (speakingRef.current || busyRef.current || Date.now() - lastSpeakEndRef.current < 900) return;
      // Hands-free: wake-word gated. Sleep until "ملاك" (or any agent name) is
      // heard; once awake, a short window lets follow-ups skip the name.
      if (handsFreeRef.current) {
        const called = detectCalledAgent(transcript);
        const awake = Date.now() < awakeUntilRef.current;
        if (!called && !awake) return; // still asleep — wait for the wake word
        if (called) {
          setActiveAgent(called);
          setDirectAgent(called);
          directAgentRef.current = called;
        }
        awakeUntilRef.current = Date.now() + AWAKE_MS;
        // Bare wake word with no command → acknowledge and keep listening.
        if (called && commandAfterWake(transcript).length < 2) {
          const a = agentById(called);
          const greet = called === "malak" ? "نعم فهد، تأمر؟" : `معاك ${a.name}، تأمر؟`;
          setTyped("");
          setTurns((prev) => [...prev, { role: "malak", text: greet }]);
          speak(greet, called);
          return;
        }
      }
      setInput("");
      send(transcript);
    };
    rec.onend = () => {
      setListening(false);
      // Hands-free: keep listening — auto-restart unless Malak is mid-speech
      // (we resume from onSpeakEnd) or a request is being processed.
      if (handsFreeRef.current && !speakingRef.current && !busyRef.current) {
        try { rec.start(); setListening(true); setState((s) => (s === "idle" ? "listening" : s)); return; } catch { /* will retry */ }
      }
      setState((s) => (s === "listening" ? "idle" : s));
    };
    rec.onerror = (ev: any) => {
      setListening(false);
      // Transient errors (no-speech, network) are expected in continuous mode;
      // onend fires right after and handles the restart.
      if (!handsFreeRef.current) setState((s) => (s === "listening" ? "idle" : s));
      void ev;
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
      rec.continuous = false;
      rec.stop();
      setListening(false);
      setState("idle");
    } else {
      try {
        stopAudio();
        rec.continuous = false; // single push-to-talk utterance
        rec.start();
        setListening(true);
        setState("listening");
      } catch {
        /* already started */
      }
    }
  };

  // Hands-free wake mode: continuous listening, no button. Say the wake word
  // "ملاك" (or any agent name) and she answers; follow-ups stay awake for a
  // window. The mic mutes itself while Malak speaks (no feedback).
  const toggleHandsFree = () => {
    const rec = recognitionRef.current;
    if (!rec) return;
    unlockAudio(); // user gesture → allow spoken replies to play
    if (handsFree) {
      setHandsFree(false);
      handsFreeRef.current = false;
      awakeUntilRef.current = 0;
      try { rec.continuous = false; rec.stop(); } catch { /* ignore */ }
      setListening(false);
      setState("idle");
    } else {
      setHandsFree(true);
      handsFreeRef.current = true;
      // Pressing the button is a deliberate wake → listen for the first command
      // immediately (no need to say "ملاك" right after tapping).
      awakeUntilRef.current = Date.now() + AWAKE_MS;
      stopAudio();
      try {
        rec.continuous = true;
        rec.start();
        setListening(true);
        setState("listening");
      } catch {
        /* already running */
      }
    }
  };

  useEffect(() => {
    const onFs = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const activeDef = agentById(activeAgent);

  const toggleFullscreen = () => {
    const el = rootRef.current;
    if (!el) return;
    if (isFs || pseudoFs) {
      // Exit whichever mode is active.
      if (document.fullscreenElement) document.exitFullscreen?.();
      setPseudoFs(false);
      return;
    }
    // Prefer the native Fullscreen API; fall back to CSS fill on devices that
    // don't support it (notably iOS Safari, where it's undefined on elements).
    if (el.requestFullscreen) {
      el.requestFullscreen().catch(() => setPseudoFs(true));
    } else {
      setPseudoFs(true);
    }
  };

  // Combined flag: native fullscreen OR the CSS fallback.
  const fsActive = isFs || pseudoFs;

  return (
    <div
      ref={rootRef}
      className={
        fsActive
          ? // Fullscreen: full-width, full-height flex column so the lab fills the
            // screen. 100dvh accounts for mobile browser chrome; pseudoFs adds
            // fixed positioning since there's no native FS element (iOS Safari).
            `flex h-[100dvh] w-full flex-col gap-3 overflow-hidden bg-[#0B1020] p-3 sm:p-4 ${
              pseudoFs ? "fixed inset-0 z-50" : ""
            }`
          : "mx-auto w-full max-w-6xl space-y-4 pb-2"
      }
    >
      {/* Header (hidden in fullscreen to give the lab the whole screen) */}
      {fsActive ? null : (
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-lg font-extrabold tracking-tight sm:text-xl">
              ملاك · <span className="text-white/60">Malak AI</span>
            </h1>
            <p className="text-xs text-white/45">المديرة العامة الذكية · Malika&apos;s Universe Trading</p>
          </div>
        </div>
      )}

      {/* Professional error alert (raw technical details only when ?dev=1) */}
      {errorAlert ? (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-400/30 bg-amber-500/10 p-3 text-sm">
          <span className="text-lg leading-none">⚠️</span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-amber-200">{errorAlert.pretty}</p>
            {devMode && errorAlert.raw ? (
              <pre dir="ltr" className="mt-1.5 overflow-x-auto rounded-lg bg-black/40 p-2 text-left text-[11px] text-amber-100/80">
                {errorAlert.raw}
              </pre>
            ) : null}
          </div>
          <button onClick={() => setErrorAlert(null)} aria-label="إغلاق" className="shrink-0 text-white/50 hover:text-white">
            ×
          </button>
        </div>
      ) : null}

      {/* Hero: the interactive 3D lab (click an agent to talk).
          In fullscreen it grows (flex-1) to fill the whole screen. */}
      <div
        className={`relative flex flex-col overflow-hidden rounded-3xl border border-white/10 bg-[#0b1020] shadow-xl ${
          fsActive ? "min-h-0 flex-1" : "h-[42vh] sm:h-[58vh]"
        }`}
      >
        <Office3D
          agents={AGENTS}
          activeAgent={activeAgent}
          state={state}
          onSelect={(id) => {
            const ag = id as AgentId;
            setActiveAgent(ag);
            setDirectAgent(ag);
            directAgentRef.current = ag;
          }}
        />
        <button
          type="button"
          onClick={toggleFullscreen}
          className="absolute left-3 top-3 z-10 rounded-full border border-white/15 bg-black/45 px-3 py-1.5 text-[11px] font-bold text-white/90 shadow backdrop-blur-sm hover:bg-black/60"
        >
          {fsActive ? "↙ تصغير" : "⛶ ملء الشاشة"}
        </button>
      </div>

      {/* JARVIS-style pop-in keyframes (used by the holographic output overlay) */}
      <style>{`
        @keyframes hudIn { 0%{opacity:0;transform:translateY(12px) scale(.94);filter:blur(6px)} 100%{opacity:1;transform:none;filter:none} }
      `}</style>

      {/* Agent rail (tap to talk) */}
      <div className={`flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${fsActive ? "shrink-0" : ""}`}>
        {RAIL.map((a) => {
          const on = a.id === activeAgent;
          return (
            <button
              key={a.id}
              onClick={() => {
                const ag = a.id as AgentId;
                setActiveAgent(ag);
                setDirectAgent(ag);
                directAgentRef.current = ag;
              }}
              className={`flex shrink-0 flex-col items-center gap-0.5 rounded-xl px-2 py-1.5 transition ${
                on ? "bg-white/10" : "opacity-60 hover:opacity-100"
              }`}
              style={on ? { boxShadow: `0 0 0 1px ${a.color}66, 0 0 14px ${a.color}44` } : undefined}
            >
              <span
                className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold"
                style={{ background: on ? a.color : `${a.color}33`, color: on ? "#0b1020" : a.color }}
              >
                {a.name.slice(0, 1)}
              </span>
              <span className="text-[10px] font-medium leading-none text-white/75">{a.name}</span>
            </button>
          );
        })}
      </div>

      {/* Agent card (when an agent is selected) */}
      {directAgent ? (
        <div
          className={`flex items-center gap-3 rounded-2xl border p-3 ${fsActive ? "shrink-0" : ""}`}
          style={{ borderColor: `${agentById(directAgent).color}55`, background: `${agentById(directAgent).color}14` }}
        >
          <span
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-base font-bold"
            style={{ background: agentById(directAgent).color, color: "#0b1020" }}
          >
            {agentById(directAgent).name.slice(0, 1)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold">{agentById(directAgent).name}</p>
            <p className="truncate text-[11px] text-white/55">
              {agentById(directAgent).role} · آخر مهمة: لا توجد مهام بعد
            </p>
          </div>
          <button
            onClick={() => {
              unlockAudio();
              const a = agentById(directAgent);
              send(`معك ${a.name}؟ عطني ملخص سريع عن وضع ${a.role} وأهم نقطة تحتاج تصرّف.`);
              scrollRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }}
            className="shrink-0 rounded-full px-3 py-1.5 text-[12px] font-bold text-[#0b1020]"
            style={{ background: agentById(directAgent).color }}
          >
            تشغيل
          </button>
          <button
            onClick={() => { inputRef.current?.focus(); scrollRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }}
            className="shrink-0 rounded-full border border-white/15 px-3 py-1.5 text-[12px] text-white/80 hover:bg-white/10"
          >
            التفاصيل
          </button>
        </div>
      ) : null}

      {/* Chat card. In fullscreen it stays a fixed, compact height (shrink-0) so
          it never grows and pushes the layout past the screen — the lab keeps
          the rest of the space and nothing scrolls the page. */}
      <div className={`rounded-3xl border border-white/10 bg-white/[0.03] p-2.5 sm:p-3 ${fsActive ? "shrink-0" : ""}`}>
        {/* Transcript + panel. In fullscreen it gets a taller, comfortably
            scrollable area (the lab flexes to fill the rest, no page overflow). */}
        <div ref={scrollRef} className={`space-y-2.5 overflow-y-auto px-1 py-1 ${fsActive ? "h-[38vh]" : "max-h-[44vh] min-h-[140px]"}`}>
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

        {/* (structured results pop up as a holographic overlay — see below) */}
      </div>

        {/* Composer */}
        <div className="mt-2 border-t border-white/10 pt-2.5">
        {/* Hands-free wake mode: call any agent by name, no button */}
        <div className="mb-2 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={toggleHandsFree}
            disabled={!micSupported}
            className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-bold transition disabled:opacity-30 ${
              handsFree
                ? "bg-emerald-500 text-white"
                : "border border-white/15 bg-white/5 text-white/80 hover:bg-white/10"
            }`}
            style={handsFree ? { boxShadow: "0 0 16px rgba(16,185,129,0.6)" } : undefined}
            aria-pressed={handsFree}
          >
            <span className={handsFree ? "animate-pulse" : ""}>{handsFree ? "🟢" : "🛎️"}</span>
            {handsFree ? "ينصت · قل «ملاك»" : "كلمة الإيقاظ الصوتية"}
          </button>
          {handsFree ? (
            <span className="truncate text-[11px] text-emerald-300/80">قل «ملاك» وترد عليك — أو نادِ أي وكيل باسمه</span>
          ) : (
            <span className="hidden truncate text-[11px] text-white/40 sm:block">نادِ «ملاك» فتنتبه وترد</span>
          )}
        </div>
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
            ref={inputRef}
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

      {/* Holographic output overlay (JARVIS): structured results pop up here */}
      {panel ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
          <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={() => setPanel(null)} />
          <div
            className="relative z-10 flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl"
            style={{
              border: "1px solid #22d3ee66",
              background: "linear-gradient(160deg, rgba(34,211,238,0.10), rgba(11,16,32,0.97))",
              boxShadow: "0 0 44px rgba(34,211,238,0.35), inset 0 0 30px rgba(34,211,238,0.08)",
              animation: "hudIn .4s ease-out both",
            }}
          >
            {/* scanlines */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 opacity-[0.12]"
              style={{ backgroundImage: "repeating-linear-gradient(0deg, #22d3ee 0px, #22d3ee 1px, transparent 1px, transparent 4px)" }}
            />
            {/* corner brackets */}
            <span aria-hidden className="absolute left-2 top-2 h-4 w-4 border-l-2 border-t-2 border-cyan-400/70" />
            <span aria-hidden className="absolute right-2 top-2 h-4 w-4 border-r-2 border-t-2 border-cyan-400/70" />
            <span aria-hidden className="absolute bottom-2 left-2 h-4 w-4 border-b-2 border-l-2 border-cyan-400/70" />
            <span aria-hidden className="absolute bottom-2 right-2 h-4 w-4 border-b-2 border-r-2 border-cyan-400/70" />
            {/* header */}
            <div className="relative flex items-center justify-between border-b border-cyan-400/30 px-4 py-2.5">
              <span className="font-mono text-[11px] tracking-[0.25em] text-cyan-300">◢ MALAK · النتيجة</span>
              <button
                type="button"
                onClick={() => setPanel(null)}
                aria-label="إغلاق"
                className="flex h-7 w-7 items-center justify-center rounded-full border border-cyan-400/40 text-cyan-200 hover:bg-cyan-400/10"
              >
                ✕
              </button>
            </div>
            {/* content */}
            <div className="relative min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
              <Panel
                data={panel}
                onConfirmDone={(m) => {
                  setTurns((prev) => [...prev, { role: "malak", text: m }]);
                  speak(m, activeAgent);
                }}
                onConfirmCancel={() => {
                  setPanel(null);
                  setTurns((prev) => [...prev, { role: "malak", text: "تمام، ألغيت العملية." }]);
                }}
                onGenerated={(p) => setPanel(p)}
                onQuick={(q) => { setPanel(null); send(q); }}
                onListen={(text) => { unlockAudio(); speak(text, "rashid"); }}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
