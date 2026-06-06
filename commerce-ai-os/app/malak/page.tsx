"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

// ---- Agent team -----------------------------------------------------------
type AgentId = "malak" | "noor" | "bayan" | "reem" | "siraj" | "razan" | "rashid" | "latifa" | "salem";

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
];

// The 8 specialists shown on the rail (Malak herself is the orb).
const RAIL = AGENTS.filter((a) => a.id !== "malak");
const agentById = (id: string): AgentDef => AGENTS.find((a) => a.id === id) ?? AGENTS[0];

type OrbState = "idle" | "listening" | "thinking" | "speaking";

interface PanelData {
  type: "products" | "stats" | "post" | "tiktok";
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
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
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
            <p className="line-clamp-2 text-[13px] font-medium leading-snug text-white/90">{p.name}</p>
            {p.brand ? <p className="text-[11px] text-white/50">{p.brand}</p> : null}
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
                  {p.status}
                </span>
              ) : null}
            </div>
            {p.sku ? <p className="font-mono text-[10px] text-white/30">{p.sku}</p> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function StatsPanel({ items }: { items: any[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {items.map((s, i) => (
        <div key={i} className="rounded-2xl border border-white/10 bg-white/5 p-4 text-right backdrop-blur">
          <p className="text-2xl font-extrabold text-white">{s.value}</p>
          <p className="mt-1 text-sm text-white/70">{s.label}</p>
          {s.sub ? <p className="mt-0.5 text-[11px] text-white/40">{s.sub}</p> : null}
        </div>
      ))}
    </div>
  );
}

function PostPanel({ item }: { item: any }) {
  return (
    <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4 text-right backdrop-blur">
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
    <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4 text-right backdrop-blur">
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

function Panel({ data }: { data: PanelData }) {
  if (data.type === "products" && Array.isArray(data.items)) return <ProductsPanel items={data.items} />;
  if (data.type === "stats" && Array.isArray(data.items)) return <StatsPanel items={data.items} />;
  if (data.type === "post" && data.item) return <PostPanel item={data.item} />;
  if (data.type === "tiktok" && data.item) return <TiktokPanel item={data.item} />;
  return null;
}

// ---- Main page -------------------------------------------------------------
export default function MalakPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [panel, setPanel] = useState<PanelData | null>(null);
  const [input, setInput] = useState("");
  const [state, setState] = useState<OrbState>("idle");
  const [activeAgent, setActiveAgent] = useState<AgentId>("malak");
  const [listening, setListening] = useState(false);
  const [typed, setTyped] = useState(""); // typewriter buffer for latest malak turn
  const [micSupported, setMicSupported] = useState(true);
  const [orbSize, setOrbSize] = useState(160); // responsive; set on mount

  const recognitionRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);

  const accent = agentById(activeAgent).color;

  // Responsive orb: small on phones, larger on wide screens. Caps by viewport
  // height too so it never crowds out the transcript on short screens.
  useEffect(() => {
    const calc = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const byW = w < 380 ? 120 : w < 640 ? 140 : 200;
      setOrbSize(Math.round(Math.min(byW, h * 0.22)));
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
  const speak = useCallback((text: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ar-SA";
      const voices = window.speechSynthesis.getVoices();
      const ar = voices.find((v) => v.lang?.toLowerCase().startsWith("ar"));
      if (ar) u.voice = ar;
      u.rate = 1;
      u.pitch = 1;
      u.onstart = () => setState("speaking");
      u.onend = () => setState("idle");
      window.speechSynthesis.speak(u);
    } catch {
      setState("idle");
    }
  }, []);

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
      if (!clean || busyRef.current) return;
      busyRef.current = true;

      const nextTurns: Turn[] = [...turns, { role: "user", text: clean }];
      setTurns(nextTurns);
      setInput("");
      setPanel(null);
      setState("thinking");

      // Build API message history from committed turns.
      const apiMessages = nextTurns.map((t) => ({
        role: t.role === "user" ? "user" : "assistant",
        content: t.text,
      }));

      try {
        const res = await fetch("/api/malak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: apiMessages }),
        });
        const data = await res.json();
        const ag: AgentId = (AGENTS.some((a) => a.id === data?.agent) ? data.agent : "malak") as AgentId;
        setActiveAgent(ag);
        const speakText = typeof data?.speak === "string" ? data.speak : "تم.";
        if (data?.panel?.type) setPanel(data.panel as PanelData);
        typewriter(speakText);
        speak(speakText);
      } catch {
        const err = "ما قدرت أوصل للخادم، جرّب مرة ثانية.";
        typewriter(err);
        setState("idle");
      } finally {
        busyRef.current = false;
      }
    },
    [turns, typewriter, speak]
  );

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
    if (listening) {
      rec.stop();
      setListening(false);
      setState("idle");
    } else {
      try {
        window.speechSynthesis?.cancel();
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
      <header className="flex items-center justify-between px-4 py-3 sm:px-6">
        <Link
          href="/dashboard"
          className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white/70 backdrop-blur transition hover:bg-white/10"
        >
          ← لوحة التحكم
        </Link>
        <div className="text-center">
          <h1 className="text-lg font-extrabold tracking-tight">ملاك</h1>
          <p className="text-[11px] text-white/40">المديرة العامة الذكية</p>
        </div>
        <div className="w-[92px]" />
      </header>

      {/* Agent rail */}
      <div className="flex shrink-0 gap-1.5 overflow-x-auto px-3 pb-1.5 pt-0.5 [scrollbar-width:none] sm:justify-center sm:px-6">
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
            </div>
          );
        })}
      </div>

      {/* Orb */}
      <div className="relative flex shrink-0 flex-col items-center justify-center">
        <Orb state={state} color={accent} size={orbSize} />
        <div className="-mt-3 text-center">
          <p className="text-sm font-semibold" style={{ color: accent }}>
            {activeDef.name}
          </p>
          <p className="text-[11px] text-white/40">
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

      {/* Transcript + panel (scrollable) */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 sm:px-6">
        {turns.length === 0 && !typed ? (
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
            <Panel data={panel} />
          </div>
        ) : null}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-white/10 bg-black/20 px-4 py-3 backdrop-blur sm:px-6">
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

        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="flex items-center gap-2"
        >
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
  );
}
