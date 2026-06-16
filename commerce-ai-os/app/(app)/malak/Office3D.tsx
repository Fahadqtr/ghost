"use client";

// "مبنى ملاك" — لكل وكيل غرفته الخاصة (خلفية مكتب آيزومترك على طراز AXIAL).
// عند الفتح: الوكلاء "ينزلون" إلى غرفهم بأنميشن متدرّج كأنهم حقيقيون.
// الوكيل الذي يعمل الآن: تظهر غرفته مضيئة، شخصيته تتحرّك بنشاط، ولافتة "يشتغل…"
// مع حالته الحيّة. خفيف بالكامل: صور + CSS، بدون WebGL.

export interface OfficeAgent {
  id: string;
  name: string;
  role: string;
  color: string;
}

// تحويل لون hex إلى درجة لون (hue) لتلوين الشخصية (الأساس أزرق ≈ 210°)
function hueOf(hex: string): number {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 210;
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

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
  const working = state === "thinking" || state === "speaking" || state === "listening";
  const workLabel =
    state === "thinking" ? "يفكّر…" : state === "speaking" ? "يتكلّم…" : state === "listening" ? "يسمع…" : "نشِط";

  return (
    <div className="min-h-0 w-full flex-1 overflow-y-auto bg-[#f4f6fb] px-3 py-3 sm:px-5">
      <style>{`
        @keyframes mkDrop { 0%{transform:translateY(-220%) scale(.6);opacity:0} 70%{opacity:1} 100%{transform:translateY(0) scale(1);opacity:1} }
        @keyframes mkBob { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-5px)} }
        @keyframes mkWork { 0%,100%{transform:translateY(0) rotate(-2deg)} 50%{transform:translateY(-9px) rotate(2deg)} }
        @keyframes mkRing { 0%,100%{transform:translate(-50%,-50%) scale(1);opacity:.5} 50%{transform:translate(-50%,-50%) scale(1.3);opacity:.12} }
        @keyframes mkDots { 0%{opacity:.2} 50%{opacity:1} 100%{opacity:.2} }
      `}</style>

      <div className="mx-auto grid max-w-4xl gap-3 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))] sm:gap-4">
        {agents.map((a, i) => {
          const on = a.id === activeAgent;
          const busy = on && working;
          const hueShift = Math.round(hueOf(a.color) - 210);

          return (
            <div
              key={a.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelect?.(a.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect?.(a.id);
                }
              }}
              className="group relative aspect-square cursor-pointer overflow-hidden rounded-2xl bg-white transition hover:-translate-y-0.5"
              style={{
                border: on ? `2px solid ${a.color}` : "1px solid #e6e9f2",
                boxShadow: on ? `0 10px 30px ${a.color}55` : "0 2px 8px rgba(20,30,60,0.06)",
                transition: "box-shadow .3s, border-color .3s, transform .2s",
              }}
            >
              {/* تلميح: اضغط للتحدّث */}
              <div
                className="absolute left-2 top-2 z-20 flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-bold text-white opacity-0 transition group-hover:opacity-100"
                style={on ? { opacity: 1 } : undefined}
              >
                💬 تحدّث
              </div>
              {/* خلفية الغرفة */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/room-tile.png"
                alt=""
                className="absolute inset-0 h-full w-full object-cover"
                draggable={false}
              />

              {/* لافتة الاسم */}
              <div
                className="absolute right-2 top-2 z-20 flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-bold shadow"
                style={{ background: on ? a.color : "rgba(255,255,255,0.92)", color: on ? "#fff" : "#1e2433" }}
              >
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: on ? "#fff" : a.color }} />
                {a.name}
              </div>

              {/* الشخصية */}
              <div
                className="absolute z-10"
                style={{
                  left: "52%",
                  bottom: "12%",
                  width: "48%",
                  transform: "translateX(-50%)",
                  animation: `mkDrop .8s cubic-bezier(.34,1.56,.64,1) ${i * 0.1}s backwards`,
                }}
              >
                {/* هالة العمل */}
                {busy ? (
                  <span
                    aria-hidden
                    style={{
                      position: "absolute",
                      left: "50%",
                      top: "55%",
                      width: "120%",
                      aspectRatio: "1",
                      borderRadius: 999,
                      background: `radial-gradient(circle, ${a.color}aa 0%, ${a.color}00 70%)`,
                      animation: "mkRing 1.6s ease-in-out infinite",
                    }}
                  />
                ) : null}

                {/* ظل أرضي */}
                <span
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: "50%",
                    bottom: "-6%",
                    width: "60%",
                    height: "10%",
                    transform: "translateX(-50%)",
                    borderRadius: 999,
                    background: "rgba(0,0,0,0.18)",
                    filter: "blur(3px)",
                  }}
                />

                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/agent-sprite.png"
                  alt={a.name}
                  draggable={false}
                  style={{
                    position: "relative",
                    width: "100%",
                    filter: `hue-rotate(${hueShift}deg) saturate(1.15)`,
                    animation: busy ? "mkWork .9s ease-in-out infinite" : `mkBob ${3 + (i % 4) * 0.4}s ease-in-out infinite`,
                  }}
                />
              </div>

              {/* لافتة "يشتغل…" */}
              {busy ? (
                <div
                  className="absolute bottom-2 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold text-white shadow-lg"
                  style={{ background: a.color }}
                >
                  💻 {workLabel}
                  <span className="flex gap-0.5">
                    {[0, 1, 2].map((d) => (
                      <span
                        key={d}
                        className="inline-block h-1 w-1 rounded-full bg-white"
                        style={{ animation: `mkDots 1s ${d * 0.2}s infinite` }}
                      />
                    ))}
                  </span>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
