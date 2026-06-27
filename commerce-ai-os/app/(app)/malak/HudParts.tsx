"use client";

// Shared Mission-Control HUD side panels, fed by /api/malak/scan data. Used to
// frame Malak's orb + chat into a single JARVIS screen.

import { useEffect, useRef, type ReactNode, type MutableRefObject } from "react";

export const CY = "#00d9ff";        // primary cyan
export const CY_SOFT = "#6eeaff";    // soft cyan
export const CY_DIM = "rgba(110,234,255,0.6)";
export const CY_FAINT = "rgba(0,217,255,0.22)";
export const AMBER = "#ff9f1c";
export const GREEN = "#3ddc97";
export const ROSE = "#ff6b8a";
export const MUTED = "#6f8fa3";

export interface ScanData {
  total: number; approved: number; rejected: number; missingImages: number;
  lowStock: number; outOfStock: number; suspiciousPrice: number; channelMismatch: number;
  issues: { key: string; icon: string; title: string; count: number; prompt: string; severity: string }[];
  recentActivity: { created_at: string; action_type: string; sku: string | null; old_value: string | null; new_value: string | null; status: string | null }[];
  priority: string; allClear: boolean;
}

const ACTION_AR: Record<string, string> = {
  update_stock: "مخزون", set_price: "سعر", set_approval: "اعتماد",
  add_product: "منتج", set_image: "صورة", sync_availability: "مزامنة",
};
const PLATFORMS = ["مليكاس", "Pure Seoul", "Talabat", "Rafeeq", "Shopify"];

const pct = (x: number, of: number) => (of > 0 ? Math.round((x / of) * 100) : 0);
function timeArab(iso: string) {
  try { return new Intl.DateTimeFormat("ar", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Qatar" }).format(new Date(iso)); }
  catch { return ""; }
}

// Flat, borderless HUD section (matches the reference): a "{ TITLE }" header
// with a thin underline, content floating on the dark background — no box.
// Glassmorphism HUD card: translucent dark glass, thin cyan border, soft glow.
function Panel({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div
      className="relative rounded-lg border p-3 backdrop-blur-md"
      style={{
        borderColor: CY_FAINT,
        background: "linear-gradient(160deg, rgba(0,217,255,0.05), rgba(4,17,31,0.55))",
        boxShadow: "0 0 22px rgba(0,217,255,0.06), inset 0 0 22px rgba(0,217,255,0.03)",
      }}
    >
      <span aria-hidden className="pointer-events-none absolute right-1.5 top-1.5 h-2.5 w-2.5 border-r border-t" style={{ borderColor: "rgba(0,217,255,0.45)" }} />
      <div className="mb-2 flex items-center justify-between border-b pb-1.5" style={{ borderColor: CY_FAINT }}>
        <p className="font-mono text-[9px] font-semibold tracking-[0.3em]" style={{ color: CY_SOFT }}>{`▮ ${title}`}</p>
        {right}
      </div>
      {children}
    </div>
  );
}

// Thin horizontal vital bar (label · value · 1px track) — like the reference.
function VitalBar({ label, p, note, tone = "rgba(130,185,225,0.85)" }: { label: string; p: number; note: string; tone?: string }) {
  return (
    <div className="mb-1.5">
      <div className="mb-0.5 flex items-center justify-between font-mono text-[9px]">
        <span style={{ color: "rgba(150,195,230,0.7)" }}>{label}</span>
        <span style={{ color: "rgba(180,210,235,0.85)" }}>{note}</span>
      </div>
      <div className="relative h-[3px] w-full" style={{ background: "rgba(120,170,210,0.12)" }}>
        <div className="h-full" style={{ width: `${Math.max(2, Math.min(100, p))}%`, background: tone }} />
        <span className="absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: `${Math.max(2, Math.min(100, p))}%`, background: tone, boxShadow: `0 0 6px ${tone}` }} />
      </div>
    </div>
  );
}

// PROXIMITY radar — sweeping line + the 5 platforms as blips (Shopify flagged
// red when there's an unsynced mismatch).
function Radar({ scan }: { scan: ScanData }) {
  const synced = scan.channelMismatch === 0;
  const blips = [
    { x: "64%", y: "34%" }, { x: "38%", y: "30%" }, { x: "30%", y: "62%" },
    { x: "70%", y: "66%" }, { x: "52%", y: "50%" },
  ];
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[128px]">
      {[0, 0.34, 0.66].map((i) => (
        <div key={i} className="absolute rounded-full border" style={{ inset: `${i * 50}%`, borderColor: "rgba(120,175,215,0.18)" }} />
      ))}
      <div className="absolute left-1/2 top-0 h-full w-px" style={{ background: "rgba(120,175,215,0.14)" }} />
      <div className="absolute left-0 top-1/2 h-px w-full" style={{ background: "rgba(120,175,215,0.14)" }} />
      <div className="absolute inset-0 rounded-full" style={{ background: "conic-gradient(from 0deg, rgba(130,185,225,0.35), transparent 22%)", animation: "radarSweep 3.2s linear infinite" }} />
      {blips.map((b, i) => {
        const flagged = !synced && i === 4;
        return <span key={i} className="absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: b.x, top: b.y, background: flagged ? ROSE : GREEN, boxShadow: `0 0 6px ${flagged ? ROSE : GREEN}` }} />;
      })}
    </div>
  );
}

// AUDIO I/O — bars driven by Malak's real live voice level (levelRef).
function AudioMeter({ levelRef }: { levelRef?: MutableRefObject<number> }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const bars = ref.current ? Array.from(ref.current.children) as HTMLElement[] : [];
    const tick = () => {
      const lv = levelRef?.current ?? 0;
      const tt = performance.now() / 1000;
      for (let i = 0; i < bars.length; i++) {
        const base = 0.12 + 0.5 * lv * Math.abs(Math.sin(i * 0.6 + tt * 6));
        bars[i].style.transform = `scaleY(${Math.max(0.1, Math.min(1, base + (lv > 0.01 ? 0.1 : 0)))})`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [levelRef]);
  return (
    <div ref={ref} className="flex h-9 items-center gap-[2px]">
      {Array.from({ length: 32 }).map((_, i) => (
        <span key={i} className="flex-1 origin-center rounded-full" style={{ height: "100%", background: "rgba(130,185,225,0.7)", transform: "scaleY(0.12)" }} />
      ))}
    </div>
  );
}

// A compact monospace log feed (TELEMETRY / DIAGNOSTICS) from real audit rows.
function Feed({ rows }: { rows: ScanData["recentActivity"] }) {
  return (
    <div className="space-y-1 text-[8.5px] leading-relaxed">
      {(rows ?? []).length === 0 ? (
        <p className="py-1 text-center" style={{ color: "rgba(120,175,215,0.4)" }}>— no activity —</p>
      ) : rows.map((a, i) => (
        <div key={i} className="flex gap-2" style={{ color: "rgba(150,195,230,0.5)" }}>
          <span style={{ color: "rgba(120,175,215,0.45)" }}>{timeArab(a.created_at)}</span>
          <span style={{ color: a.status?.includes("over_band") ? AMBER : "rgba(130,185,225,0.7)" }}>{ACTION_AR[a.action_type] ?? a.action_type}</span>
          <span className="truncate">{a.sku ?? ""} {a.old_value != null ? `${a.old_value}→${a.new_value}` : ""}</span>
        </div>
      ))}
    </div>
  );
}

export function HudLeft({ scan, onAction }: { scan: ScanData; onAction: (prompt: string) => void }) {
  const t = scan.total || 0;
  return (
    <div dir="ltr" className="space-y-3 font-mono">
      <Panel title="STORE VITALS">
        <VitalBar label="CATALOG معتمد" p={pct(scan.approved, t)} note={`${scan.approved}/${t}`} tone={GREEN} />
        <VitalBar label="IN-STOCK متوفّر" p={pct(t - scan.outOfStock, t)} note={`نافد ${scan.outOfStock}`} tone={scan.outOfStock ? AMBER : GREEN} />
        <VitalBar label="IMAGES صور" p={pct(t - scan.missingImages, t)} note={`ناقص ${scan.missingImages}`} />
        <VitalBar label="PRICING تسعير" p={pct(t - scan.suspiciousPrice, t)} note={`مشكلة ${scan.suspiciousPrice}`} tone={scan.suspiciousPrice ? AMBER : "rgba(130,185,225,0.85)"} />
        <VitalBar label="SYNC مزامنة" p={scan.channelMismatch ? 60 : 100} note={scan.channelMismatch ? `${scan.channelMismatch} تعارض` : "متطابق"} tone={scan.channelMismatch ? ROSE : GREEN} />
        <VitalBar label="HEALTH صحّة" p={pct(t - (scan.outOfStock + scan.missingImages + scan.suspiciousPrice), t)} note="عام" />
      </Panel>
      <Panel title="ACTION QUEUE" right={<span className="text-[8.5px]" style={{ color: CY_DIM }}>{scan.issues?.length ?? 0}</span>}>
        {scan.allClear ? (
          <p className="py-2 text-center text-[10px]" style={{ color: GREEN }}>✓ كل شي تمام</p>
        ) : (
          <div className="space-y-1.5">
            {scan.issues.map((is) => (
              <button key={is.key} onClick={() => onAction(is.prompt)}
                className="flex w-full items-center justify-between gap-2 rounded border px-2 py-1.5 text-right transition hover:bg-white/5"
                style={{ borderColor: is.severity === "high" ? "rgba(255,107,138,0.4)" : is.severity === "med" ? "rgba(255,180,84,0.35)" : CY_FAINT }}>
                <span className="text-[9px]" style={{ color: "rgba(174,230,255,0.85)" }}>{is.icon} {is.title}</span>
                <span className="text-[11px] font-bold" style={{ color: is.severity === "high" ? ROSE : is.severity === "med" ? AMBER : CY }}>{is.count}</span>
              </button>
            ))}
          </div>
        )}
      </Panel>
      <Panel title="TELEMETRY">
        <Feed rows={scan.recentActivity} />
      </Panel>
    </div>
  );
}

export function HudRight({ scan, levelRef }: { scan: ScanData; levelRef?: MutableRefObject<number> }) {
  const synced = scan.channelMismatch === 0;
  return (
    <div dir="ltr" className="space-y-3 font-mono">
      <style>{`@keyframes radarSweep { to { transform: rotate(360deg); } }`}</style>
      <Panel title="PROXIMITY" right={<span className="text-[8px]" style={{ color: "rgba(120,175,215,0.5)" }}>{synced ? "CLEAR" : "ALERT"}</span>}>
        <Radar scan={scan} />
        <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[7.5px]" style={{ color: "rgba(150,195,230,0.6)" }}>
          {PLATFORMS.map((p, i) => (
            <span key={p} className="flex items-center gap-1">
              <span className="h-1 w-1 rounded-full" style={{ background: !synced && i === 4 ? ROSE : GREEN }} />{p}
            </span>
          ))}
        </div>
      </Panel>
      <Panel title="AUDIO I/O">
        <div className="border p-2" style={{ borderColor: "rgba(120,175,215,0.25)" }}>
          <AudioMeter levelRef={levelRef} />
          <div className="mt-1.5 flex items-center justify-between text-[8px] tracking-widest" style={{ color: "rgba(120,175,215,0.45)" }}>
            <span>48kHz · 24bit</span><span>RX · ملاك</span>
          </div>
        </div>
      </Panel>
      <Panel title="DIAGNOSTICS" right={<a href="/malak/audit" className="text-[8px] underline" style={{ color: "rgba(120,175,215,0.5)" }}>الكل</a>}>
        <Feed rows={scan.recentActivity} />
      </Panel>
    </div>
  );
}

// Bottom status bar: UPTIME · VERSION · CURRENT TASK · LAST SYNC · PLATFORM.
export function FooterStatusBar({ scan, stateLabel, uptime }: { scan: ScanData; stateLabel: string; uptime: string }) {
  const synced = scan.channelMismatch === 0;
  const lastSync = scan.recentActivity?.[0] ? timeArab(scan.recentActivity[0].created_at) : "—";
  const cell = (label: string, value: string, tone = CY_SOFT) => (
    <span className="flex items-center gap-1.5">
      <span style={{ color: MUTED }}>{label}</span>
      <span style={{ color: tone }}>{value}</span>
    </span>
  );
  return (
    <div dir="ltr" className="flex flex-wrap items-center justify-between gap-x-5 gap-y-1 border-t px-1 pt-2 font-mono text-[9px] tracking-widest" style={{ borderColor: CY_FAINT }}>
      {cell("UPTIME", uptime)}
      {cell("VERSION", "MALAK · 2.0")}
      {cell("CURRENT TASK", scan.priority?.slice(0, 28) ?? stateLabel)}
      {cell("LAST SYNC", lastSync)}
      {cell("PLATFORM", synced ? "ALIGNED" : "MISMATCH", synced ? GREEN : ROSE)}
    </div>
  );
}

export function HudObjective({ scan }: { scan: ScanData }) {
  const t = scan.total || 0;
  const health = pct(t - (scan.outOfStock + scan.missingImages + scan.suspiciousPrice), t);
  return (
    <div dir="ltr" className="border-t p-3 pt-2 font-mono" style={{ borderColor: "rgba(120,175,215,0.18)" }}>
      <div className="flex items-center justify-between">
        <p className="text-[9px] tracking-[0.3em]" style={{ color: AMBER }}>■ PRIMARY OBJECTIVE · أولوية اليوم</p>
        <p className="text-[9px] tracking-widest" style={{ color: CY_DIM }}>{scan.issues?.length ?? 0} بند يحتاج تصرّف</p>
      </div>
      <p dir="rtl" className="mt-2 text-sm font-bold" style={{ color: "#cfeeff" }}>{scan.priority}</p>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full" style={{ background: "rgba(76,195,255,0.12)" }}>
        <div className="h-full rounded-full" style={{ width: `${health}%`, background: GREEN, boxShadow: `0 0 8px ${GREEN}` }} />
      </div>
      <p className="mt-1 text-[8.5px] tracking-widest" style={{ color: CY_FAINT }}>HEALTH {health}% · صحّة الكتالوج</p>
    </div>
  );
}
