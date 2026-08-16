// AI.1 — Unified Action Center: source adapters (PURE).
//
// Each adapter TRANSLATES the already-computed output of a certified reader into
// the shared Action model. It duplicates NO detection logic and runs NO scan of
// its own — it only re-shapes signals the OPS/BI readers already produced.
//
// Runtime-pure: every `@/` import is `import type` (erased by the type-stripping
// runtime), so this module performs no I/O, holds no clock, and never touches a
// database. Tests drive it with synthetic reader-shaped inputs.

import type { ActionInput, ActionType } from "./action-model.ts";
import type { AnalyticsSnapshot, Metric } from "@/lib/analytics/analytics-read";
import type { HealthCenterModel, HealthFinding, DomainKey } from "@/lib/operations/health/health-center";
import type { MediaCenterView } from "@/lib/operations/media/media-center.server";
import type { AiCenterModel } from "@/lib/operations/ai/ai-center";

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

// ── 9. Analytics (BI.1) → catalog-quality + stock actions (catalog-wide) ──────
function isAvailable(m: Metric<number> | undefined | null): m is Metric<number> & { value: number } {
  return !!m && m.status === "available" && typeof m.value === "number" && m.value > 0;
}

/**
 * BI.1 catalog-quality + inventory metrics → one catalog-wide Action per non-zero
 * available metric. UNKNOWN metrics (status !== "available") emit nothing — they
 * are honestly absent, never a fabricated zero.
 */
export function actionsFromAnalytics(snap: AnalyticsSnapshot | null | undefined): ActionInput[] {
  if (!snap || typeof snap !== "object") return [];
  const out: ActionInput[] = [];
  const cq = snap.catalogQuality;
  const inv = snap.inventory;

  const catalogWide = (
    type: ActionType,
    metric: Metric<number> | undefined,
    title: string,
    verb: string,
    scope: "catalog" | "inventory",
  ) => {
    if (!isAvailable(metric)) return;
    const n = metric.value;
    out.push({
      id: `${type}:analytics:${scope}`,
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

  if (cq) {
    catalogWide("IMAGE_REQUIRED", cq.missingImages, "صور ناقصة في الكتالوج", "منتج بدون صورة", "catalog");
    catalogWide("BARCODE_REQUIRED", cq.missingBarcode, "باركود ناقص", "منتج بدون باركود", "catalog");
    catalogWide("DESCRIPTION_UPDATE", cq.missingDescription, "أوصاف ناقصة", "منتج بدون وصف", "catalog");
    catalogWide("KEYWORDS_UPDATE", cq.missingKeywords, "كلمات مفتاحية ناقصة", "منتج بدون كلمات مفتاحية", "catalog");
    catalogWide("PRICE_REVIEW", cq.missingPrice, "أسعار ناقصة", "منتج بدون سعر", "catalog");
    catalogWide("MAPPING_REVIEW", cq.needsMapping, "بحاجة لمراجعة الربط", "عنصر بحاجة لمراجعة الربط", "catalog");
    catalogWide("AI_REVIEW", cq.needsAi, "بحاجة لمراجعة الذكاء الاصطناعي", "منتج بحاجة للإثراء", "catalog");
  }
  if (inv) {
    catalogWide("LOW_STOCK", inv.lowStock, "مخزون منخفض", "منتج بمخزون منخفض", "inventory");
    catalogWide("OUT_OF_STOCK", inv.outOfStock, "نفد المخزون", "منتج نفد مخزونه", "inventory");
    catalogWide("ARCHIVE_CANDIDATE", inv.deadStock, "مخزون راكد — مرشّح للأرشفة", "منتج راكد", "inventory");
  }
  return out;
}

// ── 1(b). OPS Media → per-product IMAGE_REQUIRED + IMAGE_REPLACE ───────────────
/**
 * Media Center's already-computed queues: `missing[]` (products with no image) →
 * IMAGE_REQUIRED per product; `duplicates[]` (cross-product image reuse) →
 * IMAGE_REPLACE per group. No image scanning happens here.
 */
export function actionsFromMedia(view: MediaCenterView | null | undefined): ActionInput[] {
  if (!view || typeof view !== "object") return [];
  const out: ActionInput[] = [];

  for (const item of Array.isArray(view.missing) ? view.missing : []) {
    const label = item.name ?? item.sku ?? item.productId;
    out.push({
      id: `IMAGE_REQUIRED:ops_media:${item.productId}`,
      type: "IMAGE_REQUIRED",
      source: "ops_media",
      confidence: "high",
      title: label,
      reason: "المنتج بدون صورة أساسية",
      evidence: [
        ...(item.sku ? [{ label: "SKU", value: item.sku }] : []),
        ...(item.category ? [{ label: "الفئة", value: item.category }] : []),
      ],
      currentState: "بدون صورة",
      suggestedState: item.suggestedAction === "RECOVER_SNOONU" ? "استرجاع من سنونو" : "رفع صورة",
      entityId: item.productId,
      entityLabel: label,
      workflowHref: "/v2/operations/media",
    });
  }

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

// ── 4. OPS AI → per-product DESCRIPTION_UPDATE / KEYWORDS_UPDATE / AI_REVIEW ───
/**
 * AI Center's `needsGeneration[]` queue → one Action per row, typed by the field
 * kind (keywords / description) and otherwise AI_REVIEW. Confidence follows the
 * reader's own suggested action (`generate` is a clear signal → high).
 */
export function actionsFromAi(model: AiCenterModel | null | undefined): ActionInput[] {
  const rows = model && Array.isArray(model.needsGeneration) ? model.needsGeneration : [];
  return rows.map((row) => {
    const field = typeof row.field === "string" ? row.field : "";
    const type: ActionType = field.startsWith("keywords")
      ? "KEYWORDS_UPDATE"
      : field.startsWith("description")
        ? "DESCRIPTION_UPDATE"
        : "AI_REVIEW";
    const label = row.name ?? row.sku ?? row.productId;
    return {
      id: `${type}:ops_ai:${row.key}`,
      type,
      source: "ops_ai",
      confidence: row.action === "generate" ? "high" : "medium",
      title: label,
      reason: row.reason,
      evidence: [
        ...(row.field ? [{ label: "الحقل", value: row.field }] : []),
        ...(row.currentQuality ? [{ label: "الجودة الحالية", value: String(row.currentQuality) }] : []),
      ],
      currentState: row.currentQuality ? String(row.currentQuality) : null,
      suggestedState: row.action === "generate" ? "توليد مقترح" : "مراجعة المقترح",
      entityId: row.productId || null,
      entityLabel: label,
      workflowHref: "/v2/operations/ai",
    };
  });
}
