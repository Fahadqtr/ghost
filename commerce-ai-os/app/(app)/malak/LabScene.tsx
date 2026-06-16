"use client";

// "مركز قيادة ملاك" — مشهد 3D إجرائي (Three.js نقي) على طراز AI Command Center:
// أرضية navy غامقة + خطوط نيون متوهّجة، مكتب قيادة مركزي بدماغ هولوغرافي، و6 شاشات
// جدارية لكل قسم (الكتالوج/الصور/المنصّات/المخزون/التسويق/العملاء) مع روبوت كيوت لكل
// وكيل في محطته. كاميرا تدور بالسحب، نقر يختار الوكيل. نفس واجهة Office3D
// (agents, activeAgent, state, onSelect) — لا يلمس المحادثة.

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

export interface OfficeAgent {
  id: string;
  name: string;
  role: string;
  color: string;
}

const HINT = "اسحب للدوران · قرّب بإصبعين · انقر وكيل";

// زون كل وكيل: العنوان العربي + الاسم الإنجليزي على الشاشة الجدارية.
const ZONE_META: Record<string, { ar: string; en: string }> = {
  noor: { ar: "الكتالوج", en: "CATALOG" },
  reem: { ar: "الصور والمحتوى", en: "CREATIVE" },
  siraj: { ar: "المنصّات", en: "CHANNELS" },
  razan: { ar: "الأسعار والمخزون", en: "INVENTORY" },
  rashid: { ar: "التسويق والتقارير", en: "MARKETING" },
  latifa: { ar: "العملاء", en: "SUPPORT" },
};

export default function Office3D({
  agents,
  activeAgent,
  state,
  onSelect,
}: {
  agents: OfficeAgent[];
  activeAgent: string;
  state: string;
  onSelect?: (id: string) => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef(activeAgent);
  const stateRef = useRef(state);
  const onSelectRef = useRef(onSelect);
  const lifeRef = useRef(true);
  const [lifeOn, setLifeOn] = useState(true);
  activeRef.current = activeAgent;
  stateRef.current = state;
  onSelectRef.current = onSelect;
  lifeRef.current = lifeOn;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let raf = 0;
    const W = () => mount.clientWidth || 800;
    const H = () => mount.clientHeight || 500;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070b18);
    scene.fog = new THREE.Fog(0x070b18, 18, 46);

    const camera = new THREE.PerspectiveCamera(42, W() / H(), 0.1, 100);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(W(), H());
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.touchAction = "none";

    const clock = new THREE.Clock();
    let elapsed = 0;
    // Responsive framing (close on phones, pulled back on wide desktop).
    const baseRadiusFor = (aspect: number) =>
      Math.max(12.5, Math.min(12.5 + Math.max(0, aspect - 1.2) * 4.4, 19));
    const focusRadiusFor = (aspect: number) => Math.max(8.5, baseRadiusFor(aspect) * 0.72);
    let camTheta = Math.PI * 0.5, camPhi = Math.PI * 0.4, camRadius = baseRadiusFor(W() / H());
    let manualZoom = false;
    const camTarget = new THREE.Vector3(0, 1.0, 0);
    let focusActive = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const robots: Record<string, any> = {};

    // ---- specialists (Malak is the centre commander) ----
    const specialists = agents.filter((a) => a.id !== "malak");
    const malak = agents.find((a) => a.id === "malak") ?? agents[0];

    // Station + wall-panel layout: a wide U around the central command desk.
    // [x, z] for the desk; wall panel sits just behind, angled to face centre.
    const STATIONS: { x: number; z: number; rot: number }[] = [
      { x: -6.2, z: -2.6, rot: Math.PI * 0.5 },   // left-back
      { x: -3.6, z: -5.4, rot: Math.PI * 0.16 },  // back-left
      { x: 3.6, z: -5.4, rot: -Math.PI * 0.16 },  // back-right
      { x: 6.2, z: -2.6, rot: -Math.PI * 0.5 },   // right-back
      { x: -6.2, z: 2.6, rot: Math.PI * 0.5 },    // left-front
      { x: 6.2, z: 2.6, rot: -Math.PI * 0.5 },    // right-front
    ];

    // ---- shared materials ----
    const metalMat = () => new THREE.MeshStandardMaterial({ color: 0x6b7690, roughness: 0.42, metalness: 0.55 });
    const darkMetal = () => new THREE.MeshStandardMaterial({ color: 0x1a2238, roughness: 0.5, metalness: 0.5 });
    const neon = (c: THREE.ColorRepresentation, i = 1.8) =>
      new THREE.MeshStandardMaterial({ color: new THREE.Color(c), emissive: new THREE.Color(c), emissiveIntensity: i, roughness: 0.3 });

    // ---- lights ----
    scene.add(new THREE.HemisphereLight(0x9fc0ff, 0x0a1024, 0.85));
    const key = new THREE.DirectionalLight(0xdfeaff, 1.5);
    key.position.set(5, 14, 8); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1; key.shadow.camera.far = 44;
    key.shadow.camera.left = -13; key.shadow.camera.right = 13; key.shadow.camera.top = 13; key.shadow.camera.bottom = -13;
    key.shadow.bias = -0.0004; key.shadow.radius = 7;
    scene.add(key);
    const cyanFill = new THREE.PointLight(0x35d0ff, 0.9, 30); cyanFill.position.set(-7, 5, 5); scene.add(cyanFill);
    const purpleFill = new THREE.PointLight(0x9b6bff, 0.9, 30); purpleFill.position.set(7, 5, 5); scene.add(purpleFill);
    const centreGlow = new THREE.PointLight(0x6cf0ff, 1.4, 16); centreGlow.position.set(0, 3.2, 0); scene.add(centreGlow);

    // ---- floor ----
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(26, 0.4, 22),
      new THREE.MeshStandardMaterial({ color: 0x0c1326, roughness: 0.55, metalness: 0.35 })
    );
    floor.position.y = -0.2; floor.receiveShadow = true; scene.add(floor);
    const grid = new THREE.GridHelper(26, 52, 0x1c2c4a, 0x141f38);
    grid.position.y = 0.011; (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.5; scene.add(grid);

    // back + side walls (low, dark)
    const wMat = new THREE.MeshStandardMaterial({ color: 0x0b1326, roughness: 0.85, metalness: 0.2 });
    const backWall = new THREE.Mesh(new THREE.BoxGeometry(26, 6, 0.4), wMat); backWall.position.set(0, 2.6, -7.2); backWall.receiveShadow = true; scene.add(backWall);
    const leftWall = new THREE.Mesh(new THREE.BoxGeometry(0.4, 6, 22), wMat); leftWall.position.set(-8.4, 2.6, 0); leftWall.receiveShadow = true; scene.add(leftWall);
    const rightWall = new THREE.Mesh(new THREE.BoxGeometry(0.4, 6, 22), wMat); rightWall.position.set(8.4, 2.6, 0); rightWall.receiveShadow = true; scene.add(rightWall);

    // ---- neon floor circuit lines: centre ring + spokes to each station ----
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.5, 2.72, 72), neon(0x39d0ff, 1.6));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02; (ring.material as THREE.Material).side = THREE.DoubleSide; scene.add(ring);
    const ring2 = new THREE.Mesh(new THREE.RingGeometry(3.1, 3.18, 72), neon(0x7b5bff, 1.1));
    ring2.rotation.x = -Math.PI / 2; ring2.position.y = 0.02; (ring2.material as THREE.Material).side = THREE.DoubleSide; scene.add(ring2);

    const neonPath = (x: number, z: number, color: THREE.ColorRepresentation) => {
      const r0 = Math.hypot(x, z) || 1;
      const sx = (x / r0) * 2.6, sz = (z / r0) * 2.6; // start at the centre ring
      const midX = x; // elbow: go along Z first, then X
      // two-segment elbow path from the ring out to the station
      const seg = (ax: number, az: number, bx: number, bz: number) => {
        const dx = bx - ax, dz = bz - az; const len = Math.hypot(dx, dz);
        if (len < 0.05) return;
        const bar = new THREE.Mesh(new THREE.BoxGeometry(len, 0.04, 0.12), neon(color, 1.7));
        bar.position.set((ax + bx) / 2, 0.03, (az + bz) / 2);
        bar.rotation.y = -Math.atan2(dz, dx);
        scene.add(bar);
      };
      seg(sx, sz, midX, sz);
      seg(midX, sz, x, z);
      const node = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.05, 18), neon(color, 1.9));
      node.position.set(x, 0.03, z); scene.add(node);
    };

    // ---- canvas dashboard texture for the wall screens ----
    const dashTexture = (ar: string, en: string, hex: number) => {
      const c = document.createElement("canvas"); c.width = 512; c.height = 320;
      const ctx = c.getContext("2d")!;
      const col = "#" + hex.toString(16).padStart(6, "0");
      // bg
      const g = ctx.createLinearGradient(0, 0, 0, 320);
      g.addColorStop(0, "#0d1730"); g.addColorStop(1, "#0a1124");
      ctx.fillStyle = g; ctx.fillRect(0, 0, 512, 320);
      ctx.strokeStyle = col + ""; ctx.globalAlpha = 0.5; ctx.lineWidth = 4; ctx.strokeRect(6, 6, 500, 308); ctx.globalAlpha = 1;
      // header
      ctx.fillStyle = col; ctx.fillRect(0, 0, 512, 58);
      ctx.fillStyle = "#061024"; ctx.font = "bold 30px sans-serif"; ctx.textAlign = "right";
      ctx.fillText(en, 492, 40);
      ctx.fillStyle = "#0a1530"; ctx.font = "bold 22px sans-serif"; ctx.textAlign = "left";
      ctx.fillText(ar, 20, 39);
      // big stat
      ctx.fillStyle = "#ffffff"; ctx.font = "bold 64px sans-serif"; ctx.textAlign = "left";
      ctx.fillText(String(120 + Math.floor(Math.random() * 880)), 28, 150);
      ctx.fillStyle = col; ctx.font = "bold 22px sans-serif";
      ctx.fillText("● ACTIVE", 28, 182);
      // bar chart
      const bx = 250, bw = 30, bgap = 38;
      for (let i = 0; i < 6; i++) {
        const h = 30 + Math.random() * 110;
        ctx.fillStyle = i === 5 ? col : "rgba(255,255,255,0.25)";
        ctx.fillRect(bx + i * bgap, 250 - h, bw, h);
      }
      // sparkline
      ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.beginPath();
      for (let i = 0; i <= 30; i++) { const x = 24 + i * 6.6; const y = 250 - (40 + Math.sin(i * 0.6) * 22 + Math.random() * 10); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.stroke();
      const tex = new THREE.CanvasTexture(c); tex.needsUpdate = true; tex.anisotropy = 4; return tex;
    };

    // ---- wall dashboard panel ----
    const makeWallPanel = (ar: string, en: string, hex: number) => {
      const g = new THREE.Group();
      const frame = new THREE.Mesh(new THREE.BoxGeometry(2.7, 1.75, 0.12), new THREE.MeshStandardMaterial({ color: 0x141d34, roughness: 0.4, metalness: 0.5 }));
      g.add(frame);
      const screen = new THREE.Mesh(
        new THREE.BoxGeometry(2.5, 1.55, 0.04),
        new THREE.MeshStandardMaterial({ map: dashTexture(ar, en, hex), emissive: new THREE.Color(hex), emissiveIntensity: 0.35, emissiveMap: dashTexture(ar, en, hex), roughness: 0.3 })
      );
      screen.position.z = 0.08; g.add(screen);
      // glow trim
      const trim = new THREE.Mesh(new THREE.BoxGeometry(2.74, 0.06, 0.14), neon(hex, 1.4));
      trim.position.y = -0.9; g.add(trim);
      return g;
    };

    // ---- station desk (per agent) ----
    const makeDesk = (hex: number) => {
      const g = new THREE.Group();
      const top = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.1, 0.85), darkMetal()); top.position.y = 0.74; top.castShadow = true; top.receiveShadow = true; g.add(top);
      const front = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.66, 0.12), new THREE.MeshStandardMaterial({ color: 0x121a30, roughness: 0.5, metalness: 0.4 })); front.position.set(0, 0.4, 0.36); g.add(front);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.04, 0.04), neon(hex, 1.6)); strip.position.set(0, 0.55, 0.43); g.add(strip);
      // angled holo screen on the desk
      const scr = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.6, 0.03), new THREE.MeshStandardMaterial({ color: 0x0a1430, emissive: new THREE.Color(hex), emissiveIntensity: 0.8, roughness: 0.3, transparent: true, opacity: 0.92 }));
      scr.position.set(0, 1.16, -0.18); scr.rotation.x = -0.18; g.add(scr);
      const stand = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.2, 0.05), metalMat()); stand.position.set(0, 0.9, -0.18); g.add(stand);
      for (let i = 0; i < 3; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.02), neon(hex, 1.2)); b.position.set(-0.3 + i * 0.3, 1.16 + (i % 2 ? 0.08 : -0.08), -0.16); g.add(b); }
      return g;
    };

    // ---- central command desk + holographic brain ----
    const centreGroup = new THREE.Group(); scene.add(centreGroup);
    {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(2.35, 2.6, 0.3, 48), new THREE.MeshStandardMaterial({ color: 0x121b34, roughness: 0.5, metalness: 0.45 }));
      base.position.y = 0.15; base.castShadow = true; base.receiveShadow = true; centreGroup.add(base);
      const baseRim = new THREE.Mesh(new THREE.TorusGeometry(2.45, 0.05, 14, 64), neon(0x39d0ff, 1.7)); baseRim.rotation.x = -Math.PI / 2; baseRim.position.y = 0.31; centreGroup.add(baseRim);
      // console ring (curved control desk)
      const consoleRing = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 0.5, 40, 1, true, 0, Math.PI * 2), new THREE.MeshStandardMaterial({ color: 0x18223c, roughness: 0.45, metalness: 0.5, side: THREE.DoubleSide }));
      consoleRing.position.y = 0.62; centreGroup.add(consoleRing);
      const consoleTop = new THREE.Mesh(new THREE.TorusGeometry(1.7, 0.16, 16, 48), new THREE.MeshStandardMaterial({ color: 0x1d2845, roughness: 0.4, metalness: 0.5 })); consoleTop.rotation.x = -Math.PI / 2; consoleTop.position.y = 0.88; centreGroup.add(consoleTop);
      const consoleGlow = new THREE.Mesh(new THREE.TorusGeometry(1.7, 0.05, 12, 48), neon(0x6cf0ff, 1.4)); consoleGlow.rotation.x = -Math.PI / 2; consoleGlow.position.y = 1.0; centreGroup.add(consoleGlow);
      // "AI COMMAND CENTER" front sign
      const sc = document.createElement("canvas"); sc.width = 512; sc.height = 160;
      const sx = sc.getContext("2d")!;
      sx.fillStyle = "#0a1430"; sx.fillRect(0, 0, 512, 160);
      sx.strokeStyle = "#39d0ff"; sx.lineWidth = 4; sx.strokeRect(6, 6, 500, 148);
      sx.fillStyle = "#ffffff"; sx.font = "bold 40px sans-serif"; sx.textAlign = "center";
      sx.fillText("AI COMMAND CENTER", 256, 66);
      sx.fillStyle = "#7fe6ff"; sx.font = "bold 30px sans-serif";
      sx.fillText("مركز قيادة ملاك", 256, 116);
      const signTex = new THREE.CanvasTexture(sc); signTex.needsUpdate = true;
      const sign = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.75, 0.08), new THREE.MeshStandardMaterial({ map: signTex, emissive: 0x2aa6ff, emissiveIntensity: 0.5, emissiveMap: signTex, roughness: 0.3 }));
      sign.position.set(0, 0.62, 1.78); centreGroup.add(sign);
    }

    // holographic brain (floating above the centre)
    const brain = new THREE.Group(); brain.position.set(0, 2.95, 0); centreGroup.add(brain);
    const brainCore = new THREE.Mesh(new THREE.IcosahedronGeometry(0.62, 1), new THREE.MeshStandardMaterial({ color: 0x6cf0ff, emissive: 0x39d0ff, emissiveIntensity: 1.4, transparent: true, opacity: 0.55, roughness: 0.2 }));
    brain.add(brainCore);
    const brainWire = new THREE.Mesh(new THREE.IcosahedronGeometry(0.7, 1), new THREE.MeshBasicMaterial({ color: 0x9fefff, wireframe: true, transparent: true, opacity: 0.6 }));
    brain.add(brainWire);
    const halo1 = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.018, 10, 64), neon(0x39d0ff, 1.6)); halo1.rotation.x = Math.PI / 2.4; brain.add(halo1);
    const halo2 = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.016, 10, 64), neon(0x9b6bff, 1.4)); halo2.rotation.x = Math.PI / 1.7; halo2.rotation.y = 0.6; brain.add(halo2);
    const brainBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.5, 1.9, 24, 1, true), new THREE.MeshBasicMaterial({ color: 0x39d0ff, transparent: true, opacity: 0.12, side: THREE.DoubleSide }));
    brainBeam.position.y = -1.4; brain.add(brainBeam);

    // ---- décor: plants, holo cylinders, robotic arm ----
    const addPlant = (x: number, z: number) => {
      const g = new THREE.Group(); g.position.set(x, 0, z);
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.17, 0.34, 18), new THREE.MeshStandardMaterial({ color: 0x223052, roughness: 0.6, metalness: 0.3 })); pot.position.y = 0.17; pot.castShadow = true; g.add(pot);
      for (let i = 0; i < 5; i++) { const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 12), new THREE.MeshStandardMaterial({ color: 0x3fae72, roughness: 0.7 })); leaf.scale.set(0.5, 1.1, 0.5); leaf.position.set((Math.random() - 0.5) * 0.22, 0.5 + Math.random() * 0.24, (Math.random() - 0.5) * 0.22); leaf.rotation.z = (Math.random() - 0.5) * 0.6; leaf.castShadow = true; g.add(leaf); }
      scene.add(g);
    };
    addPlant(-7.6, 4.4); addPlant(7.6, 4.4);

    const holoCyl = (x: number, z: number, color: number) => {
      const g = new THREE.Group(); g.position.set(x, 0, z);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 0.12, 20), darkMetal()); base.position.y = 0.06; g.add(base);
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.7, 24, 1, true), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, side: THREE.DoubleSide })); tube.position.y = 0.46; g.add(tube);
      const inner = new THREE.Mesh(new THREE.IcosahedronGeometry(0.18, 0), neon(color, 1.4)); inner.position.y = 0.46; g.add(inner);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.02, 8, 32), neon(color, 1.6)); rim.rotation.x = Math.PI / 2; rim.position.y = 0.12; g.add(rim);
      scene.add(g);
      return inner;
    };
    const hc1 = holoCyl(3.4, 4.7, 0x39d0ff);
    const hc2 = holoCyl(-3.4, 4.7, 0xec6bff);

    // small wheeled delivery bot (front-left)
    const deliveryBot = new THREE.Group(); deliveryBot.position.set(-2.0, 0, 5.4); scene.add(deliveryBot);
    {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.22, 0.95), metalMat()); body.position.y = 0.28; body.castShadow = true; deliveryBot.add(body);
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.1, 0.02), neon(0x6cf0ff, 1.8)); eye.position.set(0, 0.32, 0.49); deliveryBot.add(eye);
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshStandardMaterial({ color: 0xc79a5e, roughness: 0.8 })); box.position.y = 0.66; box.castShadow = true; deliveryBot.add(box);
      for (const wx of [-0.34, 0.34]) for (const wz of [-0.32, 0.32]) { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.08, 16), new THREE.MeshStandardMaterial({ color: 0x0a0e18 })); w.rotation.z = Math.PI / 2; w.position.set(wx, 0.12, wz); deliveryBot.add(w); }
    }

    // robotic arm (front-right)
    const armPivot = new THREE.Group(); armPivot.position.set(2.4, 0, 5.6); scene.add(armPivot);
    {
      const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, 0.4, 20), darkMetal()); stand.position.y = 0.2; armPivot.add(stand);
      const a1 = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.7, 0.12), metalMat()); a1.position.y = 0.7; armPivot.add(a1);
      const elbow = new THREE.Group(); elbow.position.y = 1.0; armPivot.add(elbow);
      const a2 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.6, 0.1), metalMat()); a2.position.set(0, 0.3, 0.05); elbow.add(a2);
      const tip = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.16), neon(0x39d0ff, 1.2)); tip.position.set(0, 0.62, 0.05); elbow.add(tip);
      (armPivot as any).userData.elbow = elbow;
    }

    // ---- robot builder (cute, per agent) ----
    const buildRobot = (a: OfficeAgent, x: number, z: number, faceRot: number) => {
      const group = new THREE.Group();
      group.position.set(x, 0, z);
      group.rotation.y = faceRot;
      group.userData.agentId = a.id;
      const col = new THREE.Color(a.color);
      const bodyMat = new THREE.MeshPhysicalMaterial({ color: col, roughness: 0.26, clearcoat: 1, clearcoatRoughness: 0.16, sheen: 0.6, sheenColor: new THREE.Color(0x9cc8ff) });
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.46, 32, 32), bodyMat); body.scale.set(0.92, 1, 0.9); body.position.y = 0.6; body.castShadow = true; group.add(body);
      const headPivot = new THREE.Group(); headPivot.position.y = 1.32; group.add(headPivot);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.4, 32, 32), new THREE.MeshPhysicalMaterial({ color: col, roughness: 0.26, clearcoat: 1, clearcoatRoughness: 0.16 })); head.scale.set(1.1, 0.95, 1); head.castShadow = true; headPivot.add(head);
      const face = new THREE.Mesh(new THREE.SphereGeometry(0.4, 24, 24), new THREE.MeshPhysicalMaterial({ color: 0x0a0e18, roughness: 0.15, clearcoat: 1 })); face.scale.set(0.92, 0.66, 0.55); face.position.set(0, 0, 0.27); headPivot.add(face);
      const eyeMat = new THREE.MeshStandardMaterial({ color: 0xcdeeff, emissive: 0x7cc8ff, emissiveIntensity: 2.6, roughness: 0.2 });
      const eyeGeo = new THREE.BoxGeometry(0.1, 0.14, 0.04);
      const eyeL = new THREE.Mesh(eyeGeo, eyeMat); eyeL.position.set(-0.13, 0.02, 0.46);
      const eyeR = new THREE.Mesh(eyeGeo, eyeMat); eyeR.position.set(0.13, 0.02, 0.46);
      headPivot.add(eyeL, eyeR);
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.15, 8), bodyMat); ant.position.y = 0.47; headPivot.add(ant);
      const antTip = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 16), eyeMat); antTip.position.y = 0.57; headPivot.add(antTip);
      const armGeo = new THREE.CapsuleGeometry(0.08, 0.15, 6, 12);
      const leftArm = new THREE.Mesh(armGeo, bodyMat); leftArm.position.set(-0.42, 0.6, 0); leftArm.castShadow = true;
      const rightArm = new THREE.Mesh(armGeo, bodyMat); rightArm.position.set(0.42, 0.6, 0); rightArm.castShadow = true;
      group.add(leftArm, rightArm);
      const baseDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.6, 0.08, 40), new THREE.MeshPhysicalMaterial({ color: 0x16203a, roughness: 0.4, clearcoat: 0.6 })); baseDisc.position.y = 0.04; baseDisc.receiveShadow = true; group.add(baseDisc);
      const ringM = new THREE.Mesh(new THREE.TorusGeometry(0.48, 0.032, 16, 56), neon(col.getHex(), 2.0)); ringM.rotation.x = -Math.PI / 2; ringM.position.y = 0.09; group.add(ringM);
      const glowDisc = new THREE.Mesh(new THREE.CircleGeometry(0.46, 40), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.14 })); glowDisc.rotation.x = -Math.PI / 2; glowDisc.position.y = 0.085; group.add(glowDisc);
      scene.add(group);
      robots[a.id] = { group, headPivot, leftArm, rightArm, eyeL, eyeR, ring: ringM, glowDisc, body, phase: Math.random() * Math.PI * 2, blinkT: 2 + Math.random() * 3, home: { x, z } };
    };

    // place specialists at stations + their wall panels; map zone meta
    specialists.forEach((a, i) => {
      const st = STATIONS[i] || STATIONS[STATIONS.length - 1];
      const hex = new THREE.Color(a.color).getHex();
      // desk
      const desk = makeDesk(hex); desk.position.set(st.x, 0, st.z); desk.rotation.y = st.rot; scene.add(desk);
      // robot stands just in front of the desk (toward centre)
      const inward = new THREE.Vector3(-st.x, 0, -st.z).normalize();
      buildRobot(a, st.x + inward.x * 0.95, st.z + inward.z * 0.95, Math.atan2(-st.x, -st.z));
      // wall panel behind the desk (pushed outward toward the wall)
      const meta = ZONE_META[a.id] || { ar: a.role, en: a.id.toUpperCase() };
      const panel = makeWallPanel(meta.ar, meta.en, hex);
      const out = new THREE.Vector3(st.x, 0, st.z).normalize();
      panel.position.set(st.x + out.x * 1.4, 2.5, st.z + out.z * 1.4);
      panel.rotation.y = st.rot;
      scene.add(panel);
      // neon spoke from centre to this station
      neonPath(st.x, st.z, hex);
    });

    // Malak at the centre command seat
    buildRobot(malak, 0, 0.2, Math.PI); // faces front toward the camera/sign
    if (robots[malak.id]) { robots[malak.id].group.position.y = 0.92; robots[malak.id].group.scale.setScalar(1.12); robots[malak.id].centre = true; }

    // ---- controls ----
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const pick = (cx: number, cy: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((cx - rect.left) / rect.width) * 2 - 1; pointer.y = -((cy - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const groups = Object.values(robots).map((x: any) => x.group);
      const hits = raycaster.intersectObjects(groups, true);
      if (hits.length) { let o: THREE.Object3D | null = hits[0].object; while (o && !o.userData.agentId) o = o.parent; if (o && o.userData.agentId) onSelectRef.current?.(o.userData.agentId); }
    };
    let dragging = false, lx = 0, ly = 0, moved = 0, pinchStart = 0, pinchRad = 0;
    const down = (x: number, y: number) => { dragging = true; lx = x; ly = y; moved = 0; };
    const move = (x: number, y: number) => { if (!dragging) return; const dx = x - lx, dy = y - ly; lx = x; ly = y; moved += Math.abs(dx) + Math.abs(dy); camTheta -= dx * 0.006; camPhi = Math.max(0.16, Math.min(Math.PI * 0.46, camPhi - dy * 0.006)); focusActive = false; };
    const up = (x: number, y: number) => { dragging = false; if (moved < 6) pick(x, y); };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dist = (tt: any) => Math.hypot(tt[0].clientX - tt[1].clientX, tt[0].clientY - tt[1].clientY);
    const el = renderer.domElement;
    const onMouseDown = (e: MouseEvent) => down(e.clientX, e.clientY);
    const onMouseMove = (e: MouseEvent) => move(e.clientX, e.clientY);
    const onMouseUp = (e: MouseEvent) => up(e.clientX, e.clientY);
    const onWheel = (e: WheelEvent) => { camRadius = Math.max(7, Math.min(26, camRadius + e.deltaY * 0.01)); focusActive = false; manualZoom = true; };
    const onTouchStart = (e: TouchEvent) => { if (e.touches.length === 1) down(e.touches[0].clientX, e.touches[0].clientY); else if (e.touches.length === 2) { pinchStart = dist(e.touches); pinchRad = camRadius; } };
    const onTouchMove = (e: TouchEvent) => { if (e.touches.length === 1) move(e.touches[0].clientX, e.touches[0].clientY); else if (e.touches.length === 2) { const d = dist(e.touches); camRadius = Math.max(7, Math.min(26, (pinchRad * pinchStart) / d)); focusActive = false; manualZoom = true; } };
    const onTouchEnd = (e: TouchEvent) => { if (e.changedTouches.length) up(e.changedTouches[0].clientX, e.changedTouches[0].clientY); };
    el.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("touchend", onTouchEnd);

    const updateCamera = () => {
      camera.position.set(
        camTarget.x + camRadius * Math.sin(camPhi) * Math.cos(camTheta),
        camTarget.y + camRadius * Math.cos(camPhi),
        camTarget.z + camRadius * Math.sin(camPhi) * Math.sin(camTheta)
      );
      camera.lookAt(camTarget);
    };

    let lastActive = "";
    const animate = () => {
      raf = requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.05);
      elapsed += dt;
      const t = elapsed;
      const anim = lifeRef.current;
      const activeId = activeRef.current;
      const speaking = stateRef.current === "speaking";
      if (activeId !== lastActive) { lastActive = activeId; focusActive = true; }

      // brain hologram
      brain.rotation.y += dt * (anim ? 0.5 : 0.12);
      brainWire.rotation.y -= dt * 0.7; brainWire.rotation.x += dt * 0.2;
      halo1.rotation.z += dt * 0.6; halo2.rotation.z -= dt * 0.5;
      brain.position.y = 2.95 + Math.sin(t * 1.2) * 0.06;
      const bp = 0.5 + Math.sin(t * 3) * 0.5;
      (brainCore.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.1 + bp * 0.8;
      // holo cylinder spinners
      hc1.rotation.y += dt * 1.1; hc1.rotation.x += dt * 0.5;
      hc2.rotation.y -= dt * 0.9; hc2.rotation.x += dt * 0.4;
      // robotic arm sway
      const elbow = (armPivot as any).userData.elbow as THREE.Group | undefined;
      if (elbow) { elbow.rotation.x = Math.sin(t * 1.4) * 0.4 - 0.2; armPivot.rotation.y = Math.sin(t * 0.5) * 0.3; }
      // delivery bot gentle patrol
      deliveryBot.position.x = -2.0 + Math.sin(t * 0.5) * 1.4;

      agents.forEach((a) => {
        const r = robots[a.id]; if (!r) return;
        const isActive = a.id === activeId;
        const baseY = r.centre ? 0.92 : 0;
        let yOff = anim ? Math.sin(t * 1.6 + r.phase) * 0.03 : 0;
        r.group.position.y = baseY + yOff;
        r.body.scale.y = 0.92 + (anim ? Math.sin(t * 2.2 + r.phase) * 0.02 : 0);
        r.headPivot.rotation.y = anim ? Math.sin(t * 0.6 + r.phase) * 0.18 : 0;
        r.headPivot.rotation.x = anim ? Math.sin(t * 0.9 + r.phase) * 0.05 : 0;

        // idle arm sway
        if (!isActive) {
          r.rightArm.rotation.z = anim ? Math.sin(t * 1.5 + r.phase) * 0.12 : 0;
          r.leftArm.rotation.z = anim ? -Math.sin(t * 1.5 + r.phase) * 0.12 : 0;
          r.rightArm.rotation.x = 0; r.leftArm.rotation.x = 0;
        }

        // blink
        r.blinkT -= dt;
        if (r.blinkT <= 0) {
          const k = Math.max(0, 1 - Math.abs(r.blinkT + 0.06) / 0.06); const s = 1 - k; r.eyeL.scale.y = s; r.eyeR.scale.y = s;
          if (r.blinkT < -0.12) { r.blinkT = 2 + Math.random() * 4; r.eyeL.scale.y = 1; r.eyeR.scale.y = 1; }
        }

        if (isActive) {
          const p = 0.5 + Math.sin(t * 4) * 0.5;
          r.ring.material.emissiveIntensity = 2.0 + p * 1.8; r.glowDisc.material.opacity = 0.14 + p * 0.2;
          r.rightArm.rotation.x = 0; r.rightArm.rotation.z = -0.4 - Math.abs(Math.sin(t * (speaking ? 9 : 6))) * 0.8;
          r.group.scale.setScalar((r.centre ? 1.12 : 1.0) * (1.1 + Math.sin(t * 3) * 0.02));
        } else {
          r.ring.material.emissiveIntensity = 1.7; r.glowDisc.material.opacity = 0.12;
          r.group.scale.setScalar(r.centre ? 1.12 : 1.0);
        }
      });

      if (focusActive && activeId && robots[activeId]) {
        const p = robots[activeId].group.position; camTarget.lerp(new THREE.Vector3(p.x, 0.9, p.z), 0.06);
        camRadius += (focusRadiusFor(camera.aspect) - camRadius) * 0.05;
      } else camTarget.lerp(new THREE.Vector3(0, 1.0, 0), 0.04);
      updateCamera();
      renderer.render(scene, camera);
    };
    updateCamera();
    animate();

    const ro = new ResizeObserver(() => {
      const aspect = W() / H();
      camera.aspect = aspect; camera.updateProjectionMatrix(); renderer.setSize(W(), H());
      if (!manualZoom && !focusActive) camRadius = baseRadiusFor(aspect);
    });
    ro.observe(mount);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      renderer.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mm: any = m.material;
        if (mm) (Array.isArray(mm) ? mm : [mm]).forEach((x) => x.dispose && x.dispose());
      });
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative min-h-0 w-full flex-1 overflow-hidden">
      <div ref={mountRef} className="absolute inset-0" />
      {/* hint */}
      <div className="pointer-events-none absolute bottom-2.5 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/40 px-3 py-1 text-[10px] text-white/65 backdrop-blur-sm">
        {HINT}
      </div>
      {/* online status bar (bottom-left) */}
      <div className="pointer-events-none absolute bottom-2.5 left-3 z-10 flex items-center gap-2 rounded-full bg-black/45 px-3 py-1 text-[10px] font-bold text-white/80 backdrop-blur-sm">
        <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
        الوكلاء متصلون · 24/7
      </div>
      {/* animation toggle (top-right) */}
      <button
        type="button"
        onClick={() => setLifeOn((v) => !v)}
        className="absolute right-3 top-3 z-10 rounded-full border border-white/15 bg-black/45 px-3 py-1.5 text-[11px] font-bold text-white/90 shadow backdrop-blur-sm"
      >
        {lifeOn ? "● الحركة مفعّلة" : "○ الحركة موقفة"}
      </button>
    </div>
  );
}
