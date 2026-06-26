"use client";

// ملاك — Mission Control HUD (JARVIS skin, REAL data). The dashboard pulls live
// store data from /api/malak/scan: STORE VITALS = real coverage %, ACTION QUEUE
// = the prioritized issues, ACTIVITY LOG = real malak_audit, PLATFORMS = sync
// status, PRIMARY OBJECTIVE = today's priority. Cyan-on-near-black monospace HUD.

import { useEffect, useRef, useState } from "react";
import JarvisOrb, { type OrbState } from "../JarvisOrb";

const CY = "#4cc3ff";
const CY_DIM = "rgba(76,195,255,0.55)";
const CY_FAINT = "rgba(76,195,255,0.25)";
const AMBER = "#ffb454";
const GREEN = "#3ddc97";
const ROSE = "#ff6b8a";

const STATE_TABS: { id: OrbState; label: string }[] = [
  { id: "idle", label: "IDLE" },
  { id: "listening", label: "LISTENING" },
  { id: "thinking", label: "THINKING" },
  { id: "speaking", label: "TALKING" },
];

const ACTION_AR: Record<string, string> = {
  update_stock: "مخزون", set_price: "سعر", set_approval: "اعتماد",
  add_product: "منتج", set_image: "صورة", sync_availability: "مزامنة",
};

const PLATFORMS = ["مليكاس", "Pure Seoul", "Talabat", "Rafeeq", "Shopify"];

interface Scan {
  total: number; approved: number; rejected: number; missingImages: number;
  lowStock: number; outOfStock: number; suspiciousPrice: number; channelMismatch: number;
  issues: { key: string; icon: string; title: string; count: number; prompt: string; severity: string }[];
  recentActivity: { created_at: string; action_type: string; sku: string | null; old_value: string | null; new_value: string | null; status: string | null }[];
  priority: string; allClear: boolean;
}

function Bracket({ at }: { at: string }) {
  return <span className={`pointer-events-none absolute h-7 w-7 ${at}`} style={{ borderColor: CY_DIM }} />;
}
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-[9px] tracking-widest" style={{ borderColor: CY_FAINT, color: CY_DIM }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: CY, boxShadow: `0 0 6px ${CY}` }} />
      {children}
    </span>
  );
}
function Panel({ title, right, children, className = "" }: { title: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={`relative rounded border p-2.5 ${className}`} style={{ borderColor: CY_FAINT, background: "rgba(8,20,40,0.35)" }}>
      <div className="mb-2 flex items-center justify-between">
        <p className="font-mono text-[9px] tracking-[0.3em]" style={{ color: CY_DIM }}>{`{ ${title} }`}</p>
        {right}
      </div>
      {children}
    </div>
  );
}
function VitalBar({ label, pct, note, tone = CY }: { label: string; pct: number; note: string; tone?: string }) {
  return (
    <div className="mb-2">
      <div className="mb-0.5 flex items-center justify-between font-mono text-[9px]" style={{ color: "rgba(174,230,255,0.85)" }}>
        <span style={{ color: CY_DIM }}>{label}</span>
        <span>{note}</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full" style={{ background: "rgba(76,195,255,0.12)" }}>
        <div className="h-full rounded-full" style={{ width: `${Math.max(2, Math.min(100, pct))}%`, background: tone, boxShadow: `0 0 8px ${tone}` }} />
      </div>
    </div>
  );
}

function timeArab(iso: string): string {
  try { return new Intl.DateTimeFormat("ar", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Qatar" }).format(new Date(iso)); }
  catch { return ""; }
}

export default function MalakHud() {
  const [state, setState] = useState<OrbState>("idle");
  const [now, setNow] = useState("--:--:--");
  const [orbSize, setOrbSize] = useState(360);
  const [scan, setScan] = useState<Scan | null>(null);
  const [loading, setLoading] = useState(true);
  const levelRef = useRef(0);

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, "0");
      setNow(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(Math.floor(d.getMilliseconds() / 10))}`);
    };
    tick();
    const id = setInterval(tick, 80);
    const fit = () => setOrbSize(Math.min(440, Math.round(Math.min(window.innerWidth * 0.4, window.innerHeight * 0.55))));
    fit();
    window.addEventListener("resize", fit);
    return () => { clearInterval(id); window.removeEventListener("resize", fit); };
  }, []);

  useEffect(() => {
    setState("thinking");
    (async () => {
      try {
        const r = await fetch("/api/malak/scan");
        const d = await r.json();
        if (!d?.error) setScan(d);
      } catch { /* keep placeholders */ }
      finally { setLoading(false); setState("idle"); }
    })();
  }, []);

  const pct = (x: number, of: number) => (of > 0 ? Math.round((x / of) * 100) : 0);
  const t = scan?.total ?? 0;
  const synced = (scan?.channelMismatch ?? 0) === 0;

  return (
    <div dir="ltr" className="relative -m-4 min-h-[calc(100vh-2rem)] overflow-hidden font-mono sm:-m-6" style={{ background: "#020510", color: CY }}>
      <style>{`
        @keyframes eq { 0%,100% { transform: scaleY(0.2); } 50% { transform: scaleY(1); } }
        @keyframes hudScan { to { transform: translateY(100%); } }
      `}</style>

      <div className="pointer-events-none absolute inset-0 opacity-[0.10]" style={{
        backgroundImage: `linear-gradient(${CY} 1px, transparent 1px), linear-gradient(90deg, ${CY} 1px, transparent 1px)`, backgroundSize: "40px 40px",
      }} />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-24 opacity-30" style={{ background: `linear-gradient(${CY}22, transparent)`, animation: "hudScan 6s linear infinite" }} />

      <Bracket at="left-3 top-3 border-l-2 border-t-2" />
      <Bracket at="right-3 top-3 border-r-2 border-t-2" />
      <Bracket at="left-3 bottom-3 border-l-2 border-b-2" />
      <Bracket at="right-3 bottom-3 border-r-2 border-b-2" />

      {/* HEADER */}
      <div className="relative z-10 flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
        <div>
          <p className="text-[13px] font-bold tracking-[0.2em]" style={{ color: "#cfeeff" }}>MALIKA&apos;S UNIVERSE <span style={{ color: CY_DIM }}>// COMMERCE CONTROL</span></p>
          <p className="text-[9px] tracking-[0.25em]" style={{ color: CY_DIM }}>M.A.L.A.K · نظام إدارة المتجر الذكي</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Chip>ONLINE</Chip><Chip>SECURE</Chip><Chip>{synced ? "SYNCED" : "SYNC NEEDED"}</Chip><Chip>AUTH-LVL9</Chip>
          </div>
        </div>
        <div className="flex items-center gap-1 rounded border p-1" style={{ borderColor: CY_FAINT }}>
          {STATE_TABS.map((s) => (
            <button key={s.id} onClick={() => setState(s.id)} className="rounded px-2.5 py-1 text-[9px] tracking-widest transition"
              style={state === s.id ? { background: "rgba(76,195,255,0.18)", color: "#cfeeff", boxShadow: `inset 0 0 10px ${CY}44` } : { color: CY_DIM }}>{s.label}</button>
          ))}
        </div>
        <div className="text-right">
          <p className="text-[26px] font-bold leading-none tracking-wider" style={{ color: "#cfeeff", textShadow: `0 0 12px ${CY}88` }}>{now}</p>
          <p className="mt-1 text-[9px] tracking-widest" style={{ color: CY_DIM }}>منتجات: {t} · معتمد: {scan?.approved ?? "—"}</p>
          <p className="text-[9px] tracking-widest" style={{ color: CY_DIM }}>DOHA · QA</p>
        </div>
      </div>

      {/* MAIN GRID */}
      <div className="relative z-10 grid grid-cols-12 gap-3 px-5 pt-4">
        {/* LEFT */}
        <div className="col-span-3 space-y-3">
          <Panel title="STORE VITALS">
            <VitalBar label="CATALOG معتمد" pct={pct(scan?.approved ?? 0, t)} note={`${scan?.approved ?? 0}/${t}`} tone={GREEN} />
            <VitalBar label="IN-STOCK متوفّر" pct={pct(t - (scan?.outOfStock ?? 0), t)} note={`نافد ${scan?.outOfStock ?? 0}`} tone={(scan?.outOfStock ?? 0) ? AMBER : GREEN} />
            <VitalBar label="IMAGES صور" pct={pct(t - (scan?.missingImages ?? 0), t)} note={`ناقص ${scan?.missingImages ?? 0}`} tone={(scan?.missingImages ?? 0) ? CY : GREEN} />
            <VitalBar label="PRICING تسعير" pct={pct(t - (scan?.suspiciousPrice ?? 0), t)} note={`مشكلة ${scan?.suspiciousPrice ?? 0}`} tone={(scan?.suspiciousPrice ?? 0) ? AMBER : GREEN} />
            <VitalBar label="SYNC مزامنة" pct={synced ? 100 : 60} note={synced ? "متطابق" : `${scan?.channelMismatch} تعارض`} tone={synced ? GREEN : ROSE} />
          </Panel>

          <Panel title="ACTION QUEUE" right={<span className="text-[8.5px]" style={{ color: CY_DIM }}>{scan?.issues?.length ?? 0}</span>}>
            {scan?.allClear ? (
              <p className="py-2 text-center text-[10px]" style={{ color: GREEN }}>✓ كل شي تمام</p>
            ) : (
              <div className="space-y-1.5">
                {(scan?.issues ?? []).map((is) => (
                  <a key={is.key} href="/malak" className="flex items-center justify-between gap-2 rounded border px-2 py-1.5 transition hover:bg-white/5"
                    style={{ borderColor: is.severity === "high" ? "rgba(255,107,138,0.4)" : is.severity === "med" ? "rgba(255,180,84,0.35)" : CY_FAINT }}>
                    <span className="text-[9px]" style={{ color: "rgba(174,230,255,0.85)" }}>{is.icon} {is.title}</span>
                    <span className="font-bold text-[11px]" style={{ color: is.severity === "high" ? ROSE : is.severity === "med" ? AMBER : CY }}>{is.count}</span>
                  </a>
                ))}
                {loading ? <p className="py-2 text-center text-[9px]" style={{ color: CY_DIM }}>…يفحص</p> : null}
              </div>
            )}
          </Panel>
        </div>

        {/* CENTER */}
        <div className="col-span-6 flex flex-col items-center justify-start pt-4">
          <JarvisOrb state={state} size={orbSize} levelRef={levelRef} />
          <p className="mt-1 text-[10px] tracking-[0.35em]" style={{ color: CY_DIM }}>
            {loading ? "SCANNING" : state === "speaking" ? "RESPONDING" : state === "thinking" ? "PROCESSING" : "STANDBY"}
          </p>
        </div>

        {/* RIGHT */}
        <div className="col-span-3 space-y-3">
          <Panel title="PLATFORMS">
            <div className="space-y-1.5">
              {PLATFORMS.map((p) => {
                const flagged = !synced && p === "Shopify";
                return (
                  <div key={p} className="flex items-center justify-between text-[9px]" style={{ color: "rgba(174,230,255,0.8)" }}>
                    <span>{p}</span>
                    <span className="flex items-center gap-1.5" style={{ color: flagged ? ROSE : GREEN }}>
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: flagged ? ROSE : GREEN, boxShadow: `0 0 6px ${flagged ? ROSE : GREEN}` }} />
                      {flagged ? "MISMATCH" : "ALIGNED"}
                    </span>
                  </div>
                );
              })}
            </div>
          </Panel>

          <Panel title="AUDIO I/O">
            <div className="flex h-9 items-center gap-[2px]">
              {Array.from({ length: 36 }).map((_, i) => (
                <span key={i} className="flex-1 rounded-full" style={{
                  height: "100%", background: CY, opacity: 0.5,
                  animation: state === "speaking" || state === "listening" ? `eq ${0.6 + (i % 5) * 0.12}s ${i * 0.03}s ease-in-out infinite` : "none",
                  transform: state === "speaking" || state === "listening" ? undefined : "scaleY(0.18)",
                }} />
              ))}
            </div>
            <p className="mt-1 text-[8.5px] tracking-widest" style={{ color: CY_FAINT }}>48kHz · 24bit</p>
          </Panel>

          <Panel title="ACTIVITY LOG" right={<a href="/malak/audit" className="text-[8.5px] underline" style={{ color: CY_DIM }}>الكل</a>}>
            <div className="space-y-1 font-mono text-[8.5px] leading-relaxed">
              {(scan?.recentActivity ?? []).length === 0 ? (
                <p className="py-1 text-center" style={{ color: CY_FAINT }}>{loading ? "…" : "ما في نشاط بعد"}</p>
              ) : (scan?.recentActivity ?? []).map((a, i) => (
                <div key={i} className="flex gap-2" style={{ color: "rgba(174,230,255,0.55)" }}>
                  <span style={{ color: CY_FAINT }}>{timeArab(a.created_at)}</span>
                  <span style={{ color: a.status?.includes("over_band") ? AMBER : "rgba(76,195,255,0.7)" }}>{ACTION_AR[a.action_type] ?? a.action_type}</span>
                  <span className="truncate">{a.sku ?? ""} {a.old_value != null ? `${a.old_value}→${a.new_value}` : ""}</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>

      {/* PRIMARY OBJECTIVE */}
      <div className="relative z-10 mx-5 mt-4 rounded border p-3" style={{ borderColor: CY_FAINT, background: "rgba(8,20,40,0.4)" }}>
        <div className="flex items-center justify-between">
          <p className="text-[9px] tracking-[0.3em]" style={{ color: AMBER }}>■ أولوية اليوم</p>
          <p className="text-[9px] tracking-widest" style={{ color: CY_DIM }}>{(scan?.issues?.length ?? 0)} بند يحتاج تصرّف</p>
        </div>
        <div className="mt-2 flex items-end gap-6">
          <div className="flex-1">
            <p className="text-base font-bold" style={{ color: "#cfeeff" }}>{scan?.priority ?? "…يفحص الوضع"}</p>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full" style={{ background: "rgba(76,195,255,0.12)" }}>
              <div className="h-full rounded-full" style={{ width: `${pct(t - ((scan?.outOfStock ?? 0) + (scan?.missingImages ?? 0) + (scan?.suspiciousPrice ?? 0)), t)}%`, background: GREEN, boxShadow: `0 0 8px ${GREEN}` }} />
            </div>
            <p className="mt-1 text-[8.5px] tracking-widest" style={{ color: CY_FAINT }}>HEALTH · صحّة الكتالوج العامة</p>
          </div>
          <a href="/malak" className="shrink-0 rounded border px-4 py-2 text-[10px] tracking-widest transition hover:bg-white/5"
            style={{ borderColor: CY, color: "#cfeeff", boxShadow: `0 0 14px ${CY}44` }}>افتح ملاك ←</a>
        </div>
      </div>
    </div>
  );
}
