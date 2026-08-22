export type InventoryHubStatus = "REUSE" | "NEEDS_MIGRATION";

export interface InventoryHubLink {
  key: string;
  label: string;
  description: string;
  href: string;
  status: InventoryHubStatus;
}

// INV.V2.1 is deliberately navigation-only. Every destination below is an
// existing, authenticated inventory surface and keeps its current data/actions.
export const INVENTORY_HUB_LINKS: readonly InventoryHubLink[] = [
  { key: "overview", label: "الكميات والتوفّر", description: "عرض الكميات، الحدود، الاستيراد والتصدير والمزامنة الحالية.", href: "/inventory", status: "REUSE" },
  { key: "shelves", label: "الرفوف والمواقع", description: "إدارة الرفوف وتوزيع مخزون المنتجات والخيارات.", href: "/inventory/shelves", status: "REUSE" },
  { key: "stocktake", label: "الجرد", description: "تسجيل العدّ الفعلي للمنتجات والخيارات حسب الموقع.", href: "/inventory/stocktake", status: "REUSE" },
  { key: "movements", label: "الحركات", description: "إدخال حركات الوارد والصادر ومراجعة سجل الحركة.", href: "/inventory/movements", status: "REUSE" },
  { key: "out-of-stock", label: "المنتجات النافدة", description: "مراجعة المنتجات النافدة وحالة عرضها في القنوات.", href: "/inventory/out-of-stock", status: "REUSE" },
  { key: "reports", label: "التقارير", description: "المبيعات، القيمة، الهوامش، المخزون الميت والفاقد.", href: "/inventory/reports", status: "REUSE" },
  { key: "barcode", label: "الباركود والملصقات", description: "طباعة ملصقات المنتجات واستخدام قارئ الباركود الحالي.", href: "/inventory/labels", status: "REUSE" },
  { key: "shelf-labels", label: "ملصقات الرفوف", description: "طباعة ملصقات المواقع اعتمادًا على توزيع الرفوف الحالي.", href: "/inventory/shelves/labels", status: "REUSE" },
  { key: "approvals", label: "اعتمادات الموظفين", description: "مراجعة واعتماد أو عكس حركات المخزون المسجلة من الموظفين.", href: "/inventory/approvals", status: "REUSE" },
];

