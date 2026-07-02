"use client";

import { Component, useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { MalakKpis } from "@/lib/dashboard";
import type { Locale } from "@/lib/i18n";

// Tiny bilingual helper used across this file's sub-components (threaded via an
// `en: boolean` prop since they're defined outside the main component).
const tr = (en: boolean, ar: string, e: string) => (en ? e : ar);

// Real 3D AI core (R3F) — browser-only, so load it without SSR.
const AiCoreOrb = dynamic(() => import("./AiCoreOrb"), {
  ssr: false,
  loading: () => <div className="h-full w-full" />,
});
import { HudLeft, HudRight, HudObjective, FooterStatusBar, type ScanData } from "./HudParts";

// In-app error boundary: instead of the white "Application error" screen, show
// the actual error text (visible on mobile, no console needed) + a reload.
class UIErrorBoundary extends Component<{ children: React.ReactNode; en?: boolean }, { err: Error | null }> {
  state: { err: Error | null } = { err: null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  componentDidCatch(err: Error, info: unknown) {
    console.error("[malak-ui] crash:", err, info);
  }
  render() {
    const en = !!this.props.en;
    if (this.state.err) {
      return (
        <div dir={en ? "ltr" : "rtl"} className={`min-h-screen overflow-auto bg-[#060814] p-5 text-white ${en ? "text-left" : "text-right"}`}>
          <p className="mb-2 text-sm font-bold text-rose-300">{tr(en, "خطأ في الواجهة (تشخيص):", "UI error (diagnostics):")}</p>
          <pre className="mb-3 whitespace-pre-wrap wrap-break-word rounded-lg bg-black/40 p-3 text-[12px] text-amber-200">
            {String(this.state.err?.message || this.state.err)}
          </pre>
          <pre className="mb-4 whitespace-pre-wrap wrap-break-word rounded-lg bg-black/40 p-3 text-[10px] text-white/50">
            {String(this.state.err?.stack || "").slice(0, 1000)}
          </pre>
          <button
            onClick={() => location.reload()}
            className="rounded-xl bg-linear-to-br from-blue-500 to-purple-600 px-5 py-2.5 text-sm font-bold"
          >
            {tr(en, "إعادة التحميل", "Reload")}
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
// Localized display name/role for the assistant (the data above stays Arabic so
// existing logic that matches on id/name is untouched).
const agentName = (en: boolean) => (en ? "Malak" : "ملاك");

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
  type: "products" | "stats" | "post" | "tiktok" | "confirm" | "image_request" | "briefing" | "scan" | "browser" | "search" | "live" | "links" | "player";
  items?: any[];
  item?: any;
}

interface Turn {
  role: "user" | "malak";
  text: string;
}

const QUICK_PROMPTS_AR = [
  "تقرير حالة الكتالوج",
  "اعرض منتجات Medicube",
  "كم منتج مرفوض؟",
  "اكتب وصف عربي وإنجليزي لـ Anua Toner",
  "اعمل محتوى تيك توك لمنتج كوري",
];
const QUICK_PROMPTS_EN = [
  "Catalog status report",
  "Show Medicube products",
  "How many products are rejected?",
  "Write an Arabic and English description for Anua Toner",
  "Make TikTok content for a Korean product",
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
function ProductsPanel({ items, en = false }: { items: any[]; en?: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3">
      {items.map((p, i) => (
        <div
          key={p.sku ?? i}
          className="overflow-hidden rounded-2xl border border-white/10 bg-white/5 backdrop-blur-sm"
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
          <div className={`space-y-1 p-2.5 ${en ? "text-left" : "text-right"}`}>
            <p className="line-clamp-2 text-[13px] font-medium leading-snug text-white/90">{txt(p.name)}</p>
            {p.brand ? <p className="text-[11px] text-white/50">{txt(p.brand)}</p> : null}
            <div className="flex items-center justify-between pt-1">
              <span className="text-sm font-bold text-cyan-300">{p.price != null ? `${p.price} ${tr(en, "ر.ق", "QAR")}` : "—"}</span>
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

function StatsPanel({ items, en = false }: { items: any[]; en?: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3">
      {items.map((s, i) => (
        <div key={i} className={`rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur-sm ${en ? "text-left" : "text-right"}`}>
          <p className="text-2xl font-extrabold text-white">{txt(s.value)}</p>
          <p className="mt-1 text-sm text-white/70">{txt(s.label)}</p>
          {s.sub ? <p className="mt-0.5 text-[11px] text-white/40">{txt(s.sub)}</p> : null}
        </div>
      ))}
    </div>
  );
}

function PostPanel({ item, en = false }: { item: any; en?: boolean }) {
  return (
    <div className={`space-y-3 rounded-2xl border border-white/10 bg-white/5 p-3 backdrop-blur-sm sm:p-4 ${en ? "text-left" : "text-right"}`}>
      {item.product ? <p className="text-sm font-semibold text-cyan-300">{item.product}</p> : null}
      {item.caption_ar ? (
        <div>
          <p className="mb-1 text-[11px] text-white/40">{tr(en, "عربي", "Arabic")}</p>
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
        {Array.isArray(item.platforms) && item.platforms.length ? <span>📱 {item.platforms.join(tr(en, "، ", ", "))}</span> : null}
        {item.schedule ? <span>🗓️ {item.schedule}</span> : null}
      </div>
    </div>
  );
}

function TiktokPanel({ item, en = false }: { item: any; en?: boolean }) {
  return (
    <div className={`space-y-3 rounded-2xl border border-white/10 bg-white/5 p-3 backdrop-blur-sm sm:p-4 ${en ? "text-left" : "text-right"}`}>
      {item.hook ? (
        <div className="rounded-xl bg-pink-500/15 p-3">
          <p className="text-[11px] text-pink-300">{tr(en, "الخطّاف (Hook)", "Hook")}</p>
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
  en = false,
}: {
  item: any;
  onDone: (message: string) => void;
  onCancel: () => void;
  en?: boolean;
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
        setMsg(txt(data.message) || tr(en, "تم التنفيذ.", "Done."));
        onDone(txt(data.message) || tr(en, "تم التنفيذ.", "Done."));
        // leave busyRef true on success → no further submits for this card.
      } else {
        setStatus("error");
        setMsg(txt(data?.error) || tr(en, "تعذّر التنفيذ.", "Couldn't complete the action."));
        busyRef.current = false; // allow retry
      }
    } catch {
      setStatus("error");
      setMsg(tr(en, "تعذّر الاتصال بالخادم.", "Couldn't reach the server."));
      busyRef.current = false; // allow retry
    }
  };

  const changes: { label: string; old?: any; new: any }[] = Array.isArray(item.changes) ? item.changes : [];

  return (
    <div className={`space-y-3 rounded-2xl border border-amber-400/30 bg-amber-500/5 p-3 backdrop-blur-sm sm:p-4 ${en ? "text-left" : "text-right"}`}>
      <div className="flex items-center justify-between">
        <span className="rounded-full bg-amber-500/20 px-2.5 py-0.5 text-[11px] font-semibold text-amber-200">
          {tr(en, "⚠️ تأكيد مطلوب", "⚠️ Confirmation required")}
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
          <img src={item.imageUrl} alt={tr(en, "معاينة", "Preview")} className="mx-auto max-h-48 w-auto object-contain" />
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
              {tr(en, "⚠️ تم التنفيذ لكن لم يُسجَّل في malak_audit.", "⚠️ Done, but it wasn't logged in malak_audit.")}
              <br />
              <span className="wrap-break-word font-mono text-[11px] text-amber-300/80">{auditWarn}</span>
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
            {tr(en, "إعادة المحاولة", "Retry")}
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            onClick={confirm}
            disabled={status === "working"}
            className="flex-1 rounded-xl bg-linear-to-br from-emerald-500 to-green-600 py-2.5 text-sm font-bold text-white transition disabled:opacity-50"
          >
            {status === "working" ? tr(en, "جارٍ التنفيذ…", "Working…") : item.confirmLabel || tr(en, "أكّد", "Confirm")}
          </button>
          <button
            onClick={onCancel}
            disabled={status === "working"}
            className="flex-1 rounded-xl border border-white/15 bg-white/5 py-2.5 text-sm font-semibold text-white/70 transition hover:bg-white/10 disabled:opacity-50"
          >
            {item.cancelLabel || tr(en, "إلغاء", "Cancel")}
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
  en = false,
}: {
  item: any;
  onGenerated: (panel: PanelData) => void;
  onCancel: () => void;
  en?: boolean;
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
        setMsg(txt(data?.error) || tr(en, "تعذّر توليد الصورة.", "Couldn't generate the image."));
        busyRef.current = false;
      }
    } catch {
      setStatus("error");
      setMsg(tr(en, "تعذّر الاتصال بالخادم.", "Couldn't reach the server."));
      busyRef.current = false;
    }
  };

  return (
    <div className={`space-y-3 rounded-2xl border border-amber-400/30 bg-amber-500/5 p-3 backdrop-blur-sm sm:p-4 ${en ? "text-left" : "text-right"}`}>
      <div className="flex items-center justify-between">
        <span className="rounded-full bg-amber-500/20 px-2.5 py-0.5 text-[11px] font-semibold text-amber-200">
          {tr(en, "✨ توليد صورة", "✨ Generate image")}
        </span>
        <p className="text-sm font-bold text-white">{txt(item.title)}</p>
      </div>

      <div>
        {item.name ? <p className="text-sm font-semibold text-cyan-300">{txt(item.name)}</p> : null}
        {item.sku ? <p className="font-mono text-[11px] text-white/40">{txt(item.sku)}</p> : null}
        <p className="mt-1 text-[13px] text-white/70">
          {tr(en, "النمط: ", "Style: ")}{item.style === "lifestyle" ? tr(en, "لايف ستايل", "Lifestyle") : tr(en, "هيرو (خلفية نظيفة)", "Hero (clean background)")}
          {item.currentImage ? tr(en, " · تحسين الصورة الحالية مع الحفاظ على العلبة", " · Enhance the current image while keeping the packaging") : tr(en, " · توليد من اسم المنتج", " · Generate from the product name")}
        </p>
      </div>

      {item.currentImage ? (
        <div className="overflow-hidden rounded-xl border border-white/10 bg-black/30">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={item.currentImage} alt={tr(en, "الحالية", "Current")} className="mx-auto max-h-40 w-auto object-contain opacity-80" />
        </div>
      ) : null}

      {status === "error" ? (
        <p className="rounded-xl bg-rose-500/15 px-3 py-2 text-sm text-rose-200">⚠️ {msg}</p>
      ) : null}

      <div className="flex gap-2">
        <button
          onClick={generate}
          disabled={status === "working"}
          className="flex-1 rounded-xl bg-linear-to-br from-fuchsia-500 to-purple-600 py-2.5 text-sm font-bold text-white transition disabled:opacity-50"
        >
          {status === "working" ? tr(en, "جارٍ التوليد… (قد يأخذ نصف دقيقة)", "Generating… (may take half a minute)") : tr(en, "✨ ولّد الصورة", "✨ Generate image")}
        </button>
        <button
          onClick={onCancel}
          disabled={status === "working"}
          className="rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white/70 transition hover:bg-white/10 disabled:opacity-50"
        >
          {tr(en, "إلغاء", "Cancel")}
        </button>
      </div>
    </div>
  );
}

// Spoken summary text for the briefing (shared by auto-speak + the listen button).
function briefSummary(d: any, en = false): string {
  // Prefer the server-composed, TTS-safe Arabic briefing (greeting + the day's
  // priority + sales) when the API provides it; fall back to the raw counts.
  if (!en && typeof d?.briefing?.speak === "string" && d.briefing.speak.trim()) {
    return d.briefing.speak;
  }
  const morning = new Date().getHours() < 12;
  if (en) {
    const greet = morning ? "Good morning" : "Good evening";
    return (
      `${greet} Fahad. You have ${d.total} products, ${d.rejected} rejected, ${d.lowStock} low stock, and ${d.missingImages} without an image. ` +
      `Today's priority is ${d.priority}.`
    );
  }
  const greet = morning ? "صباح الخير" : "مساء الخير";
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
  en = false,
}: {
  item: any;
  onQuick: (q: string) => void;
  onListen: (text: string) => void;
  en?: boolean;
}) {
  const hr = new Date().getHours();
  const greet = hr < 12 ? tr(en, "صباح الخير", "Good morning") : tr(en, "مساء الخير", "Good evening");
  const rows: { icon: string; label: string; value: number; tone?: string }[] = [
    { icon: "📦", label: tr(en, "منتج إجمالي", "Total products"), value: item.total ?? 0 },
    { icon: "🖼️", label: tr(en, "بدون صور", "No image"), value: item.missingImages ?? 0, tone: "text-sky-300" },
    { icon: "📉", label: tr(en, "ستوك منخفض", "Low stock"), value: item.lowStock ?? 0, tone: "text-amber-300" },
    { icon: "⛔", label: tr(en, "مرفوض", "Rejected"), value: item.rejected ?? 0, tone: "text-rose-300" },
  ];
  if ((item.suspiciousPrice ?? 0) > 0)
    rows.push({ icon: "💸", label: tr(en, "سعر ناقص/صفر", "Missing/zero price"), value: item.suspiciousPrice, tone: "text-orange-300" });

  return (
    <div className={`space-y-3 rounded-2xl border border-amber-400/25 bg-linear-to-br from-amber-500/10 to-purple-500/10 p-3 backdrop-blur-sm sm:p-4 ${en ? "text-left" : "text-right"}`}>
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={() => onListen(briefSummary(item, en))}
          className="shrink-0 rounded-full border border-amber-400/40 bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-amber-200 transition hover:bg-amber-500/25"
        >
          {tr(en, "▶ استمع", "▶ Listen")}
        </button>
        <p className="text-base font-extrabold text-white">{greet} {tr(en, "فهد", "Fahad")}</p>
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
          {tr(en, "← الأولوية اليوم: ", "← Today's priority: ")}{item.priority}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => onQuick(tr(en, "اعرض المنتجات المرفوضة", "Show rejected products"))}
          className="rounded-full border border-rose-400/30 bg-rose-500/10 px-3 py-1.5 text-[12px] text-rose-200 transition hover:bg-rose-500/20"
        >
          {tr(en, "اعرض المرفوضين", "Show rejected")}
        </button>
        <button
          onClick={() => onQuick(tr(en, "اعرض المنتجات بدون صورة", "Show products without an image"))}
          className="rounded-full border border-sky-400/30 bg-sky-500/10 px-3 py-1.5 text-[12px] text-sky-200 transition hover:bg-sky-500/20"
        >
          {tr(en, "اعرض بدون صور", "Show no-image")}
        </button>
        <button
          onClick={() => onQuick(tr(en, "اعرض المنتجات منخفضة المخزون", "Show low-stock products"))}
          className="rounded-full border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-[12px] text-amber-200 transition hover:bg-amber-500/20"
        >
          {tr(en, "اعرض ستوك منخفض", "Show low stock")}
        </button>
        <a
          href="/malak/audit"
          className="rounded-full border border-white/20 bg-white/5 px-3 py-1.5 text-[12px] text-white/80 transition hover:bg-white/10"
        >
          {tr(en, "📋 سجل ملاك", "📋 Malak log")}
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
  en = false,
}: {
  item: any;
  onQuick: (q: string) => void;
  onListen: (text: string) => void;
  en?: boolean;
}) {
  const hr = new Date().getHours();
  const greet = hr < 12 ? tr(en, "صباح الخير", "Good morning") : tr(en, "مساء الخير", "Good evening");
  const issues: { key: string; icon: string; title: string; count: number; prompt: string; severity: string }[] = item.issues ?? [];
  const sevTone: Record<string, string> = {
    high: "border-rose-400/30 bg-rose-500/10",
    med: "border-amber-400/30 bg-amber-500/10",
    low: "border-sky-400/30 bg-sky-500/10",
  };

  return (
    <div className={`space-y-3 rounded-2xl border border-amber-400/25 bg-linear-to-br from-amber-500/10 to-purple-500/10 p-3 backdrop-blur-sm sm:p-4 ${en ? "text-left" : "text-right"}`}>
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={() => onListen(briefSummary(item, en))}
          className="shrink-0 rounded-full border border-amber-400/40 bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-amber-200 transition hover:bg-amber-500/25"
        >
          {tr(en, "▶ استمع", "▶ Listen")}
        </button>
        <p className="text-base font-extrabold text-white">{greet} {tr(en, "فهد", "Fahad")}</p>
      </div>

      {item.allClear ? (
        <p className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3 py-3 text-center text-[13px] font-medium text-emerald-100">
          {tr(en, `✅ كل شي تمام — ما في بند عاجل اليوم. عندك ${item.total ?? 0} منتج، الوضع نظيف.`, `✅ All clear — nothing urgent today. You have ${item.total ?? 0} products, all in good shape.`)}
        </p>
      ) : (
        <>
          <p className="text-[12px] text-white/70">{tr(en, "🔍 اللي يحتاج تصرّف — مرتّب بالأهم:", "🔍 What needs action — sorted by priority:")}</p>
          <div className="space-y-2">
            {issues.map((is) => (
              <div key={is.key} className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 ${sevTone[is.severity] ?? "border-white/15 bg-white/5"}`}>
                <button
                  onClick={() => onQuick(is.prompt)}
                  className="shrink-0 rounded-full bg-white/15 px-3 py-1 text-[12px] font-semibold text-white transition hover:bg-white/25"
                >
                  {tr(en, "عالجها ←", "Fix it ←")}
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
          {tr(en, "📋 سجل ملاك", "📋 Malak log")}
        </a>
      </div>
    </div>
  );
}

// A draggable holographic result window. Several can be open at once; drag by
// the header, close with ✕.
// LIVE virtual browser (Hyperbeam) — a real interactive browser with AUDIO,
// embedded straight into the popup. Unlike BrowserPanel (static screenshots),
// this streams live and plays sound on the user's device.
function LiveBrowserPanel({ item, en = false }: { item: any; en?: boolean }) {
  const embedUrl: string = typeof item?.embedUrl === "string" ? item.embedUrl : "";
  const url: string = txt(item?.url) || "";
  const title: string = txt(item?.title) || tr(en, "متصفح حي", "Live browser");
  // Backend: "browserbase" = lighter/snappier screencast, NO audio, needs a
  // sandbox; "hyperbeam" = full WebRTC video WITH audio, no sandbox.
  const bb = item?.kind === "browserbase";
  const liveLabel = bb ? tr(en, "🟢 مباشر", "🟢 Live") : tr(en, "🔴 مباشر بصوت", "🔴 Live with audio");
  // Maximize: prefer the real Fullscreen API on the wrapper (no remount, and it
  // escapes the popup window's CSS transform — a plain `fixed` overlay would be
  // trapped inside that transformed ancestor). Fall back to a viewport-fixed
  // overlay only if Fullscreen isn't available.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [fs, setFs] = useState(false);
  const [manualBig, setManualBig] = useState(false);
  // The stream often shows black until the first tap (mobile media autoplay) /
  // while the VM boots — show a one-tap "start" hint over the iframe.
  const [started, setStarted] = useState(false);
  // Bumping this remounts the iframe → reconnects to the SAME (persistent)
  // session, recovering from a black/stalled stream without a new VM.
  const [reloadKey, setReloadKey] = useState(0);
  let host = "";
  try { host = url ? new URL(url).hostname.replace(/^www\./, "") : ""; } catch { host = ""; }

  useEffect(() => {
    const onFs = () => setFs(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const big = fs || manualBig;
  const toggleBig = () => {
    if (big) {
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      setManualBig(false);
      return;
    }
    const el = wrapRef.current;
    const req = el?.requestFullscreen?.bind(el);
    if (req) req().catch(() => setManualBig(true));
    else setManualBig(true);
  };

  if (!embedUrl) {
    return (
      <div className="flex h-44 flex-col items-center justify-center gap-2 rounded-xl border border-white/10 bg-black/30 px-4 text-center text-[12px] text-amber-200/90">
        <span>{tr(en, "ما قدرت أفتح المتصفح الحي.", "I couldn't open the live browser.")}</span>
        <span className="text-white/50">{tr(en, "قد تحتاج خدمة المتصفح الحي تتفعّل على الخادم (HYPERBEAM_API_KEY).", "The live browser service may need to be enabled on the server (HYPERBEAM_API_KEY).")}</span>
      </div>
    );
  }

  return (
    <div className={`space-y-2 ${en ? "text-left" : "text-right"}`}>
      <div className="flex items-center gap-2 rounded-t-xl border border-emerald-400/30 bg-black/40 px-3 py-2">
        <span className="flex gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-rose-400/70" /><i className="h-2.5 w-2.5 rounded-full bg-amber-400/70" /><i className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" /></span>
        <span className="flex-1 truncate text-[11px] font-semibold text-emerald-300">{liveLabel}{host ? ` · ${host}` : ""}</span>
        <button type="button" onClick={() => { setStarted(true); setReloadKey((k) => k + 1); }} title={tr(en, "إعادة تحميل", "Reload")} aria-label={tr(en, "إعادة تحميل", "Reload")} className="flex h-6 w-6 items-center justify-center rounded-md border border-emerald-400/40 text-emerald-200 hover:bg-emerald-400/10">⟳</button>
        <button type="button" onClick={toggleBig} title={big ? tr(en, "تصغير", "Minimize") : tr(en, "تكبير", "Maximize")} aria-label={tr(en, "تكبير الشاشة", "Maximize screen")} className="flex h-6 w-6 items-center justify-center rounded-md border border-emerald-400/40 text-emerald-200 hover:bg-emerald-400/10">{big ? "✕" : "⛶"}</button>
      </div>

      <div
        ref={wrapRef}
        className={
          // manualBig (no Fullscreen API) → a viewport-fixed overlay. In native
          // fullscreen the browser sizes wrapRef itself, so just fill it black.
          manualBig
            ? "fixed inset-0 z-100 bg-black"
            : `relative overflow-hidden bg-black ${fs ? "h-full w-full" : "rounded-xl border border-emerald-400/20"}`
        }
        style={big ? { height: manualBig ? undefined : "100%" } : { aspectRatio: "16 / 11" }}
      >
        {big ? (
          <button type="button" onClick={toggleBig} aria-label={tr(en, "تصغير", "Minimize")} className="absolute left-3 top-3 z-20 flex h-10 w-10 items-center justify-center rounded-full border border-emerald-400/50 bg-black/70 text-lg text-emerald-100">✕</button>
        ) : null}
        {bb ? (
          // Browserbase live view: needs a sandbox; interactive (no audio).
          <iframe
            key={reloadKey}
            src={embedUrl}
            title={title}
            className="h-full w-full"
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
            allow="clipboard-read; clipboard-write"
          />
        ) : (
          // Hyperbeam: full WebRTC video WITH audio. No sandbox (it blacks out).
          <iframe
            key={reloadKey}
            src={embedUrl}
            title={title}
            className="h-full w-full"
            allow="autoplay; fullscreen; microphone; camera; clipboard-read; clipboard-write; encrypted-media; display-capture; gamepad; web-share"
            allowFullScreen
          />
        )}
        {!bb && !started ? (
          <button
            type="button"
            onClick={() => setStarted(true)}
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/55 text-emerald-200 backdrop-blur-[1px]"
          >
            <span className="text-3xl">▶</span>
            <span className="text-[13px] font-semibold">{tr(en, "اضغط لبدء البث الحي بالصوت", "Tap to start the live stream with audio")}</span>
            <span className="text-[11px] text-white/60">{tr(en, "لو ظلّت سوداء انتظر ثانيتين — النافذة تشتغل", "If it stays black, wait a couple seconds — it's starting up")}</span>
          </button>
        ) : null}
      </div>

      {!big ? (
        <>
          <p className="px-1 text-[12px] leading-relaxed text-white/70">{bb ? tr(en, "متصفح حي سريع تفاعلي — اضغط واكتب داخله. ⛶ تكبير · ⟳ تحديث.", "Fast interactive live browser — click and type inside it. ⛶ Maximize · ⟳ Refresh.") : tr(en, "متصفح حي تفاعلي بصوت — اضغط داخل النافذة، والصوت يطلع على جهازك. ⛶ تكبير · ⟳ لو صارت سوداء.", "Interactive live browser with audio — click inside the window, and the sound plays on your device. ⛶ Maximize · ⟳ if it goes black.")}</p>
          <div className="flex flex-wrap gap-2">
            {/* Opening the EMBED url in a top-level tab works even when the phone
                blocks third-party cookies (which black out the iframe). */}
            <a href={embedUrl} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/60 bg-emerald-400/10 px-3 py-1.5 text-[12px] font-semibold text-emerald-200 hover:bg-emerald-400/20">{tr(en, "🖥️ افتح البث في تبويب (لو الشاشة سوداء)", "🖥️ Open the stream in a tab (if the screen is black)")}</a>
            {url ? (
              <a href={url} target="_blank" rel="noopener noreferrer" dir="ltr"
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/40 px-3 py-1.5 text-[12px] text-emerald-200 hover:bg-emerald-400/10">{tr(en, "↗ الموقع مباشرة", "↗ Open the site directly")}</a>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

// In-app music/video player — embeds the YouTube IFrame player, which runs in
// the USER's browser (their IP), so playback works WITH SOUND and isn't blocked
// by YouTube's datacenter bot wall (unlike the server-side live browser).
// Compact "now playing" music card — album art + title + animated equalizer.
// The YouTube embed plays the AUDIO from a hidden (opacity-0) iframe, so it
// feels like a music player, not a video.
function PlayerPanel({ item, en = false }: { item: any; en?: boolean }) {
  const raw = txt(item?.videoId);
  const videoId = /^[A-Za-z0-9_-]{11}$/.test(raw) ? raw : "";
  const title = txt(item?.title);
  const [play, setPlay] = useState(false);
  if (!videoId) return null;
  return (
    <div className={`space-y-2 ${en ? "text-left" : "text-right"}`}>
      <div className="relative overflow-hidden rounded-2xl border border-rose-400/30">
        {/* Full-size audio source (reliable autoplay), hidden behind the opaque
            card overlay so only the music is heard, not the video. */}
        {play ? (
          <iframe
            src={`https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0&playsinline=1`}
            title={title || "player"}
            className="pointer-events-none absolute inset-0 h-full w-full"
            allow="autoplay; encrypted-media"
          />
        ) : null}
        <div className="relative z-10 flex items-center gap-3 bg-[#160a12]/95 p-2.5">
        {/* album art */}
        <span className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-black">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`} alt={title} className="h-full w-full object-cover" />
        </span>
        {/* title + state */}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-bold text-white">{title || tr(en, "أغنية", "Track")}</p>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-rose-200">
            {play ? (
              <>
                <span className="flex h-3 items-end gap-[2px]">
                  {[0, 1, 2, 3].map((i) => (
                    <i key={i} className="w-[3px] animate-pulse rounded-xs bg-rose-300" style={{ height: `${[10, 6, 12, 8][i]}px`, animationDelay: `${i * 120}ms`, animationDuration: "700ms" }} />
                  ))}
                </span>
                <span>{tr(en, "جارٍ التشغيل…", "Playing…")}</span>
              </>
            ) : (
              <span className="text-white/55">{tr(en, "🎵 جاهزة للتشغيل بصوت", "🎵 Ready to play with audio")}</span>
            )}
          </div>
        </div>
        {/* play / stop */}
        <button
          type="button"
          onClick={() => setPlay((p) => !p)}
          aria-label={play ? tr(en, "إيقاف", "Stop") : tr(en, "تشغيل", "Play")}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-rose-500 text-lg text-white shadow-lg shadow-rose-500/30 hover:bg-rose-400"
        >
          {play ? "⏹" : "▶"}
        </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <a href={`https://music.youtube.com/watch?v=${videoId}`} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-rose-400/40 px-3 py-1.5 text-[12px] text-rose-200 hover:bg-rose-400/10">{tr(en, "🎵 افتح في يوتيوب ميوزك", "🎵 Open in YouTube Music")}</a>
        {/* Cast to TV — opens the track on YouTube where the native Cast button
            (📡) sends it to a Chromecast / smart TV on the same Wi-Fi. */}
        <a href={`https://www.youtube.com/watch?v=${videoId}`} target="_blank" rel="noopener noreferrer"
          title={tr(en, "يفتح في يوتيوب — اضغط أيقونة البثّ 📡 لإرساله للتلفزيون", "Opens in YouTube — tap the Cast icon 📡 to send it to your TV")}
          className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/40 px-3 py-1.5 text-[12px] text-cyan-200 hover:bg-cyan-400/10">{tr(en, "📺 بثّ للتلفزيون", "📺 Cast to TV")}</a>
      </div>
    </div>
  );
}

// Big tappable action links — open straight in the user's native apps (YouTube,
// Temu, Shein…) with full speed + sound, instead of a flaky embedded browser.
function LinksPanel({ items, en = false }: { items: any[]; en?: boolean }) {
  const icon = (host: string) => {
    if (/music\.youtube/.test(host)) return "🎵";
    if (/youtu/.test(host)) return "▶";
    if (/temu/.test(host)) return "🛒";
    if (/shein/.test(host)) return "🛍️";
    if (/google|bing/.test(host)) return "🔎";
    return "↗";
  };
  return (
    <div className={`space-y-2 ${en ? "text-left" : "text-right"}`}>
      <span className="inline-flex items-center gap-1.5 rounded-full bg-cyan-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-cyan-200">{tr(en, "🔗 افتح بتطبيقك", "🔗 Open in your app")}</span>
      <div className="space-y-2">
        {items.map((it, i) => {
          const url = txt(it?.url);
          let host = "";
          try { host = url ? new URL(url).hostname.replace(/^www\./, "") : ""; } catch { host = ""; }
          if (!url) return null;
          return (
            <a key={i} href={url} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-3 rounded-xl border border-cyan-400/40 bg-cyan-400/10 px-3 py-3 text-cyan-100 hover:bg-cyan-400/20">
              <span className="text-xl">{icon(host)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-bold">{txt(it?.label) || host || url}</span>
                {it?.note ? <span className="block truncate text-[11px] text-white/60">{txt(it.note)}</span> : (host ? <span dir="ltr" className="block truncate text-left font-mono text-[10px] text-emerald-300/70">{host}</span> : null)}
              </span>
              <span className="text-cyan-300">↗</span>
            </a>
          );
        })}
      </div>
    </div>
  );
}

// Web-search results list (from a search API — no CAPTCHA). Each row links out.
function SearchPanel({ items, en = false }: { items: any[]; en?: boolean }) {
  return (
    <div className={`space-y-2 ${en ? "text-left" : "text-right"}`}>
      <span className="inline-flex items-center gap-1.5 rounded-full bg-cyan-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-cyan-200">{tr(en, "🔎 نتائج البحث", "🔎 Search results")}</span>
      <ul className="space-y-2">
        {items.map((r, i) => {
          const url = txt(r?.url);
          let host = "";
          try { host = url ? new URL(url).hostname.replace(/^www\./, "") : ""; } catch { host = ""; }
          return (
            <li key={i} className="rounded-xl border border-white/10 bg-black/30 p-2.5">
              <a href={url} target="_blank" rel="noopener noreferrer" className="text-[13px] font-bold text-cyan-300 hover:underline">{txt(r?.title) || host || url}</a>
              {host ? <p dir="ltr" className="text-left font-mono text-[10px] text-emerald-300/70">{host}</p> : null}
              {r?.snippet ? <p className="mt-1 text-[12px] leading-relaxed text-white/70">{txt(r.snippet)}</p> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Popup "browser screen": Malak opened a real site server-side; we show a live
// screenshot of it (loaded lazily from /api/malak/browse) plus her summary.
function BrowserPanel({ item, en = false }: { item: any; en?: boolean }) {
  const url: string = txt(item?.url) || "";
  const title: string = txt(item?.title) || "";
  const summary: string = txt(item?.summary) || "";
  // browser_action captures the RESULT screenshot server-side and passes it as a
  // data URL — show it directly (re-fetching the URL would lose the actions).
  const shot: string = typeof item?.shot === "string" && item.shot.startsWith("data:") ? item.shot : "";
  const [bust, setBust] = useState(0);
  const [state, setState] = useState<"loading" | "ok" | "error">(shot ? "ok" : "loading");
  let host = "";
  try { host = url ? new URL(url).hostname.replace(/^www\./, "") : ""; } catch { host = ""; }
  const shotSrc = shot || (url ? `/api/malak/browse?url=${encodeURIComponent(url)}${bust ? `&_=${bust}` : ""}` : "");
  const reload = () => { if (shot) return; setState("loading"); setBust((b) => b + 1); };

  return (
    <div className={`space-y-3 ${en ? "text-left" : "text-right"}`}>
      {/* faux browser chrome */}
      <div className="flex items-center gap-2 rounded-t-xl border border-cyan-400/30 bg-black/40 px-3 py-2">
        <span className="flex gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-rose-400/70" /><i className="h-2.5 w-2.5 rounded-full bg-amber-400/70" /><i className="h-2.5 w-2.5 rounded-full bg-emerald-400/70" /></span>
        <span dir="ltr" className="flex-1 truncate rounded-md bg-white/5 px-2 py-1 text-left font-mono text-[11px] text-cyan-200/80">{host || "—"}</span>
        {!shot ? <button type="button" onClick={reload} title={tr(en, "تحديث", "Refresh")} className="flex h-6 w-6 items-center justify-center rounded-md border border-cyan-400/30 text-cyan-200 hover:bg-cyan-400/10">⟳</button> : null}
      </div>

      {title ? <p className="px-1 text-sm font-bold text-white">{title}</p> : null}

      <div className="relative overflow-hidden rounded-xl border border-white/10 bg-black/30">
        {state === "loading" ? (
          <div className="flex h-44 items-center justify-center text-[12px] text-cyan-200/70">
            <span className="animate-pulse">{tr(en, "يفتح الصفحة في المتصفح…", "Opening the page in the browser…")}</span>
          </div>
        ) : null}
        {shotSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={shotSrc}
            alt={title || host}
            onLoad={() => setState("ok")}
            onError={() => setState("error")}
            className={`max-h-[46vh] w-full object-contain object-top ${state === "ok" ? "block" : "hidden"}`}
          />
        ) : null}
        {state === "error" ? (
          <div className="flex h-44 flex-col items-center justify-center gap-2 px-4 text-center text-[12px] text-amber-200/90">
            <span>{tr(en, "ما قدرت ألتقط صورة الصفحة الحين.", "I couldn't capture the page right now.")}</span>
            <span className="text-white/50">{tr(en, "قد تحتاج خدمة المتصفح تتفعّل على الخادم (BROWSERLESS_URL / BROWSERLESS_TOKEN)، أو الموقع رفض الفتح.", "The browser service may need to be enabled on the server (BROWSERLESS_URL / BROWSERLESS_TOKEN), or the site refused to open.")}</span>
            <button type="button" onClick={reload} className="rounded-md border border-cyan-400/40 px-3 py-1 text-cyan-200 hover:bg-cyan-400/10">{tr(en, "جرّب مرة ثانية", "Try again")}</button>
          </div>
        ) : null}
      </div>

      {summary ? <p className="px-1 text-[13px] leading-relaxed text-white/80">{summary}</p> : null}

      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" dir="ltr"
          className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/40 px-3 py-1.5 text-[12px] text-cyan-200 hover:bg-cyan-400/10">
          {tr(en, "↗ افتح في تبويب جديد", "↗ Open in a new tab")}
        </a>
      ) : null}
    </div>
  );
}

function ResultWindow({
  data, index, onClose, onConfirmDone, onConfirmCancel, onGenerated, onQuick, onListen, en = false,
}: {
  data: PanelData;
  index: number;
  onClose: () => void;
  onConfirmDone?: (message: string) => void;
  onConfirmCancel?: () => void;
  onGenerated?: (panel: PanelData) => void;
  onQuick?: (q: string) => void;
  onListen?: (text: string) => void;
  en?: boolean;
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
          <span className="font-mono text-[11px] tracking-[0.25em] text-cyan-300">{tr(en, "◢ MALAK · النتيجة", "◢ MALAK · Result")}</span>
          <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={onClose} aria-label={tr(en, "إغلاق", "Close")} className="flex h-7 w-7 items-center justify-center rounded-full border border-cyan-400/40 text-cyan-200 hover:bg-cyan-400/10">✕</button>
        </div>
        <div className="relative min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
          <Panel data={data} onConfirmDone={onConfirmDone} onConfirmCancel={onConfirmCancel} onGenerated={onGenerated} onQuick={onQuick} onListen={onListen} en={en} />
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
  en = false,
}: {
  data: PanelData;
  onConfirmDone?: (message: string) => void;
  onConfirmCancel?: () => void;
  onGenerated?: (panel: PanelData) => void;
  onQuick?: (q: string) => void;
  onListen?: (text: string) => void;
  en?: boolean;
}) {
  if (data.type === "products" && Array.isArray(data.items)) return <ProductsPanel items={data.items} en={en} />;
  if (data.type === "stats" && Array.isArray(data.items)) return <StatsPanel items={data.items} en={en} />;
  if (data.type === "post" && data.item) return <PostPanel item={data.item} en={en} />;
  if (data.type === "tiktok" && data.item) return <TiktokPanel item={data.item} en={en} />;
  if (data.type === "browser" && data.item) return <BrowserPanel item={data.item} en={en} />;
  if (data.type === "search" && Array.isArray(data.items)) return <SearchPanel items={data.items} en={en} />;
  if (data.type === "links" && Array.isArray(data.items)) return <LinksPanel items={data.items} en={en} />;
  if (data.type === "player" && data.item) return <PlayerPanel item={data.item} en={en} />;
  if (data.type === "live" && data.item) return <LiveBrowserPanel item={data.item} en={en} />;
  if (data.type === "briefing" && data.item)
    return <BriefingPanel item={data.item} onQuick={(q) => onQuick?.(q)} onListen={(t) => onListen?.(t)} en={en} />;
  if (data.type === "scan" && data.item)
    return <ScanPanel item={data.item} onQuick={(q) => onQuick?.(q)} onListen={(t) => onListen?.(t)} en={en} />;
  if (data.type === "image_request" && data.item)
    return (
      <ImageRequestPanel
        item={data.item}
        onGenerated={(p) => onGenerated?.(p)}
        onCancel={() => onConfirmCancel?.()}
        en={en}
      />
    );
  if (data.type === "confirm" && data.item)
    return (
      <ConfirmPanel
        item={data.item}
        onDone={(m) => onConfirmDone?.(m)}
        onCancel={() => onConfirmCancel?.()}
        en={en}
      />
    );
  return null;
}

// ---- Main page -------------------------------------------------------------
export default function MalakPage({ kpis, locale = "ar" }: { kpis?: MalakKpis; locale?: Locale }) {
  return (
    <UIErrorBoundary en={locale === "en"}>
      <MalakInner kpis={kpis} locale={locale} />
    </UIErrorBoundary>
  );
}

function MalakInner({ kpis, locale = "ar" }: { kpis?: MalakKpis; locale?: Locale }) {
  const en = locale === "en";
  const L = (ar: string, e: string) => (en ? e : ar);
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
  // "عرض على التلفزيون" help sheet (Smart View / screen-mirroring steps).
  const [tvHelp, setTvHelp] = useState(false);
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

      const userText = clean || L("أرفقت صورة لمنتج.", "I attached a product image.");
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
            typewriter(upData?.error || L("فشل رفع الصورة.", "Image upload failed."));
            setState("idle");
            busyRef.current = false;
            resumeHandsFree();
            return;
          }
        }
        const res = await fetch("/api/malak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: apiMessages,
            imageUrl,
            targetAgent: directAgentRef.current,
            // Device viewport → the live browser opens at the user's size (so a
            // phone gets the usable mobile site, not a squished desktop one).
            viewport: typeof window !== "undefined" ? { w: Math.round(window.innerWidth), h: Math.round(window.innerHeight) } : undefined,
          }),
        });
        const data = await res.json();
        const ag: AgentId = (AGENTS.some((a) => a.id === data?.agent) ? data.agent : "malak") as AgentId;
        const speakText = typeof data?.speak === "string" ? data.speak : L("تم.", "Done.");
        // Technical/config errors → professional alert (raw hidden unless ?dev=1).
        // Pick an ACCURATE headline: billing/credit vs config vs generic, so a
        // depleted Anthropic balance isn't mislabeled as a database problem.
        const isBilling = /رصيد|Anthropic|credit|billing|Plans & Billing/i.test(speakText);
        const isConfig = /SUPABASE|Service role|Supabase|قاعدة|الكتالوج مو مربوط|not configured/i.test(speakText);
        if (isBilling || isConfig || /ANTHROPIC_API_KEY|صار خطأ تقني|غير مهيأ/i.test(speakText)) {
          const pretty = isBilling
            ? L("رصيد Anthropic (عقل ملاك) خلص — جدّد الرصيد من console.anthropic.com ← Plans & Billing", "Anthropic credit (Malak's brain) is depleted — top up at console.anthropic.com ← Plans & Billing")
            : isConfig
              ? L("تعذّر تنفيذ الطلب — إعدادات الخادم/قاعدة البيانات غير مكتملة", "Couldn't complete the request — server/database configuration is incomplete")
              : L("تعذّر تنفيذ الطلب — صار خطأ تقني مؤقّت", "Couldn't complete the request — a temporary technical error occurred");
          setErrorAlert({ pretty, raw: speakText });
          setState("idle");
          resumeHandsFree();
        } else {
          setActiveAgent(ag);
          if (data?.panel?.type) pushPanel(data.panel as PanelData);
          typewriter(speakText);
          speak(speakText, ag);
        }
      } catch (e) {
        setErrorAlert({ pretty: L("تعذّر الاتصال بالخادم — حاول مرة ثانية", "Couldn't reach the server — try again"), raw: String((e as Error)?.message || e) });
        setState("idle");
        resumeHandsFree();
      } finally {
        busyRef.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [turns, typewriter, speak, stopAudio, unlockAudio, pendingImage, resumeHandsFree, en]
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
          speak(briefSummary(d, en), "malak"); // voice brief once per session
        }
      } catch {
        /* scan is best-effort */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speak, en]);

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
          const greet = L("نعم فهد، تأمر؟", "Yes Fahad, how can I help?");
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

  // "Show Malak on the TV": a browser CANNOT start Smart View / screen mirroring
  // from a button (it's an OS-level action), so we do the two things the web CAN
  // do — put Malak into the big, clean full-screen layout, then show the user the
  // exact steps to start mirroring from their phone's quick panel.
  const startTvMode = () => {
    const el = rootRef.current;
    if (el && !(isFs || pseudoFs)) {
      if (el.requestFullscreen) el.requestFullscreen().catch(() => setPseudoFs(true));
      else setPseudoFs(true);
    }
    setTvHelp(true);
  };

  // Combined flag: native fullscreen OR the CSS fallback.
  const fsActive = isFs || pseudoFs;

  // The HUD panels always render (so the dashboard frame is always there); they
  // fill with zeros until the scan loads.
  const sd: ScanData = scanData ?? {
    total: 0, approved: 0, rejected: 0, missingImages: 0, lowStock: 0, outOfStock: 0,
    suspiciousPrice: 0, channelMismatch: 0, issues: [], recentActivity: [],
    priority: L("…يفحص الوضع", "…checking status"), allClear: true,
  };

  return (
    <div
      ref={rootRef}
      className={
        fsActive
          ? // Fullscreen: full-width, full-height flex column so the lab fills the
            // screen. 100dvh accounts for mobile browser chrome; pseudoFs adds
            // fixed positioning since there's no native FS element (iOS Safari).
            `h-dvh w-full space-y-3 overflow-y-auto p-3 sm:p-4 ${
              pseudoFs ? "fixed inset-0 z-50" : ""
            }`
          : // Mobile: fill the available screen exactly (no page bounce) — a flex
            // column where the chat takes the leftover height and scrolls inside.
            // Desktop (md+): the full mission-control dashboard, natural height.
            "mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col gap-3 pb-2 md:block md:h-auto md:min-h-0 md:gap-0 md:space-y-3"
      }
      style={fsActive ? { background: "#020711" } : undefined}
    >
      {/* Mission-Control header */}
      {true ? (
        <div dir="ltr" className="flex shrink-0 flex-wrap items-start justify-between gap-3 font-mono">
          <div>
            <p className="text-[13px] font-bold tracking-[0.2em] text-cyan-50">MALIKA&apos;S UNIVERSE <span className="text-cyan-300/50">// COMMERCE CONTROL</span></p>
            <p dir={en ? "ltr" : "rtl"} className="text-[10px] tracking-[0.15em] text-cyan-300/50">{L("ملاك · المديرة العامة الذكية", "Malak · AI general manager")}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {["ONLINE", "SECURE", scanData ? (scanData.channelMismatch ? "SYNC NEEDED" : "SYNCED") : "…", "AUTH-LVL9"].map((c, i) => (
                <span key={i} className="inline-flex items-center gap-1 rounded-xs border border-cyan-500/25 px-2 py-0.5 text-[8.5px] tracking-widest text-cyan-300/60">
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
                <span key={tab} className="rounded-sm px-2.5 py-1 text-[9px] font-semibold tracking-widest transition"
                  style={on ? { background: "rgba(0,217,255,0.16)", color: "#9ff0ff", boxShadow: "inset 0 0 12px rgba(0,217,255,0.4)" } : { color: "rgba(110,234,255,0.5)" }}>
                  {tab}
                </span>
              );
            })}
          </div>
          <div className="order-2 text-right sm:order-3">
            <p className="text-[22px] font-bold leading-none tracking-wider text-cyan-50" style={{ textShadow: "0 0 14px rgba(0,217,255,0.6)" }}>{hudClock}</p>
            <p className="mt-1 text-[9px] tracking-widest text-cyan-300/50">{L("منتجات", "Products")}: {scanData?.total ?? "—"} · {L("معتمد", "Approved")}: {scanData?.approved ?? "—"}</p>
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
          <button onClick={() => setErrorAlert(null)} aria-label={L("إغلاق", "Close")} className="shrink-0 text-slate-400 hover:text-slate-700">
            ×
          </button>
        </div>
      ) : null}

      {/* Unified Mission-Control HUD: side panels frame the orb + chat into one
          screen. display:contents in fullscreen keeps the orb full-screen. */}
      <div className="grid shrink-0 grid-cols-1 gap-3 md:grid-cols-12">
        <div className="hidden md:order-1 md:col-span-3 md:block" style={{ animation: "screenInL .26s ease-out both" }}><HudLeft scan={sd} onAction={send} locale={locale} /></div>
        <div className="order-1 md:order-2 md:col-span-6">

      {/* Hero: Malak's JARVIS-style atom orb. Tap it to focus the input.
          In fullscreen it grows to fill the screen. */}
      <div
        className={`relative flex flex-col items-center justify-center overflow-hidden ${
          fsActive ? "h-[60vh]" : "h-[30vh] sm:h-[40vh] md:h-[60vh]"
        }`}
        style={{ background: "transparent" }}
      >
        <button
          type="button"
          onClick={() => { if (micSupported) { toggleMic(); } else { unlockAudio(); inputRef.current?.focus(); } }}
          aria-label={listening ? L("إيقاف المايك", "Stop the mic") : L("تكلّم مع ملاك", "Talk to Malak")}
          className="flex h-full w-full items-center justify-center"
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
            { c: "right-[16%] top-[7%]", t: `${L("معتمد", "APPROVED")} · ${scanData?.approved ?? 0}` },
            { c: "left-[5%] top-[26%]", t: `${L("نافد", "OUT")} · ${scanData?.outOfStock ?? 0}` },
            { c: "right-[5%] top-[26%]", t: `HEALTH · ${health}%` },
            { c: "left-[2%] top-1/2 -translate-y-1/2", t: `${L("أسعار", "PRICES")} · ${scanData?.suspiciousPrice ?? 0}` },
            { c: "right-[2%] top-1/2 -translate-y-1/2", t: `${L("ستوك", "STOCK")} · ${scanData?.lowStock ?? 0}` },
            { c: "left-[5%] bottom-[26%]", t: `${L("صور ناقصة", "NO IMAGE")} · ${scanData?.missingImages ?? 0}` },
            { c: "right-[5%] bottom-[26%]", t: `${L("مرفوض", "REJECTED")} · ${scanData?.rejected ?? 0}` },
            { c: "left-[16%] bottom-[7%]", t: `${L("بنود", "ITEMS")} · ${scanData?.issues?.length ?? 0}` },
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
          className="absolute left-3 top-3 z-10 rounded-full border border-white/15 bg-black/45 px-3 py-1.5 text-[11px] font-bold text-white/90 shadow-sm backdrop-blur-xs hover:bg-black/60"
        >
          {fsActive ? L("↙ تصغير", "↙ Minimize") : L("⛶ ملء الشاشة", "⛶ Fullscreen")}
        </button>
        {/* Show Malak on a Smart TV (via the phone's Smart View / screen cast) */}
        <button
          type="button"
          onClick={startTvMode}
          className="absolute right-3 top-3 z-10 rounded-full border border-cyan-300/30 bg-black/45 px-3 py-1.5 text-[11px] font-bold text-cyan-100 shadow-sm backdrop-blur-xs hover:bg-black/60"
        >
          {L("📺 التلفزيون", "📺 TV")}
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
              {agentName(en).slice(0, 1)}
            </span>
            <div className={`leading-tight ${en ? "text-left" : "text-right"}`}>
              <p className="text-[12px] font-bold text-white">{agentName(en)}</p>
              <p className="text-[10px] text-white/60">{state === "speaking" ? L("يتكلّم الآن…", "Speaking now…") : L("يفكّر…", "Thinking…")}</p>
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
        <div className="hidden md:col-span-3 md:block" style={{ animation: "screenInR .26s ease-out both" }}><HudRight scan={sd} levelRef={levelRef} locale={locale} /></div>
      </div>{/* HUD grid */}
      <div className="hidden md:block" style={{ animation: "screenInB .28s ease-out both" }}><HudObjective scan={sd} locale={locale} /></div>

      {/* Chat card. In fullscreen it stays a fixed, compact height (shrink-0) so
          it never grows and pushes the layout past the screen — the lab keeps
          the rest of the space and nothing scrolls the page. */}
      <div className={`flex min-h-0 flex-1 flex-col border-t p-2.5 sm:p-3 md:block md:flex-none ${fsActive ? "shrink-0" : ""}`} style={{ borderColor: "rgba(120,175,215,0.18)" }}>
        {/* Transcript + panel. In fullscreen it gets a taller, comfortably
            scrollable area (the lab flexes to fill the rest, no page overflow). */}
        <div ref={scrollRef} className={`space-y-2.5 overflow-y-auto px-1 py-1 ${fsActive ? "h-[38vh]" : "min-h-0 flex-1 md:max-h-[44vh] md:min-h-[140px] md:flex-none"}`}>
        {turns.length === 0 && !typed ? (
          <div className="mx-auto max-w-md pt-4 text-center text-sm text-cyan-300/60">
            {L("أهلًا فهد 👋 أنا ملاك، جاهزة أسوّي لك كل شي — الكتالوج، الأسعار، الصور، التقارير، أو أكتب لك محتوى.", "Hi Fahad 👋 I'm Malak, ready to handle everything for you — the catalog, prices, images, reports, or writing content.")}
          </div>
        ) : null}

        {turns.map((t, i) => (
          <div key={i} className={`flex ${t.role === "user" ? "justify-start" : "justify-end"}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                t.role === "user"
                  ? "border border-cyan-500/20 bg-cyan-500/10 text-cyan-50"
                  : "bg-linear-to-br from-cyan-500 to-blue-600 text-white shadow-xs"
              }`}
            >
              {t.text}
            </div>
          </div>
        ))}

        {typed ? (
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl bg-linear-to-br from-blue-500 to-purple-600 px-4 py-2.5 text-sm leading-relaxed text-white shadow-xs">
              {typed}
              <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-white/70 align-middle" />
            </div>
          </div>
        ) : null}

        {/* (structured results pop up as a holographic overlay — see below) */}
      </div>

        {/* Composer */}
        <div className="mt-2 shrink-0 border-t border-cyan-500/20 pt-2.5">
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
            {handsFree ? L("ينصت دائمًا · قل «ملاك»", "Always listening · say “Malak”") : L("تفعيل الاستماع الدائم", "Enable always-on listening")}
          </button>
          {handsFree ? (
            <span className="truncate text-[11px] text-emerald-600">{L("قل «ملاك» بأي وقت — وتقدر تقاطعها وهي تتكلم", "Say “Malak” anytime — and you can interrupt her while she's talking")}</span>
          ) : (
            <span className="hidden truncate text-[11px] text-cyan-300/50 sm:block">{L("فعّلها مرّة وتبقى تنصت لـ«ملاك» كل زيارة", "Enable it once and she keeps listening for “Malak” every visit")}</span>
          )}
        </div>
        {/* Quick prompts */}
        <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
          {(en ? QUICK_PROMPTS_EN : QUICK_PROMPTS_AR).map((q) => (
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
              alt={L("مرفق", "Attachment")}
              className="h-9 w-9 rounded-md object-cover"
            />
            <span className="flex-1 truncate text-[12px] text-cyan-100/80">📎 {pendingImage.name}</span>
            <span className="text-[11px] text-cyan-300/50">{L("اكتب الـSKU وأرسل", "Type the SKU and send")}</span>
            <button
              type="button"
              onClick={() => setPendingImage(null)}
              aria-label={L("إزالة الصورة", "Remove image")}
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
            aria-label={L("إرفاق صورة", "Attach image")}
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
            aria-label={L("ميكروفون", "Microphone")}
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
            placeholder={L("اكتب لملاك… (أو استخدم الميكروفون)", "Type to Malak… (or use the microphone)")}
            className="h-11 flex-1 rounded-full border border-cyan-500/25 bg-cyan-500/5 px-4 text-sm text-cyan-50 placeholder:text-cyan-300/40 focus:border-cyan-400/60 focus:bg-cyan-500/10 focus:outline-hidden"
          />
          <button
            type="submit"
            disabled={!input.trim()}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-blue-500 to-purple-600 text-lg text-white transition disabled:opacity-30"
          >
            ↑
          </button>
        </form>
       </div>
      </div>{/* chat card (full-width, below the HUD) */}

      <div className="hidden shrink-0 md:block">
        <FooterStatusBar scan={sd} uptime={uptime} stateLabel={state === "speaking" ? "RESPONDING" : state === "thinking" ? "PROCESSING" : state === "listening" ? "LISTENING" : "STANDBY"} locale={locale} />
      </div>

      {/* "Show Malak on the TV" — Smart View / screen-mirroring steps. The web
          can't start mirroring itself; this readies the big-screen view and tells
          the user how to cast from their phone. */}
      {tvHelp ? (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/75 p-4" onClick={() => setTvHelp(false)}>
          <div dir={en ? "ltr" : "rtl"} className={`w-full max-w-sm rounded-2xl border border-cyan-400/30 bg-[#0a1422] p-5 text-white shadow-2xl ${en ? "text-left" : "text-right"}`} onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-base font-bold">{L("📺 عرض ملاك على التلفزيون", "📺 Show Malak on the TV")}</p>
              <button onClick={() => setTvHelp(false)} aria-label={L("إغلاق", "Close")} className="text-xl leading-none text-white/50 hover:text-white">×</button>
            </div>
            <p className="mb-3 text-[13px] leading-relaxed text-cyan-100/80">{L("ملاك دخلت وضع العرض الكبير ✅ — الحين شغّل مرآة الشاشة من جوالك:", "Malak is now in big-screen mode ✅ — now start screen mirroring from your phone:")}</p>
            <ol className="space-y-2 text-[13px] leading-relaxed text-white/90">
              <li>{en ? <>1️⃣ Swipe down from the <b>top of the screen</b> to open the quick settings panel.</> : <>1️⃣ اسحب من <b>أعلى الشاشة</b> لتفتح لوحة الإعدادات السريعة.</>}</li>
              <li>{en ? <>2️⃣ Tap <b>Smart View</b> (Samsung) or <b>Screen Cast</b> (LG/Android).</> : <>2️⃣ اضغط <b>Smart View</b> (سامسونج) أو <b>Screen Cast / بث الشاشة</b> (LG/أندرويد).</>}</li>
              <li>{en ? <>3️⃣ Pick <b>your TV</b> — it must be on the same Wi-Fi network.</> : <>3️⃣ اختر <b>تلفزيونك</b> — لازم على نفس شبكة الواي‌فاي.</>}</li>
              <li>{en ? <>4️⃣ Malak appears on the TV 🎉 and you control everything from your phone.</> : <>4️⃣ بتطلع ملاك على التلفزيون 🎉 وتتحكّم بكل شي من جوالك.</>}</li>
            </ol>
            <p className="mt-3 text-[11px] leading-relaxed text-white/45">{L("ملاحظة: مرآة الشاشة خاصية النظام، ما نقدر نشغّلها من داخل التطبيق — بس جهّزنا لك العرض الكبير النظيف.", "Note: screen mirroring is a system feature we can't start from inside the app — we just set up the clean big-screen view for you.")}</p>
            <button onClick={() => setTvHelp(false)} className="mt-4 w-full rounded-xl bg-cyan-500 py-2.5 text-sm font-bold text-[#06121f] hover:bg-cyan-400">{L("تمام، فهمت", "Got it")}</button>
          </div>
        </div>
      ) : null}

      {/* Holographic result windows — multiple can be open at once, each draggable. */}
      {panels.map((p, i) => (
        <ResultWindow
          key={i}
          data={p}
          index={i}
          onClose={() => closePanel(i)}
          en={en}
          onConfirmDone={(m) => { setTurns((prev) => [...prev, { role: "malak", text: m }]); speak(m, activeAgent); closePanel(i); }}
          onConfirmCancel={() => { closePanel(i); setTurns((prev) => [...prev, { role: "malak", text: L("تمام، ألغيت العملية.", "OK, I cancelled the action.") }]); }}
          onGenerated={(np) => setPanels((ps) => ps.map((x, k) => (k === i ? np : x)))}
          onQuick={(q) => { closePanel(i); send(q); }}
          onListen={(text) => { unlockAudio(); speak(text, "malak"); }}
        />
      ))}
    </div>
  );
}
