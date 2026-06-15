"use client";

// مشهد المكتب الآيزومترك 3D (على طريقة "the sims for AI agents"):
// غرفة + أثاث (مكتب/شاشة، خزنة، سبورة، لوحة كانبان، لاونج، بوابة) + الوكلاء
// شخصيات 3D ملوّنة تتمايل، والنشط يضيء ويتحرّك أسرع. Three.js / react-three-fiber.
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, ContactShadows, Html } from "@react-three/drei";
import { useMemo, useRef } from "react";
import * as THREE from "three";

export interface OfficeAgent {
  id: string;
  name: string;
  role: string;
  color: string;
}

// Floor positions for up to ~10 agents, scattered around the room.
const SPOTS: [number, number, number][] = [
  [-2.8, 0, 1.7],
  [-1.3, 0, 0.5],
  [0.1, 0, 1.5],
  [1.5, 0, 0.3],
  [2.8, 0, 1.3],
  [-2.5, 0, -0.9],
  [-0.7, 0, -1.3],
  [1.1, 0, -0.9],
  [2.6, 0, -1.5],
  [0.4, 0, -0.2],
];

function Character({
  spot,
  color,
  name,
  active,
  status,
}: {
  spot: [number, number, number];
  color: string;
  name: string;
  active: boolean;
  status: string | null;
}) {
  const g = useRef<THREE.Group>(null);
  const phase = useMemo(() => Math.random() * Math.PI * 2, []);
  useFrame((s) => {
    if (!g.current) return;
    const t = s.clock.elapsedTime;
    const speed = active ? 3.4 : 1.7;
    const amp = active ? 0.16 : 0.07;
    g.current.position.y = spot[1] + Math.abs(Math.sin(t * speed + phase)) * amp;
    g.current.rotation.y = Math.sin(t * 0.6 + phase) * 0.25;
  });
  const emissive = active ? 0.55 : 0.12;
  return (
    <group ref={g} position={spot} scale={active ? 1.18 : 1}>
      {/* body */}
      <mesh castShadow position={[0, 0.38, 0]}>
        <capsuleGeometry args={[0.22, 0.42, 6, 16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={emissive} roughness={0.35} metalness={0.05} />
      </mesh>
      {/* head */}
      <mesh castShadow position={[0, 0.92, 0]}>
        <sphereGeometry args={[0.21, 24, 24]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={emissive} roughness={0.35} metalness={0.05} />
      </mesh>
      {/* active ground ring */}
      {active ? (
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.32, 0.44, 40]} />
          <meshBasicMaterial color={color} transparent opacity={0.75} side={THREE.DoubleSide} />
        </mesh>
      ) : null}
      {/* name / status label */}
      <Html position={[0, 1.35, 0]} center style={{ pointerEvents: "none" }}>
        <div
          style={{
            whiteSpace: "nowrap",
            fontSize: active ? 12 : 10,
            fontWeight: 700,
            color: "#fff",
            background: active ? color : "rgba(0,0,0,0.45)",
            border: `1px solid ${color}`,
            borderRadius: 999,
            padding: active ? "2px 8px" : "1px 6px",
            textShadow: "0 1px 2px rgba(0,0,0,0.5)",
          }}
        >
          {name}
          {active && status ? ` · ${status}` : ""}
        </div>
      </Html>
    </group>
  );
}

function Label({ pos, text }: { pos: [number, number, number]; text: string }) {
  return (
    <Html position={pos} center style={{ pointerEvents: "none" }}>
      <div
        style={{
          whiteSpace: "nowrap",
          fontSize: 9,
          color: "rgba(255,255,255,0.75)",
          background: "rgba(10,16,32,0.7)",
          border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 6,
          padding: "1px 5px",
        }}
      >
        {text}
      </div>
    </Html>
  );
}

function Room() {
  return (
    <group>
      {/* floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow position={[0, 0, 0]}>
        <planeGeometry args={[12, 10]} />
        <meshStandardMaterial color="#e9edf5" roughness={0.9} />
      </mesh>
      {/* back walls (L-shape, low so the iso view stays open) */}
      <mesh position={[0, 1.3, -3]} receiveShadow>
        <boxGeometry args={[10, 2.6, 0.15]} />
        <meshStandardMaterial color="#f3f6fc" roughness={1} />
      </mesh>
      <mesh position={[-4.5, 1.3, 0]} receiveShadow>
        <boxGeometry args={[0.15, 2.6, 6]} />
        <meshStandardMaterial color="#eef1f8" roughness={1} />
      </mesh>

      {/* Desk + monitor */}
      <mesh position={[-1.4, 0.35, -2.1]} castShadow receiveShadow>
        <boxGeometry args={[1.6, 0.12, 0.8]} />
        <meshStandardMaterial color="#8a5a2b" roughness={0.6} />
      </mesh>
      <mesh position={[-1.4, 0.18, -2.1]}>
        <boxGeometry args={[1.4, 0.36, 0.6]} />
        <meshStandardMaterial color="#6b4423" roughness={0.7} />
      </mesh>
      <mesh position={[-1.4, 0.7, -2.35]} castShadow>
        <boxGeometry args={[0.7, 0.42, 0.05]} />
        <meshStandardMaterial color="#10233f" emissive="#1e63ff" emissiveIntensity={0.5} />
      </mesh>
      <Label pos={[-1.4, 1.1, -2.1]} text="Desk 01" />

      {/* Vault */}
      <mesh position={[-3.3, 0.6, -2.2]} castShadow>
        <boxGeometry args={[1.1, 1.2, 0.8]} />
        <meshStandardMaterial color="#9aa3ad" metalness={0.7} roughness={0.4} />
      </mesh>
      <mesh position={[-3.3, 0.6, -1.78]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.26, 0.26, 0.06, 24]} />
        <meshStandardMaterial color="#cfd6de" metalness={0.8} roughness={0.3} />
      </mesh>
      <Label pos={[-3.3, 1.4, -2.2]} text="Vault" />

      {/* Whiteboard on back wall */}
      <mesh position={[1.3, 1.5, -2.9]}>
        <boxGeometry args={[1.8, 1.1, 0.06]} />
        <meshStandardMaterial color="#ffffff" roughness={0.5} />
      </mesh>
      <Label pos={[1.3, 2.2, -2.9]} text="Whiteboard" />

      {/* Kanban wall (glowing panel) */}
      <mesh position={[3.2, 1.4, -2.88]}>
        <boxGeometry args={[1.5, 1.4, 0.05]} />
        <meshStandardMaterial color="#0b2a4a" emissive="#22d3ee" emissiveIntensity={0.7} />
      </mesh>
      <Label pos={[3.2, 2.25, -2.88]} text="Kanban Wall" />

      {/* Lounge sofa */}
      <mesh position={[-3.4, 0.28, 1.8]} castShadow receiveShadow>
        <boxGeometry args={[1.2, 0.45, 0.9]} />
        <meshStandardMaterial color="#f4f4f7" roughness={0.8} />
      </mesh>
      <mesh position={[-3.4, 0.62, 1.45]}>
        <boxGeometry args={[1.2, 0.45, 0.22]} />
        <meshStandardMaterial color="#e6e8ee" roughness={0.8} />
      </mesh>
      <Label pos={[-3.4, 1.15, 1.8]} text="Lounge" />

      {/* Security gate */}
      <mesh position={[3.1, 0.5, 1.4]} castShadow>
        <boxGeometry args={[0.16, 1, 0.16]} />
        <meshStandardMaterial color="#aeb6bf" metalness={0.6} roughness={0.4} />
      </mesh>
      <mesh position={[3.1, 0.5, 2.2]} castShadow>
        <boxGeometry args={[0.16, 1, 0.16]} />
        <meshStandardMaterial color="#aeb6bf" metalness={0.6} roughness={0.4} />
      </mesh>
      <mesh position={[3.1, 0.92, 1.8]}>
        <boxGeometry args={[0.1, 0.1, 1]} />
        <meshStandardMaterial color="#22d3ee" emissive="#22d3ee" emissiveIntensity={0.6} />
      </mesh>
      <Label pos={[3.1, 1.3, 1.8]} text="Security Gate" />
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
  return (
    <>
      <ambientLight intensity={0.65} />
      <directionalLight
        position={[6, 9, 4]}
        intensity={1.15}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-left={-8}
        shadow-camera-right={8}
        shadow-camera-top={8}
        shadow-camera-bottom={-8}
      />
      <Room />
      {agents.map((a, i) => (
        <Character
          key={a.id}
          spot={SPOTS[i % SPOTS.length]}
          color={a.color}
          name={a.name}
          active={a.id === activeAgent}
          status={status}
        />
      ))}
      <ContactShadows position={[0, 0.01, 0]} opacity={0.35} scale={16} blur={2.2} far={6} />
      <OrbitControls
        enablePan={false}
        minDistance={7}
        maxDistance={18}
        minPolarAngle={Math.PI / 7}
        maxPolarAngle={Math.PI / 2.4}
        target={[0, 0.4, 0]}
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
      <Canvas shadows orthographic camera={{ position: [9, 8, 9], zoom: 52, near: 0.1, far: 100 }}>
        <color attach="background" args={["#0b1020"]} />
        <Scene agents={agents} activeAgent={activeAgent} state={state} />
      </Canvas>
    </div>
  );
}
