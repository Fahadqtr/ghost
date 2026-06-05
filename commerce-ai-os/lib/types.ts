// Hand-written TypeScript types mirroring the EXISTING Supabase schema.
// The schema is already created & seeded — these types describe it, they do not
// define it. Keep them in sync with the DB; do not modify the DB to match these.

import type { Category, ChannelStatus, StockStatus } from "./constants";

/** `products` — mirror of the 28-column Master Product Sheet. */
export interface Product {
  id: string;
  sku: string | null;
  barcode: string | null;
  name_en: string | null;
  name_ar: string | null;
  brand_id: string | null;
  main_category: Category | null;
  sub_category: string | null;
  product_type: string | null;
  color: string | null;
  size: string | null;
  price: number | null;
  discount_price: number | null;
  cost: number | null;
  stock_quantity: number | null;
  stock_status: StockStatus | string | null;
  platform_status: string | null;
  image_filename: string | null;
  image_url: string | null;
  description_en: string | null;
  description_ar: string | null;
  keywords_en: string | null;
  keywords_ar: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** `product_variants` — parent/child, drives the Talabat splitter later. */
export interface ProductVariant {
  id: string;
  parent_product_id: string;
  variant_name: string | null;
  sku: string | null;
  color: string | null;
  size: string | null;
  price: number | null;
  stock_quantity: number | null;
}

/** `product_images`. */
export interface ProductImage {
  id: string;
  product_id: string;
  url: string | null;
  filename: string | null;
  is_primary: boolean | null;
  sort_order: number | null;
}

/** `product_categories` (the 11 locked categories). */
export interface ProductCategory {
  id: string;
  name: string;
}

/** `inventory` — single source of stock truth. */
export interface Inventory {
  id: string;
  product_id: string;
  stock_quantity: number | null;
  low_stock_threshold: number | null;
  sold_quantity: number | null;
  updated_at: string;
}

/** `brands`. */
export interface Brand {
  id: string;
  name: string;
}

/** `channels`. */
export interface Channel {
  id: string;
  name: string;
  supports_variants: boolean | null;
}

/** `channel_products` — per-channel publishing rules (status & optional price).
 *  SHARED INVENTORY: `channel_stock` is intentionally ALWAYS null. Every channel
 *  (both Snoonu storefronts, Shopify, Talabat, Rafeeq) draws from the single
 *  `inventory` pool — there is no per-channel stock. Never write channel_stock. */
export interface ChannelProduct {
  id: string;
  channel_id: string;
  product_id: string;
  channel_status: ChannelStatus | string | null;
  channel_price: number | null;
  /** Always null by design — see note above. Stock lives only in `inventory`. */
  channel_stock: null;
}

/** `agent_logs` — Phase 1 command panel writes rows here (no AI).
 *  Columns verified against the live schema: id, agent_name, command, result, created_at. */
export interface AgentLog {
  id: string;
  agent_name: string | null;
  command: string | null;
  result: string | null;
  created_at: string;
}
