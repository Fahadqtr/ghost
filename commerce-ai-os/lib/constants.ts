// Shared, locked constants for Commerce AI OS.
// These mirror the seeded Supabase reference data. Do NOT diverge from the DB.

/**
 * Product categories — must match the `product_categories` table exactly
 * (FK products.main_category -> product_categories.name). Synced to the real
 * categories from the imported master sheet (✨Toys cleaned to Toys 2026-06-09).
 */
export const CATEGORIES = [
  "Face Care",
  "Body Care",
  "Hair Care",
  "Makeup",
  "Lashes & Nails",
  "Beauty Accessories",
  "Beauty Bundle",
  "Masks",
  "Sun Protection",
  "Dental Care",
  "Women’s Essentials",
  "Rhode Products Section",
  "Thailand Products",
  "Summer And Camping Supplies",
  "Electronics",
  "Toys",
  "Uncategorized",
] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * Sales platforms, each with its own independent Product Hub. The PRODUCT DATA
 * (name/price/images/description/variants) is shared — it lives on the master
 * (`products`) and is edited once. Only per-platform APPROVAL/REJECTION is
 * independent: Malika is the master itself (its products.approval), every other
 * platform stores its approval/rejection in the `platform_status` overlay table
 * keyed by (product_id, platform). Rejecting on one platform never affects
 * another, nor the master data.
 */
// Note: Malika is itself the Snoonu store, so "Snoonu" is not a separate
// platform here — it would duplicate the master.
export const PLATFORMS = [
  { key: "malika", label: "مليكاس", en: "Malika", master: true },
  { key: "pure_seoul", label: "Pure Seoul", en: "Pure Seoul", master: false },
  { key: "talabat", label: "Talabat", en: "Talabat", master: false },
  { key: "shopify", label: "Shopify", en: "Shopify", master: false },
  { key: "rafeeq", label: "Rafeeq", en: "Rafeeq", master: false },
] as const;
export type PlatformKey = (typeof PLATFORMS)[number]["key"];
export const PLATFORM_KEYS = PLATFORMS.map((p) => p.key) as readonly PlatformKey[];
export const platformBy = (key: string) => PLATFORMS.find((p) => p.key === key);

/** Per-channel publishing status options (mirrors channel_products.channel_status). */
export const CHANNEL_STATUSES = ["Active", "Draft", "Not Listed"] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

/** Stock status options used on products / inventory. */
export const STOCK_STATUSES = ["In Stock", "Low Stock", "Out of Stock"] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

/**
 * The 13 agents shown on the Agents page. Phase 1 = UI only; the command panel
 * writes a row to `agent_logs`. No AI logic, no external API calls.
 */
export const AGENTS = [
  { key: "product", name: "Product Agent", blurb: "Cleans & structures product data." },
  { key: "image", name: "Image Agent", blurb: "Organizes and tags product images." },
  { key: "inventory", name: "Inventory Agent", blurb: "Watches stock levels & thresholds." },
  { key: "channel_sync", name: "Channel Sync Agent", blurb: "Keeps channel listings aligned." },
  { key: "variant_splitter", name: "Variant Splitter Agent", blurb: "Splits parents into Talabat children." },
  { key: "snoonu", name: "Snoonu Agent", blurb: "Prepares Snoonu masterlist exports." },
  { key: "talabat", name: "Talabat Agent", blurb: "Prepares Talabat split-CSV exports." },
  { key: "rafeeq", name: "Rafeeq Agent", blurb: "Prepares Rafeeq exports." },
  { key: "shopify", name: "Shopify Agent", blurb: "Prepares Shopify CSV exports." },
  { key: "marketing", name: "Marketing Agent", blurb: "Drafts marketing posts." },
  { key: "customer_service", name: "Customer Service Agent", blurb: "Handles customer queries." },
  { key: "finance", name: "Finance Agent", blurb: "Tracks expenses & margins." },
  { key: "ceo", name: "CEO Agent", blurb: "Summarizes the whole business." },
] as const;

/** Primary sidebar navigation. */
export const NAV_ITEMS = [
  { href: "/malak", label: "ملاك · Malak AI", icon: "✨" },
  { href: "/dashboard", label: "CEO Dashboard", icon: "📊" },
  { href: "/products", label: "Product Hub", icon: "📦" },
  { href: "/platforms", label: "المنصات · Platforms", icon: "🏬" },
  { href: "/inventory", label: "Inventory", icon: "🏷️" },
  { href: "/channels", label: "Channels", icon: "🛒" },
  { href: "/agents", label: "Agents", icon: "🤖" },
  { href: "/import-export", label: "Import / Export", icon: "📤" },
] as const;

// Grouped navigation (Commerce AI OS). Groups only EXISTING routes under
// Arabic section headers — no invented pages.
export const NAV_GROUPS = [
  { title: "الرئيسية", titleEn: "Home", items: [{ href: "/dashboard", label: "لوحة المدير", en: "Dashboard", icon: "📊" }] },
  {
    title: "ملاك والوكلاء", titleEn: "Malak & agents",
    items: [
      { href: "/malak", label: "ملاك · Malak AI", en: "Malak AI", icon: "✨" },
      { href: "/agents", label: "الوكلاء", en: "Agents", icon: "🤖" },
    ],
  },
  { title: "المنتجات", titleEn: "Products", items: [
    { href: "/products", label: "الكتالوج", en: "Catalog", icon: "📦" },
    { href: "/catalog/health", label: "صحّة الكتالوج", en: "Catalog health", icon: "🩺" },
    { href: "/catalog/enrich", label: "إكمال بالذكاء", en: "AI completion", icon: "🤖" },
    { href: "/products/archive", label: "أرشفة وحذف", en: "Archive & delete", icon: "🗄️" },
  ] },
  {
    title: "المخزون", titleEn: "Inventory",
    items: [
      { href: "/inventory", label: "الكميات", en: "Quantities", icon: "🏷️" },
      { href: "/inventory/shelves", label: "الأرفف", en: "Shelves", icon: "🗄️" },
      { href: "/inventory/stocktake", label: "الجرد", en: "Stocktake", icon: "🔢" },
      { href: "/inventory/movements", label: "حركات الدخول/الخروج", en: "Stock IN / OUT", icon: "🔄" },
      { href: "/inventory/out-of-stock", label: "النافد", en: "Out of stock", icon: "⚠️" },
      { href: "/inventory/reports", label: "التقارير", en: "Reports", icon: "📈" },
      { href: "/inventory/labels", label: "الباركود", en: "Barcodes", icon: "🖨️" },
    ],
  },
  {
    title: "الموظفون", titleEn: "Staff",
    items: [
      { href: "/team", label: "الموظفون", en: "Employees", icon: "👥" },
      { href: "/tasks", label: "المهام", en: "Tasks", icon: "📋" },
      { href: "/approvals", label: "الاعتمادات", en: "Approvals", icon: "✅" },
      { href: "/staff", label: "صفحة الموظفين", en: "Staff page", icon: "📲" },
    ],
  },
  { title: "العملاء", titleEn: "Customers", items: [
    { href: "/crm", label: "العملاء (CRM)", en: "Customers (CRM)", icon: "🧑‍🤝‍🧑" },
    { href: "/loyalty", label: "مكافآت الجمال", en: "Beauty Rewards", icon: "❤️" },
  ] },
  { title: "التسويق", titleEn: "Marketing", items: [
    { href: "/inbox", label: "الوارد (دايركت)", en: "Inbox (DMs)", icon: "💬" },
    { href: "/social", label: "محتوى السوشيال", en: "Social content", icon: "📣" },
    { href: "/content", label: "مولّد المحتوى", en: "Content generator", icon: "🎬" },
    { href: "/studio", label: "استوديو ماليكا · Malika AI Studio", en: "Malika AI Studio", icon: "🎨" },
  ] },
  {
    title: "المنصات", titleEn: "Channels",
    items: [
      { href: "/platforms", label: "المنصات", en: "Platforms", icon: "🏬" },
      { href: "/shopify-orders", label: "طلبات شوبي فاي", en: "Shopify orders", icon: "🛍️" },
      { href: "/channels", label: "القنوات", en: "Channels", icon: "🛒" },
    ],
  },
  { title: "الاستيراد والتصدير", titleEn: "Import / Export", items: [{ href: "/import-export", label: "Excel استيراد/تصدير", en: "Excel import/export", icon: "📤" }] },
] as const;

export const APP_NAME = "Commerce AI OS";
export const APP_OWNER = "Malika's Universe Trading";
