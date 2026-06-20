// CEO Dashboard data layer (server-only, read-only). Uses the anon/cookie
// client — every value is COMPUTED from the DB, nothing invented. Each query is
// defensive: failures degrade to safe zeros so the page never crashes.
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";

export interface NameCount { name: string; count: number }
export interface ChannelBreak { channel: string; active: number; draft: number; notListed: number; total: number }
export interface RejectedItem { id: string; sku: string | null; name_en: string | null }

export interface CeoKpis {
  configured: boolean;
  totalProducts: number;
  categoriesCount: number;
  brandsCount: number;
  productsWithBrand: number;
  approvedCount: number;
  rejectedCount: number;
  sentAiCount: number;
  noApprovalCount: number;
  rejectedList: RejectedItem[];
  missingImage: number;
  featuredCount: number;
  promotedCount: number;
  inventoryUnits: number;
  inventoryRows: number;
  missingPrice: number;
  missingBarcode: number;
  missingCategory: number;   // products with no main_category
  publishedActive: number;   // total Active rows across all channel_products
  publishedChannels: number; // how many channels have at least one Active listing
  categoryBreakdown: NameCount[];
  brandBreakdown: NameCount[];
  channelBreakdown: ChannelBreak[];
  generatedAt: string;       // ISO timestamp this snapshot was computed
}

const PAGE = 1000;

async function countOf(builder: () => PromiseLike<{ count: number | null; error: unknown }>): Promise<number> {
  try { const { count, error } = await builder(); return error ? 0 : (count ?? 0); } catch { return 0; }
}
async function fetchAll(client: any, table: string, cols: string): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client.from(table).select(cols).range(from, from + PAGE - 1);
    if (error) break;
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  return out;
}

export async function getCeoKpis(): Promise<CeoKpis> {
  const empty: CeoKpis = {
    configured: isSupabaseConfigured(),
    totalProducts: 0, categoriesCount: 0, brandsCount: 0, productsWithBrand: 0,
    approvedCount: 0, rejectedCount: 0, sentAiCount: 0, noApprovalCount: 0, rejectedList: [],
    missingImage: 0, featuredCount: 0, promotedCount: 0,
    inventoryUnits: 0, inventoryRows: 0,
    missingPrice: 0, missingBarcode: 0, missingCategory: 0, publishedActive: 0, publishedChannels: 0,
    categoryBreakdown: [], brandBreakdown: [], channelBreakdown: [],
    generatedAt: new Date().toISOString(),
  };
  if (!empty.configured) return empty;

  const sb = createClient();
  const c = (q: string, apply?: (b: any) => any) => countOf(() => {
    let b = sb.from(q).select("*", { count: "exact", head: true });
    return apply ? apply(b) : b;
  });

  // Cheap head-count queries in parallel.
  const [
    totalProducts, categoriesCount, brandsCount, productsWithBrand,
    approvedCount, rejectedCount, sentAiCount, noApprovalCount,
    missingImage, featuredCount, promotedCount, missingPrice, missingBarcode,
  ] = await Promise.all([
    c("products"),
    c("product_categories"),
    c("brands"),
    c("products", (b) => b.not("brand_id", "is", null)),
    c("products", (b) => b.eq("approval", "Approved")),
    c("products", (b) => b.eq("approval", "Rejected")),
    c("products", (b) => b.eq("approval", "SentAI")),
    c("products", (b) => b.is("approval", null)),
    c("products", (b) => b.is("image_url", null)),
    c("products", (b) => b.eq("is_featured", true)),
    c("products", (b) => b.eq("is_promoted", true)),
    c("products", (b) => b.or("price.is.null,price.eq.0")),
    c("products", (b) => b.is("barcode", null)),
  ]);

  // The actual rejected products (small list — for the "View rejected" panel).
  let rejectedList: RejectedItem[] = [];
  try {
    const { data } = await sb
      .from("products").select("id, sku, name_en")
      .eq("approval", "Rejected")
      .order("sku", { ascending: true })
      .limit(200);
    rejectedList = (data ?? []) as RejectedItem[];
  } catch { /* leave empty */ }

  // Row-level fetches for breakdowns + inventory sum.
  const [prodRows, invRows, channels, links, brands] = await Promise.all([
    fetchAll(sb, "products", "main_category, brand_id"),
    fetchAll(sb, "inventory", "stock_quantity"),
    fetchAll(sb, "channels", "id, name"),
    fetchAll(sb, "channel_products", "channel_id, channel_status"),
    fetchAll(sb, "brands", "id, name"),
  ]);

  // Inventory units (placeholder 50 each until stocktake).
  const inventoryUnits = invRows.reduce((s, r) => s + (Number(r.stock_quantity) || 0), 0);

  // Category breakdown.
  const catMap = new Map<string, number>();
  for (const r of prodRows) { const k = r.main_category || "Uncategorized"; catMap.set(k, (catMap.get(k) || 0) + 1); }
  const categoryBreakdown = [...catMap.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

  // Brand breakdown (top 10).
  const brandName = new Map<string, string>(brands.map((b: any) => [b.id, b.name]));
  const brandMap = new Map<string, number>();
  for (const r of prodRows) { if (!r.brand_id) continue; const k = brandName.get(r.brand_id) || "(unknown)"; brandMap.set(k, (brandMap.get(k) || 0) + 1); }
  const brandBreakdown = [...brandMap.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 10);

  // Channel status breakdown (disambiguate duplicate channel names).
  const counts: Record<string, number> = {};
  const idToName = new Map<string, string>(channels.map((ch: any) => [ch.id, ch.name]));
  const seen: Record<string, number> = {};
  const labelFor = new Map<string, string>();
  for (const ch of channels) {
    const dupes = channels.filter((x: any) => x.name === ch.name).length;
    if (dupes > 1) { seen[ch.name] = (seen[ch.name] || 0) + 1; labelFor.set(ch.id, `${ch.name} #${seen[ch.name]}`); }
    else labelFor.set(ch.id, ch.name);
  }
  const chMap = new Map<string, ChannelBreak>();
  for (const ch of channels) chMap.set(ch.id, { channel: labelFor.get(ch.id) || ch.name, active: 0, draft: 0, notListed: 0, total: 0 });
  for (const l of links) {
    const cb = chMap.get(l.channel_id); if (!cb) continue;
    cb.total++;
    if (l.channel_status === "Active") cb.active++;
    else if (l.channel_status === "Draft") cb.draft++;
    else cb.notListed++;
  }
  void counts; void idToName;
  const channelBreakdown = [...chMap.values()];

  // Real publishing reach (from channel_products), not the legacy Snoonu approval flag.
  const publishedActive = channelBreakdown.reduce((s, c) => s + c.active, 0);
  const publishedChannels = channelBreakdown.filter((c) => c.active > 0).length;

  // Products with no category (the "Uncategorized" bucket above).
  const missingCategory = prodRows.filter((r) => !r.main_category).length;

  return {
    configured: true,
    totalProducts, categoriesCount, brandsCount, productsWithBrand,
    approvedCount, rejectedCount, sentAiCount, noApprovalCount, rejectedList,
    missingImage, featuredCount, promotedCount,
    inventoryUnits, inventoryRows: invRows.length,
    missingPrice, missingBarcode, missingCategory, publishedActive, publishedChannels,
    categoryBreakdown, brandBreakdown, channelBreakdown,
    generatedAt: new Date().toISOString(),
  };
}
