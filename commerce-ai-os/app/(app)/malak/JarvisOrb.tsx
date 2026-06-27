"use client";

// Mission-Control particle-sphere orb (matches the JARVIS reference): a rotating
// globe of points + thin concentric reticle rings + cardinal tick marks, in a
// muted desaturated blue. State-driven (idle/listening/thinking/speaking);
// `levelRef` (0..1) optionally drives the speaking motion from real audio.
// 2D canvas, no Three.js.

import { useEffect, useRef } from "react";

export type OrbState = "idle" | "listening" | "thinking" | "speaking";

export default function JarvisOrb({
  state,
  size = 320,
  levelRef,
}: {
  state: OrbState;
  size?: number;
  levelRef?: React.MutableRefObject<number>;
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
    let W = size, H = size, cx = size / 2, cy = size / 2, R = size * 0.30;

    function setup() {
      W = canvas.clientWidth || size;
      H = canvas.clientHeight || size;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx = W / 2; cy = H / 2; R = Math.min(W, H) * 0.30;
    }
    setup();
    const ro = new ResizeObserver(setup);
    ro.observe(canvas);

    // Fibonacci sphere of unit points (generated once).
    const N = 520;
    const pts: { x: number; y: number; z: number }[] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = golden * i;
      pts.push({ x: Math.cos(th) * r, y, z: Math.sin(th) * r });
    }

    function reticle(t: number, a: number) {
      ctx.save();
      ctx.translate(cx, cy);
      // concentric thin rings
      for (const [rad, alpha] of [[R * 1.18, 0.30], [R * 1.42, 0.18]] as const) {
        ctx.beginPath();
        ctx.arc(0, 0, rad, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(120,180,225,${alpha * a})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      // rotating dashed outer ring
      ctx.rotate(t * 0.06);
      ctx.beginPath();
      ctx.setLineDash([2, 16]);
      ctx.arc(0, 0, R * 1.6, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(120,180,225,${0.35 * a})`;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      // cardinal tick brackets (fixed)
      ctx.save();
      ctx.translate(cx, cy);
      for (let k = 0; k < 12; k++) {
        const ang = (k / 12) * Math.PI * 2;
        const big = k % 3 === 0;
        const r1 = R * 1.46, r2 = R * (big ? 1.36 : 1.42);
        ctx.beginPath();
        ctx.moveTo(Math.cos(ang) * r1, Math.sin(ang) * r1);
        ctx.lineTo(Math.cos(ang) * r2, Math.sin(ang) * r2);
        ctx.strokeStyle = `rgba(140,195,235,${(big ? 0.55 : 0.28) * a})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.restore();
    }

    function draw(now: number) {
      const t = (now - t0) / 1000;
      const st = stateRef.current;

      let spin = 0.18, jitter = 0, bright = 0.6, ringA = 0.85, breathe = 0.0;
      if (st === "idle") { spin = 0.16; bright = 0.55; ringA = 0.8; }
      else if (st === "listening") { spin = 0.26; bright = 0.8; ringA = 1; breathe = 0.02; }
      else if (st === "thinking") { spin = 0.7; bright = 0.85; ringA = 0.9; jitter = 0.4; }
      else if (st === "speaking") {
        const live = levelRef && levelRef.current > 0 ? Math.min(1, levelRef.current) : -1;
        const amp = live >= 0 ? live : Math.abs(0.6 * Math.sin(t * 7.3) + 0.4 * Math.sin(t * 12.1));
        spin = 0.3; bright = 0.95; ringA = 1; breathe = 0.05 + 0.09 * amp; jitter = 0.25 * amp;
      }

      ctx.clearRect(0, 0, W, H);

      // faint inner glow
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.3);
      g.addColorStop(0, `rgba(40,90,140,${0.22 * bright})`);
      g.addColorStop(1, "rgba(4,10,22,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.3, 0, Math.PI * 2);
      ctx.fill();

      reticle(t, ringA);

      // rotate + project the sphere
      const ay = t * spin;
      const ax = 0.42 + Math.sin(t * 0.12) * 0.05;
      const cosY = Math.cos(ay), sinY = Math.sin(ay);
      const cosX = Math.cos(ax), sinX = Math.sin(ax);
      const rad = R * (1 + breathe);
      for (let i = 0; i < N; i++) {
        const p = pts[i];
        // rotate Y then X
        let x = p.x * cosY - p.z * sinY;
        let z = p.x * sinY + p.z * cosY;
        let y = p.y * cosX - z * sinX;
        z = p.y * sinX + z * cosX;
        const depth = (z + 1) / 2; // 0 back .. 1 front
        const jx = jitter ? (Math.sin(i * 12.9 + t * 6) * jitter) : 0;
        const px = cx + (x + jx * 0.02) * rad;
        const py = cy + y * rad;
        const dot = 0.5 + depth * 1.3;
        ctx.beginPath();
        ctx.arc(px, py, dot, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(150,205,240,${(0.12 + depth * 0.6) * bright})`;
        ctx.fill();
      }

      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [size, levelRef]);

  return <canvas ref={canvasRef} className="h-full w-full" style={{ width: size, height: size }} />;
}
