"use client";

// ملاك — مختبر الكرة (JARVIS-style orb preview). Design playground for the
// shared <JarvisOrb> with the four states + HUD chrome. Standalone so we can
// iterate on the look before/around the live Malak integration.

import { useEffect, useState } from "react";
import JarvisOrb, { type OrbState } from "../JarvisOrb";

const STATE_LABEL: Record<OrbState, string> = {
  idle: "خامل",
  listening: "ينصت",
  thinking: "يفكّر",
  speaking: "يتكلّم",
};

const CORE = "#aee6ff";
const MID = "#4cc3ff";
const BG = "#020510";

export default function OrbLab() {
  const [state, setState] = useState<OrbState>("idle");
  const [orbSize, setOrbSize] = useState(420);

  useEffect(() => {
    const fit = () => setOrbSize(Math.min(560, Math.round(Math.min(window.innerWidth, window.innerHeight) * 0.82)));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  return (
    <div dir="rtl" className="relative -m-4 flex min-h-[calc(100vh-2rem)] flex-col overflow-hidden sm:-m-6" style={{ background: BG }}>
      {/* faint grid */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.12]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(76,195,255,0.4) 1px, transparent 1px), linear-gradient(90deg, rgba(76,195,255,0.4) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(circle at 50% 45%, black 30%, transparent 75%)",
          WebkitMaskImage: "radial-gradient(circle at 50% 45%, black 30%, transparent 75%)",
        }}
      />

      {/* corner HUD brackets */}
      {["left-4 top-4 border-l-2 border-t-2", "right-4 top-4 border-r-2 border-t-2", "left-4 bottom-4 border-l-2 border-b-2", "right-4 bottom-4 border-r-2 border-b-2"].map((c) => (
        <span key={c} className={`pointer-events-none absolute h-8 w-8 ${c}`} style={{ borderColor: "rgba(76,195,255,0.5)" }} />
      ))}

      {/* header */}
      <div className="relative z-10 flex items-center justify-between px-6 pt-6">
        <span className="font-mono text-[11px] tracking-[0.35em]" style={{ color: MID }}>M · A · L · A · K</span>
        <span className="font-mono text-[11px] tracking-widest" style={{ color: "rgba(174,230,255,0.7)" }}>STATUS: {state.toUpperCase()}</span>
      </div>

      {/* orb */}
      <div className="relative z-0 flex flex-1 flex-col items-center justify-center">
        <JarvisOrb state={state} size={orbSize} />
        <div className="pointer-events-none -mt-6 text-center">
          <p className="text-2xl font-extrabold text-white" style={{ textShadow: `0 0 18px ${MID}` }}>ملاك</p>
          <p className="mt-1 font-mono text-[11px] tracking-widest" style={{ color: "rgba(174,230,255,0.65)" }}>
            {state === "speaking" ? "… يتكلّم" : state === "thinking" ? "… يعالج" : state === "listening" ? "… ينصت" : "جاهزة"}
          </p>
        </div>
      </div>

      {/* state controls (preview only) */}
      <div className="relative z-10 flex flex-wrap items-center justify-center gap-2 px-4 pb-6">
        {(Object.keys(STATE_LABEL) as OrbState[]).map((s) => (
          <button
            key={s}
            onClick={() => setState(s)}
            className="rounded-full border px-4 py-1.5 font-mono text-xs tracking-wider transition"
            style={
              state === s
                ? { background: "rgba(76,195,255,0.18)", borderColor: MID, color: CORE, boxShadow: "0 0 16px rgba(76,195,255,0.45)" }
                : { background: "rgba(76,195,255,0.05)", borderColor: "rgba(76,195,255,0.25)", color: "rgba(174,230,255,0.7)" }
            }
          >
            {STATE_LABEL[s]}
          </button>
        ))}
      </div>
    </div>
  );
}
