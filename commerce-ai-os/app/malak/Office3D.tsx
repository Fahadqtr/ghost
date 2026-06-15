"use client";

// مكتب ملاك الافتراضي 3D — مطابق لمرجع AXIAL ("the sims for managing AI agents"):
// غرفة آيزومترك فاتحة على منصّة سميكة، جدارَان منخفضان، أثاث واقعي (خزنة بقرص،
// مكتب خشب + شاشة + كرسي، سبورة، لوحة كانبان مضيئة بأعمدة وبطاقات، لاونج بكنبة
// ونبتة، بوابة تيرنستايل)، ولافتات بيضاء بنقطة ملوّنة + عنوان + وصف. الشخصيات
// كتل زجاجية لطيفة (جسم + رأس + ذراعان + رِجلان + عيون)، كل وكيل بمحطّته ووضعيّته،
// أحدهم روبوت. الوكيل النشط يضيء ويكبر وله حلقة على الأرض ولافتة بحالته الحيّة.
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, ContactShadows, Html, SoftShadows } from "@react-three/drei";
import { useMemo, useRef } from "react";
import * as THREE from "three";

export interface OfficeAgent {
  id: string;
  name: string;
  role: string;
  color: string;
}

type Pose = "idle" | "sit" | "wave" | "point";

interface Station {
  pos: [number, number, number];
  rotY: number;
  pose: Pose;
  robot?: boolean;
}

// محطّات ثابتة لبعض الوكلاء (مطابقة لوضعيات المرجع)، والباقي يقف ويتمايل.
const STATIONS: Record<string, Station> = {
  malak: { pos: [-0.85, 0, 0.35], rotY: Math.PI, pose: "sit" }, // المكتب، يجلس مواجهًا الشاشة
  noor: { pos: [0.35, 0, -1.75], rotY: 0, pose: "wave" }, // عند السبورة، يد مرفوعة
  bayan: { pos: [2.55, 0, -1.25], rotY: -0.55, pose: "point" }, // عند الكانبان، يشير
  latifa: { pos: [-4.05, 0, 1.2], rotY: Math.PI / 2, pose: "sit" }, // اللاونج، يجلس على الكنبة
  faisal: { pos: [2.15, 0, 1.55], rotY: Math.PI * 0.86, pose: "wave", robot: true }, // الروبوت عند البوابة
};

// مواقع الوقوف لبقية الوكلاء (idle)، بالترتيب.
const STANDING: [number, number, number][] = [
  [-2.3, 0, 0.8],
  [-1.0, 0, 1.7],
  [0.7, 0, 1.15],
  [1.7, 0, 0.25],
  [-2.9, 0, -0.55],
  [0.0, 0, 0.0],
];

// ---- Glossy material helper ------------------------------------------------
function bodyMat(color: string, emissive: number) {
  return (
    <meshStandardMaterial
      color={color}
      emissive={color}
      emissiveIntensity={emissive}
      roughness={0.42}
      metalness={0.04}
    />
  );
}

// طرف (ذراع/رجل): مجموعة محورها الكتف/الورك، والكبسولة تتدلّى لأسفل فتدور حول المحور.
function Limb({
  base,
  rot,
  len,
  radius,
  color,
  emissive,
}: {
  base: [number, number, number];
  rot: [number, number, number];
  len: number;
  radius: number;
  color: string;
  emissive: number;
}) {
  return (
    <group position={base} rotation={rot}>
      <mesh castShadow position={[0, -len / 2, 0]}>
        <capsuleGeometry args={[radius, len, 4, 10]} />
        {bodyMat(color, emissive)}
      </mesh>
      {/* hand / foot */}
      <mesh castShadow position={[0, -len - radius * 0.4, 0]}>
        <sphereGeometry args={[radius * 1.15, 12, 12]} />
        {bodyMat(color, emissive)}
      </mesh>
    </group>
  );
}

const POSE_ARMS: Record<Pose, { l: [number, number, number]; r: [number, number, number] }> = {
  idle: { l: [0, 0, 0.22], r: [0, 0, -0.22] },
  sit: { l: [-0.5, 0, 0.18], r: [-0.5, 0, -0.18] },
  wave: { l: [0, 0, 0.2], r: [0, 0, -2.6] }, // الذراع اليمنى مرفوعة للأعلى/الخارج
  point: { l: [0, 0, 0.2], r: [-1.5, 0, -0.1] }, // الذراع اليمنى للأمام
};
const POSE_LEGS: Record<Pose, [number, number, number]> = {
  idle: [0, 0, 0],
  sit: [-1.45, 0, 0], // الفخذان للأمام أفقيًا (جلوس)
  wave: [0, 0, 0],
  point: [0, 0, 0],
};

function Person({
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
  const g = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const phase = useMemo(() => Math.random() * Math.PI * 2, []);
  const pose = station.pose;
  const sitting = pose === "sit";
  const baseY = sitting ? station.pos[1] + 0.16 : station.pos[1];
  const emissive = active ? 0.5 : 0.1;

  useFrame((s) => {
    if (!g.current) return;
    const t = s.clock.elapsedTime;
    if (!sitting) {
      const sp = active ? 3.2 : 1.6;
      const amp = active ? 0.08 : 0.035;
      g.current.position.y = baseY + Math.abs(Math.sin(t * sp + phase)) * amp;
      g.current.rotation.y = station.rotY + Math.sin(t * 0.5 + phase) * (active ? 0.18 : 0.1);
    }
    // تلويح اليد عند wave
    if (armR.current && pose === "wave") {
      armR.current.rotation.x = Math.sin(t * (active ? 6 : 3) + phase) * 0.35;
    }
  });

  const arms = POSE_ARMS[pose];
  const legRot = POSE_LEGS[pose];

  return (
    <group
      ref={g}
      position={[station.pos[0], baseY, station.pos[2]]}
      rotation={[0, station.rotY, 0]}
      scale={active ? 1.16 : 1}
    >
      {/* legs */}
      <Limb base={[0.13, 0.4, sitting ? 0.05 : 0]} rot={legRot} len={0.32} radius={0.1} color={color} emissive={emissive} />
      <Limb base={[-0.13, 0.4, sitting ? 0.05 : 0]} rot={legRot} len={0.32} radius={0.1} color={color} emissive={emissive} />

      {/* torso (rounded blob) */}
      <mesh castShadow position={[0, 0.66, 0]} scale={[1, 1.05, 0.9]}>
        <capsuleGeometry args={[0.27, 0.3, 6, 18]} />
        {bodyMat(color, emissive)}
      </mesh>

      {/* arms */}
      <Limb base={[0.3, 0.82, 0]} rot={arms.l} len={0.34} radius={0.082} color={color} emissive={emissive} />
      <group ref={armR} position={[-0.3, 0.82, 0]} rotation={arms.r}>
        <mesh castShadow position={[0, -0.17, 0]}>
          <capsuleGeometry args={[0.082, 0.34, 4, 10]} />
          {bodyMat(color, emissive)}
        </mesh>
        <mesh castShadow position={[0, -0.37, 0]}>
          <sphereGeometry args={[0.094, 12, 12]} />
          {bodyMat(color, emissive)}
        </mesh>
      </group>

      {/* head */}
      {station.robot ? (
        <group position={[0, 1.18, 0]}>
          <mesh castShadow>
            <boxGeometry args={[0.42, 0.36, 0.34]} />
            <meshStandardMaterial
              color={color}
              roughness={0.3}
              metalness={0.25}
              emissive={color}
              emissiveIntensity={emissive}
            />
          </mesh>
          {/* visor */}
          <mesh position={[0, 0.02, 0.18]}>
            <boxGeometry args={[0.32, 0.16, 0.04]} />
            <meshStandardMaterial color="#0b1020" emissive="#22d3ee" emissiveIntensity={0.9} roughness={0.2} />
          </mesh>
          {/* eyes on visor */}
          <mesh position={[-0.07, 0.02, 0.205]}>
            <sphereGeometry args={[0.028, 10, 10]} />
            <meshBasicMaterial color="#bff7ff" />
          </mesh>
          <mesh position={[0.07, 0.02, 0.205]}>
            <sphereGeometry args={[0.028, 10, 10]} />
            <meshBasicMaterial color="#bff7ff" />
          </mesh>
          {/* antenna */}
          <mesh position={[0, 0.27, 0]}>
            <cylinderGeometry args={[0.012, 0.012, 0.16, 8]} />
            <meshStandardMaterial color="#9aa3ad" metalness={0.6} roughness={0.3} />
          </mesh>
          <mesh position={[0, 0.37, 0]}>
            <sphereGeometry args={[0.04, 12, 12]} />
            <meshStandardMaterial color="#ff5577" emissive="#ff5577" emissiveIntensity={0.9} />
          </mesh>
        </group>
      ) : (
        <group position={[0, 1.16, 0]}>
          <mesh castShadow>
            <sphereGeometry args={[0.235, 28, 28]} />
            {bodyMat(color, emissive)}
          </mesh>
          {/* eyes */}
          <mesh position={[-0.08, 0.02, 0.2]}>
            <sphereGeometry args={[0.032, 12, 12]} />
            <meshBasicMaterial color="#0b1020" />
          </mesh>
          <mesh position={[0.08, 0.02, 0.2]}>
            <sphereGeometry args={[0.032, 12, 12]} />
            <meshBasicMaterial color="#0b1020" />
          </mesh>
        </group>
      )}

      {/* active ground ring */}
      {active ? (
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.4, 0.55, 48]} />
          <meshBasicMaterial color={color} transparent opacity={0.7} side={THREE.DoubleSide} />
        </mesh>
      ) : null}

      {/* name / status pill */}
      <Html position={[0, station.robot ? 1.62 : 1.58, 0]} center distanceFactor={9} style={{ pointerEvents: "none" }}>
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

// لافتة محطّة بيضاء: نقطة ملوّنة + عنوان + وصف (مثل المرجع).
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
    <group position={[-3.7, 0, -2.15]} rotation={[0, 0.35, 0]}>
      <mesh position={[0, 0.7, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.15, 1.4, 0.95]} />
        <meshStandardMaterial color="#aeb6c0" metalness={0.75} roughness={0.35} />
      </mesh>
      {/* door inset */}
      <mesh position={[0, 0.7, 0.49]}>
        <boxGeometry args={[0.92, 1.16, 0.04]} />
        <meshStandardMaterial color="#cfd5dd" metalness={0.6} roughness={0.4} />
      </mesh>
      {/* dial */}
      <mesh position={[0.18, 0.7, 0.53]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.2, 0.2, 0.07, 28]} />
        <meshStandardMaterial color="#e9edf3" metalness={0.85} roughness={0.25} />
      </mesh>
      <mesh position={[0.18, 0.7, 0.58]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.05, 0.05, 0.06, 16]} />
        <meshStandardMaterial color="#5b6472" metalness={0.7} roughness={0.3} />
      </mesh>
      {/* handle */}
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
    <group position={[-0.85, 0, -0.6]}>
      {/* top */}
      <mesh position={[0, 0.74, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.9, 0.1, 0.95]} />
        <meshStandardMaterial color="#9c6b3c" roughness={0.55} metalness={0.05} />
      </mesh>
      {/* pedestal */}
      <mesh position={[0.6, 0.37, 0]} castShadow>
        <boxGeometry args={[0.6, 0.74, 0.9]} />
        <meshStandardMaterial color="#7c4f28" roughness={0.6} />
      </mesh>
      {/* left leg */}
      <mesh position={[-0.82, 0.37, 0]} castShadow>
        <boxGeometry args={[0.08, 0.74, 0.85]} />
        <meshStandardMaterial color="#7c4f28" roughness={0.6} />
      </mesh>
      {/* monitor */}
      <mesh position={[0, 0.92, -0.34]}>
        <boxGeometry args={[0.12, 0.12, 0.12]} />
        <meshStandardMaterial color="#2a2f3a" roughness={0.5} />
      </mesh>
      <mesh position={[0, 1.18, -0.36]} castShadow>
        <boxGeometry args={[0.92, 0.54, 0.05]} />
        <meshStandardMaterial color="#0e1626" emissive="#2563eb" emissiveIntensity={0.55} roughness={0.3} />
      </mesh>
      {/* keyboard */}
      <mesh position={[0, 0.8, 0.15]}>
        <boxGeometry args={[0.5, 0.03, 0.18]} />
        <meshStandardMaterial color="#3a3f4b" roughness={0.6} />
      </mesh>
      {/* office chair */}
      <group position={[0, 0, 0.85]}>
        <mesh position={[0, 0.44, 0]} castShadow>
          <boxGeometry args={[0.5, 0.1, 0.5]} />
          <meshStandardMaterial color="#2b3140" roughness={0.6} />
        </mesh>
        <mesh position={[0, 0.74, 0.24]} castShadow>
          <boxGeometry args={[0.5, 0.55, 0.1]} />
          <meshStandardMaterial color="#2b3140" roughness={0.6} />
        </mesh>
        <mesh position={[0, 0.24, 0]}>
          <cylinderGeometry args={[0.05, 0.05, 0.4, 12]} />
          <meshStandardMaterial color="#9aa3ad" metalness={0.6} roughness={0.4} />
        </mesh>
        <mesh position={[0, 0.05, 0]}>
          <cylinderGeometry args={[0.3, 0.3, 0.06, 20]} />
          <meshStandardMaterial color="#3a3f4b" metalness={0.4} roughness={0.5} />
        </mesh>
      </group>
      {/* small plant */}
      <group position={[-0.78, 0.84, -0.28]}>
        <mesh>
          <cylinderGeometry args={[0.08, 0.06, 0.12, 12]} />
          <meshStandardMaterial color="#c96f4a" roughness={0.7} />
        </mesh>
        <mesh position={[0, 0.14, 0]}>
          <sphereGeometry args={[0.12, 14, 14]} />
          <meshStandardMaterial color="#4caf6e" roughness={0.7} />
        </mesh>
      </group>
      <StationLabel pos={[0, 0.5, 1.0]} dot="#2563eb" title="Desk 01" sub="Active Compute" />
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
      {/* faint marks */}
      <mesh position={[-0.4, 1.75, 0.06]}>
        <boxGeometry args={[0.6, 0.04, 0.01]} />
        <meshStandardMaterial color="#9aa3ad" />
      </mesh>
      <mesh position={[-0.2, 1.55, 0.06]}>
        <boxGeometry args={[0.9, 0.04, 0.01]} />
        <meshStandardMaterial color="#c4cad4" />
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
      {/* glowing backing */}
      <mesh position={[0, 1.5, 0]}>
        <boxGeometry args={[1.9, 1.5, 0.06]} />
        <meshStandardMaterial color="#08263f" emissive="#22d3ee" emissiveIntensity={0.7} roughness={0.3} />
      </mesh>
      {/* columns + cards */}
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
    <group position={[-4.1, 0, 1.2]} rotation={[0, Math.PI / 2, 0]}>
      {/* seat */}
      <mesh position={[0, 0.3, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.3, 0.32, 0.95]} />
        <meshStandardMaterial color="#f3f4f8" roughness={0.85} />
      </mesh>
      {/* back */}
      <mesh position={[0, 0.62, -0.38]} castShadow>
        <boxGeometry args={[1.3, 0.55, 0.22]} />
        <meshStandardMaterial color="#e7e9f0" roughness={0.85} />
      </mesh>
      {/* arms */}
      <mesh position={[-0.6, 0.5, 0]} castShadow>
        <boxGeometry args={[0.18, 0.4, 0.95]} />
        <meshStandardMaterial color="#e7e9f0" roughness={0.85} />
      </mesh>
      <mesh position={[0.6, 0.5, 0]} castShadow>
        <boxGeometry args={[0.18, 0.4, 0.95]} />
        <meshStandardMaterial color="#e7e9f0" roughness={0.85} />
      </mesh>
      {/* plant beside */}
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
      {/* two cabinets */}
      {[-0.55, 0.55].map((x) => (
        <mesh key={x} position={[x, 0.5, 0]} castShadow>
          <boxGeometry args={[0.28, 1.0, 0.5]} />
          <meshStandardMaterial color="#c2c8d0" metalness={0.5} roughness={0.4} />
        </mesh>
      ))}
      {/* turnstile arms */}
      {[-0.18, 0.0, 0.18].map((y, i) => (
        <mesh key={i} position={[0, 0.62 + y, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.03, 0.03, 0.82, 12]} />
          <meshStandardMaterial color="#9aa3ad" metalness={0.7} roughness={0.3} />
        </mesh>
      ))}
      {/* glow strips */}
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
      {/* thick floor slab (platform) */}
      <mesh position={[0, -0.2, 0]} receiveShadow>
        <boxGeometry args={[13, 0.4, 10]} />
        <meshStandardMaterial color="#eef1f6" roughness={0.95} />
      </mesh>
      {/* floor top (lighter, receives shadows) */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, 0]} receiveShadow>
        <planeGeometry args={[13, 10]} />
        <meshStandardMaterial color="#f4f6fa" roughness={0.95} />
      </mesh>
      {/* low back wall */}
      <mesh position={[0, 1.1, -3.25]} receiveShadow>
        <boxGeometry args={[11, 2.3, 0.16]} />
        <meshStandardMaterial color="#f7f9fd" roughness={1} />
      </mesh>
      {/* low left wall */}
      <mesh position={[-5.0, 1.1, 0]} receiveShadow>
        <boxGeometry args={[0.16, 2.3, 6.4]} />
        <meshStandardMaterial color="#eef1f8" roughness={1} />
      </mesh>
      {/* glass top strip on back wall (subtle) */}
      <mesh position={[0, 2.45, -3.25]}>
        <boxGeometry args={[11, 0.5, 0.05]} />
        <meshStandardMaterial color="#cfe6ff" transparent opacity={0.25} roughness={0.1} metalness={0.1} />
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

  // وزّع الوكلاء: من له محطّة يأخذها، والباقي يقف بالترتيب.
  let standIdx = 0;
  const placed = agents.map((a) => {
    const st = STATIONS[a.id];
    if (st) return { agent: a, station: st };
    const pos = STANDING[standIdx % STANDING.length];
    const rotY = Math.PI + (standIdx % 3) * 0.4 - 0.4;
    standIdx++;
    return { agent: a, station: { pos, rotY, pose: "idle" as Pose } };
  });

  return (
    <>
      <SoftShadows size={26} samples={12} focus={0.8} />
      <ambientLight intensity={0.72} />
      <hemisphereLight args={["#ffffff", "#d6dbe6", 0.6]} />
      <directionalLight
        position={[6, 11, 5]}
        intensity={1.1}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-9}
        shadow-camera-right={9}
        shadow-camera-top={9}
        shadow-camera-bottom={-9}
        shadow-bias={-0.0004}
      />
      <directionalLight position={[-6, 7, -3]} intensity={0.32} />

      <Room />

      {placed.map(({ agent, station }) => (
        <Person
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
