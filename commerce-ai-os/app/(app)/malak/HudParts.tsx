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

function Panel({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="relative rounded border p-2.5" style={{ borderColor: CY_FAINT, background: "rgba(8,20,40,0.35)" }}>
      <div className="mb-2 flex items-center justify-between">
        <p className="font-mono text-[9px] tracking-[0.3em]" style={{ color: CY_DIM }}>{`{ ${title} }`}</p>
        {right}
      </div>
      {children}
    </div>
  );
}
function VitalBar({ label, p, note, tone = CY }: { label: string; p: number; note: string; tone?: string }) {
  return (
    <div className="mb-2">
      <div className="mb-0.5 flex items-center justify-between font-mono text-[9px]" style={{ color: "rgba(174,230,255,0.85)" }}>
        <span style={{ color: CY_DIM }}>{label}</span><span>{note}</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full" style={{ background: "rgba(76,195,255,0.12)" }}>
        <div className="h-full rounded-full" style={{ width: `${Math.max(2, Math.min(100, p))}%`, background: tone, boxShadow: `0 0 8px ${tone}` }} />
      </div>
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
        <VitalBar label="IMAGES صور" p={pct(t - scan.missingImages, t)} note={`ناقص ${scan.missingImages}`} tone={scan.missingImages ? CY : GREEN} />
        <VitalBar label="PRICING تسعير" p={pct(t - scan.suspiciousPrice, t)} note={`مشكلة ${scan.suspiciousPrice}`} tone={scan.suspiciousPrice ? AMBER : GREEN} />
        <VitalBar label="SYNC مزامنة" p={scan.channelMismatch ? 60 : 100} note={scan.channelMismatch ? `${scan.channelMismatch} تعارض` : "متطابق"} tone={scan.channelMismatch ? ROSE : GREEN} />
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
    <div dir="ltr" className="rounded border p-3 font-mono" style={{ borderColor: CY_FAINT, background: "rgba(8,20,40,0.4)" }}>
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
  );
}
