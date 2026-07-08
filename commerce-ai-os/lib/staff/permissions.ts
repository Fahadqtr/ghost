// Per-employee capabilities. The admin grants these on /team; the /staff page
// renders only the granted tabs, and every staff server action re-checks them.
// Pure data + helpers (no server-only imports) so both client and server can use it.

export type StaffPermission =
  | "stock" | "add_product" | "products" | "prices"
  | "edit_products" | "edit_images" // supervisor: change prices/data & photos from /staff
  | "malak" | "reports" | "tasks";

export const STAFF_PERMISSION_KEYS: StaffPermission[] = ["stock", "add_product", "products", "prices", "edit_products", "edit_images", "malak", "reports", "tasks"];

// Existing employees (before the permissions column) keep exactly what they had:
// stock in/out only.
export const DEFAULT_PERMISSIONS: StaffPermission[] = ["stock"];

export const STAFF_PERMISSIONS: { key: StaffPermission; ar: string; en: string; icon: string; needs?: StaffPermission }[] = [
  { key: "stock",       ar: "إدخال/إخراج المخزون", en: "Stock in / out",  icon: "📦" },
  { key: "add_product", ar: "إضافة منتج جديد",     en: "Add new product", icon: "➕" },
  { key: "products", ar: "عرض المنتجات",         en: "View products",   icon: "👁️" },
  { key: "prices",   ar: "عرض الأسعار",          en: "View prices",     icon: "💵", needs: "products" },
  { key: "edit_products", ar: "تعديل المنتجات (مشرف)", en: "Edit products (supervisor)", icon: "✏️", needs: "products" },
  { key: "edit_images",   ar: "تعديل الصور (مشرف)",    en: "Edit photos (supervisor)",   icon: "🖼️", needs: "products" },
  { key: "malak",    ar: "استخدام ملاك AI",       en: "Use Malak AI",    icon: "✨" },
  { key: "reports",  ar: "عرض تقاريره",           en: "View own reports", icon: "📊" },
  { key: "tasks",    ar: "المهام",                en: "Tasks",           icon: "📋" },
];

// Coerce whatever came back from the DB (jsonb array, comma string, null) into a
// clean, valid permission list.
export function parsePermissions(raw: unknown): StaffPermission[] {
  let arr: unknown[] = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === "string" && raw.trim()) {
    try {
      const j = JSON.parse(raw);
      arr = Array.isArray(j) ? j : String(raw).split(",");
    } catch {
      arr = raw.split(",");
    }
  } else return [...DEFAULT_PERMISSIONS];

  const set = new Set(
    arr.map((v) => String(v).trim()).filter((v): v is StaffPermission => (STAFF_PERMISSION_KEYS as string[]).includes(v))
  );
  // Dependent permissions are meaningless without their base tab (e.g. "prices"
  // or the supervisor edit perms without "products").
  for (const p of STAFF_PERMISSIONS) {
    if (p.needs && set.has(p.key) && !set.has(p.needs)) set.delete(p.key);
  }
  return STAFF_PERMISSION_KEYS.filter((k) => set.has(k));
}

export function hasPerm(perms: StaffPermission[] | undefined, key: StaffPermission): boolean {
  return !!perms && perms.includes(key);
}
