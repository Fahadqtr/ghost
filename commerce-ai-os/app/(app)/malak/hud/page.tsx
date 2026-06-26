"use client";

// ملاك — Mission Control HUD (JARVIS-style full dashboard preview). Faithful to
// the reference: header + status chips, state tabs, clock/coords, left SYSTEM
// VITALS + TELEMETRY, center orb with reticle, right PROXIMITY + AUDIO I/O +
// DIAGNOSTICS, bottom PRIMARY OBJECTIVE. Cyan-on-near-black, monospace, thin
// glowing strokes. Standalone so we can iterate before wiring real data.

import { useEffect, useRef, useState } from "react";
import JarvisOrb, { type OrbState } from "../JarvisOrb";

const CY = "#4cc3ff";
const CY_DIM = "rgba(76,195,255,0.55)";
const CY_FAINT = "rgba(76,195,255,0.25)";
const AMBER = "#ffb454";

const STATE_TABS: { id: OrbState; label: string }[] = [
  { id: "idle", label: "IDLE" },
  { id: "listening", label: "LISTENING" },
  { id: "thinking", label: "THINKING" },
  { id: "speaking", label: "TALKING" },
];

const VITALS = [
  { label: "NEURAL CORE", value: 37, unit: "%" },
  { label: "MEMORY", value: 67, unit: "%" },
  { label: "LATENCY", value: 18, unit: "ms", raw: "9.55ms" },
  { label: "SIGNAL", value: 96, unit: "%" },
  { label: "THERMAL", value: 40, unit: "°C", raw: "39.5°C" },
  { label: "THROUGHPUT", value: 52, unit: "", raw: "1.0 GB/s" },
];

const LOG_LINES = [
  ["01:16:41", "OK", "context.load 256k tokens"],
  ["12:44:23", "OK", "embedding.cache throttle 0.04"],
  ["19:43:15", "OK", "core.heartbeat buffer clear"],
  ["21:15:36", "ERR", "audio.stream ctx resumed"],
  ["15:10:38", "OK", "vector.query sync complete"],
  ["21:17:06", "OK", "sensor.poll handshake ok"],
  ["22:25:01", "OK", "neural.inference quantized"],
  ["20:46:08", "OK", "context.load latency 12ms"],
  ["02:32:59", "OK", "core.heartbeat sync complete"],
  ["06:47:42", "OK", "signal.trace quantized"],
  ["14:11:59", "OK", "audio.stream quantized"],
];

function Bracket({ at }: { at: string }) {
  return <span className={`pointer-events-none absolute h-7 w-7 ${at}`} style={{ borderColor: CY_DIM }} />;
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-[9px] tracking-widest" style={{ borderColor: CY_FAINT, color: CY_DIM }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: CY, boxShadow: `0 0 6px ${CY}` }} />
      {children}
    </span>
  );
}

function Panel({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`relative rounded border p-2.5 ${className}`} style={{ borderColor: CY_FAINT, background: "rgba(8,20,40,0.35)" }}>
      <p className="mb-2 font-mono text-[9px] tracking-[0.3em]" style={{ color: CY_DIM }}>{`{ ${title} }`}</p>
      {children}
    </div>
  );
}

function VitalBar({ label, value, raw, unit }: { label: string; value: number; raw?: string; unit: string }) {
  return (
    <div className="mb-2">
      <div className="mb-0.5 flex items-center justify-between font-mono text-[9px]" style={{ color: "rgba(174,230,255,0.8)" }}>
        <span style={{ color: CY_DIM }}>{label}</span>
        <span>{raw ?? `${value}${unit}`}</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full" style={{ background: "rgba(76,195,255,0.12)" }}>
        <div className="h-full rounded-full" style={{ width: `${value}%`, background: CY, boxShadow: `0 0 8px ${CY}` }} />
      </div>
    </div>
  );
}

function LogFeed({ lines }: { lines: string[][] }) {
  return (
    <div className="space-y-1 font-mono text-[8.5px] leading-relaxed">
      {lines.map(([t, st, msg], i) => (
        <div key={i} className="flex gap-2" style={{ color: "rgba(174,230,255,0.5)" }}>
          <span style={{ color: CY_FAINT }}>{t}</span>
          <span style={{ color: st === "ERR" ? AMBER : "rgba(76,195,255,0.7)" }}>{st}</span>
          <span className="truncate">{msg}</span>
        </div>
      ))}
    </div>
  );
}

// Sweeping proximity radar.
function Radar() {
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[150px]">
      <div className="absolute inset-0 rounded-full border" style={{ borderColor: CY_FAINT }} />
      <div className="absolute inset-[18%] rounded-full border" style={{ borderColor: "rgba(76,195,255,0.18)" }} />
      <div className="absolute inset-[40%] rounded-full border" style={{ borderColor: "rgba(76,195,255,0.18)" }} />
      <div className="absolute left-1/2 top-0 h-full w-px" style={{ background: "rgba(76,195,255,0.18)" }} />
      <div className="absolute left-0 top-1/2 h-px w-full" style={{ background: "rgba(76,195,255,0.18)" }} />
      <div className="absolute inset-0 rounded-full" style={{ background: `conic-gradient(from 0deg, ${CY}55, transparent 25%)`, animation: "radarSweep 3s linear infinite" }} />
      <span className="absolute h-1.5 w-1.5 rounded-full" style={{ left: "66%", top: "38%", background: CY, boxShadow: `0 0 6px ${CY}` }} />
      <span className="absolute h-1.5 w-1.5 rounded-full" style={{ left: "40%", top: "62%", background: CY, boxShadow: `0 0 6px ${CY}` }} />
    </div>
  );
}

// Live-ish audio equalizer bars.
function AudioBars({ active }: { active: boolean }) {
  const bars = 40;
  return (
    <div className="flex h-10 items-center gap-[2px]">
      {Array.from({ length: bars }).map((_, i) => (
        <span
          key={i}
          className="flex-1 rounded-full"
          style={{
            height: "100%",
            background: CY,
            opacity: 0.5,
            transformOrigin: "center",
            animation: active ? `eq ${0.6 + (i % 5) * 0.12}s ${i * 0.03}s ease-in-out infinite` : "none",
            transform: active ? undefined : "scaleY(0.18)",
          }}
        />
      ))}
    </div>
  );
}

export default function MalakHud() {
  const [state, setState] = useState<OrbState>("idle");
  const [now, setNow] = useState("--:--:--");
  const [orbSize, setOrbSize] = useState(360);
  const levelRef = useRef(0);

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const p = (n: number, l = 2) => String(n).padStart(l, "0");
      setNow(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(Math.floor(d.getMilliseconds() / 10))}`);
    };
    tick();
    const id = setInterval(tick, 80);
    const fit = () => setOrbSize(Math.min(460, Math.round(Math.min(window.innerWidth * 0.42, window.innerHeight * 0.6))));
    fit();
    window.addEventListener("resize", fit);
    return () => { clearInterval(id); window.removeEventListener("resize", fit); };
  }, []);

  // Drive the audio bars + orb breathing in the TALKING tab with a synthetic
  // level (the live page feeds a real levelRef instead).
  useEffect(() => {
    if (state !== "speaking") { levelRef.current = 0; return; }
    let raf = 0;
    const t0 = performance.now();
    const loop = (t: number) => {
      const s = (t - t0) / 1000;
      levelRef.current = Math.abs(0.6 * Math.sin(s * 7.3) + 0.4 * Math.sin(s * 12.1));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [state]);

  return (
    <div dir="ltr" className="relative -m-4 min-h-[calc(100vh-2rem)] overflow-hidden font-mono sm:-m-6" style={{ background: "#020510", color: CY }}>
      <style>{`
        @keyframes radarSweep { to { transform: rotate(360deg); } }
        @keyframes eq { 0%,100% { transform: scaleY(0.2); } 50% { transform: scaleY(1); } }
        @keyframes hudScan { to { transform: translateY(100%); } }
      `}</style>

      {/* grid */}
      <div className="pointer-events-none absolute inset-0 opacity-[0.10]" style={{
        backgroundImage: `linear-gradient(${CY} 1px, transparent 1px), linear-gradient(90deg, ${CY} 1px, transparent 1px)`,
        backgroundSize: "40px 40px",
      }} />
      {/* scanline */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-24 opacity-30" style={{ background: `linear-gradient(${CY}22, transparent)`, animation: "hudScan 6s linear infinite" }} />

      <Bracket at="left-3 top-3 border-l-2 border-t-2" />
      <Bracket at="right-3 top-3 border-r-2 border-t-2" />
      <Bracket at="left-3 bottom-3 border-l-2 border-b-2" />
      <Bracket at="right-3 bottom-3 border-r-2 border-b-2" />

      {/* HEADER */}
      <div className="relative z-10 flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
        <div>
          <p className="text-[13px] font-bold tracking-[0.2em]" style={{ color: "#cfeeff" }}>MALIKA&apos;S UNIVERSE <span style={{ color: CY_DIM }}>// COMMERCE CONTROL</span></p>
          <p className="text-[9px] tracking-[0.25em]" style={{ color: CY_DIM }}>M.A.L.A.K · MALIKA&apos;S AUTONOMOUS LOGISTICS &amp; ASSISTANT KERNEL</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Chip>ONLINE</Chip><Chip>SECURE</Chip><Chip>ENCRYPTED</Chip><Chip>AUTH-LVL9</Chip>
          </div>
        </div>

        {/* state tabs */}
        <div className="flex items-center gap-1 rounded border p-1" style={{ borderColor: CY_FAINT }}>
          {STATE_TABS.map((s) => (
            <button key={s.id} onClick={() => setState(s.id)}
              className="rounded px-2.5 py-1 text-[9px] tracking-widest transition"
              style={state === s.id ? { background: "rgba(76,195,255,0.18)", color: "#cfeeff", boxShadow: `inset 0 0 10px ${CY}44` } : { color: CY_DIM }}>
              {s.label}
            </button>
          ))}
        </div>

        <div className="text-right">
          <p className="text-[26px] font-bold leading-none tracking-wider" style={{ color: "#cfeeff", textShadow: `0 0 12px ${CY}88` }}>{now}</p>
          <p className="mt-1 text-[9px] tracking-widest" style={{ color: CY_DIM }}>SESSION · 7E4A-99F2-01C0</p>
          <p className="text-[9px] tracking-widest" style={{ color: CY_DIM }}>LAT 25.2854°N · LON 51.5310°E</p>
          <p className="text-[9px] tracking-widest" style={{ color: CY_DIM }}>DOHA · QA · BEARING 087°</p>
        </div>
      </div>

      {/* MAIN GRID */}
      <div className="relative z-10 grid grid-cols-12 gap-3 px-5 pt-4">
        {/* LEFT */}
        <div className="col-span-3 space-y-3">
          <Panel title="SYSTEM VITALS">
            {VITALS.map((v) => <VitalBar key={v.label} {...v} />)}
          </Panel>
          <Panel title="TELEMETRY"><LogFeed lines={LOG_LINES} /></Panel>
        </div>

        {/* CENTER ORB */}
        <div className="col-span-6 flex flex-col items-center justify-start pt-6">
          <JarvisOrb state={state} size={orbSize} levelRef={levelRef} />
          <p className="mt-2 text-[10px] tracking-[0.35em]" style={{ color: CY_DIM }}>
            {state === "speaking" ? "RESPONDING" : state === "thinking" ? "PROCESSING" : state === "listening" ? "LISTENING" : "STANDBY"}
          </p>
        </div>

        {/* RIGHT */}
        <div className="col-span-3 space-y-3">
          <Panel title="PROXIMITY"><Radar /></Panel>
          <Panel title="AUDIO I/O">
            <AudioBars active={state === "speaking" || state === "listening"} />
            <p className="mt-1 text-[8.5px] tracking-widest" style={{ color: CY_FAINT }}>48kHz · 24bit</p>
          </Panel>
          <Panel title="DIAGNOSTICS"><LogFeed lines={LOG_LINES.slice(0, 7)} /></Panel>
        </div>
      </div>

      {/* PRIMARY OBJECTIVE */}
      <div className="relative z-10 mx-5 mt-4 rounded border p-3" style={{ borderColor: CY_FAINT, background: "rgba(8,20,40,0.4)" }}>
        <div className="flex items-center justify-between">
          <p className="text-[9px] tracking-[0.3em]" style={{ color: AMBER }}>■ PRIMARY OBJECTIVE</p>
          <p className="text-[9px] tracking-widest" style={{ color: CY_DIM }}>MISSION · REV-03</p>
        </div>
        <div className="mt-2 flex items-end gap-6">
          <div><p className="text-[8.5px] tracking-widest" style={{ color: CY_FAINT }}>TARGET</p><p className="text-xl font-bold" style={{ color: "#cfeeff" }}>$10,000<span className="text-[10px]" style={{ color: CY_DIM }}>/MRR</span></p></div>
          <div><p className="text-[8.5px] tracking-widest" style={{ color: CY_FAINT }}>CURRENT</p><p className="text-xl font-bold" style={{ color: CY }}>$2,846</p></div>
          <div><p className="text-[8.5px] tracking-widest" style={{ color: CY_FAINT }}>GAP</p><p className="text-xl font-bold" style={{ color: AMBER }}>$7,154</p></div>
          <div className="flex-1">
            <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: "rgba(76,195,255,0.12)" }}>
              <div className="h-full rounded-full" style={{ width: "28%", background: CY, boxShadow: `0 0 8px ${CY}` }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
