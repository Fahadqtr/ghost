"use client";

// Shared Mission-Control HUD side panels, fed by /api/malak/scan data. Used to
// frame Malak's orb + chat into a single JARVIS screen.

import type { ReactNode } from "react";

export const CY = "#4cc3ff";
export const CY_DIM = "rgba(76,195,255,0.55)";
export const CY_FAINT = "rgba(76,195,255,0.25)";
export const AMBER = "#ffb454";
export const GREEN = "#3ddc97";
export const ROSE = "#ff6b8a";

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

// Angular Iron-Man HUD plate: cut top-right + bottom-left corners, thin cyan
// edge (drawn as a 1px under-layer showing through the clip), header tab.
const CLIP = "polygon(0 0, calc(100% - 11px) 0, 100% 11px, 100% 100%, 11px 100%, 0 calc(100% - 11px))";
function Panel({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ clipPath: CLIP, background: "rgba(76,195,255,0.30)", padding: 1 }}>
      <div className="relative p-2.5" style={{ clipPath: CLIP, background: "rgba(4,12,26,0.92)" }}>
        <div className="mb-2 flex items-center justify-between border-b pb-1" style={{ borderColor: CY_FAINT }}>
          <p className="font-mono text-[9px] tracking-[0.3em]" style={{ color: CY }}>◢ {title}</p>
          {right}
        </div>
        {children}
      </div>
    </div>
  );
}

// Radial gauge (Iron-Man style): arc ring + center value + label.
function Gauge({ label, p, sub, tone = CY }: { label: string; p: number; sub: string; tone?: string }) {
  const r = 17, c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(100, p)) / 100);
  return (
    <div className="flex flex-col items-center gap-0.5">
      <svg width="46" height="46" viewBox="0 0 46 46">
        <circle cx="23" cy="23" r={r} fill="none" stroke="rgba(76,195,255,0.12)" strokeWidth="3" />
        <circle cx="23" cy="23" r={r} fill="none" stroke={tone} strokeWidth="3" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={off} transform="rotate(-90 23 23)" style={{ filter: `drop-shadow(0 0 3px ${tone})` }} />
        <text x="23" y="26" textAnchor="middle" fontSize="11" fontFamily="monospace" fill="#cfeeff">{p}</text>
      </svg>
      <span className="text-[8px] tracking-wider" style={{ color: CY_DIM }}>{label}</span>
      <span className="text-[7px]" style={{ color: "rgba(174,230,255,0.45)" }}>{sub}</span>
    </div>
  );
}

export function HudLeft({ scan, onAction }: { scan: ScanData; onAction: (prompt: string) => void }) {
  const t = scan.total || 0;
  return (
    <div dir="ltr" className="space-y-3 font-mono">
      <Panel title="STORE VITALS">
        <div className="grid grid-cols-3 gap-y-2 pt-1">
          <Gauge label="CATALOG" p={pct(scan.approved, t)} sub={`${scan.approved}/${t}`} tone={GREEN} />
          <Gauge label="IN-STOCK" p={pct(t - scan.outOfStock, t)} sub={`نافد ${scan.outOfStock}`} tone={scan.outOfStock ? AMBER : GREEN} />
          <Gauge label="IMAGES" p={pct(t - scan.missingImages, t)} sub={`ناقص ${scan.missingImages}`} tone={scan.missingImages ? CY : GREEN} />
          <Gauge label="PRICING" p={pct(t - scan.suspiciousPrice, t)} sub={`مشكلة ${scan.suspiciousPrice}`} tone={scan.suspiciousPrice ? AMBER : GREEN} />
          <Gauge label="SYNC" p={scan.channelMismatch ? 60 : 100} sub={scan.channelMismatch ? `${scan.channelMismatch}⚠` : "متطابق"} tone={scan.channelMismatch ? ROSE : GREEN} />
          <Gauge label="HEALTH" p={pct(t - (scan.outOfStock + scan.missingImages + scan.suspiciousPrice), t)} sub="عام" tone={CY} />
        </div>
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
    </div>
  );
}

export function HudRight({ scan }: { scan: ScanData }) {
  const synced = scan.channelMismatch === 0;
  return (
    <div dir="ltr" className="space-y-3 font-mono">
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
      <Panel title="ACTIVITY LOG" right={<a href="/malak/audit" className="text-[8.5px] underline" style={{ color: CY_DIM }}>الكل</a>}>
        <div className="space-y-1 text-[8.5px] leading-relaxed">
          {(scan.recentActivity ?? []).length === 0 ? (
            <p className="py-1 text-center" style={{ color: CY_FAINT }}>ما في نشاط بعد</p>
          ) : scan.recentActivity.map((a, i) => (
            <div key={i} className="flex gap-2" style={{ color: "rgba(174,230,255,0.55)" }}>
              <span style={{ color: CY_FAINT }}>{timeArab(a.created_at)}</span>
              <span style={{ color: a.status?.includes("over_band") ? AMBER : "rgba(76,195,255,0.7)" }}>{ACTION_AR[a.action_type] ?? a.action_type}</span>
              <span className="truncate">{a.sku ?? ""} {a.old_value != null ? `${a.old_value}→${a.new_value}` : ""}</span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

export function HudObjective({ scan }: { scan: ScanData }) {
  const t = scan.total || 0;
  const health = pct(t - (scan.outOfStock + scan.missingImages + scan.suspiciousPrice), t);
  return (
    <div dir="ltr" style={{ clipPath: CLIP, background: "rgba(76,195,255,0.3)", padding: 1 }}>
    <div className="p-3 font-mono" style={{ clipPath: CLIP, background: "rgba(4,12,26,0.92)" }}>
      <div className="flex items-center justify-between">
        <p className="text-[9px] tracking-[0.3em]" style={{ color: AMBER }}>■ أولوية اليوم</p>
        <p className="text-[9px] tracking-widest" style={{ color: CY_DIM }}>{scan.issues?.length ?? 0} بند يحتاج تصرّف</p>
      </div>
      <p dir="rtl" className="mt-2 text-sm font-bold" style={{ color: "#cfeeff" }}>{scan.priority}</p>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full" style={{ background: "rgba(76,195,255,0.12)" }}>
        <div className="h-full rounded-full" style={{ width: `${health}%`, background: GREEN, boxShadow: `0 0 8px ${GREEN}` }} />
      </div>
      <p className="mt-1 text-[8.5px] tracking-widest" style={{ color: CY_FAINT }}>HEALTH {health}% · صحّة الكتالوج</p>
    </div>
    </div>
  );
}
