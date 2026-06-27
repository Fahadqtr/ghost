"use client";

// AiCoreOrb — a real 3D AI core (React Three Fiber): a glowing network sphere of
// points + connecting lines, a bright pulsing core, multiple counter-rotating
// HUD rings, and a hologram base platform. State-driven (idle/thinking/speaking/
// error); `levelRef` (0..1) drives the speaking pulse from real audio. Glow is
// done with additive blending (no postprocessing dependency).

import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

export type CoreState = "idle" | "listening" | "thinking" | "speaking" | "error";

const CYAN = "#00d9ff";
const AMBER = "#ff9f1c";

// round soft sprite texture for points + core glow
function softTexture() {
  const s = 64;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(180,235,255,0.7)");
  g.addColorStop(1, "rgba(0,180,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  return t;
}

function Core({ stateRef, levelRef }: { stateRef: React.MutableRefObject<CoreState>; levelRef?: React.MutableRefObject<number> }) {
  const group = useRef<THREE.Group>(null);
  const ringsRef = useRef<THREE.Group>(null);
  const coreRef = useRef<THREE.Sprite>(null);
  const ptsMat = useRef<THREE.PointsMaterial>(null);
  const tex = useMemo(softTexture, []);

  // network sphere: points on a shell with slight radius jitter
  const { positions, linePositions } = useMemo(() => {
    const N = 1500;
    const pts: THREE.Vector3[] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = golden * i;
      const rad = 1 + (Math.sin(i * 13.7) * 0.04);
      pts.push(new THREE.Vector3(Math.cos(th) * r * rad, y * rad, Math.sin(th) * r * rad));
    }
    const positions = new Float32Array(N * 3);
    pts.forEach((p, i) => { positions[i * 3] = p.x; positions[i * 3 + 1] = p.y; positions[i * 3 + 2] = p.z; });
    // connecting lines: each point to its nearest few within a threshold (capped)
    const segs: number[] = [];
    const TH = 0.22;
    let count = 0;
    for (let i = 0; i < N && count < 1400; i++) {
      let found = 0;
      for (let j = i + 1; j < N && found < 2; j++) {
        if (pts[i].distanceToSquared(pts[j]) < TH * TH) {
          segs.push(pts[i].x, pts[i].y, pts[i].z, pts[j].x, pts[j].y, pts[j].z);
          found++; count++;
        }
      }
    }
    return { positions, linePositions: new Float32Array(segs) };
  }, []);

  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const st = stateRef.current;
    const spin = st === "thinking" ? 0.6 : st === "speaking" ? 0.3 : st === "listening" ? 0.26 : 0.14;
    const t = performance.now() / 1000;
    const live = levelRef && levelRef.current > 0 ? Math.min(1, levelRef.current) : -1;
    const amp = st === "speaking" ? (live >= 0 ? live : Math.abs(Math.sin(t * 7))) : 0;
    const breathe = 1 + 0.03 * Math.sin(t * 1.8) + (st === "speaking" ? 0.06 * amp : 0);

    if (group.current) { group.current.rotation.y += dt * spin; group.current.rotation.x = 0.3; group.current.scale.setScalar(breathe); }
    if (ringsRef.current) {
      ringsRef.current.children.forEach((r, i) => {
        const dir = i % 2 === 0 ? 1 : -1;
        r.rotation.z += dt * spin * (0.6 + i * 0.25) * dir;
      });
    }
    const col = st === "error" ? AMBER : CYAN;
    if (ptsMat.current) {
      ptsMat.current.color.set(col);
      ptsMat.current.opacity = 0.85;
      ptsMat.current.size = 0.05 + (st === "thinking" ? 0.01 : 0) + amp * 0.02;
    }
    if (coreRef.current) {
      const s = 1.1 + 0.25 * Math.sin(t * 2.2) + amp * 0.5;
      coreRef.current.scale.setScalar(s);
      (coreRef.current.material as THREE.SpriteMaterial).color.set(col);
    }
  });

  return (
    <group>
      {/* network sphere */}
      <group ref={group}>
        <points>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[positions, 3]} />
          </bufferGeometry>
          <pointsMaterial ref={ptsMat} map={tex} color={CYAN} size={0.05} sizeAttenuation transparent opacity={0.85} depthWrite={false} blending={THREE.AdditiveBlending} />
        </points>
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[linePositions, 3]} />
          </bufferGeometry>
          <lineBasicMaterial color={CYAN} transparent opacity={0.14} depthWrite={false} blending={THREE.AdditiveBlending} />
        </lineSegments>
      </group>

      {/* bright pulsing core */}
      <sprite ref={coreRef} scale={1.1}>
        <spriteMaterial map={tex} color={CYAN} transparent opacity={0.95} depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>

      {/* HUD rings (counter-rotating) */}
      <group ref={ringsRef}>
        {[1.35, 1.55, 1.8].map((r, i) => (
          <mesh key={i} rotation={[Math.PI / 2.4 + i * 0.5, i * 0.3, 0]}>
            <torusGeometry args={[r, 0.004, 8, 120]} />
            <meshBasicMaterial color={CYAN} transparent opacity={0.3 - i * 0.06} blending={THREE.AdditiveBlending} />
          </mesh>
        ))}
      </group>

      {/* hologram base platform */}
      <group position={[0, -1.7, 0]} rotation={[Math.PI / 2, 0, 0]}>
        {[0.5, 0.9, 1.35, 1.8].map((r, i) => (
          <mesh key={i}>
            <ringGeometry args={[r - 0.01, r + 0.01, 96]} />
            <meshBasicMaterial color={CYAN} transparent opacity={0.5 - i * 0.1} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

export default function AiCoreOrb({ state, levelRef }: { state: CoreState; levelRef?: React.MutableRefObject<number> }) {
  const stateRef = useRef<CoreState>(state);
  stateRef.current = state;
  return (
    <Canvas camera={{ position: [0, 0.2, 4.2], fov: 50 }} dpr={[1, 2]} gl={{ antialias: true, alpha: true }} style={{ width: "100%", height: "100%", pointerEvents: "none" }}>
      <Core stateRef={stateRef} levelRef={levelRef} />
    </Canvas>
  );
}
