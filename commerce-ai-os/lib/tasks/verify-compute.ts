// Pure verdicts for "did the staff entry actually land on the platform?" —
// DB-free, unit-tested. The platform's own export is the ground truth; each
// catalog-change task is checked against it: additions/edits must be PRESENT
// (and priced right when the export has a price column), deletions ABSENT.

export interface VerifyTaskLite {
  id: string;
  status: string;                 // open | in_progress | done
  action: string;                 // create | update | delete | image | approval | bulk
  sku: string | null;
  name_en: string | null;
  // What the platform should show now (current catalog values; for deletes
  // this is the pre-delete snapshot and only presence matters).
  price: number | null;           // effective price (discounted when on sale)
}

export interface PlatformIndexLite {
  hasSku: (sku: string) => boolean;       // exact or split-suffix (mk1-2) match
  hasName: (name: string) => boolean;
  priceFor: (sku: string, name: string) => number | null; // null = no price column / row
}

export type VerifyStatus = "confirmed" | "missing" | "price_mismatch" | "still_present" | "skipped";

export interface VerifyVerdict {
  taskId: string;
  status: VerifyStatus;
  reopen: boolean;   // a done-task that failed verification goes back to open
  detail: string;    // Arabic, goes into the auto comment
}

const s = (v: unknown) => String(v ?? "").trim();

export function verdictForTask(t: VerifyTaskLite, idx: PlatformIndexLite): VerifyVerdict {
  const sku = s(t.sku);
  const name = s(t.name_en);
  if (t.action === "bulk" || (!sku && !name)) {
    return { taskId: t.id, status: "skipped", reopen: false, detail: "" };
  }
  const present = (sku && idx.hasSku(sku)) || (name && idx.hasName(name));

  if (t.action === "delete") {
    if (present) {
      return {
        taskId: t.id, status: "still_present", reopen: t.status === "done",
        detail: `المنتج ما زال موجودًا في ملف المنصة رغم أنه محذوف من الكتالوج${sku ? ` (${sku})` : ""} — احذفه من لوحة المنصة.`,
      };
    }
    return { taskId: t.id, status: "confirmed", reopen: false, detail: "تحقق تلقائي: المنتج غير موجود في ملف المنصة — الحذف مطبق." };
  }

  if (!present) {
    return {
      taskId: t.id, status: "missing", reopen: t.status === "done",
      detail: `المنتج غير موجود في ملف المنصة${sku ? ` (${sku})` : ""} — الإدخال ما وصل، أعد إضافته.`,
    };
  }

  const platPrice = idx.priceFor(sku, name);
  if (platPrice != null && t.price != null && Number(t.price) > 0 && Math.abs(platPrice - Number(t.price)) > 0.009) {
    return {
      taskId: t.id, status: "price_mismatch", reopen: t.status === "done",
      detail: `السعر في المنصة ${platPrice} والمفروض ${t.price} — صحّح السعر في لوحة المنصة.`,
    };
  }
  return { taskId: t.id, status: "confirmed", reopen: false, detail: "تحقق تلقائي: الإدخال موجود ومطابق في ملف المنصة." };
}
