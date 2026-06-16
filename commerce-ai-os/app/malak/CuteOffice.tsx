"use client";

// "برج ملاك" — مكتب 3D كيوت (Three.js نقي، إجرائي بالكامل، بدون موديلات).
// روبوت لطيف لكل وكيل (راس مدوّر + جسم ممتلئ + عيون مضيئة + هوائي + منصة نيون)،
// مع نظام حياة (يتمشّون قرب أماكنهم)، كاميرا تدور بالسحب/تقرّب بإصبعين، ونقر
// يختار الوكيل. الوكيل النشط يلوّح + هالة نابضة + الكاميرا تركّز عليه.
// نفس واجهة Office3D (agents, activeAgent, state, onSelect) — لا يلمس المحادثة.
// مُحوَّل من cute-office-reference.html المعتمد.

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

export interface OfficeAgent {
  id: string;
  name: string;
  role: string;
  color: string;
}

const TITLE = "برج ملاك · الفريق الذكي";
const HINT = "اسحب للدوران · قرّب بإصبعين · انقر وكيل";

const ROOM = { w: 16, d: 13 };

// أماكن الوكلاء الموزّعة في المكتب المفتوح (حتى 10؛ نستخدم أول N حسب الفريق).
const HOME_POS = [
  { x: -5.8, z: -3.4 }, { x: -5.8, z: 0.0 }, { x: -5.8, z: 3.4 },
  { x: -1.5, z: -3.8 }, { x: 2.0, z: -3.8 },
  { x: 0, z: 0.5 }, { x: 5.2, z: -2.0 }, { x: 5.2, z: 1.5 },
  { x: -2.2, z: 3.6 }, { x: 2.2, z: 3.6 },
];

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
    let disposed = false;

    const W = () => mount.clientWidth || 800;
    const H = () => mount.clientHeight || 500;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0e1a);
    scene.fog = new THREE.Fog(0x0a0e1a, 14, 30);

    const camera = new THREE.PerspectiveCamera(42, W() / H(), 0.1, 100);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(W(), H());
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.touchAction = "none";

    const clock = new THREE.Clock();
    let elapsed = 0;

    // camera spherical state
    let camTheta = Math.PI * 0.5;
    let camPhi = Math.PI * 0.38;
    let camRadius = 15;
    const camTarget = new THREE.Vector3(0, 0.6, 0);
    let focusActive = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const robots: Record<string, any> = {};

    // ---- lights ----
    scene.add(new THREE.HemisphereLight(0xdfeaff, 0x1a2238, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(5, 12, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 40;
    key.shadow.camera.left = -10;
    key.shadow.camera.right = 10;
    key.shadow.camera.top = 10;
    key.shadow.camera.bottom = -10;
    key.shadow.bias = -0.0004;
    key.shadow.radius = 8;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x4ea2ff, 1.0);
    rim.position.set(0, 4, -10);
    scene.add(rim);
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.5);
    fill.position.set(-8, 5, 3);
    scene.add(fill);

    // ---- floor + walls + furniture ----
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(ROOM.w, 0.3, ROOM.d),
      new THREE.MeshStandardMaterial({ color: 0xe9eef7, roughness: 0.92 })
    );
    floor.position.y = -0.15;
    floor.receiveShadow = true;
    scene.add(floor);
    const grid = new THREE.GridHelper(ROOM.w, 16, 0xccd6ea, 0xdde4f0);
    grid.position.y = 0.012;
    scene.add(grid);

    const wallMat = new THREE.MeshStandardMaterial({ color: 0xf2f5fb, roughness: 0.96 });
    const backWall = new THREE.Mesh(new THREE.BoxGeometry(ROOM.w, 4, 0.3), wallMat);
    backWall.position.set(0, 1.85, -ROOM.d / 2);
    backWall.receiveShadow = true;
    scene.add(backWall);
    const leftWall = new THREE.Mesh(new THREE.BoxGeometry(0.3, 4, ROOM.d), wallMat);
    leftWall.position.set(-ROOM.w / 2, 1.85, 0);
    leftWall.receiveShadow = true;
    scene.add(leftWall);

    const baseMat = new THREE.MeshStandardMaterial({ color: 0x6cbcff, roughness: 0.5, emissive: 0x2a6fff, emissiveIntensity: 0.25 });
    const bb1 = new THREE.Mesh(new THREE.BoxGeometry(ROOM.w, 0.12, 0.34), baseMat);
    bb1.position.set(0, 0.06, -ROOM.d / 2 + 0.02);
    scene.add(bb1);
    const bb2 = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, ROOM.d), baseMat);
    bb2.position.set(-ROOM.w / 2 + 0.02, 0.06, 0);
    scene.add(bb2);

    const deskUnit = (x: number, z: number, ry: number, color: number) => {
      const g = new THREE.Group();
      g.position.set(x, 0, z);
      g.rotation.y = ry;
      const woodMat = new THREE.MeshStandardMaterial({ color: 0xb98a5e, roughness: 0.7 });
      const top = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.1, 0.7), woodMat);
      top.position.y = 0.7;
      top.castShadow = true;
      top.receiveShadow = true;
      g.add(top);
      const legGeo = new THREE.BoxGeometry(0.1, 0.7, 0.1);
      ([[-0.6, -0.28], [0.6, -0.28], [-0.6, 0.28], [0.6, 0.28]] as const).forEach(([lx, lz]) => {
        const l = new THREE.Mesh(legGeo, woodMat);
        l.position.set(lx, 0.35, lz);
        l.castShadow = true;
        g.add(l);
      });
      const scr = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.34, 0.04),
        new THREE.MeshStandardMaterial({ color: 0x10141f, emissive: new THREE.Color(color), emissiveIntensity: 0.6, roughness: 0.3 })
      );
      scr.position.set(0, 1.05, -0.18);
      scr.castShadow = true;
      g.add(scr);
      const stand = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.06), new THREE.MeshStandardMaterial({ color: 0x222838 }));
      stand.position.set(0, 0.83, -0.18);
      g.add(stand);
      scene.add(g);
    };
    deskUnit(-ROOM.w / 2 + 1.3, -3.5, Math.PI / 2, 0x8b5cf6);
    deskUnit(-ROOM.w / 2 + 1.3, 0.0, Math.PI / 2, 0x10b981);
    deskUnit(-ROOM.w / 2 + 1.3, 3.5, Math.PI / 2, 0x14b8a6);
    deskUnit(0, -ROOM.d / 2 + 1.0, 0, 0x2f7ff0);
    deskUnit(3.5, -ROOM.d / 2 + 1.0, 0, 0xf97316);
    const rug = new THREE.Mesh(
      new THREE.CircleGeometry(2.4, 48),
      new THREE.MeshStandardMaterial({ color: 0xdfe7f5, roughness: 0.95 })
    );
    rug.rotation.x = -Math.PI / 2;
    rug.position.y = 0.02;
    rug.receiveShadow = true;
    scene.add(rug);

    // ---- build a cute robot per agent ----
    const roundedHead = (color: THREE.ColorRepresentation) => {
      const m = new THREE.MeshPhysicalMaterial({ color, roughness: 0.28, clearcoat: 1.0, clearcoatRoughness: 0.18, sheen: 0.5, sheenColor: new THREE.Color(0x9cc8ff) });
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 32, 32), m);
      head.scale.set(1.1, 0.95, 1.0);
      head.castShadow = true;
      return head;
    };

    const buildRobot = (a: OfficeAgent, station: number) => {
      const group = new THREE.Group();
      const pos = HOME_POS[station] || { x: 0, z: 0 };
      group.position.set(pos.x, 0, pos.z);
      group.userData.agentId = a.id;
      const col = new THREE.Color(a.color);

      const bodyMat = new THREE.MeshPhysicalMaterial({ color: col, roughness: 0.26, clearcoat: 1.0, clearcoatRoughness: 0.16, sheen: 0.6, sheenColor: new THREE.Color(0x9cc8ff) });

      const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 32), bodyMat);
      body.scale.set(0.92, 1.0, 0.9);
      body.position.y = 0.66;
      body.castShadow = true;
      group.add(body);

      const headPivot = new THREE.Group();
      headPivot.position.y = 1.42;
      group.add(headPivot);
      headPivot.add(roundedHead(col));

      const face = new THREE.Mesh(
        new THREE.SphereGeometry(0.42, 24, 24),
        new THREE.MeshPhysicalMaterial({ color: 0x0a0e18, roughness: 0.15, clearcoat: 1.0 })
      );
      face.scale.set(0.92, 0.66, 0.55);
      face.position.set(0, 0.0, 0.28);
      headPivot.add(face);

      const eyeMat = new THREE.MeshStandardMaterial({ color: 0xcdeeff, emissive: 0x7cc8ff, emissiveIntensity: 2.6, roughness: 0.2 });
      const eyeGeo = new THREE.BoxGeometry(0.11, 0.15, 0.04);
      const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
      eyeL.position.set(-0.14, 0.02, 0.48);
      const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
      eyeR.position.set(0.14, 0.02, 0.48);
      headPivot.add(eyeL, eyeR);

      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.16, 8), bodyMat);
      ant.position.y = 0.5;
      headPivot.add(ant);
      const antTip = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 16), eyeMat);
      antTip.position.y = 0.6;
      headPivot.add(antTip);

      const armGeo = new THREE.CapsuleGeometry(0.085, 0.16, 6, 12);
      const leftArm = new THREE.Mesh(armGeo, bodyMat);
      leftArm.position.set(-0.46, 0.66, 0);
      leftArm.castShadow = true;
      const rightArm = new THREE.Mesh(armGeo, bodyMat);
      rightArm.position.set(0.46, 0.66, 0);
      rightArm.castShadow = true;
      group.add(leftArm, rightArm);

      const legGeo = new THREE.CapsuleGeometry(0.1, 0.12, 6, 12);
      const legL = new THREE.Mesh(legGeo, bodyMat);
      legL.position.set(-0.18, 0.16, 0);
      legL.castShadow = true;
      const legR = new THREE.Mesh(legGeo, bodyMat);
      legR.position.set(0.18, 0.16, 0);
      legR.castShadow = true;
      group.add(legL, legR);

      const baseDisc = new THREE.Mesh(
        new THREE.CylinderGeometry(0.62, 0.66, 0.08, 48),
        new THREE.MeshPhysicalMaterial({ color: 0xf4f8ff, roughness: 0.3, clearcoat: 0.7 })
      );
      baseDisc.position.y = 0.04;
      baseDisc.receiveShadow = true;
      group.add(baseDisc);

      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.52, 0.035, 16, 64),
        new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 2.0, roughness: 0.3 })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.09;
      group.add(ring);

      const glowDisc = new THREE.Mesh(
        new THREE.CircleGeometry(0.5, 48),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.12 })
      );
      glowDisc.rotation.x = -Math.PI / 2;
      glowDisc.position.y = 0.085;
      group.add(glowDisc);

      scene.add(group);
      robots[a.id] = {
        group, headPivot, leftArm, rightArm, eyeL, eyeR, ring, glowDisc, body, legL, legR,
        phase: Math.random() * Math.PI * 2, blinkT: 2 + Math.random() * 3,
        home: { x: pos.x, z: pos.z }, beh: "idle", behTimer: 1 + Math.random() * 3,
        target: null, heading: Math.random() * Math.PI * 2, walkPhase: 0,
      };
    };
    agents.forEach((a, i) => buildRobot(a, i));

    // ---- life system ----
    const lerpAngle = (a: number, b: number, t: number) => {
      let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
      if (d < -Math.PI) d += Math.PI * 2;
      return a + d * t;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pickBehaviour = (r: any) => {
      const x = Math.random();
      if (x < 0.62) { r.beh = "walk"; r.target = { x: r.home.x, z: r.home.z }; r.behTimer = 3 + Math.random() * 3; }
      else if (x < 0.85) {
        const ang = Math.random() * Math.PI * 2, rad = 1.2 + Math.random() * 1.8;
        r.beh = "walk";
        r.target = { x: Math.max(-7, Math.min(7, r.home.x + Math.cos(ang) * rad)), z: Math.max(-5.5, Math.min(5.5, r.home.z + Math.sin(ang) * rad)) };
        r.behTimer = 3 + Math.random() * 3;
      } else { r.beh = "idle"; r.target = null; r.behTimer = 2 + Math.random() * 3; }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateLife = (r: any, dt: number) => {
      if (!lifeRef.current) {
        const g = r.group;
        g.position.x += (r.home.x - g.position.x) * 0.04;
        g.position.z += (r.home.z - g.position.z) * 0.04;
        r.beh = "idle"; r.target = null;
        r.group.rotation.y = r.heading;
        return;
      }
      r.behTimer -= dt;
      if (r.behTimer <= 0) pickBehaviour(r);
      if (r.beh === "walk" && r.target) {
        const g = r.group;
        const dx = r.target.x - g.position.x, dz = r.target.z - g.position.z;
        const dlen = Math.hypot(dx, dz);
        if (dlen < 0.15) { r.beh = "idle"; r.target = null; r.behTimer = 1.5 + Math.random() * 2.5; }
        else {
          const sp = 1.4 * dt;
          g.position.x += (dx / dlen) * sp;
          g.position.z += (dz / dlen) * sp;
          r.heading = lerpAngle(r.heading, Math.atan2(dx, dz), 0.15);
          r.walkPhase += dt * 10;
        }
      }
      r.group.rotation.y = r.heading;
    };

    // ---- controls ----
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const pick = (cx: number, cy: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((cx - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((cy - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const groups = Object.values(robots).map((x: any) => x.group);
      const hits = raycaster.intersectObjects(groups, true);
      if (hits.length) {
        let o: THREE.Object3D | null = hits[0].object;
        while (o && !o.userData.agentId) o = o.parent;
        if (o && o.userData.agentId) onSelectRef.current?.(o.userData.agentId);
      }
    };

    let dragging = false, lx = 0, ly = 0, moved = 0, pinchStart = 0, pinchRad = 0;
    const down = (x: number, y: number) => { dragging = true; lx = x; ly = y; moved = 0; };
    const move = (x: number, y: number) => {
      if (!dragging) return;
      const dx = x - lx, dy = y - ly; lx = x; ly = y;
      moved += Math.abs(dx) + Math.abs(dy);
      camTheta -= dx * 0.006;
      camPhi = Math.max(0.15, Math.min(Math.PI * 0.46, camPhi - dy * 0.006));
      focusActive = false;
    };
    const up = (x: number, y: number) => { dragging = false; if (moved < 6) pick(x, y); };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dist = (t: any) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const el = renderer.domElement;
    const onMouseDown = (e: MouseEvent) => down(e.clientX, e.clientY);
    const onMouseMove = (e: MouseEvent) => move(e.clientX, e.clientY);
    const onMouseUp = (e: MouseEvent) => up(e.clientX, e.clientY);
    const onWheel = (e: WheelEvent) => { camRadius = Math.max(6, Math.min(24, camRadius + e.deltaY * 0.01)); focusActive = false; };
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) down(e.touches[0].clientX, e.touches[0].clientY);
      else if (e.touches.length === 2) { pinchStart = dist(e.touches); pinchRad = camRadius; }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 1) move(e.touches[0].clientX, e.touches[0].clientY);
      else if (e.touches.length === 2) { const d = dist(e.touches); camRadius = Math.max(6, Math.min(24, (pinchRad * pinchStart) / d)); focusActive = false; }
    };
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
          const g = r.group;
          g.position.x += (r.home.x - g.position.x) * 0.05;
          g.position.z += (r.home.z - g.position.z) * 0.05;
          r.beh = "idle"; r.target = null;
        } else {
          updateLife(r, dt);
        }
        const walking = r.beh === "walk" && r.target && !isActive;

        const bob = Math.sin(t * 1.6 + r.phase) * 0.03;
        r.group.position.y = walking ? Math.abs(Math.sin(r.walkPhase)) * 0.04 : bob;
        r.body.scale.y = 0.92 + Math.sin(t * 2.2 + r.phase) * 0.02;
        r.headPivot.rotation.y = Math.sin(t * 0.6 + r.phase) * 0.18;
        r.headPivot.rotation.x = Math.sin(t * 0.9 + r.phase) * 0.05;

        if (walking) {
          r.legL.rotation.x = Math.sin(r.walkPhase) * 0.6;
          r.legR.rotation.x = -Math.sin(r.walkPhase) * 0.6;
          r.leftArm.rotation.x = -Math.sin(r.walkPhase) * 0.5;
          r.rightArm.rotation.x = Math.sin(r.walkPhase) * 0.5;
          r.rightArm.rotation.z = 0; r.leftArm.rotation.z = 0;
        } else {
          r.legL.rotation.x += (0 - r.legL.rotation.x) * 0.2;
          r.legR.rotation.x += (0 - r.legR.rotation.x) * 0.2;
          r.leftArm.rotation.x += (0 - r.leftArm.rotation.x) * 0.2;
          r.rightArm.rotation.x += (0 - r.rightArm.rotation.x) * 0.2;
        }

        r.blinkT -= dt;
        if (r.blinkT <= 0) {
          const k = Math.max(0, 1 - Math.abs(r.blinkT + 0.06) / 0.06);
          const s = 1 - k;
          r.eyeL.scale.y = s; r.eyeR.scale.y = s;
          if (r.blinkT < -0.12) { r.blinkT = 2 + Math.random() * 4; r.eyeL.scale.y = 1; r.eyeR.scale.y = 1; }
        }

        if (isActive) {
          const p = 0.5 + Math.sin(t * 4) * 0.5;
          r.ring.material.emissiveIntensity = 2.0 + p * 1.6;
          r.glowDisc.material.opacity = 0.12 + p * 0.18;
          r.rightArm.rotation.x = 0;
          const waveSpeed = speaking ? 9 : 6;
          r.rightArm.rotation.z = -0.4 - Math.abs(Math.sin(t * waveSpeed)) * 0.8;
          r.group.scale.setScalar(1.12 + Math.sin(t * 3) * 0.02);
        } else {
          r.ring.material.emissiveIntensity = 1.6;
          r.glowDisc.material.opacity = 0.1;
          if (!walking) {
            r.rightArm.rotation.z = Math.sin(t * 1.5 + r.phase) * 0.12;
            r.leftArm.rotation.z = -Math.sin(t * 1.5 + r.phase) * 0.12;
          }
          r.group.scale.setScalar(1.0);
        }
      });

      if (focusActive && activeId && robots[activeId]) {
        const p = robots[activeId].group.position;
        camTarget.lerp(new THREE.Vector3(p.x, 0.7, p.z), 0.06);
        camRadius += (8 - camRadius) * 0.05;
      } else {
        camTarget.lerp(new THREE.Vector3(0, 0.6, 0), 0.04);
      }
      updateCamera();
      renderer.render(scene, camera);
    };
    updateCamera();
    animate();

    const ro = new ResizeObserver(() => {
      camera.aspect = W() / H();
      camera.updateProjectionMatrix();
      renderer.setSize(W(), H());
    });
    ro.observe(mount);

    return () => {
      disposed = true;
      void disposed;
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
        if (m.material) {
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          mats.forEach((mm) => mm.dispose());
        }
      });
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative min-h-0 w-full flex-1 overflow-hidden">
      <div ref={mountRef} className="absolute inset-0" />
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-black/55 to-transparent px-4 pb-6 pt-2 text-center">
        <p className="text-[13px] font-bold text-[#cfe0ff]">{TITLE}</p>
        <p className="mt-0.5 text-[11px] text-[#6b7a99]">{HINT}</p>
      </div>
      <button
        type="button"
        onClick={() => setLifeOn((v) => !v)}
        className="absolute left-1/2 top-12 z-10 -translate-x-1/2 rounded-full border border-[#2a3550] bg-[#161c2e] px-3.5 py-1.5 text-[12px] font-bold text-[#9fb0d0]"
      >
        {lifeOn ? "● الحياة مفعّلة" : "○ الحياة موقفة"}
      </button>
    </div>
  );
}
