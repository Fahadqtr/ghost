"use client";

// "مكتب ملاك" — مشهد ثلاثي الأبعاد حقيقي: روبوت RobotExpressive متحرّك (motion
// capture) لكل وكيل، موزّعين في غرفة، بكاميرا تدور بالسحب ونقر للاختيار.
// الوكيل النشط: يلوّح + هالة + الكاميرا تركّز عليه. الباقون: حركة Idle.
// نفس واجهة المكوّن القديم (agents, activeAgent, state, onSelect) — لا يلمس
// منطق المحادثة. يقرأ الـprops الحيّة عبر refs ولا يعيد بناء المشهد.

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { CSS2DRenderer, CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";

export interface OfficeAgent {
  id: string;
  name: string;
  role: string;
  color: string;
}

type Robot = {
  id: string;
  group: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: Record<string, THREE.AnimationAction>;
  current: THREE.AnimationAction | null;
  labelEl: HTMLDivElement;
  name: string;
  role: string;
  color: string;
};

const ANIM_IDLE = "Idle";
const ANIM_GREET = "Wave";

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
  // إبقاء الـrefs محدّثة كل رندر (تُقرأ داخل حلقة الأنميشن بدون إعادة بناء).
  activeRef.current = activeAgent;
  stateRef.current = state;
  onSelectRef.current = onSelect;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let raf = 0;
    let disposed = false;

    const w = () => mount.clientWidth || 800;
    const h = () => mount.clientHeight || 500;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0b1020");

    const camera = new THREE.PerspectiveCamera(45, w() / h(), 0.1, 100);
    camera.position.set(6.5, 6, 10);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(w(), h());
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(w(), h());
    labelRenderer.domElement.style.position = "absolute";
    labelRenderer.domElement.style.top = "0";
    labelRenderer.domElement.style.left = "0";
    labelRenderer.domElement.style.pointerEvents = "none";
    mount.appendChild(labelRenderer.domElement);

    // ---- إضاءة استوديو ----
    scene.add(new THREE.HemisphereLight(0xffffff, 0x35406b, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(6, 11, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 45;
    key.shadow.camera.left = -14;
    key.shadow.camera.right = 14;
    key.shadow.camera.top = 14;
    key.shadow.camera.bottom = -14;
    key.shadow.bias = -0.0004;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xaac4ff, 0.55);
    fill.position.set(-7, 5, -3);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0x3b82f6, 0.9);
    rim.position.set(0, 4, -9);
    scene.add(rim);

    // ---- أرضية ----
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(15, 64),
      new THREE.MeshStandardMaterial({ color: 0x151b30, roughness: 0.95, metalness: 0 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    const grid = new THREE.GridHelper(30, 30, 0x2c3658, 0x1c2440);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.25;
    scene.add(grid);

    // ---- هالة الوكيل النشط ----
    const halo = new THREE.Mesh(
      new THREE.RingGeometry(0.62, 0.95, 56),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.65, side: THREE.DoubleSide })
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = 0.03;
    halo.visible = false;
    scene.add(halo);

    // ---- تحكّم الكاميرا ----
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 6;
    controls.maxDistance = 17;
    controls.minPolarAngle = 0.55;
    controls.maxPolarAngle = 1.4;
    controls.target.set(0, 1.1, 0);

    const clock = new THREE.Clock();
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const robots: Robot[] = [];
    let lastActive = "";
    const camTarget = new THREE.Vector3(0, 1.1, 0);

    function labelHtml(name: string, sub: string, active: boolean, color: string) {
      return (
        `<div style="display:flex;align-items:center;gap:5px;white-space:nowrap;font-family:system-ui,sans-serif;` +
        `font-size:${active ? 12 : 10}px;font-weight:700;color:${active ? "#fff" : "#dbe2f0"};` +
        `background:${active ? color : "rgba(13,18,34,0.7)"};border:1.5px solid ${color};border-radius:999px;` +
        `padding:${active ? "3px 9px" : "2px 7px"};box-shadow:${active ? `0 4px 16px ${color}aa` : "0 2px 8px rgba(0,0,0,0.4)"};` +
        `transform:translateY(${active ? -2 : 0}px);transition:all .2s">` +
        `<span style="width:6px;height:6px;border-radius:999px;background:${active ? "#fff" : color}"></span>` +
        `${name}${active && sub ? ` · <span style="font-weight:600;opacity:.95">${sub}</span>` : ""}</div>`
      );
    }
    const subFor = (s: string) =>
      s === "thinking" ? "يفكّر…" : s === "speaking" ? "يتكلّم…" : s === "listening" ? "يسمع…" : "";

    function fade(r: Robot, name: string, loop: THREE.AnimationActionLoopStyles, clamp = false) {
      const next = r.actions[name] || r.actions[ANIM_IDLE];
      if (!next || next === r.current) return;
      next.reset();
      next.setLoop(loop, loop === THREE.LoopOnce ? 1 : Infinity);
      next.clampWhenFinished = clamp;
      next.enabled = true;
      next.fadeIn(0.3);
      if (r.current) r.current.fadeOut(0.3);
      r.current = next;
    }

    // ---- تحميل الموديل وبناء الروبوتات ----
    const loader = new GLTFLoader();
    loader.load(
      "/models/RobotExpressive.glb",
      (gltf) => {
        if (disposed) return;
        const clips = gltf.animations;
        const box = new THREE.Box3().setFromObject(gltf.scene);
        const modelH = box.max.y - box.min.y || 3.6;
        const targetH = 1.7;
        const s = targetH / modelH;
        const n = agents.length;
        const gap = 2.1;

        agents.forEach((a, i) => {
          const group = cloneSkeleton(gltf.scene) as unknown as THREE.Group;
          const color = new THREE.Color(a.color);
          group.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if ((mesh as THREE.Mesh).isMesh) {
              mesh.castShadow = true;
              mesh.receiveShadow = true;
              const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
              mesh.material = mats.map((m) => {
                const c = (m as THREE.Material).clone() as THREE.MeshStandardMaterial;
                if (c.color) c.color.copy(color);
                if ("emissive" in c && c.emissive) {
                  c.emissive.copy(color).multiplyScalar(0.18);
                }
                if ("metalness" in c) c.metalness = 0.25;
                if ("roughness" in c) c.roughness = 0.55;
                return c;
              });
              if (Array.isArray(mesh.material) && mesh.material.length === 1) mesh.material = mesh.material[0];
            }
          });

          // ترتيب على قوس يواجه الكاميرا
          const x = (i - (n - 1) / 2) * gap;
          const z = -Math.abs(x) * 0.28;
          group.scale.setScalar(s);
          group.position.set(x, -box.min.y * s, z);
          group.rotation.y = -x * 0.05;
          scene.add(group);

          const mixer = new THREE.AnimationMixer(group);
          const actions: Record<string, THREE.AnimationAction> = {};
          for (const clip of clips) actions[clip.name] = mixer.clipAction(clip);
          // ابدأ Idle
          const idle = actions[ANIM_IDLE] || (clips[0] && mixer.clipAction(clips[0]));
          if (idle) {
            idle.play();
          }
          // عند انتهاء حركة لمرة واحدة (Wave) ارجع لـ Idle
          mixer.addEventListener("finished", () => {
            const r = robots.find((rr) => rr.mixer === mixer);
            if (r) fade(r, ANIM_IDLE, THREE.LoopRepeat);
          });

          // لافتة الاسم
          const el = document.createElement("div");
          el.innerHTML = labelHtml(a.name, "", false, a.color);
          const labelObj = new CSS2DObject(el);
          labelObj.position.set(0, (targetH + 0.45) / s, 0);
          group.add(labelObj);

          robots.push({
            id: a.id,
            group,
            mixer,
            actions,
            current: idle ?? null,
            labelEl: el,
            name: a.name,
            role: a.role,
            color: a.color,
          });
        });
      },
      undefined,
      (err) => console.error("[Office3DRobot] GLB load failed", err)
    );

    // ---- اختيار وكيل: تمييز النقر عن السحب ----
    let downX = 0,
      downY = 0,
      downT = 0;
    const onDown = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
      downT = performance.now();
    };
    const onUp = (e: PointerEvent) => {
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (moved > 6 || performance.now() - downT > 500) return; // سحب، مو نقرة
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      for (const r of robots) {
        if (raycaster.intersectObject(r.group, true).length) {
          onSelectRef.current?.(r.id);
          break;
        }
      }
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    // ---- حلقة الرسم ----
    const animate = () => {
      raf = requestAnimationFrame(animate);
      const dt = clock.getDelta();
      for (const r of robots) r.mixer.update(dt);

      const act = activeRef.current;
      if (act !== lastActive && robots.length) {
        lastActive = act;
        for (const r of robots) {
          const on = r.id === act;
          if (on) fade(r, ANIM_GREET, THREE.LoopOnce, true);
          else fade(r, ANIM_IDLE, THREE.LoopRepeat);
          r.labelEl.innerHTML = labelHtml(r.name, subFor(stateRef.current), on, r.color);
        }
        const ar = robots.find((r) => r.id === act);
        if (ar) {
          halo.visible = true;
          halo.position.x = ar.group.position.x;
          halo.position.z = ar.group.position.z;
          (halo.material as THREE.MeshBasicMaterial).color.set(ar.color);
          camTarget.set(ar.group.position.x, 1.1, ar.group.position.z);
        }
      }

      // تحديث نص حالة الوكيل النشط حيًّا (يفكّر/يتكلّم)
      const ar = robots.find((r) => r.id === activeRef.current);
      if (ar) ar.labelEl.innerHTML = labelHtml(ar.name, subFor(stateRef.current), true, ar.color);

      const tnow = clock.elapsedTime;
      if (halo.visible) halo.scale.setScalar(1 + Math.sin(tnow * 3) * 0.09);
      controls.target.lerp(camTarget, 0.05);
      controls.update();
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    };
    animate();

    // ---- resize ----
    const ro = new ResizeObserver(() => {
      camera.aspect = w() / h();
      camera.updateProjectionMatrix();
      renderer.setSize(w(), h());
      labelRenderer.setSize(w(), h());
    });
    ro.observe(mount);

    // ---- cleanup ----
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      controls.dispose();
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
      if (labelRenderer.domElement.parentNode === mount) mount.removeChild(labelRenderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={mountRef} className="relative min-h-0 w-full flex-1 overflow-hidden" />;
}
