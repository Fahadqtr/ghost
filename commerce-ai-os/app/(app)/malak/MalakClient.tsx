"use client";

import { Component, useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { MalakKpis } from "@/lib/dashboard";

// Real 3D AI core (R3F) — browser-only, so load it without SSR.
const AiCoreOrb = dynamic(() => import("./AiCoreOrb"), {
  ssr: false,
  loading: () => <div className="h-full w-full" />,
});
import { HudLeft, HudRight, HudObjective, FooterStatusBar, type ScanData } from "./HudParts";

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

// ---- Malak (single assistant — she does everything herself) ---------------
type AgentId = "malak";

interface AgentDef {
  id: AgentId;
  name: string; // Arabic display name
  role: string; // Arabic role
  color: string; // accent hex
}

const AGENTS: AgentDef[] = [
  { id: "malak", name: "ملاك", role: "المديرة العامة — تسوّي كل شي", color: "#4f8bff" },
];

const RAIL: AgentDef[] = []; // no team rail anymore
const agentById = (_id: string): AgentDef => AGENTS[0];

// Wake-word for hands-free mode: only "ملاك" now (single assistant).
const WAKE_RE = /ملاك|ملك/;
function detectCalledAgent(text: string): AgentId | null {
  return WAKE_RE.test(text) ? "malak" : null;
}
// Remove the wake word (and a leading "يا") to see whether the caller said a
// command, or only the wake word (e.g. just "يا ملاك").
const STRIP_NAMES_RE = /\b(يا)\b|ملاك|ملك/g;
function commandAfterWake(text: string): string {
  return text.replace(STRIP_NAMES_RE, " ").replace(/\s+/g, " ").trim();
}

// Barge-in echo filter: while Malak is speaking, the always-on mic may transcribe
// HER own voice. We compare what's heard against what she's currently saying — if
// most words overlap it's an echo (ignore); otherwise it's the user interrupting.
const normAr = (s: string) =>
  s.replace(/[ً-ْٰـ]/g, "").replace(/[^؀-ۿ\s]/g, " ").replace(/\s+/g, " ").trim();
function isLikelyEcho(heard: string, spoken: string): boolean {
  const sp = new Set(normAr(spoken).split(" ").filter((w) => w.length > 1));
  if (sp.size === 0) return false;
  const hw = normAr(heard).split(" ").filter((w) => w.length > 1);
  if (hw.length === 0) return true;
  const overlap = hw.filter((w) => sp.has(w)).length;
  return overlap / hw.length >= 0.5;
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
  type: "products" | "stats" | "post" | "tiktok" | "confirm" | "image_request" | "briefing" | "scan";
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
    `${greet} فهد. عندك ${d.total} منتج، ${d.rejected} مرفوض و ${d.lowStock} ستوك منخفض و ${d.missingImages} بدون صورة. ` +
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
        <a
          href="/malak/audit"
          className="rounded-full border border-white/20 bg-white/5 px-3 py-1.5 text-[12px] text-white/80 transition hover:bg-white/10"
        >
          📋 سجل ملاك
        </a>
      </div>
    </div>
  );
}

// Proactive scan card (Phase 3): greeting + a prioritized list of issues, each
// with a one-tap [عالجها] button that routes the fix prompt back through Malak.
function ScanPanel({
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
  const issues: { key: string; icon: string; title: string; count: number; prompt: string; severity: string }[] = item.issues ?? [];
  const sevTone: Record<string, string> = {
    high: "border-rose-400/30 bg-rose-500/10",
    med: "border-amber-400/30 bg-amber-500/10",
    low: "border-sky-400/30 bg-sky-500/10",
  };

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

      {item.allClear ? (
        <p className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3 py-3 text-center text-[13px] font-medium text-emerald-100">
          ✅ كل شي تمام — ما في بند عاجل اليوم. عندك {item.total ?? 0} منتج، الوضع نظيف.
        </p>
      ) : (
        <>
          <p className="text-[12px] text-white/70">🔍 اللي يحتاج تصرّف — مرتّب بالأهم:</p>
          <div className="space-y-2">
            {issues.map((is) => (
              <div key={is.key} className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 ${sevTone[is.severity] ?? "border-white/15 bg-white/5"}`}>
                <button
                  onClick={() => onQuick(is.prompt)}
                  className="shrink-0 rounded-full bg-white/15 px-3 py-1 text-[12px] font-semibold text-white transition hover:bg-white/25"
                >
                  عالجها ←
                </button>
                <span className="text-[13px] text-white/85">
                  {is.icon} {is.title} <span className="font-extrabold text-white">({is.count})</span>
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        <a
          href="/malak/audit"
          className="rounded-full border border-white/20 bg-white/5 px-3 py-1.5 text-[12px] text-white/80 transition hover:bg-white/10"
        >
          📋 سجل ملاك
        </a>
      </div>
    </div>
  );
}

// A draggable holographic result window. Several can be open at once; drag by
// the header, close with ✕.
function ResultWindow({
  data, index, onClose, onConfirmDone, onConfirmCancel, onGenerated, onQuick, onListen,
}: {
  data: PanelData;
  index: number;
  onClose: () => void;
  onConfirmDone?: (message: string) => void;
  onConfirmCancel?: () => void;
  onGenerated?: (panel: PanelData) => void;
  onQuick?: (q: string) => void;
  onListen?: (text: string) => void;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const winRef = useRef<HTMLDivElement>(null);

  const onDown = (e: React.PointerEvent) => {
    const r = winRef.current?.getBoundingClientRect();
    if (!r) return;
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setPos({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy });
  };
  const onUp = () => { drag.current = null; };

  // Each window flies out to a different anchor around the orb (right / left /
  // bottom corners), then is draggable anywhere.
  const ANCHORS: React.CSSProperties[] = [
    { right: "4%", top: "22%" },
    { left: "4%", top: "22%" },
    { right: "6%", bottom: "10%" },
    { left: "6%", bottom: "10%" },
    { left: "50%", top: "18%", transform: "translateX(-50%)" },
  ];
  const posStyle: React.CSSProperties = pos ? { left: pos.x, top: pos.y } : ANCHORS[index % ANCHORS.length];

  return (
    <div
      ref={winRef}
      data-win
      className="fixed z-50 w-[min(92vw,460px)]"
      style={{ ...posStyle, maxHeight: "70vh", animation: "hudIn .22s ease-out both" }}
    >
      <div
        className="flex max-h-[70vh] flex-col overflow-hidden rounded-2xl"
        style={{
          border: "1px solid #22d3ee66",
          background: "linear-gradient(160deg, rgba(34,211,238,0.10), rgba(11,16,32,0.97))",
          boxShadow: "0 0 44px rgba(34,211,238,0.35), inset 0 0 30px rgba(34,211,238,0.08)",
        }}
      >
        <span aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.10]" style={{ backgroundImage: "repeating-linear-gradient(0deg, #22d3ee 0px, #22d3ee 1px, transparent 1px, transparent 4px)" }} />
        <span aria-hidden className="absolute left-2 top-2 h-4 w-4 border-l-2 border-t-2 border-cyan-400/70" />
        <span aria-hidden className="absolute right-2 top-2 h-4 w-4 border-r-2 border-t-2 border-cyan-400/70" />
        {/* header = drag handle */}
        <div
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          className="relative flex cursor-move touch-none items-center justify-between border-b border-cyan-400/30 px-4 py-2.5 select-none"
        >
          <span className="font-mono text-[11px] tracking-[0.25em] text-cyan-300">◢ MALAK · النتيجة</span>
          <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={onClose} aria-label="إغلاق" className="flex h-7 w-7 items-center justify-center rounded-full border border-cyan-400/40 text-cyan-200 hover:bg-cyan-400/10">✕</button>
        </div>
        <div className="relative min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
          <Panel data={data} onConfirmDone={onConfirmDone} onConfirmCancel={onConfirmCancel} onGenerated={onGenerated} onQuick={onQuick} onListen={onListen} />
        </div>
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
  if (data.type === "scan" && data.item)
    return <ScanPanel item={data.item} onQuick={(q) => onQuick?.(q)} onListen={(t) => onListen?.(t)} />;
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
  // Multiple result windows can be open at once (one per request).
  const [panels, setPanels] = useState<PanelData[]>([]);
  const pushPanel = useCallback((p: PanelData) => setPanels((ps) => [...ps.slice(-3), p]), []); // keep last 4
  const closePanel = useCallback((idx: number) => setPanels((ps) => ps.filter((_, i) => i !== idx)), []);
  const [scanData, setScanData] = useState<ScanData | null>(null); // HUD side panels
  const [hudClock, setHudClock] = useState("--:--:--");
  const [uptime, setUptime] = useState("0:00:00");
  const mountRef = useRef(Date.now());
  const [input, setInput] = useState("");
  const [state, setState] = useState<OrbState>("idle");
  const [activeAgent, setActiveAgent] = useState<AgentId>("malak");
  const [listening, setListening] = useState(false);
  const [typed, setTyped] = useState(""); // typewriter buffer for latest malak turn
  const [micSupported, setMicSupported] = useState(true);
  const [orbSize, setOrbSize] = useState(160); // responsive; set on mount
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
  // "استماع دائم": يُحفظ في localStorage فيشتغل تلقائيًا كل زيارة (من أول لمسة).
  const [alwaysOn, setAlwaysOn] = useState(false);

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
  // What Malak is currently saying — used to filter her own voice out of the
  // always-on mic so real interruptions (barge-in) can be detected.
  const currentSpeakTextRef = useRef("");
  // Audio playback. Chrome blocks HTMLAudio.play() that runs after async work
  // (our TTS arrives after a fetch). The robust fix is the Web Audio API: an
  // AudioContext resumed inside a user gesture can play buffers at any later
  // time without per-play activation. HTMLAudio is kept only as a fallback.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const srcNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Live output level (0..1) of Malak's voice, sampled from an analyser while
  // she speaks — drives the JARVIS orb's breathing so it moves with her voice.
  const levelRef = useRef(0);
  const meterRafRef = useRef<number | null>(null);

  // Tap the Web Audio graph: node → analyser → destination, then sample RMS.
  const startMeter = useCallback((ctx: AudioContext, node: AudioBufferSourceNode): AnalyserNode => {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    node.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / data.length); // ~0..0.5 for speech
      // smooth + normalize to a lively 0..1
      levelRef.current = levelRef.current * 0.6 + Math.min(1, rms * 2.4) * 0.4;
      meterRafRef.current = requestAnimationFrame(tick);
    };
    meterRafRef.current = requestAnimationFrame(tick);
    return analyser;
  }, []);

  const stopMeter = useCallback(() => {
    if (meterRafRef.current != null) cancelAnimationFrame(meterRafRef.current);
    meterRafRef.current = null;
    levelRef.current = 0;
  }, []);

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
  }, [turns, typed, panels]);

  // ---- TTS ----
  // Stop any in-flight audio / browser speech before starting something new.
  const stopAudio = useCallback(() => {
    stopMeter();
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
  }, [stopMeter]);

  // Speak lifecycle (centralised). In hands-free we KEEP the mic running while
  // Malak talks so the user can interrupt (barge-in); her own voice is filtered
  // out by isLikelyEcho. In push-to-talk we don't need the mic open meanwhile.
  const onSpeakStart = useCallback(() => {
    speakingRef.current = true;
    setState("speaking");
    if (handsFreeRef.current) {
      try { recognitionRef.current?.start(); setListening(true); } catch { /* already running */ }
    }
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
      currentSpeakTextRef.current = clean; // for the barge-in echo filter
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
              // node → analyser → destination so we can meter her live level.
              const analyser = startMeter(ctx, node);
              analyser.connect(ctx.destination);
              node.onended = () => {
                if (srcNodeRef.current === node) {
                  srcNodeRef.current = null;
                  stopMeter();
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
          if (data?.panel?.type) pushPanel(data.panel as PanelData);
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

  // Live HUD clock.
  useEffect(() => {
    const tick = () => {
      const d = new Date(); const p = (n: number) => String(n).padStart(2, "0");
      setHudClock(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`);
      const u = Math.floor((Date.now() - mountRef.current) / 1000);
      setUptime(`${Math.floor(u / 3600)}:${p(Math.floor((u % 3600) / 60))}:${p(u % 60)}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // ---- Proactive scan: ALWAYS load the data on open (it feeds the HUD side
  // panels every visit). Only the spoken briefing is throttled to once/session.
  const briefedRef = useRef(false);
  useEffect(() => {
    if (briefedRef.current) return;
    if (typeof window === "undefined") return;
    briefedRef.current = true;
    (async () => {
      try {
        const res = await fetch("/api/malak/scan");
        const d = await res.json();
        if (!d || d.error) return;
        setActiveAgent("malak");
        setScanData(d as ScanData); // feeds the HUD side panels (every load)
        if (!sessionStorage.getItem("malak_briefed")) {
          sessionStorage.setItem("malak_briefed", "1");
          speak(briefSummary(d), "malak"); // voice brief once per session
        }
      } catch {
        /* scan is best-effort */
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

      // Barge-in: if Malak is mid-speech and the user talks over her, decide
      // whether it's her own voice (echo → ignore) or a real interruption.
      if (speakingRef.current) {
        if (isLikelyEcho(transcript, currentSpeakTextRef.current)) return;
        // Genuine interruption → cut her off immediately.
        stopAudio();
        speakingRef.current = false;
        lastSpeakEndRef.current = Date.now();
        setState("listening");
        // Pure "stop" command → just stop, don't send anything.
        const n = normAr(transcript);
        if (n.length < 2 || /^(قف|توقف|بس|كفى|اسكتي|اسكت|ستوب|stop)\b/.test(n)) return;
        awakeUntilRef.current = Date.now() + AWAKE_MS; // interrupting = clearly engaged
        // otherwise fall through and process the new request.
      } else {
        // Not speaking: ignore while a request is processing, and a brief
        // cooldown after her voice ends (trailing echo).
        if (busyRef.current || Date.now() - lastSpeakEndRef.current < 500) return;
      }

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
          const greet = "نعم فهد، تأمر؟";
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
  // "ملاك" (or any agent name) and she answers. Enabling it is remembered in
  // localStorage so it auto-resumes on every visit (always-listening).
  const startRec = useCallback(() => {
    const rec = recognitionRef.current;
    if (!rec) return false;
    try { rec.continuous = true; rec.start(); setListening(true); setState((s) => (s === "idle" ? "listening" : s)); return true; }
    catch { return false; }
  }, []);

  const enableHandsFree = useCallback((gesture = false) => {
    if (!recognitionRef.current) return;
    setHandsFree(true);
    handsFreeRef.current = true;
    awakeUntilRef.current = Date.now() + AWAKE_MS; // engaged → listen immediately
    try { localStorage.setItem("malak_always_listen", "1"); } catch { /* ignore */ }
    setAlwaysOn(true);
    if (gesture) unlockAudio(); // a real user gesture → unlock TTS playback
    stopAudio();
    startRec();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startRec, unlockAudio, stopAudio]);

  const disableHandsFree = useCallback(() => {
    setHandsFree(false);
    handsFreeRef.current = false;
    awakeUntilRef.current = 0;
    try { localStorage.setItem("malak_always_listen", "0"); } catch { /* ignore */ }
    setAlwaysOn(false);
    try { const rec = recognitionRef.current; if (rec) { rec.continuous = false; rec.stop(); } } catch { /* ignore */ }
    setListening(false);
    setState("idle");
  }, []);

  const toggleHandsFree = () => {
    unlockAudio(); // user gesture
    if (handsFree) disableHandsFree();
    else enableHandsFree(true);
  };

  // Always-listening: if the user enabled it before, auto-resume. Browsers block
  // starting the mic with no user interaction, so we try immediately (works when
  // mic permission is already granted) and otherwise start on the first tap/key.
  useEffect(() => {
    if (typeof window === "undefined" || !micSupported) return;
    let persisted = false;
    try { persisted = localStorage.getItem("malak_always_listen") === "1"; } catch { /* ignore */ }
    setAlwaysOn(persisted);
    if (!persisted) return;
    const t = setTimeout(() => enableHandsFree(false), 300); // optimistic (permission granted)
    const onGesture = () => enableHandsFree(true);
    window.addEventListener("pointerdown", onGesture, { once: true, capture: true });
    window.addEventListener("keydown", onGesture, { once: true, capture: true });
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", onGesture, true);
      window.removeEventListener("keydown", onGesture, true);
    };
  }, [micSupported, enableHandsFree]);

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

  // The HUD panels always render (so the dashboard frame is always there); they
  // fill with zeros until the scan loads.
  const sd: ScanData = scanData ?? {
    total: 0, approved: 0, rejected: 0, missingImages: 0, lowStock: 0, outOfStock: 0,
    suspiciousPrice: 0, channelMismatch: 0, issues: [], recentActivity: [],
    priority: "…يفحص الوضع", allClear: true,
  };

  return (
    <div
      ref={rootRef}
      className={
        fsActive
          ? // Fullscreen: full-width, full-height flex column so the lab fills the
            // screen. 100dvh accounts for mobile browser chrome; pseudoFs adds
            // fixed positioning since there's no native FS element (iOS Safari).
            `h-[100dvh] w-full space-y-3 overflow-y-auto p-3 sm:p-4 ${
              pseudoFs ? "fixed inset-0 z-50" : ""
            }`
          : "mx-auto w-full max-w-7xl space-y-3 pb-2"
      }
      style={fsActive ? { background: "#020711" } : undefined}
    >
      {/* Mission-Control header */}
      {true ? (
        <div dir="ltr" className="flex flex-wrap items-start justify-between gap-3 font-mono">
          <div>
            <p className="text-[13px] font-bold tracking-[0.2em] text-cyan-50">MALIKA&apos;S UNIVERSE <span className="text-cyan-300/50">// COMMERCE CONTROL</span></p>
            <p dir="rtl" className="text-[10px] tracking-[0.15em] text-cyan-300/50">ملاك · المديرة العامة الذكية</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {["ONLINE", "SECURE", scanData ? (scanData.channelMismatch ? "SYNC NEEDED" : "SYNCED") : "…", "AUTH-LVL9"].map((c, i) => (
                <span key={i} className="inline-flex items-center gap-1 rounded-sm border border-cyan-500/25 px-2 py-0.5 text-[8.5px] tracking-widest text-cyan-300/60">
                  <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" style={{ boxShadow: "0 0 6px #4cc3ff" }} />{c}
                </span>
              ))}
            </div>
          </div>
          {/* state tabs (AUTO / IDLE / THINKING / TALKING) — active glows */}
          <div className="order-3 flex items-center gap-1 self-center rounded-md border px-1 py-1 sm:order-2" style={{ borderColor: "rgba(0,217,255,0.2)", background: "rgba(4,17,31,0.5)" }}>
            {(["AUTO", "IDLE", "THINKING", "TALKING"] as const).map((tab) => {
              const on = (tab === "TALKING" && state === "speaking") || (tab === "THINKING" && state === "thinking") || (tab === "IDLE" && state === "listening") || (tab === "AUTO" && (state === "idle"));
              return (
                <span key={tab} className="rounded px-2.5 py-1 text-[9px] font-semibold tracking-widest transition"
                  style={on ? { background: "rgba(0,217,255,0.16)", color: "#9ff0ff", boxShadow: "inset 0 0 12px rgba(0,217,255,0.4)" } : { color: "rgba(110,234,255,0.5)" }}>
                  {tab}
                </span>
              );
            })}
          </div>
          <div className="order-2 text-right sm:order-3">
            <p className="text-[22px] font-bold leading-none tracking-wider text-cyan-50" style={{ textShadow: "0 0 14px rgba(0,217,255,0.6)" }}>{hudClock}</p>
            <p className="mt-1 text-[9px] tracking-widest text-cyan-300/50">منتجات: {scanData?.total ?? "—"} · معتمد: {scanData?.approved ?? "—"}</p>
            <p className="text-[9px] tracking-widest text-cyan-300/50">DOHA · QA</p>
          </div>
        </div>
      ) : null}

      {/* Professional error alert (raw technical details only when ?dev=1) */}
      {errorAlert ? (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-3 text-sm">
          <span className="text-lg leading-none">⚠️</span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-amber-800">{errorAlert.pretty}</p>
            {devMode && errorAlert.raw ? (
              <pre dir="ltr" className="mt-1.5 overflow-x-auto rounded-lg bg-black/40 p-2 text-left text-[11px] text-amber-100/80">
                {errorAlert.raw}
              </pre>
            ) : null}
          </div>
          <button onClick={() => setErrorAlert(null)} aria-label="إغلاق" className="shrink-0 text-slate-400 hover:text-slate-700">
            ×
          </button>
        </div>
      ) : null}

      {/* Unified Mission-Control HUD: side panels frame the orb + chat into one
          screen. display:contents in fullscreen keeps the orb full-screen. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
        <div className="order-2 lg:order-1 lg:col-span-3" style={{ animation: "screenInL .26s ease-out both" }}><HudLeft scan={sd} onAction={send} /></div>
        <div className="order-1 lg:order-2 lg:col-span-6">

      {/* Hero: Malak's JARVIS-style atom orb. Tap it to focus the input.
          In fullscreen it grows to fill the screen. */}
      <div
        className={`relative flex flex-col items-center justify-center overflow-hidden ${
          fsActive ? "h-[40vh]" : "h-[34vh] sm:h-[44vh]"
        }`}
        style={{ background: "transparent" }}
      >
        <button
          type="button"
          onClick={() => { unlockAudio(); inputRef.current?.focus(); }}
          aria-label="ركّز الإدخال"
          className="flex items-center justify-center"
          style={{ width: fsActive ? Math.round(orbSize * 2.6) : Math.round(orbSize * 2.3), height: fsActive ? Math.round(orbSize * 2.6) : Math.round(orbSize * 2.3) }}
        >
          <AiCoreOrb state={state} levelRef={levelRef} />
        </button>

        {/* floating HUD tags around the orb (mix of real data + status) */}
        {(() => {
          const tot = scanData?.total ?? 0;
          const synced = !(scanData?.channelMismatch);
          const health = tot ? Math.round((tot - ((scanData?.outOfStock ?? 0) + (scanData?.missingImages ?? 0) + (scanData?.suspiciousPrice ?? 0))) / tot * 100) : 0;
          const stLabel = state === "speaking" ? "RESPONDING" : state === "thinking" ? "PROCESSING" : state === "listening" ? "LISTENING" : "STANDBY";
          const tags: { c: string; t: string }[] = [
            { c: "left-1/2 -translate-x-1/2 top-[2%]", t: `STATE · ${stLabel}` },
            { c: "left-[16%] top-[7%]", t: `SKU · ${tot}` },
            { c: "right-[16%] top-[7%]", t: `معتمد · ${scanData?.approved ?? 0}` },
            { c: "left-[5%] top-[26%]", t: `نافد · ${scanData?.outOfStock ?? 0}` },
            { c: "right-[5%] top-[26%]", t: `HEALTH · ${health}%` },
            { c: "left-[2%] top-1/2 -translate-y-1/2", t: `أسعار · ${scanData?.suspiciousPrice ?? 0}` },
            { c: "right-[2%] top-1/2 -translate-y-1/2", t: `ستوك · ${scanData?.lowStock ?? 0}` },
            { c: "left-[5%] bottom-[26%]", t: `صور ناقصة · ${scanData?.missingImages ?? 0}` },
            { c: "right-[5%] bottom-[26%]", t: `مرفوض · ${scanData?.rejected ?? 0}` },
            { c: "left-[16%] bottom-[7%]", t: `بنود · ${scanData?.issues?.length ?? 0}` },
            { c: "right-[16%] bottom-[7%]", t: `SYNC · ${synced ? "OK" : (scanData?.channelMismatch ?? 0)}` },
            { c: "left-1/2 -translate-x-1/2 bottom-[2%]", t: `PROD · ${tot}` },
          ];
          return tags.map((g, i) => (
            <span key={i} dir="ltr" className={`pointer-events-none absolute z-10 hidden font-mono text-[8px] tracking-widest sm:block ${g.c}`} style={{ color: "rgba(140,190,225,0.5)" }}>
              <span style={{ color: "rgba(140,190,225,0.35)" }}>› </span>{g.t}
            </span>
          ));
        })()}
        <button
          type="button"
          onClick={toggleFullscreen}
          className="absolute left-3 top-3 z-10 rounded-full border border-white/15 bg-black/45 px-3 py-1.5 text-[11px] font-bold text-white/90 shadow backdrop-blur-sm hover:bg-black/60"
        >
          {fsActive ? "↙ تصغير" : "⛶ ملء الشاشة"}
        </button>

        {/* "يتكلم الآن" badge: shows the active agent's avatar + name while
            thinking/speaking, with animated sound bars. */}
        {state === "speaking" || state === "thinking" ? (
          <div
            className="pointer-events-none absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2.5 rounded-full border bg-black/60 px-3 py-1.5 backdrop-blur-md"
            style={{ borderColor: `${activeDef.color}66`, boxShadow: `0 0 18px ${activeDef.color}55` }}
          >
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold"
              style={{ background: activeDef.color, color: "#0b1020" }}
            >
              {activeDef.name.slice(0, 1)}
            </span>
            <div className="text-right leading-tight">
              <p className="text-[12px] font-bold text-white">{activeDef.name}</p>
              <p className="text-[10px] text-white/60">{state === "speaking" ? "يتكلّم الآن…" : "يفكّر…"}</p>
            </div>
            {state === "speaking" ? (
              <span className="flex h-4 items-end gap-0.5">
                {[0, 1, 2, 3].map((i) => (
                  <span
                    key={i}
                    className="w-0.5 rounded-full"
                    style={{ background: activeDef.color, height: "100%", animation: `eqbar .9s ${i * 0.12}s ease-in-out infinite` }}
                  />
                ))}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* JARVIS-style pop-in keyframes (used by the holographic output overlay) */}
      <style>{`
        @keyframes hudIn { 0%{opacity:0;transform:translateY(12px) scale(.94);filter:blur(6px)} 100%{opacity:1;transform:none;filter:none} }
        @keyframes eqbar { 0%,100%{transform:scaleY(0.35)} 50%{transform:scaleY(1)} }
        @keyframes screenInL { 0%{opacity:0;transform:translateX(-26px)} 100%{opacity:1;transform:none} }
        @keyframes screenInR { 0%{opacity:0;transform:translateX(26px)} 100%{opacity:1;transform:none} }
        @keyframes screenInB { 0%{opacity:0;transform:translateY(22px)} 100%{opacity:1;transform:none} }
      `}</style>
        </div>{/* center column = orb only */}
        <div className="order-3 lg:col-span-3" style={{ animation: "screenInR .26s ease-out both" }}><HudRight scan={sd} levelRef={levelRef} /></div>
      </div>{/* HUD grid */}
      <div style={{ animation: "screenInB .28s ease-out both" }}><HudObjective scan={sd} /></div>

      {/* Chat card. In fullscreen it stays a fixed, compact height (shrink-0) so
          it never grows and pushes the layout past the screen — the lab keeps
          the rest of the space and nothing scrolls the page. */}
      <div className={`border-t p-2.5 sm:p-3 ${fsActive ? "shrink-0" : ""}`} style={{ borderColor: "rgba(120,175,215,0.18)" }}>
        {/* Transcript + panel. In fullscreen it gets a taller, comfortably
            scrollable area (the lab flexes to fill the rest, no page overflow). */}
        <div ref={scrollRef} className={`space-y-2.5 overflow-y-auto px-1 py-1 ${fsActive ? "h-[38vh]" : "max-h-[44vh] min-h-[140px]"}`}>
        {turns.length === 0 && !typed ? (
          <div className="mx-auto max-w-md pt-4 text-center text-sm text-cyan-300/60">
            أهلًا فهد 👋 أنا ملاك، جاهزة أسوّي لك كل شي — الكتالوج، الأسعار، الصور، التقارير، أو أكتب لك محتوى.
          </div>
        ) : null}

        {turns.map((t, i) => (
          <div key={i} className={`flex ${t.role === "user" ? "justify-start" : "justify-end"}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                t.role === "user"
                  ? "border border-cyan-500/20 bg-cyan-500/10 text-cyan-50"
                  : "bg-gradient-to-br from-cyan-500 to-blue-600 text-white shadow-sm"
              }`}
            >
              {t.text}
            </div>
          </div>
        ))}

        {typed ? (
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 px-4 py-2.5 text-sm leading-relaxed text-white shadow-sm">
              {typed}
              <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-white/70 align-middle" />
            </div>
          </div>
        ) : null}

        {/* (structured results pop up as a holographic overlay — see below) */}
      </div>

        {/* Composer */}
        <div className="mt-2 border-t border-cyan-500/20 pt-2.5">
        {/* Hands-free wake mode: call any agent by name, no button */}
        <div className="mb-2 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={toggleHandsFree}
            disabled={!micSupported}
            className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-bold transition disabled:opacity-30 ${
              handsFree
                ? "bg-emerald-500 text-white"
                : "border border-cyan-400/30 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20"
            }`}
            style={handsFree ? { boxShadow: "0 0 16px rgba(16,185,129,0.6)" } : undefined}
            aria-pressed={handsFree}
          >
            <span className={handsFree ? "animate-pulse" : ""}>{handsFree ? "🟢" : "🛎️"}</span>
            {handsFree ? "ينصت دائمًا · قل «ملاك»" : "تفعيل الاستماع الدائم"}
          </button>
          {handsFree ? (
            <span className="truncate text-[11px] text-emerald-600">قل «ملاك» بأي وقت — وتقدر تقاطعها وهي تتكلم</span>
          ) : (
            <span className="hidden truncate text-[11px] text-cyan-300/50 sm:block">فعّلها مرّة وتبقى تنصت لـ«ملاك» كل زيارة</span>
          )}
        </div>
        {/* Quick prompts */}
        <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
          {QUICK_PROMPTS.map((q) => (
            <button
              key={q}
              onClick={() => send(q)}
              className="shrink-0 rounded-full border border-cyan-400/25 bg-cyan-500/5 px-3 py-1.5 text-xs text-cyan-200/80 transition hover:bg-cyan-500/15"
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
            <span className="flex-1 truncate text-[12px] text-cyan-100/80">📎 {pendingImage.name}</span>
            <span className="text-[11px] text-cyan-300/50">اكتب الـSKU وأرسل</span>
            <button
              type="button"
              onClick={() => setPendingImage(null)}
              aria-label="إزالة الصورة"
              className="flex h-6 w-6 items-center justify-center rounded-full bg-cyan-500/20 text-cyan-100 hover:bg-cyan-500/30"
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
              pendingImage ? "bg-pink-500 text-white" : "bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20"
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
              listening ? "bg-rose-500 text-white" : "bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20"
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
            className="h-11 flex-1 rounded-full border border-cyan-500/25 bg-cyan-500/5 px-4 text-sm text-cyan-50 placeholder:text-cyan-300/40 focus:border-cyan-400/60 focus:bg-cyan-500/10 focus:outline-none"
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
      </div>{/* chat card (full-width, below the HUD) */}

      <FooterStatusBar scan={sd} uptime={uptime} stateLabel={state === "speaking" ? "RESPONDING" : state === "thinking" ? "PROCESSING" : state === "listening" ? "LISTENING" : "STANDBY"} />

      {/* Holographic result windows — multiple can be open at once, each draggable. */}
      {panels.map((p, i) => (
        <ResultWindow
          key={i}
          data={p}
          index={i}
          onClose={() => closePanel(i)}
          onConfirmDone={(m) => { setTurns((prev) => [...prev, { role: "malak", text: m }]); speak(m, activeAgent); closePanel(i); }}
          onConfirmCancel={() => { closePanel(i); setTurns((prev) => [...prev, { role: "malak", text: "تمام، ألغيت العملية." }]); }}
          onGenerated={(np) => setPanels((ps) => ps.map((x, k) => (k === i ? np : x)))}
          onQuick={(q) => { closePanel(i); send(q); }}
          onListen={(text) => { unlockAudio(); speak(text, "malak"); }}
        />
      ))}
    </div>
  );
}
