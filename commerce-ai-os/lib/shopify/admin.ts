import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Env-gated Shopify Admin API client (GraphQL). Needs SHOPIFY_STORE_DOMAIN
// (xxxxx.myshopify.com) plus a token: either SHOPIFY_ADMIN_TOKEN directly
// (legacy custom app) or the OAuth token stored in shopify_tokens by the
// /api/shopify/install flow (new Dev Dashboard apps).

const API_VERSION = "2025-01";

export function shopifyConfigured(): boolean {
  return Boolean(
    process.env.SHOPIFY_STORE_DOMAIN &&
    (process.env.SHOPIFY_ADMIN_TOKEN || process.env.SHOPIFY_CLIENT_ID),
  );
}

// OAuth token from the DB, cached in-process for 5 minutes.
let tokCache: { v: string; at: number } | null = null;
export function invalidateShopifyTokenCache(): void { tokCache = null; }
async function resolveToken(domain: string): Promise<string | null> {
  const envTok = process.env.SHOPIFY_ADMIN_TOKEN;
  if (envTok) return envTok;
  if (tokCache && Date.now() - tokCache.at < 300_000) return tokCache.v;
  try {
    const admin = createAdminClient();
    const { data } = await admin.from("shopify_tokens").select("access_token").eq("shop", domain).single();
    const t = String(data?.access_token ?? "");
    if (t) { tokCache = { v: t, at: Date.now() }; return t; }
  } catch { /* fall through */ }
  return null;
}

export async function shopifyGraphQL<T = any>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ data?: T; error?: string }> {
  const domain = String(process.env.SHOPIFY_STORE_DOMAIN ?? "").trim();
  if (!domain) return { error: "شوبي فاي غير مهيأ (SHOPIFY_STORE_DOMAIN)." };
  const token = await resolveToken(domain);
  if (!token) return { error: "شوبي فاي غير مربوط بعد — افتح /api/shopify/install لإتمام الربط." };

  try {
    const r = await fetch(`https://${domain}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: variables ?? {} }),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      return { error: `Shopify HTTP ${r.status}: ${detail}` };
    }
    const j: any = await r.json();
    if (j.errors?.length) return { error: j.errors.map((e: any) => e?.message ?? "error").join("; ").slice(0, 500) };
    return { data: j.data as T };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Shopify request failed." };
  }
}

export interface ShopifyVariant {
  id: string;            // gid://shopify/ProductVariant/…
  sku: string;
  price: string;
  compareAtPrice: string | null;
}

export interface ShopifyProduct {
  id: string;            // gid://shopify/Product/…
  title: string;
  status: string;        // ACTIVE | DRAFT | ARCHIVED
  handle: string;
  variants: ShopifyVariant[];
}

interface ProductsQuery {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: { id: string; title: string; status: string; handle: string; variants: { nodes: { id: string; sku: string | null; price: string; compareAtPrice: string | null }[] } }[];
  };
}

/** Every product in the store (paginated 100/page; hard cap 5000 products). */
export async function fetchAllShopifyProducts(): Promise<{ products?: ShopifyProduct[]; error?: string }> {
  const out: ShopifyProduct[] = [];
  let after: string | null = null;
  for (let page = 0; page < 50; page++) {
    const resp: { data?: ProductsQuery; error?: string } = await shopifyGraphQL<ProductsQuery>(
      `query($after: String) {
        products(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id title status handle
            variants(first: 50) { nodes { id sku price compareAtPrice } }
          }
        }
      }`,
      { after },
    );
    if (resp.error) return { error: resp.error };
    const conn: ProductsQuery["products"] | undefined = resp.data?.products;
    for (const n of conn?.nodes ?? []) {
      out.push({
        id: n.id, title: n.title, status: n.status, handle: n.handle,
        variants: (n.variants?.nodes ?? []).map((v) => ({
          id: v.id, sku: String(v.sku ?? "").trim(), price: v.price, compareAtPrice: v.compareAtPrice,
        })),
      });
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return { products: out };
}

/** Update one variant's price/compareAtPrice (needs the parent product id). */
export async function updateVariantPrice(
  productId: string,
  variantId: string,
  price: string,
  compareAtPrice: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await shopifyGraphQL<{
    productVariantsBulkUpdate: { userErrors: { message: string }[] };
  }>(
    `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        userErrors { message }
      }
    }`,
    { productId, variants: [{ id: variantId, price, compareAtPrice }] },
  );
  if (error) return { ok: false, error };
  const ue = data?.productVariantsBulkUpdate?.userErrors ?? [];
  if (ue.length) return { ok: false, error: ue.map((u) => u.message).join("; ").slice(0, 300) };
  return { ok: true };
}
