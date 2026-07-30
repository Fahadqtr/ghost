import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncStockBySku, type ShopifyStockPushSummary } from "./stock-push";

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
  inventoryItemId: string;        // gid://shopify/InventoryItem/… ("" when absent)
  inventoryQuantity: number | null; // current available qty across locations
}

export interface ShopifyProduct {
  id: string;            // gid://shopify/Product/…
  title: string;
  status: string;        // ACTIVE | DRAFT | ARCHIVED
  handle: string;
  descriptionHtml: string;
  imageUrl: string;      // featured image ("" when none)
  variants: ShopifyVariant[];
}

interface ProductsQuery {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: { id: string; title: string; status: string; handle: string; descriptionHtml: string | null; featuredMedia: { preview: { image: { url: string } | null } | null } | null; variants: { nodes: { id: string; sku: string | null; price: string; compareAtPrice: string | null; inventoryQuantity: number | null; inventoryItem: { id: string } | null }[] } }[];
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
            id title status handle descriptionHtml
            featuredMedia { preview { image { url } } }
            variants(first: 50) { nodes { id sku price compareAtPrice inventoryQuantity inventoryItem { id } } }
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
        descriptionHtml: String(n.descriptionHtml ?? ""),
        imageUrl: String(n.featuredMedia?.preview?.image?.url ?? ""),
        variants: (n.variants?.nodes ?? []).map((v) => ({
          id: v.id, sku: String(v.sku ?? "").trim(), price: v.price, compareAtPrice: v.compareAtPrice,
          inventoryItemId: String(v.inventoryItem?.id ?? ""),
          inventoryQuantity: typeof v.inventoryQuantity === "number" ? v.inventoryQuantity : null,
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

/** Update a product's title and/or status (name/status sync — catalog wins). */
export async function updateShopifyProductContent(
  productId: string,
  fields: { title?: string; status?: "ACTIVE" | "DRAFT" },
): Promise<{ ok: boolean; error?: string }> {
  if (!fields.title && !fields.status) return { ok: true };
  const { data, error } = await shopifyGraphQL<{
    productUpdate: { userErrors: { message: string }[] };
  }>(
    `mutation($product: ProductUpdateInput!) {
      productUpdate(product: $product) {
        userErrors { message }
      }
    }`,
    { product: { id: productId, ...(fields.title ? { title: fields.title } : {}), ...(fields.status ? { status: fields.status } : {}) } },
  );
  if (error) return { ok: false, error };
  const ue = data?.productUpdate?.userErrors ?? [];
  if (ue.length) return { ok: false, error: ue.map((u) => u.message).join("; ").slice(0, 300) };
  return { ok: true };
}

/** Attach an image (public URL — Shopify fetches it) to an EXISTING product. */
export async function addProductImage(productId: string, imageUrl: string): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await shopifyGraphQL<{
    productCreateMedia: { mediaUserErrors: { message: string }[] };
  }>(
    `mutation($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        mediaUserErrors { message }
      }
    }`,
    { productId, media: [{ originalSource: imageUrl, mediaContentType: "IMAGE" }] },
  );
  if (error) return { ok: false, error };
  const ue = data?.productCreateMedia?.mediaUserErrors ?? [];
  if (ue.length) return { ok: false, error: ue.map((u) => u.message).join("; ").slice(0, 300) };
  return { ok: true };
}

import type { ShopifyOrderLite } from "./orders-compute";

interface OrdersQuery {
  orders: {
    nodes: {
      id: string; name: string; createdAt: string;
      displayFinancialStatus: string | null; displayFulfillmentStatus: string | null;
      totalPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null;
      customer: { displayName: string | null } | null;
      cancelledAt: string | null;
      lineItems: { nodes: { title: string; quantity: number; sku: string | null }[] };
    }[];
  };
}

/** Newest orders since `sinceIso` (custom apps see the last 60 days). */
export async function fetchRecentShopifyOrders(sinceIso: string, limit = 50): Promise<{ orders?: ShopifyOrderLite[]; error?: string }> {
  const resp: { data?: OrdersQuery; error?: string } = await shopifyGraphQL<OrdersQuery>(
    `query($q: String, $first: Int!) {
      orders(first: $first, query: $q, sortKey: CREATED_AT, reverse: true) {
        nodes {
          id name createdAt displayFinancialStatus displayFulfillmentStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          customer { displayName }
          cancelledAt
          lineItems(first: 25) { nodes { title quantity sku } }
        }
      }
    }`,
    { q: `created_at:>=${sinceIso}`, first: Math.max(1, Math.min(100, limit)) },
  );
  if (resp.error) return { error: resp.error };
  const orders: ShopifyOrderLite[] = (resp.data?.orders?.nodes ?? []).map((n) => ({
    id: n.id,
    name: n.name,
    createdAt: n.createdAt,
    financial: String(n.displayFinancialStatus ?? ""),
    fulfillment: String(n.displayFulfillmentStatus ?? ""),
    total: Number(n.totalPriceSet?.shopMoney?.amount ?? NaN),
    currency: String(n.totalPriceSet?.shopMoney?.currencyCode ?? "QAR"),
    customer: String(n.customer?.displayName ?? ""),
    cancelledAt: n.cancelledAt ?? null,
    items: (n.lineItems?.nodes ?? []).map((li) => ({ title: li.title, qty: li.quantity, sku: li.sku ?? undefined })),
  }));
  return { orders };
}

/** First active location's id (single-location stores → the main one). */
export async function fetchPrimaryLocationId(): Promise<{ locationId?: string; error?: string }> {
  const resp: { data?: { locations: { nodes: { id: string; isActive: boolean }[] } }; error?: string } =
    await shopifyGraphQL(`{ locations(first: 10) { nodes { id isActive } } }`);
  if (resp.error) return { error: resp.error };
  const loc = (resp.data?.locations?.nodes ?? []).find((l) => l.isActive) ?? resp.data?.locations?.nodes?.[0];
  if (!loc) return { error: "ما في مواقع مخزون في شوبي فاي." };
  return { locationId: loc.id };
}

/** Absolute "available" quantities at one location (batched ≤200 a call). */
export async function setInventoryQuantities(
  locationId: string,
  items: { inventoryItemId: string; quantity: number }[],
): Promise<{ ok: boolean; updated: number; error?: string }> {
  let updated = 0;
  for (let i = 0; i < items.length; i += 200) {
    const batch = items.slice(i, i + 200);
    const { data, error } = await shopifyGraphQL<{
      inventorySetQuantities: { userErrors: { message: string }[] };
    }>(
      `mutation($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) { userErrors { message } }
      }`,
      {
        input: {
          name: "available",
          reason: "correction",
          ignoreCompareQuantity: true,
          quantities: batch.map((b) => ({ inventoryItemId: b.inventoryItemId, locationId, quantity: Math.max(0, Math.round(b.quantity)) })),
        },
      },
    );
    if (error) return { ok: false, updated, error };
    const ue = data?.inventorySetQuantities?.userErrors ?? [];
    if (ue.length) return { ok: false, updated, error: ue.map((u) => u.message).join("; ").slice(0, 300) };
    updated += batch.length;
  }
  return { ok: true, updated };
}

/**
 * Resolve a variant's inventory item id by SKU via the central client.
 * Returns `inventoryItemId: ""` when no variant matches the SKU (not an error),
 * and `error` only on an actual Shopify failure. The SKU is quote/backslash
 * stripped so it can't alter the search filter.
 */
export async function resolveInventoryItemIdBySku(
  sku: string,
): Promise<{ inventoryItemId?: string; error?: string }> {
  const clean = String(sku ?? "").replace(/["\\]/g, "");
  if (!clean) return { inventoryItemId: "" };
  const { data, error } = await shopifyGraphQL<{
    productVariants: { edges: { node: { inventoryItem: { id: string } | null } }[] };
  }>(
    `query($q: String!) {
      productVariants(first: 1, query: $q) { edges { node { inventoryItem { id } } } }
    }`,
    { q: `sku:"${clean}"` },
  );
  if (error) return { error };
  return { inventoryItemId: String(data?.productVariants?.edges?.[0]?.node?.inventoryItem?.id ?? "") };
}

/**
 * Push our stock quantities to Shopify through the ONE central client (same
 * credentials, API version, and location resolution as every other Shopify
 * call). Delegates the orchestration to the pure `syncStockBySku` core so the
 * decision logic is unit-tested; here we only wire the canonical capabilities.
 * Returns a typed summary — never a silent success.
 */
export async function pushInventoryStockToShopify(
  items: { sku: string; quantity: number }[],
): Promise<ShopifyStockPushSummary> {
  return syncStockBySku(items, {
    configured: shopifyConfigured,
    resolveLocationId: fetchPrimaryLocationId,
    resolveInventoryItemId: resolveInventoryItemIdBySku,
    setQuantity: async (locationId, inventoryItemId, quantity) => {
      const r = await setInventoryQuantities(locationId, [{ inventoryItemId, quantity }]);
      return { ok: r.ok, ...(r.error ? { error: r.error } : {}) };
    },
  });
}

export interface CreateProductOpts {
  title: string;
  descriptionHtml: string;
  status: "ACTIVE" | "DRAFT";
  price: string;
  compareAtPrice: string | null;
  sku: string | null;
  quantity: number;
  locationId: string | null; // null → skip the stock step
  imageUrl: string | null;
}

/**
 * Create one product with its default variant priced, SKU'd, tracked and
 * stocked — 3 sequential Admin calls (create → variant update → quantity).
 */
export async function createShopifyProduct(opts: CreateProductOpts): Promise<{ ok: boolean; shopifyId?: string; error?: string }> {
  const media = opts.imageUrl ? [{ originalSource: opts.imageUrl, mediaContentType: "IMAGE" }] : [];
  const created: { data?: {
    productCreate: {
      product: { id: string; variants: { nodes: { id: string; inventoryItem: { id: string } | null }[] } } | null;
      userErrors: { message: string }[];
    };
  }; error?: string } = await shopifyGraphQL(
    `mutation($input: ProductInput!, $media: [CreateMediaInput!]) {
      productCreate(input: $input, media: $media) {
        product { id variants(first: 1) { nodes { id inventoryItem { id } } } }
        userErrors { message }
      }
    }`,
    { input: { title: opts.title, descriptionHtml: opts.descriptionHtml, status: opts.status }, media },
  );
  if (created.error) return { ok: false, error: created.error };
  const ue = created.data?.productCreate?.userErrors ?? [];
  if (ue.length) return { ok: false, error: ue.map((u) => u.message).join("; ").slice(0, 300) };
  const product = created.data?.productCreate?.product;
  const variant = product?.variants?.nodes?.[0];
  if (!product || !variant) return { ok: false, error: "ما رجع منتج من Shopify." };

  // Default variant: price / compare-at / SKU / tracked inventory.
  const vu: { data?: { productVariantsBulkUpdate: { userErrors: { message: string }[] } }; error?: string } = await shopifyGraphQL(
    `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { message } }
    }`,
    {
      productId: product.id,
      variants: [{
        id: variant.id,
        price: opts.price,
        compareAtPrice: opts.compareAtPrice,
        inventoryItem: { ...(opts.sku ? { sku: opts.sku } : {}), tracked: true },
      }],
    },
  );
  const vue = vu.data?.productVariantsBulkUpdate?.userErrors ?? [];
  if (vu.error || vue.length) {
    return { ok: false, shopifyId: product.id, error: vu.error ?? vue.map((u) => u.message).join("; ").slice(0, 300) };
  }

  // Opening stock (best-effort — the product exists even if this step fails).
  if (opts.locationId && variant.inventoryItem?.id) {
    await setInventoryQuantities(opts.locationId, [{ inventoryItemId: variant.inventoryItem.id, quantity: opts.quantity }]);
  }
  return { ok: true, shopifyId: product.id };
}

// ---- Customers (CRM) ---------------------------------------------------------

export interface ShopifyCustomerLite {
  id: string;               // gid://shopify/Customer/…
  name: string;
  email: string;
  phone: string;
  orders: number;
  spent: number;            // total spend
  currency: string;
  lastOrderAt: string | null;
  createdAt: string | null;
}

interface CustomersQuery {
  customers: {
    nodes: {
      id: string; displayName: string | null; email: string | null; phone: string | null;
      numberOfOrders: string | number | null;
      amountSpent: { amount: string; currencyCode: string } | null;
      createdAt: string | null;
      lastOrder: { createdAt: string | null } | null;
    }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

/** All customers (highest spend first), paged up to `limit`. Needs the app's
 *  read_customers scope — a scope error surfaces so the UI can explain it.
 *  Shopify's CustomerSortKeys has no TOTAL_SPENT, so we fetch (newest first) and
 *  sort by amountSpent client-side. */
export async function fetchShopifyCustomers(limit = 250): Promise<{ customers?: ShopifyCustomerLite[]; error?: string }> {
  const out: ShopifyCustomerLite[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20 && out.length < limit; page++) {
    const resp: { data?: CustomersQuery; error?: string } = await shopifyGraphQL<CustomersQuery>(
      `query($cursor: String) {
        customers(first: 100, after: $cursor, sortKey: CREATED_AT, reverse: true) {
          nodes {
            id displayName email phone numberOfOrders
            amountSpent { amount currencyCode }
            createdAt
            lastOrder { createdAt }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { cursor },
    );
    if (resp.error) return out.length ? { customers: out } : { error: resp.error };
    const data = resp.data?.customers;
    for (const n of data?.nodes ?? []) {
      out.push({
        id: n.id,
        name: String(n.displayName ?? "").trim(),
        email: String(n.email ?? "").trim(),
        phone: String(n.phone ?? "").trim(),
        orders: Number(n.numberOfOrders ?? 0) || 0,
        spent: Number(n.amountSpent?.amount ?? 0) || 0,
        currency: String(n.amountSpent?.currencyCode ?? "QAR"),
        lastOrderAt: n.lastOrder?.createdAt ?? null,
        createdAt: n.createdAt ?? null,
      });
    }
    if (!data?.pageInfo?.hasNextPage) break;
    cursor = data.pageInfo.endCursor;
  }
  // Highest spend first (Shopify can't sort by total spent server-side).
  out.sort((a, b) => b.spent - a.spent);
  return { customers: out.slice(0, limit) };
}

export interface ShopifyCustomerOrder {
  name: string; createdAt: string; fulfillment: string; total: number; currency: string;
}

/** Recent orders for ONE customer (for the CRM profile). */
export async function fetchShopifyCustomerOrders(customerId: string, limit = 20): Promise<{ orders?: ShopifyCustomerOrder[]; error?: string }> {
  const resp: { data?: { customer: { orders: { nodes: {
    name: string; createdAt: string; displayFulfillmentStatus: string | null;
    totalPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null;
  }[] } } | null }; error?: string } = await shopifyGraphQL(
    `query($id: ID!, $first: Int!) {
      customer(id: $id) {
        orders(first: $first, sortKey: CREATED_AT, reverse: true) {
          nodes {
            name createdAt displayFulfillmentStatus
            totalPriceSet { shopMoney { amount currencyCode } }
          }
        }
      }
    }`,
    { id: customerId, first: Math.max(1, Math.min(50, limit)) },
  );
  if (resp.error) return { error: resp.error };
  const orders: ShopifyCustomerOrder[] = (resp.data?.customer?.orders?.nodes ?? []).map((n) => ({
    name: n.name,
    createdAt: n.createdAt,
    fulfillment: String(n.displayFulfillmentStatus ?? ""),
    total: Number(n.totalPriceSet?.shopMoney?.amount ?? NaN),
    currency: String(n.totalPriceSet?.shopMoney?.currencyCode ?? "QAR"),
  }));
  return { orders };
}
