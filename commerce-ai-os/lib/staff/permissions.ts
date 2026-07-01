// Per-employee capabilities. The admin grants these on /team; the /staff page
// renders only the granted tabs, and every staff server action re-checks them.
// Pure data + helpers (no server-only imports) so both client and server can use it.

export type StaffPermission = "stock" | "products" | "prices" | "malak" | "reports";

export const STAFF_PERMISSION_KEYS: StaffPermission[] = ["stock", "products", "prices", "malak", "reports"];

// Existing employees (before the permissions column) keep exactly what they had:
// stock in/out only.
export const DEFAULT_PERMISSIONS: StaffPermission[] = ["stock"];

export const STAFF_PERMISSIONS: { key: StaffPermission; ar: string; en: string; icon: string; needs?: StaffPermission }[] = [
  { key: "stock",    ar: "إدخال/إخراج المخزون", en: "Stock in / out",  icon: "📦" },
  { key: "products", ar: "عرض المنتجات",         en: "View products",   icon: "👁️" },
  { key: "prices",   ar: "عرض الأسعار",          en: "View prices",     icon: "💵", needs: "products" },
  { key: "malak",    ar: "استخدام ملاك AI",       en: "Use Malak AI",    icon: "✨" },
  { key: "reports",  ar: "عرض تقاريره",           en: "View own reports", icon: "📊" },
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
  // "prices" is meaningless without "products".
  if (set.has("prices") && !set.has("products")) set.delete("prices");
  return STAFF_PERMISSION_KEYS.filter((k) => set.has(k));
}

export function hasPerm(perms: StaffPermission[] | undefined, key: StaffPermission): boolean {
  return !!perms && perms.includes(key);
}
