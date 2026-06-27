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

    // Fibonacci sphere — but each point keeps its latitude (y, rLat) and an
    // angle that advances at its OWN rate, so the cloud SWIRLS like a galaxy
    // (differential rotation) instead of turning as a rigid ball.
    const N = 620;
    const golden = Math.PI * (3 - Math.sqrt(5));
    const pts: { y: number; rLat: number; phi0: number; spd: number; tw: number }[] = [];
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const rLat = Math.sqrt(1 - y * y);
      // equator faster than poles + a little per-point variance → swirl
      const spd = 0.55 + 0.9 * rLat + (((i * 41) % 17) / 17) * 0.25;
      pts.push({ y, rLat, phi0: golden * i, spd, tw: ((i * 7) % 31) / 31 });
    }

    const stroke = (al: number) => `rgba(130,185,225,${al})`;

    function reticle(t: number, a: number) {
      // concentric thin rings
      ctx.save();
      ctx.translate(cx, cy);
      for (const [rad, alpha] of [[R * 1.12, 0.32], [R * 1.34, 0.20], [R * 1.62, 0.12]] as const) {
        ctx.beginPath();
        ctx.arc(0, 0, rad, 0, Math.PI * 2);
        ctx.strokeStyle = stroke(alpha * a);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.restore();

      // fine tick scale around the inner ring (36 ticks, every 9th longer)
      ctx.save();
      ctx.translate(cx, cy);
      for (let k = 0; k < 36; k++) {
        const ang = (k / 36) * Math.PI * 2;
        const big = k % 9 === 0;
        const r1 = R * 1.34, r2 = R * (big ? 1.22 : 1.29);
        ctx.beginPath();
        ctx.moveTo(Math.cos(ang) * r1, Math.sin(ang) * r1);
        ctx.lineTo(Math.cos(ang) * r2, Math.sin(ang) * r2);
        ctx.strokeStyle = stroke((big ? 0.5 : 0.2) * a);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.restore();

      // cardinal chevron brackets at N/E/S/W (between the two outer rings)
      ctx.save();
      ctx.translate(cx, cy);
      for (let q = 0; q < 4; q++) {
        const ang = q * Math.PI / 2 - Math.PI / 2;
        ctx.save();
        ctx.rotate(ang);
        const rr = R * 1.46, w = 0.13;
        ctx.strokeStyle = stroke(0.6 * a);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(-w) * (rr - R * 0.07), Math.sin(-w) * (rr - R * 0.07));
        ctx.lineTo(rr, 0);
        ctx.lineTo(Math.cos(w) * (rr - R * 0.07), Math.sin(w) * (rr - R * 0.07));
        ctx.stroke();
        ctx.restore();
      }
      ctx.restore();

      // slowly rotating dashed ring with small square markers riding it
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(t * 0.06);
      ctx.beginPath();
      ctx.setLineDash([2, 15]);
      ctx.arc(0, 0, R * 1.62, 0, Math.PI * 2);
      ctx.strokeStyle = stroke(0.3 * a);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      for (let m = 0; m < 3; m++) {
        const ang = (m / 3) * Math.PI * 2;
        const mx = Math.cos(ang) * R * 1.62, my = Math.sin(ang) * R * 1.62;
        ctx.strokeStyle = stroke(0.55 * a);
        ctx.lineWidth = 1;
        ctx.strokeRect(mx - 2, my - 2, 4, 4);
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

      // view tilt (gentle bob)
      const ax = 0.42 + Math.sin(t * 0.12) * 0.05;
      const cosX = Math.cos(ax), sinX = Math.sin(ax);
      const rad = R * (1 + breathe);
      for (let i = 0; i < N; i++) {
        const p = pts[i];
        // each point swirls at its own angular rate (galaxy differential spin)
        const phi = p.phi0 + t * spin * p.spd;
        let x = Math.cos(phi) * p.rLat;
        let z = Math.sin(phi) * p.rLat;
        // tilt about X for a 3D read
        let y = p.y * cosX - z * sinX;
        z = p.y * sinX + z * cosX;
        const depth = (z + 1) / 2; // 0 back .. 1 front
        const jr = jitter ? Math.sin(i * 12.9 + t * 6) * jitter * 0.04 : 0;
        const px = cx + x * rad * (1 + jr);
        const py = cy + y * rad * (1 + jr);
        const tw = 0.75 + 0.25 * Math.sin(t * (1.5 + p.tw * 2) + i); // twinkle
        const dot = 0.5 + depth * 1.4;
        ctx.beginPath();
        ctx.arc(px, py, dot, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(150,205,240,${(0.1 + depth * 0.62) * bright * tw})`;
        ctx.fill();
      }

      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [size, levelRef]);

  return <canvas ref={canvasRef} className="h-full w-full" style={{ width: size, height: size }} />;
}
