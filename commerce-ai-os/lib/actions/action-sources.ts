// AI.1 — Unified Action Center: source adapters (PURE).
//
// Each adapter TRANSLATES the already-computed output of a certified reader into
// the shared Action model. It duplicates NO detection logic and runs NO scan of
// its own — it only re-shapes signals the OPS/BI readers already produced.
//
// CAT.1C — the canonical CAT.1B Evidence layer now owns evidence-backed
// catalog-quality actions (image / description / keywords / barcode / price /
// mapping / AI). The overlapping legacy projections were RETIRED here to keep a
// single source per evidence identity (§3/§10):
//   • Media  → keeps only IMAGE_REPLACE (duplicate images); per-product
//     IMAGE_REQUIRED is owned by evidence (CAT_IMAGE_PRIMARY).
//   • Analytics → keeps only inventory rollups (low / out / dead stock); the
//     catalog-quality counts are owned by evidence.
//   • AI (needsGeneration) → fully retired; description / keywords / AI-readiness
//     are owned by evidence (CAT_DESC_* / CAT_KEYWORDS_* / CAT_AI_INSUFFICIENT_FACTS).
// The catalog-quality projection itself lives in evidence-actions.ts.
//
// Runtime-pure: every `@/` import is `import type` (erased by the type-stripping
// runtime), so this module performs no I/O, holds no clock, and never touches a
// database. Tests drive it with synthetic reader-shaped inputs.

import type { ActionInput, ActionType } from "./action-model.ts";
import { lifecycleReviewHref } from "../lifecycle/transitions.ts";
import type { LifecycleActionRow } from "./lifecycle-source.server.ts";
import type { AnalyticsSnapshot, Metric } from "@/lib/analytics/analytics-read";
import type { HealthCenterModel, HealthFinding, DomainKey } from "@/lib/operations/health/health-center";
import type { MediaCenterView } from "@/lib/operations/media/media-center.server";

// ── small pure helpers ────────────────────────────────────────────────────────
/** Stable, url/id-safe slug of arbitrary text (deterministic — no clock/random). */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

const HEALTH_DOMAIN_LABEL: Record<DomainKey, string> = {
  catalog: "الكتالوج",
  inventory: "المخزون",
  availability: "التوفّر",
  channels: "القنوات",
  ai: "الذكاء الاصطناعي",
  media: "الوسائط",
  ecl: "الربط الخارجي (ECL)",
  security: "الأمان",
  system: "النظام",
};

// ── 1. OPS Health → HEALTH_ALERT (cross-domain findings) ──────────────────────
/**
 * The Platform Health findings are the cross-domain alert roll-up. Each becomes a
 * HEALTH_ALERT carrying the domain, the reader's own reason/count, and its
 * existing deep-link. `severity: "action"` → critical, `"warning"` → warning.
 */
export function actionsFromHealth(model: HealthCenterModel | null | undefined): ActionInput[] {
  const findings: readonly HealthFinding[] = model && Array.isArray(model.findings) ? model.findings : [];
  return findings.map((f) => {
    const domainLabel = HEALTH_DOMAIN_LABEL[f.domain] ?? f.domain;
    const evidence = [{ label: "المجال", value: domainLabel }];
    if (typeof f.count === "number") evidence.push({ label: "العدد", value: String(f.count) });
    return {
      id: `HEALTH_ALERT:ops_health:${f.domain}:${slug(f.reason)}`,
      type: "HEALTH_ALERT" as ActionType,
      source: "ops_health",
      severity: f.severity === "action" ? "critical" : "warning",
      confidence: "high",
      title: `تنبيه صحّة — ${domainLabel}`,
      reason: f.reason,
      evidence,
      currentState: f.reason,
      suggestedState: null,
      entityId: f.domain,
      entityLabel: domainLabel,
      workflowHref: typeof f.href === "string" && f.href.length > 0 ? f.href : null,
    };
  });
}

// ── 9. Analytics (BI.1) → inventory rollups (catalog-wide) ────────────────────
function isAvailable(m: Metric<number> | undefined | null): m is Metric<number> & { value: number } {
  return !!m && m.status === "available" && typeof m.value === "number" && m.value > 0;
}

/**
 * BI.1 inventory metrics → one catalog-wide Action per non-zero available metric.
 * UNKNOWN metrics (status !== "available") emit nothing — honestly absent, never
 * a fabricated zero.
 *
 * CAT.1C — the catalog-QUALITY rollups (missing image / barcode / description /
 * keywords / price / mapping / AI) are NO LONGER projected here: those dimensions
 * are owned per-product by the canonical evidence layer (evidence-actions.ts).
 * Inventory (low / out / dead stock) has no batch evidence rule — the evidence
 * batch reads no per-product inventory — so it stays here (a genuinely different,
 * non-overlapping operational signal).
 */
export function actionsFromAnalytics(snap: AnalyticsSnapshot | null | undefined): ActionInput[] {
  if (!snap || typeof snap !== "object") return [];
  const out: ActionInput[] = [];
  const inv = snap.inventory;

  const catalogWide = (type: ActionType, metric: Metric<number> | undefined, title: string, verb: string) => {
    if (!isAvailable(metric)) return;
    const n = metric.value;
    out.push({
      id: `${type}:analytics:inventory`,
      type,
      source: "analytics",
      confidence: "high",
      title,
      reason: `${n} ${verb}`,
      evidence: [{ label: "العدد", value: String(n) }],
      currentState: `${n} ${verb}`,
      suggestedState: null,
      entityId: null,
      entityLabel: null,
      workflowHref: null,
    });
  };

  if (inv) {
    catalogWide("LOW_STOCK", inv.lowStock, "مخزون منخفض", "منتج بمخزون منخفض");
    catalogWide("OUT_OF_STOCK", inv.outOfStock, "نفد المخزون", "منتج نفد مخزونه");
    catalogWide("ARCHIVE_CANDIDATE", inv.deadStock, "مخزون راكد — مرشّح للأرشفة", "منتج راكد");
  }
  return out;
}

// ── 1(b). OPS Media → IMAGE_REPLACE (duplicate images) ────────────────────────
/**
 * Media Center's `duplicates[]` (cross-product image reuse) → IMAGE_REPLACE per
 * group. No image scanning happens here.
 *
 * CAT.1C — per-product IMAGE_REQUIRED (missing primary image) is NO LONGER
 * projected here: it is owned by the canonical evidence rule CAT_IMAGE_PRIMARY
 * (evidence-actions.ts), so one evidence identity yields exactly one action.
 * Duplicate-image detection has no evidence rule, so it stays here (unique event).
 */
export function actionsFromMedia(view: MediaCenterView | null | undefined): ActionInput[] {
  if (!view || typeof view !== "object") return [];
  const out: ActionInput[] = [];

  for (const group of Array.isArray(view.duplicates) ? view.duplicates : []) {
    const ids = Array.isArray(group.productIds) ? group.productIds : [];
    if (ids.length === 0) continue;
    out.push({
      id: `IMAGE_REPLACE:ops_media:${group.kind}:${slug(group.value)}`,
      type: "IMAGE_REPLACE",
      source: "ops_media",
      confidence: "medium",
      title: "صورة مكررة عبر منتجات",
      reason: "نفس الصورة مستخدمة في أكثر من منتج",
      evidence: [{ label: "منتجات متأثرة", value: String(ids.length) }],
      currentState: "صورة مكررة",
      suggestedState: "استبدل بصورة فريدة",
      entityId: ids[0] ?? null,
      entityLabel: null,
      workflowHref: "/v2/operations/media",
    });
  }
  return out;
}

// ── 4. OPS AI → RETIRED (CAT.1C) ──────────────────────────────────────────────
// The AI Center `needsGeneration[]` projection (DESCRIPTION_UPDATE /
// KEYWORDS_UPDATE / AI_REVIEW) was retired: those catalog-quality dimensions are
// owned per-product by the canonical evidence layer (CAT_DESC_* / CAT_KEYWORDS_* /
// CAT_AI_INSUFFICIENT_FACTS in evidence-actions.ts), so one evidence identity
// yields exactly one action. The AI Center remains the resolver workflow the
// projected AI_REVIEW actions deep-link into.

// ── OPS.8C. Lifecycle → per-product READY_FOR_ACTIVATION ──────────────────────
/**
 * The lifecycle facts (already computed by the certified readiness + lifecycle
 * engines) → Action Center items. OPS.8C wires exactly ONE evidence-backed type:
 *
 *   READY_FOR_ACTIVATION — a stored DRAFT the certified readiness engine reports
 *   as complete AND approved (readyToPublish). Deterministic; recommends
 *   DRAFT → ACTIVE and deep-links to the product lifecycle review. Activation is
 *   NEVER performed here — the Action Center is read-only.
 *
 * STOP_CANDIDATE / RESTORE_CANDIDATE / (per-product) ARCHIVE_CANDIDATE are
 * deliberately NOT emitted: no certified deterministic per-product signal exists
 * yet (OPS.8C §10/§12/§13). They stay registered and empty; heuristic detection
 * belongs to a future Catalog/Analytics Agent phase, not this wiring phase.
 */
export function actionsFromLifecycle(rows: readonly LifecycleActionRow[] | null | undefined): ActionInput[] {
  if (!Array.isArray(rows)) return [];
  const out: ActionInput[] = [];
  for (const r of rows) {
    if (r === null || typeof r !== "object") continue;
    if (r.lifecycleState === "DRAFT" && r.ready === true) {
      const label = r.name ?? r.sku ?? r.productId;
      out.push({
        id: `READY_FOR_ACTIVATION:lifecycle:${r.productId}`,
        type: "READY_FOR_ACTIVATION",
        source: "lifecycle",
        confidence: "high",
        title: label,
        reason: "المنتج مكتمل ومعتمد وجاهز للتفعيل.",
        evidence: [
          { label: "الحالة", value: "مسودة (جاهز)" },
          { label: "الجاهزية", value: `${r.readinessPercent}%` },
          { label: "الاعتماد", value: "معتمد" },
        ],
        currentState: "مسودة (جاهز)",
        suggestedState: "نشط",
        impact: "التفعيل يُدخل المنتج دورة البيع؛ لا يَنشُر المنتج على أي متجر تلقائياً — النشر يتطلب إجراءً منفصلاً.",
        entityId: r.productId,
        entityLabel: label,
        workflowHref: lifecycleReviewHref(r.productId),
      });
    }
  }
  return out;
}
