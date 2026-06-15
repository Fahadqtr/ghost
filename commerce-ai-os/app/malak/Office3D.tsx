"use client";

// مكتب ملاك الافتراضي 3D — شخصيات GLB حقيقية مُولّدة + مُجهّزة بهيكل عظمي (rigged)
// وأنيميشن idle، تُحمَّل بـ useGLTF وتُستنسخ لكل وكيل بلون مختلف، وتتحرك عبر
// AnimationMixer. الوكيل النشط يكبر ويضيء وله حلقة على الأرض ولافتة بحالته الحيّة.
// الغرفة آيزومترك فاتحة على منصّة سميكة + أثاث (خزنة، مكتب، سبورة، كانبان، لاونج، بوابة).
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, ContactShadows, Html, SoftShadows, useGLTF } from "@react-three/drei";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";

export interface OfficeAgent {
  id: string;
  name: string;
  role: string;
  color: string;
}

// مجسّم الشخصية المُولّد (GLB واقعي مكسوّ). مقاسه ~1.91 وحدة بمركز عند 0 (القدمان ~-0.957).
// نُصغّره لطول ~1.35 ونرفعه ليقف على الأرض. الأنيميشن إجرائي (نطّ/تمايل) داخل three.js.
const MODEL_URL = "/models/agent-idle.glb";
const MODEL_SCALE = 0.7; // 1.35 / 1.911 ≈ طول واقعي على الأرضية
const MODEL_Y = 0.67; // رفع القدمين إلى مستوى الأرض (0.957 × 0.7)
const MODEL_FACE = 0; // دوران ليواجه +Z (يُعدَّل لو طلع مقلوبًا)

useGLTF.preload(MODEL_URL);

type Pose = "idle";

interface Station {
  pos: [number, number, number];
  rotY: number;
  robot?: boolean;
}

// محطّات الوكلاء حول الغرفة (مطابقة لتوزيع المرجع).
const STATIONS: Record<string, Station> = {
  malak: { pos: [-0.85, 0, 0.55], rotY: Math.PI },
  noor: { pos: [0.35, 0, -1.7], rotY: 0 },
  bayan: { pos: [2.55, 0, -1.25], rotY: -0.6 },
  latifa: { pos: [-3.9, 0, 1.2], rotY: Math.PI / 2 },
  faisal: { pos: [2.15, 0, 1.6], rotY: Math.PI * 0.86 },
};
const STANDING: [number, number, number][] = [
  [-2.3, 0, 0.9],
  [-1.0, 0, 1.7],
  [0.7, 0, 1.2],
  [1.7, 0, 0.35],
  [-2.9, 0, -0.5],
  [0.0, 0, 0.1],
];

function tintMaterial(mat: THREE.Material, color: THREE.Color): THREE.Material {
  const m = mat.clone() as THREE.MeshStandardMaterial;
  if (m.color) m.color.copy(color);
  return m;
}

function Agent({
  color,
  name,
  role,
  station,
  active,
  status,
}: {
  color: string;
  name: string;
  role: string;
  station: Station;
  active: boolean;
  status: string | null;
}) {
  const { scene, animations } = useGLTF(MODEL_URL);
  const phase = useMemo(() => Math.random() * Math.PI * 2, []);

  // استنساخ مع الهيكل العظمي + تلوين (الجسم فاتح فالضرب باللون يعطي تدرّجًا نظيفًا).
  const cloned = useMemo(() => {
    const c = skeletonClone(scene);
    const tint = new THREE.Color(color).lerp(new THREE.Color("#ffffff"), 0.32);
    c.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if ((mesh as THREE.Mesh).isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const mat = mesh.material;
        mesh.material = Array.isArray(mat)
          ? mat.map((mm) => tintMaterial(mm, tint))
          : tintMaterial(mat, tint);
      }
    });
    return c;
  }, [scene, color]);

  // مكسر أنيميشن خاص بكل نسخة (idle) إن وُجد كليب داخل الـGLB.
  const mixer = useMemo(() => new THREE.AnimationMixer(cloned), [cloned]);
  const hasClip = animations.length > 0;
  useEffect(() => {
    if (hasClip) {
      const action = mixer.clipAction(animations[0]);
      action.reset();
      action.timeScale = 0.9 + Math.random() * 0.25; // تفاوت بسيط بين الوكلاء
      action.play();
    }
    return () => {
      mixer.stopAllAction();
    };
  }, [mixer, animations, hasClip]);

  const g = useRef<THREE.Group>(null);
  useFrame((s, dt) => {
    if (hasClip) mixer.update(dt * (active ? 1.5 : 1));
    if (g.current) {
      const t = s.clock.elapsedTime;
      // تمايل خفيف دائمًا، ونطّ احتياطي لو ما فيه كليب أنيميشن داخل المجسّم.
      g.current.rotation.y = station.rotY + Math.sin(t * 0.5 + phase) * (active ? 0.14 : 0.07);
      if (!hasClip) {
        const sp = active ? 3.2 : 1.6;
        const amp = active ? 0.07 : 0.03;
        g.current.position.y = station.pos[1] + MODEL_Y + Math.abs(Math.sin(t * sp + phase)) * amp;
      }
    }
  });

  return (
    <group
      ref={g}
      position={[station.pos[0], station.pos[1] + MODEL_Y, station.pos[2]]}
      rotation={[0, station.rotY + MODEL_FACE, 0]}
      scale={MODEL_SCALE * (active ? 1.16 : 1)}
    >
      <primitive object={cloned} />

      {active ? (
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.42, 0.58, 48]} />
          <meshBasicMaterial color={color} transparent opacity={0.7} side={THREE.DoubleSide} />
        </mesh>
      ) : null}

      <Html position={[0, 1.55, 0]} center distanceFactor={9} style={{ pointerEvents: "none" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            whiteSpace: "nowrap",
            fontFamily: "system-ui, sans-serif",
            fontSize: active ? 13 : 11,
            fontWeight: 700,
            color: active ? "#fff" : "#1e2433",
            background: active ? color : "rgba(255,255,255,0.92)",
            border: `1.5px solid ${color}`,
            borderRadius: 999,
            padding: active ? "3px 10px" : "2px 8px",
            boxShadow: "0 4px 12px rgba(0,0,0,0.18)",
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: 999, background: active ? "#fff" : color }} />
          {name}
          {active && status ? (
            <span style={{ fontWeight: 600, opacity: 0.9 }}> · {status}</span>
          ) : (
            <span style={{ fontWeight: 500, opacity: 0.7, fontSize: active ? 11 : 9 }}> · {role}</span>
          )}
        </div>
      </Html>
    </group>
  );
}

function StationLabel({
  pos,
  dot,
  title,
  sub,
}: {
  pos: [number, number, number];
  dot: string;
  title: string;
  sub: string;
}) {
  return (
    <Html position={pos} center distanceFactor={10} style={{ pointerEvents: "none" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          whiteSpace: "nowrap",
          fontFamily: "system-ui, sans-serif",
          background: "rgba(255,255,255,0.95)",
          border: "1px solid rgba(0,0,0,0.08)",
          borderRadius: 8,
          padding: "3px 8px",
          boxShadow: "0 4px 14px rgba(0,0,0,0.14)",
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: 999, background: dot }} />
        <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.15 }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: "#1e2433" }}>{title}</span>
          <span style={{ fontSize: 8.5, fontWeight: 500, color: "#7b8398" }}>{sub}</span>
        </span>
      </div>
    </Html>
  );
}

function Vault() {
  return (
    <group position={[-3.6, 0, -2.15]} rotation={[0, 0.35, 0]}>
      <mesh position={[0, 0.7, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.15, 1.4, 0.95]} />
        <meshStandardMaterial color="#aeb6c0" metalness={0.75} roughness={0.35} />
      </mesh>
      <mesh position={[0, 0.7, 0.49]}>
        <boxGeometry args={[0.92, 1.16, 0.04]} />
        <meshStandardMaterial color="#cfd5dd" metalness={0.6} roughness={0.4} />
      </mesh>
      <mesh position={[0.18, 0.7, 0.53]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.2, 0.2, 0.07, 28]} />
        <meshStandardMaterial color="#e9edf3" metalness={0.85} roughness={0.25} />
      </mesh>
      <mesh position={[-0.22, 0.7, 0.55]}>
        <boxGeometry args={[0.06, 0.42, 0.06]} />
        <meshStandardMaterial color="#5b6472" metalness={0.7} roughness={0.3} />
      </mesh>
      <StationLabel pos={[0, 1.7, 0.2]} dot="#9aa3ad" title="Vault" sub="Secured Memory" />
    </group>
  );
}

function Desk() {
  return (
    <group position={[-0.85, 0, -0.7]}>
      <mesh position={[0, 0.74, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.9, 0.1, 0.95]} />
        <meshStandardMaterial color="#9c6b3c" roughness={0.55} metalness={0.05} />
      </mesh>
      <mesh position={[0.6, 0.37, 0]} castShadow>
        <boxGeometry args={[0.6, 0.74, 0.9]} />
        <meshStandardMaterial color="#7c4f28" roughness={0.6} />
      </mesh>
      <mesh position={[-0.82, 0.37, 0]} castShadow>
        <boxGeometry args={[0.08, 0.74, 0.85]} />
        <meshStandardMaterial color="#7c4f28" roughness={0.6} />
      </mesh>
      <mesh position={[0, 1.18, -0.36]} castShadow>
        <boxGeometry args={[0.92, 0.54, 0.05]} />
        <meshStandardMaterial color="#0e1626" emissive="#2563eb" emissiveIntensity={0.55} roughness={0.3} />
      </mesh>
      <mesh position={[0, 0.92, -0.34]}>
        <boxGeometry args={[0.12, 0.12, 0.12]} />
        <meshStandardMaterial color="#2a2f3a" roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.8, 0.15]}>
        <boxGeometry args={[0.5, 0.03, 0.18]} />
        <meshStandardMaterial color="#3a3f4b" roughness={0.6} />
      </mesh>
      <StationLabel pos={[0, 1.62, 0.1]} dot="#2563eb" title="Desk 01" sub="Active Compute" />
    </group>
  );
}

function Whiteboard() {
  return (
    <group position={[0.3, 0, -3.02]}>
      <mesh position={[0, 1.55, 0]} castShadow>
        <boxGeometry args={[1.9, 1.15, 0.07]} />
        <meshStandardMaterial color="#cfd5de" roughness={0.5} />
      </mesh>
      <mesh position={[0, 1.55, 0.04]}>
        <boxGeometry args={[1.74, 1.0, 0.03]} />
        <meshStandardMaterial color="#ffffff" roughness={0.4} />
      </mesh>
      <mesh position={[-0.4, 1.75, 0.06]}>
        <boxGeometry args={[0.6, 0.04, 0.01]} />
        <meshStandardMaterial color="#9aa3ad" />
      </mesh>
      <StationLabel pos={[0, 2.28, 0.1]} dot="#a855f7" title="Whiteboard" sub="Notes & Plans" />
    </group>
  );
}

function Kanban() {
  const cols = [0, 1, 2];
  const colColors = ["#1e3a8a", "#155e75", "#3730a3"];
  return (
    <group position={[3.0, 0, -2.95]}>
      <mesh position={[0, 1.5, 0]}>
        <boxGeometry args={[1.9, 1.5, 0.06]} />
        <meshStandardMaterial color="#08263f" emissive="#22d3ee" emissiveIntensity={0.7} roughness={0.3} />
      </mesh>
      {cols.map((c) => (
        <group key={c} position={[(c - 1) * 0.58, 1.5, 0.05]}>
          <mesh>
            <boxGeometry args={[0.5, 1.3, 0.02]} />
            <meshStandardMaterial color={colColors[c]} emissive={colColors[c]} emissiveIntensity={0.45} roughness={0.4} />
          </mesh>
          {[0, 1, 2].map((r) => (
            <mesh key={r} position={[0, 0.42 - r * 0.34, 0.02]}>
              <boxGeometry args={[0.42, 0.24, 0.01]} />
              <meshStandardMaterial color="#dbeafe" emissive="#bfe9ff" emissiveIntensity={0.35} roughness={0.5} />
            </mesh>
          ))}
        </group>
      ))}
      <StationLabel pos={[0, 2.42, 0.1]} dot="#22d3ee" title="Kanban Wall" sub="Backlog · In Progress · Done" />
    </group>
  );
}

function Lounge() {
  return (
    <group position={[-4.0, 0, 1.2]} rotation={[0, Math.PI / 2, 0]}>
      <mesh position={[0, 0.3, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.3, 0.32, 0.95]} />
        <meshStandardMaterial color="#f3f4f8" roughness={0.85} />
      </mesh>
      <mesh position={[0, 0.62, -0.38]} castShadow>
        <boxGeometry args={[1.3, 0.55, 0.22]} />
        <meshStandardMaterial color="#e7e9f0" roughness={0.85} />
      </mesh>
      <mesh position={[-0.6, 0.5, 0]} castShadow>
        <boxGeometry args={[0.18, 0.4, 0.95]} />
        <meshStandardMaterial color="#e7e9f0" roughness={0.85} />
      </mesh>
      <mesh position={[0.6, 0.5, 0]} castShadow>
        <boxGeometry args={[0.18, 0.4, 0.95]} />
        <meshStandardMaterial color="#e7e9f0" roughness={0.85} />
      </mesh>
      <group position={[0.9, 0, 0.4]}>
        <mesh position={[0, 0.25, 0]}>
          <cylinderGeometry args={[0.13, 0.1, 0.5, 14]} />
          <meshStandardMaterial color="#c96f4a" roughness={0.7} />
        </mesh>
        <mesh position={[0, 0.62, 0]}>
          <sphereGeometry args={[0.26, 16, 16]} />
          <meshStandardMaterial color="#4caf6e" roughness={0.7} />
        </mesh>
      </group>
      <StationLabel pos={[0, 1.05, 0.0]} dot="#fb7185" title="Lounge" sub="Break Area" />
    </group>
  );
}

function SecurityGate() {
  return (
    <group position={[2.2, 0, 1.55]} rotation={[0, Math.PI / 2, 0]}>
      {[-0.55, 0.55].map((x) => (
        <mesh key={x} position={[x, 0.5, 0]} castShadow>
          <boxGeometry args={[0.28, 1.0, 0.5]} />
          <meshStandardMaterial color="#c2c8d0" metalness={0.5} roughness={0.4} />
        </mesh>
      ))}
      {[-0.18, 0.0, 0.18].map((y, i) => (
        <mesh key={i} position={[0, 0.62 + y, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.03, 0.03, 0.82, 12]} />
          <meshStandardMaterial color="#9aa3ad" metalness={0.7} roughness={0.3} />
        </mesh>
      ))}
      {[-0.55, 0.55].map((x) => (
        <mesh key={`g${x}`} position={[x, 1.02, 0]}>
          <boxGeometry args={[0.3, 0.04, 0.52]} />
          <meshStandardMaterial color="#22d3ee" emissive="#22d3ee" emissiveIntensity={0.8} />
        </mesh>
      ))}
      <StationLabel pos={[0, 1.4, 0]} dot="#22d3ee" title="Security Gate" sub="Access Control" />
    </group>
  );
}

function Room() {
  return (
    <group>
      <mesh position={[0, -0.2, 0]} receiveShadow>
        <boxGeometry args={[13, 0.4, 10]} />
        <meshStandardMaterial color="#eef1f6" roughness={0.95} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, 0]} receiveShadow>
        <planeGeometry args={[13, 10]} />
        <meshStandardMaterial color="#f4f6fa" roughness={0.95} />
      </mesh>
      <mesh position={[0, 1.1, -3.25]} receiveShadow>
        <boxGeometry args={[11, 2.3, 0.16]} />
        <meshStandardMaterial color="#f7f9fd" roughness={1} />
      </mesh>
      <mesh position={[-5.0, 1.1, 0]} receiveShadow>
        <boxGeometry args={[0.16, 2.3, 6.4]} />
        <meshStandardMaterial color="#eef1f8" roughness={1} />
      </mesh>
      <Vault />
      <Desk />
      <Whiteboard />
      <Kanban />
      <Lounge />
      <SecurityGate />
    </group>
  );
}

function Scene({
  agents,
  activeAgent,
  state,
}: {
  agents: OfficeAgent[];
  activeAgent: string;
  state: string;
}) {
  const status =
    state === "thinking" ? "يفكّر" : state === "speaking" ? "يتكلّم" : state === "listening" ? "يسمع" : null;

  let standIdx = 0;
  const placed = agents.map((a) => {
    const st = STATIONS[a.id];
    if (st) return { agent: a, station: st };
    const pos = STANDING[standIdx % STANDING.length];
    const rotY = Math.PI + (standIdx % 3) * 0.4 - 0.4;
    standIdx++;
    return { agent: a, station: { pos, rotY } as Station };
  });

  return (
    <>
      <SoftShadows size={26} samples={12} focus={0.8} />
      <ambientLight intensity={0.7} />
      <hemisphereLight args={["#ffffff", "#d6dbe6", 0.6]} />
      <directionalLight
        position={[6, 11, 5]}
        intensity={1.15}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-9}
        shadow-camera-right={9}
        shadow-camera-top={9}
        shadow-camera-bottom={-9}
        shadow-bias={-0.0004}
      />
      <directionalLight position={[-6, 7, -3]} intensity={0.3} />

      <Room />

      {placed.map(({ agent, station }) => (
        <Agent
          key={agent.id}
          color={agent.color}
          name={agent.name}
          role={agent.role}
          station={station}
          active={agent.id === activeAgent}
          status={status}
        />
      ))}

      <ContactShadows position={[0, 0.012, 0]} opacity={0.32} scale={18} blur={2.4} far={6} resolution={1024} />
      <OrbitControls
        enablePan={false}
        minDistance={7}
        maxDistance={20}
        minPolarAngle={Math.PI / 7}
        maxPolarAngle={Math.PI / 2.3}
        target={[0, 0.5, 0]}
      />
    </>
  );
}

export default function Office3D({
  agents,
  activeAgent,
  state,
}: {
  agents: OfficeAgent[];
  activeAgent: string;
  state: string;
}) {
  return (
    <div className="min-h-0 w-full flex-1">
      <Canvas shadows orthographic camera={{ position: [9, 8, 9], zoom: 50, near: 0.1, far: 100 }}>
        <color attach="background" args={["#e9edf3"]} />
        <Scene agents={agents} activeAgent={activeAgent} state={state} />
      </Canvas>
    </div>
  );
}
