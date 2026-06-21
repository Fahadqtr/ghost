"use client";

// "مختبر ملاك" — مشهد 3D علمي (Three.js نقي، إجرائي). روبوت كيوت لكل وكيل في
// مختبر فيه طاولات + زجاجات + سبورات عربية + خزائن + محطة عمل لكل تخصص، ونظام
// حياة (شغل/استراحة/لاونج/استهبال) مع إيموجي فوق الراس. كاميرا تدور بالسحب،
// نقر يختار الوكيل. نفس واجهة Office3D (agents, activeAgent, state, onSelect)
// — لا يلمس المحادثة. مُحوَّل من cute-lab-reference.html المعتمد.

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

export interface OfficeAgent {
  id: string;
  name: string;
  role: string;
  color: string;
}

const HINT = "اسحب للدوران · قرّب بإصبعين · انقر وكيل";
const ROOM = { w: 16, d: 13 };

const HOME_POS = [
  { x: -5.8, z: -3.4 }, { x: -5.8, z: 0.0 }, { x: -5.8, z: 3.4 },
  { x: -1.5, z: -3.8 }, { x: 2.0, z: -3.8 },
  { x: 0, z: 0.5 }, { x: 5.2, z: -2.0 }, { x: 5.2, z: 1.5 },
  { x: -2.2, z: 3.6 }, { x: 2.2, z: 3.6 },
];

// تخصص وإيموجي كل وكيل (مفاتيح المشروع الفعلية — 7 وكلاء)
const WORK_BY_ID: Record<string, string> = {
  malak: "manager", noor: "shelf", reem: "camera", siraj: "social",
  razan: "finance", rashid: "analytics", latifa: "support",
};
const EMOJI_BY_ID: Record<string, string> = {
  malak: "📋", noor: "📦", reem: "📸", siraj: "📱",
  razan: "💰", rashid: "📊", latifa: "💬",
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
    // Bright lab theme (matches the reference): light, airy background.
    scene.background = new THREE.Color(0xe6ebf3);
    scene.fog = new THREE.Fog(0xe6ebf3, 20, 48);

    const camera = new THREE.PerspectiveCamera(40, W() / H(), 0.1, 100);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(W(), H());
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.touchAction = "none";

    const clock = new THREE.Clock();
    let elapsed = 0;
    // Responsive framing: the approved close look (radius 11.5) is tuned for a
    // phone-ish aspect (~1.2). Wide desktop screens need the camera pulled back
    // so the whole lab stays in frame instead of zooming into the robots.
    const baseRadiusFor = (aspect: number) =>
      Math.max(11.5, Math.min(11.5 + Math.max(0, aspect - 1.2) * 4.2, 18));
    // Focus distance (when an agent is selected) scales with the base too, so
    // it doesn't slam uncomfortably close on a big monitor.
    const focusRadiusFor = (aspect: number) => Math.max(8, baseRadiusFor(aspect) * 0.7);
    let camTheta = Math.PI * 0.5, camPhi = Math.PI * 0.42, camRadius = baseRadiusFor(W() / H());
    let manualZoom = false; // true once the user wheels/pinches → stop auto-fitting on resize
    const camTarget = new THREE.Vector3(0, 0.85, 0);
    let focusActive = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const robots: Record<string, any> = {};

    // ---- shared materials ----
    const woodMat = () => new THREE.MeshStandardMaterial({ color: 0xb98a5e, roughness: 0.7 });
    const metalMat = () => new THREE.MeshStandardMaterial({ color: 0x9aa6bf, roughness: 0.4, metalness: 0.3 });
    const screenMat = (color: THREE.ColorRepresentation, glow = 0.6) => new THREE.MeshStandardMaterial({ color: 0x10141f, emissive: new THREE.Color(color), emissiveIntensity: glow, roughness: 0.3 });
    const labWhiteMat = () => new THREE.MeshStandardMaterial({ color: 0xeef2f8, roughness: 0.5, metalness: 0.05 });
    const glassMat = (tint?: THREE.ColorRepresentation) => new THREE.MeshPhysicalMaterial({ color: tint ?? 0xcfe6ff, roughness: 0.05, transparent: true, opacity: 0.42, clearcoat: 1.0 });
    const liquidMat = (color: THREE.ColorRepresentation) => new THREE.MeshStandardMaterial({ color: new THREE.Color(color), transparent: true, opacity: 0.85, roughness: 0.2, emissive: new THREE.Color(color), emissiveIntensity: 0.15 });

    // ---- lab elements ----
    const makeFlask = (color: number) => {
      const g = new THREE.Group();
      const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.13, 0.2, 16), glassMat()); cone.position.y = 0.1; g.add(cone);
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.08, 12), glassMat()); neck.position.y = 0.24; g.add(neck);
      const liq = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.1, 0.1, 16), liquidMat(color)); liq.position.y = 0.06; g.add(liq);
      return g;
    };
    const makeTube = (color: number) => {
      const g = new THREE.Group();
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.22, 12), glassMat()); tube.position.y = 0.11; g.add(tube);
      const liq = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.1, 12), liquidMat(color)); liq.position.y = 0.06; g.add(liq);
      return g;
    };
    const makeTubeRack = () => {
      const g = new THREE.Group();
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.04, 0.12), woodMat()); base.position.y = 0.02; g.add(base);
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.12, 0.03), woodMat()); back.position.set(0, 0.1, -0.045); g.add(back);
      [0x5b8cff, 0xff6fae, 0x8b5cf6, 0x32d2a0].forEach((c, i) => { const t = makeTube(c); t.position.set(-0.14 + i * 0.095, 0.04, 0); g.add(t); });
      return g;
    };
    const makeBeaker = (color: number) => {
      const g = new THREE.Group();
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.075, 0.16, 16), glassMat()); cup.position.y = 0.08; g.add(cup);
      const liq = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.068, 0.09, 16), liquidMat(color)); liq.position.y = 0.05; g.add(liq);
      return g;
    };
    const makeLabBench = (w: number, d: number) => {
      const g = new THREE.Group();
      const top = new THREE.Mesh(new THREE.BoxGeometry(w, 0.1, d), labWhiteMat()); top.position.y = 0.92; top.castShadow = true; top.receiveShadow = true; g.add(top);
      const body = new THREE.Mesh(new THREE.BoxGeometry(w - 0.1, 0.82, d - 0.1), new THREE.MeshStandardMaterial({ color: 0xdde4ee, roughness: 0.7 })); body.position.y = 0.46; body.castShadow = true; body.receiveShadow = true; g.add(body);
      for (let i = 0; i < 2; i++) { const dr = new THREE.Mesh(new THREE.BoxGeometry(w * 0.4, 0.02, 0.02), new THREE.MeshStandardMaterial({ color: 0x9aa6bf })); dr.position.set(-w * 0.22 + i * w * 0.44, 0.6, d / 2 - 0.04); g.add(dr); }
      return g;
    };
    const makeBoardTexture = (w: number, h: number, kind: string) => {
      const c = document.createElement("canvas");
      c.width = 512; c.height = Math.round((512 * h) / w);
      const ctx = c.getContext("2d")!;
      if (kind === "experiments") {
        ctx.fillStyle = "#0f5132"; ctx.fillRect(0, 0, c.width, c.height);
        ctx.fillStyle = "#d1f5e0"; ctx.font = "bold 38px sans-serif"; ctx.textAlign = "right";
        ctx.fillText("جدول التجارب", c.width - 24, 56);
        ctx.font = "28px sans-serif";
        ["تجربة كيمياء", "تحليل عينة", "تجربة فيزياء"].forEach((t, i) => { ctx.fillStyle = "#7CFFB0"; ctx.fillText("✓", c.width - 24, 120 + i * 52); ctx.fillStyle = "#eafff2"; ctx.fillText(t, c.width - 60, 120 + i * 52); });
      } else if (kind === "safety") {
        ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height);
        ctx.strokeStyle = "#e63946"; ctx.lineWidth = 8; ctx.strokeRect(8, 8, c.width - 16, c.height - 16);
        ctx.fillStyle = "#e63946"; ctx.font = "bold 34px sans-serif"; ctx.textAlign = "right";
        ctx.fillText("السلامة أولاً", c.width - 24, 54);
      } else {
        ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height);
        ctx.strokeStyle = "#3b6fd4"; ctx.lineWidth = 4;
        for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.arc(120 + k * 120, 120, 38, 0, Math.PI * 2); ctx.stroke(); }
        ctx.fillStyle = "#3b6fd4"; ctx.font = "bold 30px sans-serif"; ctx.textAlign = "right";
        ctx.fillText("ملاحظات التجارب", c.width - 24, 48);
      }
      const tex = new THREE.CanvasTexture(c); tex.needsUpdate = true; return tex;
    };
    const makeWhiteboard = (w: number, h: number, kind: string) => {
      const g = new THREE.Group();
      const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, h + 0.08, 0.04), new THREE.MeshStandardMaterial({ color: 0xbfc8d8, roughness: 0.5, metalness: 0.3 })); g.add(frame);
      const board = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.05), new THREE.MeshStandardMaterial({ map: makeBoardTexture(w, h, kind), roughness: 0.6 })); board.position.z = 0.01; g.add(board);
      return g;
    };
    const makeStorageCabinet = () => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.6, 0.5), new THREE.MeshStandardMaterial({ color: 0xe4e9f1, roughness: 0.6 })); body.position.y = 0.8; body.castShadow = true; body.receiveShadow = true; g.add(body);
      const glass = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.02), glassMat(0xdff0ff)); glass.position.set(0, 1.15, 0.26); g.add(glass);
      [0x6cc4ff, 0xb388ff, 0xff8fb1, 0x8be0c4, 0xffd36b].forEach((c, i) => { const b = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.18, 12), liquidMat(c)); b.position.set(-0.32 + i * 0.16, 1.12, 0.1); g.add(b); });
      return g;
    };
    const makeStool = () => {
      const g = new THREE.Group();
      const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.06, 20), new THREE.MeshStandardMaterial({ color: 0x2a3142, roughness: 0.6 })); seat.position.y = 0.5; seat.castShadow = true; g.add(seat);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.46, 10), metalMat()); pole.position.y = 0.25; g.add(pole);
      for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2; const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.18, 8), metalMat()); leg.position.set(Math.cos(a) * 0.12, 0.06, Math.sin(a) * 0.12); leg.rotation.z = Math.cos(a) * 0.5; leg.rotation.x = -Math.sin(a) * 0.5; g.add(leg); }
      return g;
    };
    const makeMicroscope = () => {
      const g = new THREE.Group();
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.04, 0.2), metalMat()); base.position.y = 0.02; g.add(base);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.28, 0.04), metalMat()); arm.position.set(0.04, 0.18, 0); g.add(arm);
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.18, 12), new THREE.MeshStandardMaterial({ color: 0x222838, roughness: 0.4 })); tube.position.set(-0.02, 0.3, 0.04); tube.rotation.x = 0.3; g.add(tube);
      const stage = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.02, 0.12), metalMat()); stage.position.set(-0.02, 0.16, 0.02); g.add(stage);
      return g;
    };
    const makeAnalyzer = () => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.1, 0.6), new THREE.MeshStandardMaterial({ color: 0x1a1f2b, roughness: 0.5, metalness: 0.4 })); body.position.y = 0.55; body.castShadow = true; body.receiveShadow = true; g.add(body);
      const scr = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.04), screenMat(0x32d2a0, 1.2)); scr.position.set(0, 0.8, 0.31); g.add(scr);
      const f = makeFlask(0x6cc4ff); f.position.set(0, 1.1, 0); g.add(f);
      for (let i = 0; i < 4; i++) { const wmesh = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 12), new THREE.MeshStandardMaterial({ color: 0x111111 })); wmesh.rotation.z = Math.PI / 2; wmesh.position.set(i % 2 ? 0.28 : -0.28, 0.05, i < 2 ? 0.22 : -0.22); g.add(wmesh); }
      return g;
    };
    const makeScale = () => {
      const g = new THREE.Group();
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.06, 0.22), new THREE.MeshStandardMaterial({ color: 0xe8edf5, roughness: 0.5 })); base.position.y = 0.03; g.add(base);
      const pan = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.015, 20), metalMat()); pan.position.y = 0.07; g.add(pan);
      const disp = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.04, 0.01), screenMat(0x32d2a0, 1.0)); disp.position.set(0, 0.04, 0.11); g.add(disp);
      return g;
    };

    // ---- station builders (add into provided group g) ----
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const makeDesk = (g: THREE.Group, color: any) => {
      const top = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.1, 0.75), woodMat()); top.position.y = 0.7; top.castShadow = true; top.receiveShadow = true; g.add(top);
      const legGeo = new THREE.BoxGeometry(0.1, 0.7, 0.1);
      ([[-0.65, -0.3], [0.65, -0.3], [-0.65, 0.3], [0.65, 0.3]] as const).forEach(([lx, lz]) => { const l = new THREE.Mesh(legGeo, woodMat()); l.position.set(lx, 0.35, lz); l.castShadow = true; g.add(l); });
      const scr = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.36, 0.04), screenMat(color, 0.7)); scr.position.set(0, 1.06, -0.2); scr.castShadow = true; g.add(scr);
      const stand = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.18, 0.06), new THREE.MeshStandardMaterial({ color: 0x222838 })); stand.position.set(0, 0.82, -0.2); g.add(stand);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const makeShelf = (g: THREE.Group, _color: any) => {
      const frame = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.8, 0.5), new THREE.MeshStandardMaterial({ color: 0xd8c4a8, roughness: 0.8 })); frame.position.y = 0.9; frame.castShadow = true; frame.receiveShadow = true; g.add(frame);
      for (let i = 0; i < 3; i++) { const inset = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.5, 0.42), new THREE.MeshStandardMaterial({ color: 0x6b5a44, roughness: 0.9 })); inset.position.set(0, 0.45 + i * 0.55, 0.06); g.add(inset); }
      const boxColors = [0xff6b6b, 0x4ecdc4, 0xffd93d, 0x95e1d3, 0xff8b94, 0xa8e6cf];
      for (let i = 0; i < 6; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.3, 0.28), new THREE.MeshStandardMaterial({ color: boxColors[i % boxColors.length], roughness: 0.6 })); b.position.set(-0.45 + (i % 3) * 0.45, 0.5 + Math.floor(i / 3) * 0.55, 0.12); b.castShadow = true; g.add(b); }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const makeCameraRig = (g: THREE.Group, _color: any) => {
      const desk = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 0.7), woodMat()); desk.position.y = 0.7; desk.castShadow = true; desk.receiveShadow = true; g.add(desk);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.1, 8), metalMat()); pole.position.set(0.5, 0.55, 0); g.add(pole);
      const cam = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.22, 0.28), new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.4 })); cam.position.set(0.5, 1.12, 0); cam.castShadow = true; g.add(cam);
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.14, 16), new THREE.MeshStandardMaterial({ color: 0x111418, roughness: 0.2, metalness: 0.5 })); lens.rotation.x = Math.PI / 2; lens.position.set(0.5, 1.12, 0.2); g.add(lens);
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.06), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.2, roughness: 0.5 })); box.position.set(-0.5, 1.1, 0); g.add(box);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const makeAnalytics = (g: THREE.Group, color: any) => {
      const desk = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.1, 0.7), woodMat()); desk.position.y = 0.7; desk.castShadow = true; desk.receiveShadow = true; g.add(desk);
      const board = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.7, 0.05), screenMat(color, 0.5)); board.position.set(0, 1.25, -0.2); board.castShadow = true; g.add(board);
      [0.2, 0.4, 0.3, 0.55, 0.35].forEach((hh, i) => { const bar = new THREE.Mesh(new THREE.BoxGeometry(0.1, hh, 0.02), new THREE.MeshStandardMaterial({ color: new THREE.Color(color), emissive: new THREE.Color(color), emissiveIntensity: 1.4 })); bar.position.set(-0.36 + i * 0.18, 1.05 + hh / 2, -0.17); g.add(bar); });
      const stand = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.2, 0.06), new THREE.MeshStandardMaterial({ color: 0x222838 })); stand.position.set(0, 0.8, -0.2); g.add(stand);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const makeServer = (g: THREE.Group, color: any) => {
      const rack = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.6, 0.6), new THREE.MeshStandardMaterial({ color: 0x1a1f2b, roughness: 0.5, metalness: 0.4 })); rack.position.y = 0.8; rack.castShadow = true; rack.receiveShadow = true; g.add(rack);
      for (let i = 0; i < 8; i++) { const led = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.02), new THREE.MeshStandardMaterial({ color: 0x00ff88, emissive: 0x00ff88, emissiveIntensity: 1.8 })); led.position.set(-0.25 + (i % 2) * 0.12, 1.4 - Math.floor(i / 2) * 0.2, 0.31); g.add(led); }
      const scr = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.34, 0.04), screenMat(color, 0.8)); scr.position.set(0.7, 1.1, 0); scr.rotation.y = -0.4; g.add(scr);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const makeSupportDesk = (g: THREE.Group, color: any) => {
      makeDesk(g, color);
      const bubble = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 16), new THREE.MeshStandardMaterial({ color: new THREE.Color(color), emissive: new THREE.Color(color), emissiveIntensity: 1.0 })); bubble.scale.set(1.2, 0.9, 0.4); bubble.position.set(0.4, 1.3, -0.15); g.add(bubble);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const makeCommandStation = (g: THREE.Group, color: any) => {
      const desk = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.12, 0.8), new THREE.MeshStandardMaterial({ color: 0x1a2236, roughness: 0.5, metalness: 0.3 })); desk.position.y = 0.72; desk.castShadow = true; desk.receiveShadow = true; g.add(desk);
      const big = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.7, 0.05), screenMat(color, 1.0)); big.position.set(0, 1.35, -0.28); big.castShadow = true; g.add(big);
      const sL = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.04), screenMat(0x3b9eff, 0.8)); sL.position.set(-0.7, 1.2, -0.1); sL.rotation.y = 0.5; g.add(sL);
      const sR = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.04), screenMat(0x3b9eff, 0.8)); sR.position.set(0.7, 1.2, -0.1); sR.rotation.y = -0.5; g.add(sR);
      const crown = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.2, 5), new THREE.MeshStandardMaterial({ color: 0xf4c430, emissive: 0xf4c430, emissiveIntensity: 0.8, roughness: 0.3 })); crown.position.set(0, 1.85, -0.28); g.add(crown);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const makeSocialStation = (g: THREE.Group, color: any) => {
      makeDesk(g, color);
      [0xe1306c, 0x1da1f2, 0x25d366, 0x000000].forEach((c, i) => { const tile = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.04), new THREE.MeshStandardMaterial({ color: new THREE.Color(c), emissive: new THREE.Color(c), emissiveIntensity: 0.9, roughness: 0.4 })); tile.position.set(-0.33 + i * 0.22, 1.2 + (i % 2) * 0.12, -0.15); g.add(tile); });
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const WORK_BUILDERS: Record<string, (g: THREE.Group, color: any) => void> = {
      manager: makeCommandStation, writing: makeDesk, social: makeSocialStation,
      shelf: makeShelf, logistics: makeShelf, camera: makeCameraRig,
      finance: makeAnalytics, analytics: makeAnalytics, tech: makeServer, support: makeSupportDesk,
    };

    // ---- lights ----
    scene.add(new THREE.HemisphereLight(0xffffff, 0xd4e0f5, 1.05));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(6, 13, 8); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1; key.shadow.camera.far = 40;
    key.shadow.camera.left = -11; key.shadow.camera.right = 11; key.shadow.camera.top = 11; key.shadow.camera.bottom = -11;
    key.shadow.bias = -0.0004; key.shadow.radius = 7;
    scene.add(key);
    const fillL = new THREE.DirectionalLight(0xeaf2ff, 0.7); fillL.position.set(-8, 6, 4); scene.add(fillL);
    const rimL = new THREE.DirectionalLight(0x9cc4ff, 0.6); rimL.position.set(0, 5, -10); scene.add(rimL);

    // ---- floor / walls / decor ----
    const floor = new THREE.Mesh(new THREE.BoxGeometry(ROOM.w, 0.3, ROOM.d), new THREE.MeshStandardMaterial({ color: 0xf4f7fc, roughness: 0.85 }));
    floor.position.y = -0.15; floor.receiveShadow = true; scene.add(floor);
    const grid = new THREE.GridHelper(ROOM.w, 20, 0xccd8ea, 0xe2e9f4); grid.position.y = 0.015; scene.add(grid);
    const rugRing = new THREE.Mesh(new THREE.RingGeometry(2.0, 2.35, 64), new THREE.MeshStandardMaterial({ color: 0x6cbcff, emissive: 0x6cbcff, emissiveIntensity: 0.35, roughness: 0.6 }));
    rugRing.rotation.x = -Math.PI / 2; rugRing.position.y = 0.02; scene.add(rugRing);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xfafcff, roughness: 0.95 });
    const backWall = new THREE.Mesh(new THREE.BoxGeometry(ROOM.w, 4.4, 0.3), wallMat); backWall.position.set(0, 2.05, -ROOM.d / 2); backWall.receiveShadow = true; scene.add(backWall);
    const leftWall = new THREE.Mesh(new THREE.BoxGeometry(0.3, 4.4, ROOM.d), wallMat); leftWall.position.set(-ROOM.w / 2, 2.05, 0); leftWall.receiveShadow = true; scene.add(leftWall);
    const rightWall = new THREE.Mesh(new THREE.BoxGeometry(0.3, 4.4, ROOM.d), wallMat); rightWall.position.set(ROOM.w / 2, 2.05, 0); rightWall.receiveShadow = true; scene.add(rightWall);
    // wall data screens
    {
      const cols = [0x2f8fff, 0x12c98a, 0xff5fa0];
      for (let i = 0; i < 3; i++) {
        const panel = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.8, 0.12), new THREE.MeshStandardMaterial({ color: 0x101828, emissive: new THREE.Color(cols[i]), emissiveIntensity: 0.3, roughness: 0.3 }));
        panel.position.set(-4.6 + i * 4.6, 2.7, -ROOM.d / 2 + 0.22); scene.add(panel);
        for (let b = 0; b < 7; b++) { const hgt = 0.3 + Math.random() * 0.9; const bar = new THREE.Mesh(new THREE.BoxGeometry(0.22, hgt, 0.04), new THREE.MeshStandardMaterial({ color: new THREE.Color(cols[i]), emissive: new THREE.Color(cols[i]), emissiveIntensity: 1.6 })); bar.position.set(-4.6 + i * 4.6 - 0.9 + b * 0.3, 2.2 + hgt / 2, -ROOM.d / 2 + 0.29); scene.add(bar); }
      }
    }
    // trims
    const trimColors = [0x6cbcff, 0xff8fb1, 0x8be0c4];
    const t1 = new THREE.Mesh(new THREE.BoxGeometry(ROOM.w, 0.07, 0.3), new THREE.MeshStandardMaterial({ color: trimColors[0], emissive: trimColors[0], emissiveIntensity: 0.5, roughness: 0.5 })); t1.position.set(0, 0.12, -ROOM.d / 2 + 0.02); scene.add(t1);
    const t2 = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.07, ROOM.d), new THREE.MeshStandardMaterial({ color: trimColors[1], emissive: trimColors[1], emissiveIntensity: 0.45, roughness: 0.5 })); t2.position.set(-ROOM.w / 2 + 0.02, 0.12, 0); scene.add(t2);
    const t3 = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.07, ROOM.d), new THREE.MeshStandardMaterial({ color: trimColors[2], emissive: trimColors[2], emissiveIntensity: 0.45, roughness: 0.5 })); t3.position.set(ROOM.w / 2 - 0.02, 0.12, 0); scene.add(t3);

    const addPlant = (x: number, z: number) => {
      const g = new THREE.Group(); g.position.set(x, 0, z);
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.18, 0.32, 16), new THREE.MeshStandardMaterial({ color: 0xd98f5e, roughness: 0.8 })); pot.position.y = 0.16; pot.castShadow = true; g.add(pot);
      for (let i = 0; i < 5; i++) { const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 12), new THREE.MeshStandardMaterial({ color: 0x4caf72, roughness: 0.7 })); leaf.scale.set(0.5, 1.1, 0.5); leaf.position.set((Math.random() - 0.5) * 0.2, 0.5 + Math.random() * 0.25, (Math.random() - 0.5) * 0.2); leaf.rotation.z = (Math.random() - 0.5) * 0.6; leaf.castShadow = true; g.add(leaf); }
      scene.add(g);
    };
    addPlant(-ROOM.w / 2 + 1.0, ROOM.d / 2 - 1.0);
    addPlant(ROOM.w / 2 - 1.0, -ROOM.d / 2 + 1.2);

    // ---- lab scene ----
    const benchA = makeLabBench(2.6, 1.1); benchA.position.set(-0.3, 0, -1.3); scene.add(benchA);
    const benchB = makeLabBench(2.6, 1.1); benchB.position.set(0.6, 0, 1.2); scene.add(benchB);
    [0x6cc4ff, 0xb388ff, 0xff8fb1].forEach((c, i) => { const f = makeFlask(c); f.position.set(-0.9 + i * 0.5, 0.97, -1.3); scene.add(f); });
    const rackA = makeTubeRack(); rackA.position.set(0.3, 0.97, -1.5); scene.add(rackA);
    const beakerA = makeBeaker(0x32d2a0); beakerA.position.set(0.7, 0.97, -1.1); scene.add(beakerA);
    [0x5b8cff, 0xff6fae, 0x8be0c4].forEach((c, i) => { const f = makeFlask(c); f.position.set(0.1 + i * 0.5, 0.97, 1.2); scene.add(f); });
    const rackB = makeTubeRack(); rackB.position.set(1.4, 0.97, 1.0); scene.add(rackB);
    const nb = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.02, 0.26), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 })); nb.position.set(-0.4, 0.98, 1.3); nb.rotation.y = 0.2; scene.add(nb);
    const scaleObj = makeScale(); scaleObj.position.set(1.6, 0.97, 1.4); scene.add(scaleObj);
    const micro = makeMicroscope(); micro.position.set(0.9, 0.97, -1.5); scene.add(micro);
    const wallZ = -ROOM.d / 2 + 0.18;
    const bExp = makeWhiteboard(2.0, 1.2, "experiments"); bExp.position.set(1.5, 2.4, wallZ); scene.add(bExp);
    const bNotes = makeWhiteboard(2.2, 1.3, "notes"); bNotes.position.set(-1.8, 2.4, wallZ); scene.add(bNotes);
    const bSafety = makeWhiteboard(1.0, 1.3, "safety"); bSafety.position.set(-4.4, 2.3, wallZ); scene.add(bSafety);
    const cab1 = makeStorageCabinet(); cab1.position.set(ROOM.w / 2 - 0.7, 0, -2.2); cab1.rotation.y = -Math.PI / 2; scene.add(cab1);
    const cab2 = makeStorageCabinet(); cab2.position.set(ROOM.w / 2 - 0.7, 0, 2.2); cab2.rotation.y = -Math.PI / 2; scene.add(cab2);
    const analyzer = makeAnalyzer(); analyzer.position.set(ROOM.w / 2 - 1.0, 0, 0); analyzer.rotation.y = -Math.PI / 2; scene.add(analyzer);
    ([[-1.8, -1.3], [1.6, -1.3], [-0.8, 2.2], [2.2, 1.0]] as const).forEach(([x, z]) => { const s = makeStool(); s.position.set(x, 0, z); scene.add(s); });
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.3, 2.0), new THREE.MeshPhysicalMaterial({ color: 0xbfe6ff, roughness: 0.1, transparent: true, opacity: 0.5, clearcoat: 1.0 })); win.position.set(ROOM.w / 2 - 0.16, 2.4, -4.0); scene.add(win);
    const winFrame = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.5, 2.2), new THREE.MeshStandardMaterial({ color: 0xcfd8e6 })); winFrame.position.set(ROOM.w / 2 - 0.14, 2.4, -4.0); scene.add(winFrame);

    // per-agent workstation
    agents.forEach((a, i) => {
      const home = HOME_POS[i] || { x: 0, z: 0 };
      const g = new THREE.Group();
      const d = Math.hypot(home.x, home.z) || 1;
      const ux = home.x / d, uz = home.z / d;
      g.position.set(home.x + ux * 1.1, 0, home.z + uz * 1.1);
      g.rotation.y = Math.atan2(-home.x, -home.z);
      (WORK_BUILDERS[WORK_BY_ID[a.id] || "writing"] || makeDesk)(g, new THREE.Color(a.color).getHex());
      scene.add(g);
    });
    // water cooler
    {
      const cooler = new THREE.Group(); cooler.position.set(4.5, 0, 4.2);
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.8, 0.4), new THREE.MeshStandardMaterial({ color: 0xeaf2ff, roughness: 0.5 })); body.position.y = 0.4; body.castShadow = true; cooler.add(body);
      const jug = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.3, 16), new THREE.MeshPhysicalMaterial({ color: 0x6cc4ff, transparent: true, opacity: 0.7, roughness: 0.1 })); jug.position.y = 0.95; cooler.add(jug);
      scene.add(cooler);
    }

    // ---- robots ----
    const roundedHead = (color: THREE.ColorRepresentation) => {
      const m = new THREE.MeshPhysicalMaterial({ color, roughness: 0.28, clearcoat: 1.0, clearcoatRoughness: 0.18, sheen: 0.5, sheenColor: new THREE.Color(0x9cc8ff) });
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 32, 32), m); head.scale.set(1.1, 0.95, 1.0); head.castShadow = true; return head;
    };
    const roundRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
      ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    };
    const makeEmojiTexture = (emoji: string) => {
      const c = document.createElement("canvas"); c.width = 128; c.height = 128;
      const ctx = c.getContext("2d")!; ctx.clearRect(0, 0, 128, 128);
      ctx.fillStyle = "rgba(20,26,42,0.85)"; roundRect(ctx, 14, 14, 100, 100, 26); ctx.fill();
      ctx.font = "64px serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(emoji, 64, 70);
      const tex = new THREE.CanvasTexture(c); tex.needsUpdate = true; return tex;
    };
    // Always-on floating name tag above each character (Sims-style).
    const makeNameTexture = (name: string, hex: number) => {
      const c = document.createElement("canvas"); c.width = 256; c.height = 84;
      const ctx = c.getContext("2d")!; ctx.clearRect(0, 0, 256, 84);
      ctx.fillStyle = "rgba(15,20,32,0.86)"; roundRect(ctx, 10, 20, 236, 46, 23); ctx.fill();
      const col = "#" + hex.toString(16).padStart(6, "0");
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(216, 43, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#ffffff"; ctx.font = "bold 30px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(name, 118, 45);
      const tex = new THREE.CanvasTexture(c); tex.needsUpdate = true; tex.anisotropy = 4; return tex;
    };
    const buildRobot = (a: OfficeAgent, station: number) => {
      const group = new THREE.Group();
      const pos = HOME_POS[station] || { x: 0, z: 0 };
      group.position.set(pos.x, 0, pos.z);
      group.userData.agentId = a.id;
      const col = new THREE.Color(a.color);
      const bodyMat = new THREE.MeshPhysicalMaterial({ color: col, roughness: 0.26, clearcoat: 1.0, clearcoatRoughness: 0.16, sheen: 0.6, sheenColor: new THREE.Color(0x9cc8ff) });
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 32), bodyMat); body.scale.set(0.92, 1.0, 0.9); body.position.y = 0.66; body.castShadow = true; group.add(body);
      const headPivot = new THREE.Group(); headPivot.position.y = 1.42; group.add(headPivot);
      headPivot.add(roundedHead(col));
      const face = new THREE.Mesh(new THREE.SphereGeometry(0.42, 24, 24), new THREE.MeshPhysicalMaterial({ color: 0x0a0e18, roughness: 0.15, clearcoat: 1.0 })); face.scale.set(0.92, 0.66, 0.55); face.position.set(0, 0.0, 0.28); headPivot.add(face);
      const eyeMat = new THREE.MeshStandardMaterial({ color: 0xcdeeff, emissive: 0x7cc8ff, emissiveIntensity: 2.6, roughness: 0.2 });
      const eyeGeo = new THREE.BoxGeometry(0.11, 0.15, 0.04);
      const eyeL = new THREE.Mesh(eyeGeo, eyeMat); eyeL.position.set(-0.14, 0.02, 0.48);
      const eyeR = new THREE.Mesh(eyeGeo, eyeMat); eyeR.position.set(0.14, 0.02, 0.48);
      headPivot.add(eyeL, eyeR);
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.16, 8), bodyMat); ant.position.y = 0.5; headPivot.add(ant);
      const antTip = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 16), eyeMat); antTip.position.y = 0.6; headPivot.add(antTip);
      const armGeo = new THREE.CapsuleGeometry(0.085, 0.16, 6, 12);
      const leftArm = new THREE.Mesh(armGeo, bodyMat); leftArm.position.set(-0.46, 0.66, 0); leftArm.castShadow = true;
      const rightArm = new THREE.Mesh(armGeo, bodyMat); rightArm.position.set(0.46, 0.66, 0); rightArm.castShadow = true;
      group.add(leftArm, rightArm);
      const legGeo = new THREE.CapsuleGeometry(0.1, 0.12, 6, 12);
      const legL = new THREE.Mesh(legGeo, bodyMat); legL.position.set(-0.18, 0.16, 0); legL.castShadow = true;
      const legR = new THREE.Mesh(legGeo, bodyMat); legR.position.set(0.18, 0.16, 0); legR.castShadow = true;
      group.add(legL, legR);
      const baseDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.66, 0.08, 48), new THREE.MeshPhysicalMaterial({ color: 0xf4f8ff, roughness: 0.3, clearcoat: 0.7 })); baseDisc.position.y = 0.04; baseDisc.receiveShadow = true; group.add(baseDisc);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.035, 16, 64), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 2.0, roughness: 0.3 })); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.09; group.add(ring);
      const glowDisc = new THREE.Mesh(new THREE.CircleGeometry(0.5, 48), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.12 })); glowDisc.rotation.x = -Math.PI / 2; glowDisc.position.y = 0.085; group.add(glowDisc);
      const emojiSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeEmojiTexture(EMOJI_BY_ID[a.id] || "💡"), transparent: true, opacity: 0, depthTest: false })); emojiSprite.scale.set(0.46, 0.46, 0.46); emojiSprite.position.y = 2.78; emojiSprite.renderOrder = 10; group.add(emojiSprite);
      // floating name tag (always visible)
      const nameSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeNameTexture(a.name, col.getHex()), transparent: true, opacity: 0.95, depthTest: false }));
      nameSprite.scale.set(1.15, 0.38, 1); nameSprite.position.y = 2.22; nameSprite.renderOrder = 11; group.add(nameSprite);
      scene.add(group);
      robots[a.id] = {
        group, headPivot, leftArm, rightArm, eyeL, eyeR, ring, glowDisc, body, legL, legR,
        phase: Math.random() * Math.PI * 2, blinkT: 2 + Math.random() * 3, emojiSprite, nameSprite, emojiTarget: 0,
        home: { x: pos.x, z: pos.z }, beh: "work", behTimer: 2 + Math.random() * 3,
        target: null, heading: Math.atan2(-pos.x, -pos.z), walkPhase: 0, workPhase: Math.random() * Math.PI * 2, hop: 0, stuck: 0,
      };
    };
    agents.forEach((a, i) => buildRobot(a, i));

    // ---- life system ----
    const lerpAngle = (a: number, b: number, tt: number) => { let dd = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI; if (dd < -Math.PI) dd += Math.PI * 2; return a + dd * tt; };
    const BREAK_SPOT = { x: 4.5, z: 3.4 };
    const LOUNGE = { x: 0, z: 0 };
    const clampX = (v: number) => Math.max(-7, Math.min(7, v));
    const clampZ = (v: number) => Math.max(-5.5, Math.min(5.5, v));
    // Furniture footprints (axis-aligned) the characters must not walk through.
    const OBST: { x0: number; x1: number; z0: number; z1: number }[] = [
      { x0: -1.6, x1: 1.0, z0: -1.85, z1: -0.75 },  // bench A
      { x0: -0.7, x1: 1.9, z0: 0.65, z1: 1.75 },    // bench B
      { x0: 6.2, x1: 8.2, z0: -2.9, z1: 2.9 },      // right-wall cabinets + analyzer
      { x0: 4.0, x1: 5.0, z0: 3.7, z1: 4.7 },       // water cooler
    ];
    const PAD = 0.6; // robot radius padding
    const blocked = (x: number, z: number) =>
      OBST.some((o) => x > o.x0 - PAD && x < o.x1 + PAD && z > o.z0 - PAD && z < o.z1 + PAD);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const workSpot = (r: any) => { const d = Math.hypot(r.home.x, r.home.z) || 1; return { x: r.home.x - (r.home.x / d) * 0.4, z: r.home.z - (r.home.z / d) * 0.4 }; };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pickBehaviour = (r: any) => {
      const x = Math.random();
      if (x < 0.55) { r.beh = "goWork"; r.target = workSpot(r); r.behTimer = 4 + Math.random() * 4; }
      else if (x < 0.72) { r.beh = "goBreak"; r.target = { x: BREAK_SPOT.x + (Math.random() - 0.5), z: BREAK_SPOT.z + (Math.random() - 0.5) }; r.behTimer = 3 + Math.random() * 2; }
      else if (x < 0.85) { r.beh = "goLounge"; r.target = { x: LOUNGE.x + (Math.random() - 0.5) * 2, z: LOUNGE.z + (Math.random() - 0.5) * 2 }; r.behTimer = 3 + Math.random() * 2; }
      else if (x < 0.94) { r.beh = "goof"; r.target = null; r.behTimer = 1.6 + Math.random() * 1.2; r.hop = 0; }
      else { const ang = Math.random() * Math.PI * 2, rad = 1 + Math.random() * 1.5; r.beh = "walk"; r.target = { x: clampX(r.home.x + Math.cos(ang) * rad), z: clampZ(r.home.z + Math.sin(ang) * rad) }; r.behTimer = 3 + Math.random() * 2; }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const moveToward = (r: any, dt: number) => {
      const g = r.group; const dx = r.target.x - g.position.x, dz = r.target.z - g.position.z; const dlen = Math.hypot(dx, dz);
      if (dlen < 0.2) return true;
      const sp = 1.4 * dt;
      const nx = clampX(g.position.x + (dx / dlen) * sp);
      const nz = clampZ(g.position.z + (dz / dlen) * sp);
      // wall-slide around furniture: block the axis that would enter an obstacle
      let mx = nx, mz = nz;
      if (blocked(nx, g.position.z)) mx = g.position.x;
      if (blocked(g.position.x, nz)) mz = g.position.z;
      if (blocked(mx, mz)) { mx = g.position.x; mz = g.position.z; }
      const movedDist = Math.hypot(mx - g.position.x, mz - g.position.z);
      g.position.x = mx; g.position.z = mz;
      r.heading = lerpAngle(r.heading, Math.atan2(dx, dz), 0.16); r.walkPhase += dt * 10;
      // stuck against furniture → give up this target and pick a new behaviour
      if (movedDist < sp * 0.25) { r.stuck += dt; if (r.stuck > 0.6) { r.stuck = 0; r.behTimer = 0; r.beh = "idle"; r.target = null; return true; } }
      else r.stuck = 0;
      return false;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateLife = (r: any, dt: number) => {
      if (!lifeRef.current) {
        const g = r.group; g.position.x += (r.home.x - g.position.x) * 0.04; g.position.z += (r.home.z - g.position.z) * 0.04;
        r.beh = "idle"; r.target = null; r.emojiTarget = 0; r.group.rotation.y = lerpAngle(r.group.rotation.y, Math.atan2(-r.home.x, -r.home.z), 0.06); return;
      }
      r.behTimer -= dt; if (r.behTimer <= 0) pickBehaviour(r);
      r.emojiTarget = 0;
      switch (r.beh) {
        case "goWork": if (moveToward(r, dt)) { r.beh = "working"; r.behTimer = 4 + Math.random() * 4; r.heading = Math.atan2(-r.home.x, -r.home.z); } break;
        case "working": r.emojiTarget = 1; r.heading = lerpAngle(r.heading, Math.atan2(-r.home.x, -r.home.z), 0.1); r.workPhase += dt * 4; break;
        case "goBreak": if (moveToward(r, dt)) { r.beh = "break"; r.behTimer = 2.5 + Math.random() * 2; } break;
        case "break": r.emojiTarget = 2; break;
        case "goLounge": if (moveToward(r, dt)) { r.beh = "lounge"; r.behTimer = 2.5 + Math.random() * 2.5; } break;
        case "lounge": r.emojiTarget = 3; break;
        case "goof": r.hop += dt; r.emojiTarget = 4; break;
        case "walk": if (moveToward(r, dt)) { r.beh = "idle"; r.target = null; r.behTimer = 1 + Math.random() * 2; } break;
        default: break;
      }
      r.group.rotation.y = r.heading;
    };

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
    const move = (x: number, y: number) => { if (!dragging) return; const dx = x - lx, dy = y - ly; lx = x; ly = y; moved += Math.abs(dx) + Math.abs(dy); camTheta -= dx * 0.006; camPhi = Math.max(0.15, Math.min(Math.PI * 0.46, camPhi - dy * 0.006)); focusActive = false; };
    const up = (x: number, y: number) => { dragging = false; if (moved < 6) pick(x, y); };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dist = (tt: any) => Math.hypot(tt[0].clientX - tt[1].clientX, tt[0].clientY - tt[1].clientY);
    const el = renderer.domElement;
    const onMouseDown = (e: MouseEvent) => down(e.clientX, e.clientY);
    const onMouseMove = (e: MouseEvent) => move(e.clientX, e.clientY);
    const onMouseUp = (e: MouseEvent) => up(e.clientX, e.clientY);
    const onWheel = (e: WheelEvent) => { camRadius = Math.max(6, Math.min(24, camRadius + e.deltaY * 0.01)); focusActive = false; manualZoom = true; };
    const onTouchStart = (e: TouchEvent) => { if (e.touches.length === 1) down(e.touches[0].clientX, e.touches[0].clientY); else if (e.touches.length === 2) { pinchStart = dist(e.touches); pinchRad = camRadius; } };
    const onTouchMove = (e: TouchEvent) => { if (e.touches.length === 1) move(e.touches[0].clientX, e.touches[0].clientY); else if (e.touches.length === 2) { const d = dist(e.touches); camRadius = Math.max(6, Math.min(24, (pinchRad * pinchStart) / d)); focusActive = false; manualZoom = true; } };
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
      const activeId = activeRef.current;
      const speaking = stateRef.current === "speaking";
      if (activeId !== lastActive) { lastActive = activeId; focusActive = true; }

      agents.forEach((a) => {
        const r = robots[a.id];
        if (!r) return;
        const isActive = a.id === activeId;
        if (isActive) {
          const g = r.group; g.position.x += (r.home.x - g.position.x) * 0.05; g.position.z += (r.home.z - g.position.z) * 0.05; r.beh = "idle"; r.target = null;
        } else updateLife(r, dt);

        const walking = !isActive && (r.beh === "walk" || r.beh === "goWork" || r.beh === "goBreak" || r.beh === "goLounge") && r.target;
        const working = !isActive && r.beh === "working";
        const goofing = !isActive && r.beh === "goof";
        const drinking = !isActive && r.beh === "break";

        let yOff = Math.sin(t * 1.6 + r.phase) * 0.03;
        if (walking) yOff = Math.abs(Math.sin(r.walkPhase)) * 0.04;
        if (goofing) yOff = Math.abs(Math.sin(r.hop * 7)) * 0.28;
        r.group.position.y = yOff;
        r.body.scale.y = 0.92 + Math.sin(t * 2.2 + r.phase) * 0.02;
        r.headPivot.rotation.y = Math.sin(t * 0.6 + r.phase) * (goofing ? 0.5 : 0.18);
        r.headPivot.rotation.x = Math.sin(t * 0.9 + r.phase) * 0.05;

        if (walking) {
          r.legL.rotation.x = Math.sin(r.walkPhase) * 0.6; r.legR.rotation.x = -Math.sin(r.walkPhase) * 0.6;
          r.leftArm.rotation.x = -Math.sin(r.walkPhase) * 0.5; r.rightArm.rotation.x = Math.sin(r.walkPhase) * 0.5;
          r.rightArm.rotation.z = 0; r.leftArm.rotation.z = 0;
        } else if (working) {
          const wv = Math.sin(r.workPhase * 3); r.rightArm.rotation.x = -0.8 + wv * 0.2; r.leftArm.rotation.x = -0.8 - wv * 0.2;
          r.rightArm.rotation.z = 0; r.leftArm.rotation.z = 0; r.legL.rotation.x += (0 - r.legL.rotation.x) * 0.2; r.legR.rotation.x += (0 - r.legR.rotation.x) * 0.2;
        } else if (goofing) {
          r.rightArm.rotation.z = -1.4 - Math.abs(Math.sin(t * 8)) * 0.4; r.leftArm.rotation.z = 1.4 + Math.abs(Math.sin(t * 8)) * 0.4; r.rightArm.rotation.x = 0; r.leftArm.rotation.x = 0;
        } else if (drinking) {
          r.rightArm.rotation.x = -2.2; r.rightArm.rotation.z = 0; r.leftArm.rotation.x += (0 - r.leftArm.rotation.x) * 0.2; r.legL.rotation.x += (0 - r.legL.rotation.x) * 0.2; r.legR.rotation.x += (0 - r.legR.rotation.x) * 0.2;
        } else {
          r.legL.rotation.x += (0 - r.legL.rotation.x) * 0.2; r.legR.rotation.x += (0 - r.legR.rotation.x) * 0.2;
          r.leftArm.rotation.x += (0 - r.leftArm.rotation.x) * 0.2; r.rightArm.rotation.x += (0 - r.rightArm.rotation.x) * 0.2;
        }

        const targetOp = isActive ? 0 : r.emojiTarget > 0 ? 1 : 0;
        r.emojiSprite.material.opacity += (targetOp - r.emojiSprite.material.opacity) * 0.12;
        r.emojiSprite.position.y = 2.82 + Math.sin(t * 2 + r.phase) * 0.06;
        // name tag: always visible, gently bobs; pops when the agent is active/speaking
        r.nameSprite.position.y = 2.24 + Math.sin(t * 2 + r.phase) * 0.05;
        const nameScale = isActive ? (speaking ? 1.32 : 1.18) : 1.0;
        r.nameSprite.scale.x += (1.15 * nameScale - r.nameSprite.scale.x) * 0.15;
        r.nameSprite.scale.y += (0.38 * nameScale - r.nameSprite.scale.y) * 0.15;

        r.blinkT -= dt;
        if (r.blinkT <= 0) {
          const k = Math.max(0, 1 - Math.abs(r.blinkT + 0.06) / 0.06); const s = 1 - k; r.eyeL.scale.y = s; r.eyeR.scale.y = s;
          if (r.blinkT < -0.12) { r.blinkT = 2 + Math.random() * 4; r.eyeL.scale.y = 1; r.eyeR.scale.y = 1; }
        }

        if (isActive) {
          const p = 0.5 + Math.sin(t * 4) * 0.5; r.ring.material.emissiveIntensity = 2.0 + p * 1.6; r.glowDisc.material.opacity = 0.12 + p * 0.18;
          r.rightArm.rotation.x = 0; r.rightArm.rotation.z = -0.4 - Math.abs(Math.sin(t * (speaking ? 9 : 6))) * 0.8; r.group.scale.setScalar(1.12 + Math.sin(t * 3) * 0.02);
        } else {
          r.ring.material.emissiveIntensity = 1.6; r.glowDisc.material.opacity = 0.1;
          if (!walking && !working && !goofing && !drinking) { r.rightArm.rotation.z = Math.sin(t * 1.5 + r.phase) * 0.12; r.leftArm.rotation.z = -Math.sin(t * 1.5 + r.phase) * 0.12; }
          r.group.scale.setScalar(1.0);
        }
      });

      // ---- separation: keep characters from overlapping each other ----
      const MIN_SEP = 1.05;
      for (let i = 0; i < agents.length; i++) {
        for (let j = i + 1; j < agents.length; j++) {
          const ra = robots[agents[i].id], rb = robots[agents[j].id];
          if (!ra || !rb) continue;
          const pa = ra.group.position, pb = rb.group.position;
          let dx = pb.x - pa.x, dz = pb.z - pa.z; let d = Math.hypot(dx, dz);
          if (d > 0.0001 && d < MIN_SEP) {
            const push = (MIN_SEP - d) / 2; dx /= d; dz /= d;
            const aActive = agents[i].id === activeId, bActive = agents[j].id === activeId;
            // active/centre agent holds position; the other yields (or both if neither active)
            const wa = aActive ? 0 : bActive ? 1 : 0.5;
            const wb = bActive ? 0 : aActive ? 1 : 0.5;
            const ax = clampX(pa.x - dx * push * wa * 2), az = clampZ(pa.z - dz * push * wa * 2);
            const bx = clampX(pb.x + dx * push * wb * 2), bz = clampZ(pb.z + dz * push * wb * 2);
            if (!blocked(ax, az)) { pa.x = ax; pa.z = az; }
            if (!blocked(bx, bz)) { pb.x = bx; pb.z = bz; }
          }
        }
      }

      if (focusActive && activeId && robots[activeId]) {
        const p = robots[activeId].group.position; camTarget.lerp(new THREE.Vector3(p.x, 0.7, p.z), 0.06);
        camRadius += (focusRadiusFor(camera.aspect) - camRadius) * 0.05;
      } else camTarget.lerp(new THREE.Vector3(0, 0.85, 0), 0.04);
      updateCamera();
      renderer.render(scene, camera);
    };
    updateCamera();
    animate();

    const ro = new ResizeObserver(() => {
      const aspect = W() / H();
      camera.aspect = aspect; camera.updateProjectionMatrix(); renderer.setSize(W(), H());
      // Re-fit the framing to the new aspect unless the user took manual control.
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
      {/* hint: subtle, bottom-center (title is already in the page header) */}
      <div className="pointer-events-none absolute bottom-2.5 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/40 px-3 py-1 text-[10px] text-white/65 backdrop-blur-sm">
        {HINT}
      </div>
      {/* life toggle: tucked into the top-right corner */}
      <button
        type="button"
        onClick={() => setLifeOn((v) => !v)}
        className="absolute right-3 top-3 z-10 rounded-full border border-white/15 bg-black/45 px-3 py-1.5 text-[11px] font-bold text-white/90 shadow backdrop-blur-sm"
      >
        {lifeOn ? "● الحياة مفعّلة" : "○ الحياة موقفة"}
      </button>
    </div>
  );
}
