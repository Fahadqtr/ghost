// Shared, locked constants for Commerce AI OS.
// These mirror the seeded Supabase reference data. Do NOT diverge from the DB.

/**
 * Product categories — must match the `product_categories` table exactly
 * (FK products.main_category -> product_categories.name). Synced to the 17 real
 * categories from the imported master sheet on 2026-06-05.
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
  "✨Toys",
  "Uncategorized",
] as const;

export type Category = (typeof CATEGORIES)[number];

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
  { href: "/inventory", label: "Inventory", icon: "🏷️" },
  { href: "/channels", label: "Channels", icon: "🛒" },
  { href: "/agents", label: "Agents", icon: "🤖" },
  { href: "/import-export", label: "Import / Export", icon: "📤" },
] as const;

export const APP_NAME = "Commerce AI OS";
export const APP_OWNER = "Malika's Universe Trading";
