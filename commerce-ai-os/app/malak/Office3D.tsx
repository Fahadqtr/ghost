"use client";

// مشهد "مقر ملاك" — خلفية رِندر احترافي (آيزومترك على طريقة AXIAL) + طبقة حيّة
// لوكلائنا التسعة فوقها: لكل وكيل لافتة عند محطّته، والوكيل النشط يضيء، يكبر،
// تظهر له هالة نابضة ولافتة بحالته الحيّة (يفكّر/يتكلّم/يسمع). خفيف جدًا (صورة + CSS).

export interface OfficeAgent {
  id: string;
  name: string;
  role: string;
  color: string;
}

// مواقع الوكلاء فوق الخلفية (نسبة مئوية). مُوزّعة على محطّات المشهد.
const SPOTS: Record<string, { l: number; t: number }> = {
  faisal: { l: 22, t: 57 }, // عند الخزنة (التقني)
  rashid: { l: 31, t: 47 },
  razan: { l: 35, t: 65 },
  malak: { l: 43, t: 56 }, // المكتب
  latifa: { l: 51, t: 71 }, // اللاونج
  noor: { l: 54, t: 40 }, // السبورة
  reem: { l: 61, t: 55 },
  salem: { l: 65, t: 68 },
  bayan: { l: 72, t: 46 }, // الكانبان
  siraj: { l: 79, t: 60 }, // البوابة
};
const FALLBACK: { l: number; t: number }[] = [
  { l: 40, t: 50 },
  { l: 50, t: 55 },
  { l: 60, t: 50 },
  { l: 45, t: 62 },
  { l: 55, t: 45 },
];

export default function Office3D({
  agents,
  activeAgent,
  state,
}: {
  agents: OfficeAgent[];
  activeAgent: string;
  state: string;
}) {
  const status =
    state === "thinking" ? "يفكّر…" : state === "speaking" ? "يتكلّم…" : state === "listening" ? "يسمع…" : null;

  return (
    <div className="relative min-h-0 w-full flex-1 overflow-hidden">
      <style>{`
        @keyframes mkPulse { 0%,100%{transform:translate(-50%,-50%) scale(1);opacity:.55} 50%{transform:translate(-50%,-50%) scale(1.35);opacity:.15} }
      `}</style>

      {/* الخلفية: رِندر المكتب */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/office-stage.png"
        alt="مقر ملاك"
        className="absolute inset-0 h-full w-full object-cover"
        draggable={false}
      />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/10 via-transparent to-black/25" />

      {/* عنوان */}
      <div className="absolute right-3 top-3 rounded-full bg-white/85 px-3 py-1 text-[11px] font-bold text-[#1e2433] shadow">
        🏢 مقر ملاك — {agents.length} وكلاء
      </div>

      {/* طبقة الوكلاء */}
      {agents.map((a, i) => {
        const spot = SPOTS[a.id] ?? FALLBACK[i % FALLBACK.length];
        const on = a.id === activeAgent;
        return (
          <div
            key={a.id}
            style={{
              position: "absolute",
              left: `${spot.l}%`,
              top: `${spot.t}%`,
              transform: "translate(-50%,-50%)",
              zIndex: on ? 30 : 10,
            }}
          >
            {/* هالة نابضة للوكيل النشط */}
            {on ? (
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  width: 64,
                  height: 64,
                  borderRadius: 999,
                  background: `radial-gradient(circle, ${a.color}cc 0%, ${a.color}00 70%)`,
                  animation: "mkPulse 1.8s ease-in-out infinite",
                }}
              />
            ) : null}

            {/* اللافتة */}
            <div
              style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                gap: 5,
                whiteSpace: "nowrap",
                fontFamily: "system-ui, sans-serif",
                fontSize: on ? 12 : 10,
                fontWeight: 700,
                color: on ? "#fff" : "#1e2433",
                background: on ? a.color : "rgba(255,255,255,0.92)",
                border: `1.5px solid ${a.color}`,
                borderRadius: 999,
                padding: on ? "3px 10px" : "2px 7px",
                boxShadow: on ? `0 6px 18px ${a.color}88` : "0 3px 10px rgba(0,0,0,0.2)",
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: 999, background: on ? "#fff" : a.color }} />
              {a.name}
              {on && status ? <span style={{ fontWeight: 600, opacity: 0.95 }}> · {status}</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
