"use client";

// JARVIS-style atom orb (shared by the live Malak hero + the /orb-lab preview).
// A glowing cyan core that breathes, three tilted orbiting nodes (atom), and
// concentric reticle rings — driven by Malak's state. 2D canvas, no Three.js.
// `level` (0..1) optionally drives the "speaking" breathing from real audio.

import { useEffect, useRef } from "react";

export type OrbState = "idle" | "listening" | "thinking" | "speaking";

const MID = "#4cc3ff";

export default function JarvisOrb({
  state,
  size = 220,
  levelRef,
}: {
  state: OrbState;
  size?: number;
  levelRef?: React.MutableRefObject<number>; // live audio level 0..1 (optional)
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<OrbState>(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ctx0 = el.getContext("2d");
    if (!ctx0) return;
    const canvas = el;
    const ctx = ctx0;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let raf = 0;
    const t0 = performance.now();
    let W = size, H = size, cx = size / 2, cy = size / 2, R = size * 0.13;

    function setup() {
      W = canvas.clientWidth || size;
      H = canvas.clientHeight || size;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx = W / 2; cy = H / 2; R = Math.min(W, H) * 0.13;
    }
    setup();
    const ro = new ResizeObserver(setup);
    ro.observe(canvas);

    function orbit(t: number, tiltDeg: number, rx: number, ry: number, phase: number, speed: number, bright: number) {
      const tilt = (tiltDeg * Math.PI) / 180;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(tilt);
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(76,195,255,${0.18 * bright})`;
      ctx.lineWidth = 1;
      ctx.stroke();
      const a = t * speed + phase;
      const nx = Math.cos(a) * rx;
      const ny = Math.sin(a) * ry;
      const depth = (Math.sin(a) + 1) / 2;
      const nr = 2.2 + depth * 3.2;
      ctx.shadowBlur = 14 * bright;
      ctx.shadowColor = MID;
      ctx.beginPath();
      ctx.arc(nx, ny, nr, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(174,230,255,${0.5 + 0.5 * depth})`;
      ctx.fill();
      ctx.restore();
    }

    function reticle(t: number, bright: number) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.beginPath();
      ctx.arc(0, 0, R * 2.7, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(76,195,255,${0.22 * bright})`;
      ctx.lineWidth = 1;
      ctx.stroke();
      const ticks = 60;
      for (let i = 0; i < ticks; i++) {
        const ang = (i / ticks) * Math.PI * 2 + t * 0.05;
        const r1 = R * 2.45, r2 = i % 5 === 0 ? R * 2.32 : R * 2.4;
        ctx.beginPath();
        ctx.moveTo(Math.cos(ang) * r1, Math.sin(ang) * r1);
        ctx.lineTo(Math.cos(ang) * r2, Math.sin(ang) * r2);
        ctx.strokeStyle = `rgba(76,195,255,${(i % 5 === 0 ? 0.5 : 0.22) * bright})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.rotate(t * 0.12);
      ctx.beginPath();
      ctx.setLineDash([4, 14]);
      ctx.arc(0, 0, R * 3.15, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(76,195,255,${0.35 * bright})`;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    function loadingArc(t: number, bright: number) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(t * 2.4);
      ctx.beginPath();
      ctx.arc(0, 0, R * 3.5, 0, Math.PI * 0.6);
      ctx.strokeStyle = `rgba(174,230,255,${0.85 * bright})`;
      ctx.lineWidth = 2;
      ctx.shadowBlur = 12;
      ctx.shadowColor = MID;
      ctx.stroke();
      ctx.restore();
    }

    function draw(now: number) {
      const t = (now - t0) / 1000;
      const st = stateRef.current;

      let breathe = 0.04, speed = 0.5, glow = 0.6, ringBright = 0.7;
      if (st === "idle") { breathe = 0.04; speed = 0.4; glow = 0.55; ringBright = 0.6; }
      else if (st === "listening") { breathe = 0.05 + 0.03 * (0.5 + 0.5 * Math.sin(t * 5)); speed = 0.7; glow = 0.85; ringBright = 0.95; }
      else if (st === "thinking") { breathe = 0.045; speed = 1.9; glow = 0.9; ringBright = 0.85; }
      else if (st === "speaking") {
        const live = levelRef && levelRef.current > 0 ? Math.min(1, levelRef.current) : -1;
        const amp = live >= 0
          ? live
          : Math.abs(0.6 * Math.sin(t * 7.3) + 0.4 * Math.sin(t * 12.1) + 0.2 * Math.sin(t * 23.7));
        breathe = 0.05 + 0.12 * amp; speed = 1.2; glow = 1.0; ringBright = 1.0;
      }

      ctx.clearRect(0, 0, W, H);

      const vg = ctx.createRadialGradient(cx, cy, R, cx, cy, Math.max(W, H) * 0.55);
      vg.addColorStop(0, "rgba(8,24,48,0.45)");
      vg.addColorStop(1, "rgba(2,5,16,0)");
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, W, H);

      reticle(t, ringBright);
      if (st === "thinking") loadingArc(t, ringBright);

      orbit(t, 0, R * 2.0, R * 0.78, 0, speed, ringBright);
      orbit(t, 60, R * 2.0, R * 0.78, 2.1, speed * 0.92, ringBright);
      orbit(t, 120, R * 2.0, R * 0.78, 4.2, speed * 1.08, ringBright);

      const r = R * (1 + breathe * Math.sin(t * 2.4) + (st === "speaking" ? breathe : 0));
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 2.4);
      g.addColorStop(0, `rgba(255,255,255,${0.9 * glow})`);
      g.addColorStop(0.18, `rgba(174,230,255,${0.95 * glow})`);
      g.addColorStop(0.5, `rgba(76,195,255,${0.55 * glow})`);
      g.addColorStop(1, "rgba(8,30,60,0)");
      ctx.shadowBlur = 40 * glow;
      ctx.shadowColor = MID;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.32, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${0.85 * glow})`;
      ctx.fill();

      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [size, levelRef]);

  return <canvas ref={canvasRef} className="h-full w-full" style={{ width: size, height: size }} />;
}
