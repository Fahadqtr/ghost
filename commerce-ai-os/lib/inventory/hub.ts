export type InventoryHubStatus = "REUSE" | "NEEDS_MIGRATION";

export interface InventoryHubLink {
  key: string;
  label: string;
  description: string;
  href: string;
  status: InventoryHubStatus;
}

// INV.V2.1 introduced this model navigation-only; INV.V2.3 made /v2/inventory/*
// the CANONICAL inventory URL space. Every destination below is a thin V2
// wrapper around the existing, authenticated legacy inventory surface — same
// data reads, same server actions, same permissions (status stays REUSE:
// nothing is reimplemented, the legacy component renders inside the V2 shell).
export const INVENTORY_HUB_LINKS: readonly InventoryHubLink[] = [
  { key: "overview", label: "الكميات والتوفّر", description: "عرض الكميات، الحدود، الاستيراد والتصدير والمزامنة الحالية.", href: "/v2/inventory", status: "REUSE" },
  { key: "movements", label: "الحركات", description: "إدخال حركات الوارد والصادر ومراجعة سجل الحركة.", href: "/v2/inventory/movements", status: "REUSE" },
  { key: "stocktake", label: "الجرد", description: "تسجيل العدّ الفعلي للمنتجات والخيارات حسب الموقع.", href: "/v2/inventory/stocktake", status: "REUSE" },
  { key: "shelves", label: "الرفوف والمواقع", description: "إدارة الرفوف وتوزيع مخزون المنتجات والخيارات.", href: "/v2/inventory/shelves", status: "REUSE" },
  { key: "out-of-stock", label: "المنتجات النافدة", description: "مراجعة المنتجات النافدة وحالة عرضها في القنوات.", href: "/v2/inventory/out-of-stock", status: "REUSE" },
  { key: "approvals", label: "اعتمادات الموظفين", description: "مراجعة واعتماد أو عكس حركات المخزون المسجلة من الموظفين.", href: "/v2/inventory/approvals", status: "REUSE" },
  { key: "reports", label: "التقارير", description: "المبيعات، القيمة، الهوامش، المخزون الميت والفاقد.", href: "/v2/inventory/reports", status: "REUSE" },
  { key: "barcode", label: "الباركود والملصقات", description: "طباعة ملصقات المنتجات واستخدام قارئ الباركود الحالي.", href: "/v2/inventory/labels", status: "REUSE" },
  { key: "shelf-labels", label: "ملصقات الرفوف", description: "طباعة ملصقات المواقع اعتمادًا على توزيع الرفوف الحالي.", href: "/v2/inventory/shelves/labels", status: "REUSE" },
];
