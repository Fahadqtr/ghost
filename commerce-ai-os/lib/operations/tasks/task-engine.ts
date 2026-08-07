// Malikas V2 Operations — Task Engine (Phase UI.7.1).
//
// PURE: tasks are COMPUTED, never stored. Recomputing over the same input
// yields the same tasks with the same deterministic ids
// (`<type>[:<platform>]:<productId>`), so any future surface (the UI.7.2
// dashboard, a TickTick export) can diff/de-duplicate safely. No database,
// no fetch, no clock, no randomness.
//
// The engine composes the OTHER engines' outputs: it receives the readiness
// result and the platform statuses instead of recomputing them, so the
// business rules live in exactly one place each.

import type {
  OperationsProduct,
  OperationTask,
  PlatformStatus,
  PlatformType,
  ProductReadiness,
  TaskPriority,
  TaskType,
} from "../shared/models";

const PRIORITY_ORDER: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 };

const PLATFORM_TITLES: Record<PlatformType, string> = {
  shopify: "النشر على Shopify",
  puresoul: "النشر على PureSoul",
  talabat: "النشر على Talabat",
  rafeeq: "النشر على Rafeeq",
};

const PLATFORM_REVIEW_TITLES: Record<PlatformType, string> = {
  shopify: "مراجعة Shopify",
  puresoul: "مراجعة PureSoul",
  talabat: "مراجعة Talabat",
  rafeeq: "مراجعة Rafeeq",
};

function productLabel(p: OperationsProduct): string {
  const name = (p.nameAr ?? "").trim() || (p.nameEn ?? "").trim();
  if (name !== "") return name;
  const sku = (p.sku ?? "").trim();
  return sku !== "" ? sku : "منتج بدون اسم";
}

function taskId(type: TaskType, productId: string, platform?: PlatformType): string {
  return platform ? `${type}:${platform}:${productId}` : `${type}:${productId}`;
}

/**
 * Generate the open tasks for ONE product from its readiness + platform view.
 * Rules:
 * - needs_review (high): the readiness engine says a human must look at it.
 * - needs_image (high): image missing — blocks publishing everywhere (house
 *   «ناقص صورة» rule), so it is its own task even when other data is missing.
 * - needs_data (high): any OTHER required data check failed.
 * - publish_platform (medium): the product is publishable and the platform
 *   status is "ready" — one task per platform.
 * - platform_review (high): a platform is "different" or "review_required".
 * - new_product (medium): never-reviewed, never-published product — surface it.
 */
export function generateProductTasks(
  product: OperationsProduct,
  readiness: ProductReadiness,
  platformStatuses: readonly PlatformStatus[],
): OperationTask[] {
  const tasks: OperationTask[] = [];
  const label = productLabel(product);

  if (readiness.status === "needs_review") {
    tasks.push({
      id: taskId("needs_review", product.id),
      productId: product.id,
      type: "needs_review",
      priority: "high",
      title: "مراجعة المنتج",
      description: `راجع بيانات «${label}» قبل المتابعة.`,
      reason: readiness.reasons[0]?.message ?? "يحتاج مراجعة.",
    });
  }

  const failedRequired = readiness.checks.filter((c) => c.required && !c.passed);
  const imageMissing = failedRequired.some((c) => c.code === "image");
  const otherDataMissing = failedRequired.some((c) => c.code !== "image");

  if (imageMissing) {
    tasks.push({
      id: taskId("needs_image", product.id),
      productId: product.id,
      type: "needs_image",
      priority: "high",
      title: "إضافة صورة",
      description: `أضف صورة للمنتج «${label}» من محرر المنتج أو منشئ الذكاء الاصطناعي.`,
      reason: "لا توجد صورة.",
    });
  }

  if (otherDataMissing) {
    tasks.push({
      id: taskId("needs_data", product.id),
      productId: product.id,
      type: "needs_data",
      priority: "high",
      title: "إكمال البيانات",
      description: `أكمل البيانات الناقصة للمنتج «${label}».`,
      reason:
        readiness.reasons.find((r) => r.code !== "missing_image" && r.code !== "not_approved")?.message ??
        "بيانات ناقصة.",
    });
  }

  for (const ps of platformStatuses) {
    if (ps.status === "ready" && readiness.readyToPublish) {
      tasks.push({
        id: taskId("publish_platform", product.id, ps.platform),
        productId: product.id,
        type: "publish_platform",
        priority: "medium",
        title: PLATFORM_TITLES[ps.platform],
        description: `المنتج «${label}» جاهز ولم يُنشر على هذه المنصة بعد.`,
        platform: ps.platform,
        reason: "جاهز للنشر وغير منشور.",
      });
    } else if (ps.status === "different" || ps.status === "review_required") {
      tasks.push({
        id: taskId("platform_review", product.id, ps.platform),
        productId: product.id,
        type: "platform_review",
        priority: "high",
        title: PLATFORM_REVIEW_TITLES[ps.platform],
        description: `بيانات «${label}» على المنصة تحتاج مطابقة مع ماليكاس.`,
        platform: ps.platform,
        reason: ps.status === "different" ? "بيانات المنصة مختلفة عن ماليكاس." : "المنصة تتطلب مراجعة.",
      });
    }
  }

  if (readiness.isNew) {
    tasks.push({
      id: taskId("new_product", product.id),
      productId: product.id,
      type: "new_product",
      priority: "medium",
      title: "منتج جديد",
      description: `«${label}» منتج جديد — أكمل تجهيزه واعتمده.`,
      reason: "منتج جديد لم يُعتمد ولم يُنشر بعد.",
    });
  }

  return sortTasks(tasks);
}

/** Stable ordering: priority (high→low), then type, then platform, then id. */
export function sortTasks(tasks: readonly OperationTask[]): OperationTask[] {
  return [...tasks].sort((a, b) => {
    const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (p !== 0) return p;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export interface ProductOperationsInput {
  product: OperationsProduct;
  readiness: ProductReadiness;
  platformStatuses: readonly PlatformStatus[];
}

/** Generate tasks for a whole catalog snapshot (stable global ordering). */
export function generateTasks(entries: readonly ProductOperationsInput[]): OperationTask[] {
  return sortTasks(entries.flatMap((e) => generateProductTasks(e.product, e.readiness, e.platformStatuses)));
}
