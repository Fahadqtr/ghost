// Tests for the Malikas V2 Master Catalog view layer + read/page/shell safety
// scans (Phase UI.1). PURE tests only — no database, no network, no Supabase.
// Run: node --conditions=react-server --experimental-strip-types --test lib/catalog-v2/master-catalog-view.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_FILTERS,
  DEFAULT_CONTROLS,
  PAGE_SIZE,
  parseCatalogFilters,
  parseCatalogControls,
  parseCatalogPage,
  parseProductId,
  projectCatalogVariants,
  getVariantDisplayName,
  filterCatalogProducts,
  sortCatalogProducts,
  paginateCatalog,
  catalogHref,
  catalogDetailHref,
  catalogEditHref,
  summarizeCatalog,
  projectCatalogRows,
  getCompleteness,
  getCompletenessLabel,
  getApprovalLabel,
  getDisplayName,
  hasValidPrice,
  hasValidDiscount,
  isApproved,
  readinessPriority,
  CATALOG_FILTER_OPTIONS,
  CATALOG_SORT_OPTIONS,
  type CatalogControls,
  type MasterCatalogProduct,
} from "./master-catalog-view.ts";
import {
  loadMasterCatalog,
  loadCatalogProduct,
  type CatalogReadClient,
  type CatalogQueryResult,
  type CatalogRangeBuilder,
  type CatalogDetailReadClient,
  type CatalogDetailFilterBuilder,
} from "./master-catalog-read.ts";

// Inject the REAL pure projector so the read layer never resolves its lazy
// dynamic import under node:test.
const PROJECTOR = { projectCatalogRows };
const DETAIL_PROJECTOR = { projectCatalogRows, projectCatalogVariants };

// ── Builders ─────────────────────────────────────────────────────────────────

function product(over: Partial<MasterCatalogProduct> = {}): MasterCatalogProduct {
  return {
    id: "p1",
    sku: "MK-1",
    barcode: "B-1",
    nameAr: "منتج تجريبي",
    nameEn: "Sample Product",
    price: 10,
    discountPrice: null,
    imageUrl: "https://img/x.jpg",
    approval: "Approved",
    variantCount: 0,
    ...over,
  };
}
function rawProduct(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "p1",
    sku: "MK-1",
    barcode: "B-1",
    name_ar: "منتج",
    name_en: "Product",
    price: 10,
    discount_price: null,
    image_url: "https://img/x.jpg",
    approval: "Approved",
    ...over,
  };
}

// ── parseCatalogFilters ──────────────────────────────────────────────────────

test("empty params → default filters", () => {
  assert.deepEqual(parseCatalogFilters({}), DEFAULT_FILTERS);
  assert.deepEqual(parseCatalogFilters(null), DEFAULT_FILTERS);
  assert.deepEqual(parseCatalogFilters(undefined), DEFAULT_FILTERS);
});

test("unknown filter value → all", () => {
  assert.equal(parseCatalogFilters({ filter: "DROP TABLE" }).filter, "all");
  assert.equal(parseCatalogFilters({ filter: ["nonsense"] }).filter, "all");
});

test("query is trimmed", () => {
  assert.equal(parseCatalogFilters({ query: "  MK-9  " }).query, "MK-9");
});

test("query is capped at 80 characters", () => {
  assert.equal(parseCatalogFilters({ query: "a".repeat(500) }).query.length, 80);
});

test("non-string query is never coerced", () => {
  assert.equal(parseCatalogFilters({ query: 123 as unknown as string }).query, "");
  assert.equal(parseCatalogFilters({ query: { a: 1 } as unknown as string }).query, "");
  assert.equal(parseCatalogFilters({ query: [] }).query, "");
});

test("array query picks the first string member", () => {
  assert.equal(parseCatalogFilters({ query: ["MK-2", "MK-3"] }).query, "MK-2");
});

// ── Search ───────────────────────────────────────────────────────────────────

test("search by SKU (case-insensitive)", () => {
  const rows = [product({ id: "a", sku: "MK-777" }), product({ id: "b", sku: "OTHER", nameAr: null, nameEn: null, barcode: null })];
  const out = filterCatalogProducts(rows, { ...DEFAULT_FILTERS, query: "mk-777" });
  assert.deepEqual(out.map((p) => p.id), ["a"]);
});

test("search by barcode", () => {
  const rows = [product({ id: "a", barcode: "BAR-42", sku: null, nameAr: null, nameEn: null }), product({ id: "b", barcode: "ZZ" })];
  const out = filterCatalogProducts(rows, { ...DEFAULT_FILTERS, query: "bar-42" });
  assert.deepEqual(out.map((p) => p.id), ["a"]);
});

test("search by Arabic name", () => {
  const rows = [product({ id: "a", nameAr: "كريم مرطب", sku: null, barcode: null, nameEn: null }), product({ id: "b", nameAr: "شامبو" })];
  const out = filterCatalogProducts(rows, { ...DEFAULT_FILTERS, query: "مرطب" });
  assert.deepEqual(out.map((p) => p.id), ["a"]);
});

test("search by English name", () => {
  const rows = [product({ id: "a", nameEn: "Moisturizer", sku: null, barcode: null, nameAr: null }), product({ id: "b", nameEn: "Shampoo" })];
  const out = filterCatalogProducts(rows, { ...DEFAULT_FILTERS, query: "moist" });
  assert.deepEqual(out.map((p) => p.id), ["a"]);
});

// ── Filters ──────────────────────────────────────────────────────────────────

test("filter: has_variants / no_variants", () => {
  const rows = [product({ id: "a", variantCount: 2 }), product({ id: "b", variantCount: 0 })];
  assert.deepEqual(filterCatalogProducts(rows, { ...DEFAULT_FILTERS, filter: "has_variants" }).map((p) => p.id), ["a"]);
  assert.deepEqual(filterCatalogProducts(rows, { ...DEFAULT_FILTERS, filter: "no_variants" }).map((p) => p.id), ["b"]);
});

test("filter: missing_sku / missing_barcode / missing_image", () => {
  const rows = [
    product({ id: "nosku", sku: null }),
    product({ id: "nobar", barcode: "  " }),
    product({ id: "noimg", imageUrl: null }),
    product({ id: "full" }),
  ];
  assert.deepEqual(filterCatalogProducts(rows, { ...DEFAULT_FILTERS, filter: "missing_sku" }).map((p) => p.id), ["nosku"]);
  assert.deepEqual(filterCatalogProducts(rows, { ...DEFAULT_FILTERS, filter: "missing_barcode" }).map((p) => p.id), ["nobar"]);
  assert.deepEqual(filterCatalogProducts(rows, { ...DEFAULT_FILTERS, filter: "missing_image" }).map((p) => p.id), ["noimg"]);
});

test("search and filter combine (AND)", () => {
  const rows = [
    product({ id: "a", sku: "MK-1", variantCount: 3 }),
    product({ id: "b", sku: "MK-2", variantCount: 0 }),
  ];
  const out = filterCatalogProducts(rows, { query: "mk", filter: "has_variants" });
  assert.deepEqual(out.map((p) => p.id), ["a"]);
});

// ── Summary ──────────────────────────────────────────────────────────────────

test("summary totals + counts products (not variants) + missing fields", () => {
  const rows = [
    product({ id: "a", variantCount: 5, sku: "S", barcode: "B", imageUrl: "i" }),
    product({ id: "b", variantCount: 3, sku: null, barcode: "B", imageUrl: "i" }),
    product({ id: "c", variantCount: 0, sku: "S", barcode: null, imageUrl: null }),
  ];
  const s = summarizeCatalog(rows);
  assert.equal(s.totalProducts, 3, "counts products");
  assert.equal(s.withVariants, 2, "two products have variants (not 8)");
  assert.equal(s.missingSku, 1);
  assert.equal(s.missingBarcode, 1);
  assert.equal(s.missingImage, 1);
});

test("summary contract exposes only aggregate keys", () => {
  assert.deepEqual(
    Object.keys(summarizeCatalog([product()])).sort(),
    [
      "complete",
      "missingBarcode",
      "missingImage",
      "missingMultiple",
      "missingPrice",
      "missingSku",
      "totalProducts",
      "withDiscount",
      "withVariants",
    ].sort(),
  );
});

// ── Completeness ─────────────────────────────────────────────────────────────

test("completeness states + fixed Arabic labels", () => {
  assert.equal(getCompleteness(product()), "complete");
  assert.equal(getCompleteness(product({ sku: null })), "missing_sku");
  assert.equal(getCompleteness(product({ barcode: null })), "missing_barcode");
  assert.equal(getCompleteness(product({ imageUrl: null })), "missing_image");
  assert.equal(getCompleteness(product({ sku: null, imageUrl: null })), "missing_multiple");
  assert.equal(getCompletenessLabel("complete"), "مكتمل");
  assert.equal(getCompletenessLabel("missing_multiple"), "ناقص أكثر من حقل");
  // prototype-safe fallback
  assert.equal(getCompletenessLabel("__proto__" as unknown as ReturnType<typeof getCompleteness>), "مكتمل");
});

test("getDisplayName prefers Arabic, then English, else dash", () => {
  assert.equal(getDisplayName(product({ nameAr: "اسم" })), "اسم");
  assert.equal(getDisplayName(product({ nameAr: null, nameEn: "Name" })), "Name");
  assert.equal(getDisplayName(product({ nameAr: null, nameEn: null })), "—");
});

// ── projectCatalogRows ───────────────────────────────────────────────────────

test("projection maps whitelisted fields and counts variants per product", () => {
  const out = projectCatalogRows(
    [rawProduct({ id: "p1" }), rawProduct({ id: "p2", sku: "MK-2" })],
    [{ parent_product_id: "p1" }, { parent_product_id: "p1" }, { parent_product_id: "p2" }],
  );
  assert.equal(out.length, 2);
  assert.equal(out[0]!.variantCount, 2);
  assert.equal(out[1]!.variantCount, 1);
  assert.equal(out[0]!.nameAr, "منتج");
  assert.equal(out[0]!.imageUrl, "https://img/x.jpg");
});

test("projection output NEVER contains inventory/channel/platform/order fields", () => {
  const out = projectCatalogRows(
    [
      rawProduct({
        id: "p1",
        stock_quantity: 99,
        inventory: { stock: 5 },
        channel_status: "active",
        platform_status: "approved",
        shopify_id: "gid://shopify/Order/1",
        talabat_id: "T1",
        rafeeq_product_id: "R1",
        snoonu_id: "S1",
        order_id: "O1",
        raw: { body: "SECRET" },
        customer: { phone: "+974", email: "a@b.c", address: "x" },
      }),
    ],
    [],
  );
  const keys = Object.keys(out[0]!).sort();
  assert.deepEqual(keys, ["approval", "barcode", "discountPrice", "id", "imageUrl", "nameAr", "nameEn", "price", "sku", "variantCount"].sort());
  const json = JSON.stringify(out);
  for (const bad of ["stock", "inventory", "channel", "platform", "shopify", "talabat", "rafeeq", "snoonu", "order_id", "SECRET", "+974", "a@b.c", "address", "customer"]) {
    assert.ok(!json.includes(bad), `leaked: ${bad}`);
  }
});

test("projection does not mutate the input arrays", () => {
  const products = [rawProduct({ id: "p1" })];
  const variants = [{ parent_product_id: "p1" }];
  const ps = JSON.parse(JSON.stringify(products));
  const vs = JSON.parse(JSON.stringify(variants));
  projectCatalogRows(products, variants);
  assert.deepEqual(products, ps, "product rows not mutated");
  assert.deepEqual(variants, vs, "variant rows not mutated");
});

test("filter/search do not mutate the input products array", () => {
  const rows = [product({ id: "a" }), product({ id: "b", sku: "ZZ" })];
  const snap = JSON.parse(JSON.stringify(rows));
  filterCatalogProducts(rows, { ...DEFAULT_FILTERS, query: "mk" });
  assert.deepEqual(rows, snap);
});

test("runtime-invalid identity values do not invoke coercion and are skipped", () => {
  const hostileId = {
    toString() {
      throw new Error("toString must not run");
    },
    [Symbol.toPrimitive]() {
      throw new Error("toPrimitive must not run");
    },
  } as unknown as string;
  let out: MasterCatalogProduct[] = [];
  assert.doesNotThrow(() => {
    out = projectCatalogRows(
      [{ id: hostileId, sku: "X" }, rawProduct({ id: "good" })],
      [{ parent_product_id: hostileId }, { parent_product_id: "good" }],
    );
  });
  assert.deepEqual(out.map((p) => p.id), ["good"], "hostile id row skipped, valid row kept");
  assert.equal(out[0]!.variantCount, 1, "hostile variant parent id ignored, valid one counted");
});

test("non-string field values become null (never coerced)", () => {
  const out = projectCatalogRows([{ id: "p1", sku: 12345, price: "10", barcode: { a: 1 } }], []);
  assert.equal(out[0]!.sku, null, "numeric sku → null");
  assert.equal(out[0]!.price, null, "string price → null");
  assert.equal(out[0]!.barcode, null, "object barcode → null");
});

test("option list starts with 'all'", () => {
  assert.equal(CATALOG_FILTER_OPTIONS[0]!.value, "all");
});

// ── Source safety scan: view file ────────────────────────────────────────────

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("view source: pure, DB-free, no writes/coercion/any", () => {
  const src = strip(readFileSync(new URL("./master-catalog-view.ts", import.meta.url), "utf8"));
  for (const [re, msg] of [
    [/\bfetch\s*\(/, "fetch("],
    [/\.rpc\s*\(/, ".rpc("],
    [/\.insert\s*\(/, ".insert("],
    [/\.update\s*\(/, ".update("],
    [/\.upsert\s*\(/, ".upsert("],
    [/\.delete\s*\(/, ".delete("],
    [/server-only/, "server-only"],
    [/supabase/i, "supabase"],
    [/from\s+["']next/, "next import"],
    [/\bString\s*\(/, "String("],
    [/Date\.now/, "Date.now"],
    [/:\s*any\b/, ": any"],
    [/\bas\s+any\b/, "as any"],
    [/select\(\s*["']\*["']\s*\)/, 'select("*")'],
  ] as const) {
    assert.ok(!re.test(src), `forbidden in view source: ${msg}`);
  }
});

// ── Source safety scan: read layer ───────────────────────────────────────────

test("read source: SELECT-only, no writes/RPC/fetch/admin/env/logging/select(*)", () => {
  const src = strip(readFileSync(new URL("./master-catalog-read.ts", import.meta.url), "utf8"));
  for (const [re, msg] of [
    [/\bfetch\s*\(/, "fetch("],
    [/\.rpc\s*\(/, ".rpc("],
    [/\.insert\s*\(/, ".insert("],
    [/\.update\s*\(/, ".update("],
    [/\.upsert\s*\(/, ".upsert("],
    [/\.delete\s*\(/, ".delete("],
    [/createAdminClient/, "createAdminClient"],
    [/service_role/, "service_role"],
    [/process\.env/, "process.env"],
    [/console\./, "console."],
    [/dangerouslySetInnerHTML/, "dangerouslySetInnerHTML"],
    [/select\(\s*["']\*["']\s*\)/, 'select("*")'],
    [/:\s*any\b/, ": any"],
  ] as const) {
    assert.ok(!re.test(src), `forbidden in read source: ${msg}`);
  }
  // reads ONLY the catalog tables plus the membership listing table — no
  // inventory/platform/order tables
  for (const table of ["inventory", "channel_products", "channels", "platform_status", "orders", "talabat_orders", "shopify_synced_orders"]) {
    assert.ok(!new RegExp(`["']${table}["']`).test(src), `read must not reference table ${table}`);
  }
  assert.ok(/["']products["']/.test(src), "reads products");
  assert.ok(/["']product_variants["']/.test(src), "reads product_variants");
  // Membership scope: derived from ACTIVE snoonu:malikas listings, product_id
  // only, and never a hardcoded master size.
  assert.ok(/["']external_channel_listings["']/.test(src), "reads external_channel_listings for membership");
  // The storefront/status literals live in the SHARED pure module that the Home
  // Dashboard membership provider imports too, so the two cannot drift apart.
  assert.ok(/master-membership/.test(src), "membership definition comes from the shared module");
  const shared = strip(readFileSync(new URL("./master-membership.ts", import.meta.url), "utf8"));
  assert.ok(/["']snoonu:malikas["']/.test(shared), "scoped to the snoonu:malikas storefront");
  assert.ok(/["']active["']/.test(shared), "scoped to active mappings");
  assert.ok(!/\b1343\b/.test(shared), "master size must never be hardcoded (shared)");
  assert.ok(!/\b1343\b/.test(src), "master size must never be hardcoded");
  assert.ok(!/external_product_id/.test(src), "membership read must not select external ids");
});

// ── Page + layout wiring / read-only scans ───────────────────────────────────

test("catalog page: force-dynamic, wired to read layer, read-only, no PII/platform fields", () => {
  const raw = readFileSync(new URL("../../app/(v2)/v2/catalog/page.tsx", import.meta.url), "utf8");
  const src = strip(raw);
  assert.ok(/export const dynamic = "force-dynamic"/.test(src), "force-dynamic");
  assert.ok(/createClient\s*\(/.test(src), "uses createClient()");
  assert.ok(/loadMasterCatalog\s*\(/.test(src), "calls loadMasterCatalog");
  assert.ok(/تعذر تحميل كتالوج ماليكاس\./.test(src), "constant load-error message");
  for (const [re, msg] of [
    [/\bfetch\s*\(/, "fetch("],
    [/\.rpc\s*\(/, ".rpc("],
    [/\.insert\s*\(/, ".insert("],
    [/\.update\s*\(/, ".update("],
    [/\.upsert\s*\(/, ".upsert("],
    [/\.delete\s*\(/, ".delete("],
    [/createAdminClient/, "createAdminClient"],
    [/service_role/, "service_role"],
    [/process\.env/, "process.env"],
    [/console\./, "console."],
    [/dangerouslySetInnerHTML/, "dangerouslySetInnerHTML"],
    [/select\(\s*["']\*["']\s*\)/, 'select("*")'],
  ] as const) {
    assert.ok(!re.test(src), `forbidden in page: ${msg}`);
  }
});

test("v2 layout authenticates through the existing Supabase user session", () => {
  const src = strip(readFileSync(new URL("../../app/(v2)/v2/layout.tsx", import.meta.url), "utf8"));
  assert.ok(/createClient\s*\(/.test(src), "uses createClient()");
  assert.ok(/auth\.getUser\s*\(/.test(src), "checks auth.getUser()");
  assert.ok(/redirect\(\s*["']\/login["']\s*\)/.test(src), "redirects unauthenticated to /login");
  assert.ok(!/service_role/.test(src) && !/createAdminClient/.test(src), "no service role / admin client");
});

// ── Legacy interface untouched (V2 is independent) ───────────────────────────

test("legacy AppShell/Sidebar/BottomNav/constants do not reference V2 (unchanged)", () => {
  for (const rel of ["../../components/AppShell.tsx", "../../components/Sidebar.tsx", "../../components/BottomNav.tsx", "../constants.ts"]) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.ok(!/catalog-v2/.test(src), `${rel} must not reference catalog-v2`);
    assert.ok(!/components\/v2/.test(src), `${rel} must not reference components/v2`);
    assert.ok(!/["']\/v2/.test(src), `${rel} must not link to /v2`);
  }
});

// ── Paginated read (server row-limit safe) ───────────────────────────────────

const SERVER_MAX = 1000; // simulate the PostgREST default max-rows per response

interface FakeTableCfg {
  rows?: unknown[];
  failAtCall?: number; // 1-based page index whose result is an error
  throwAtCall?: number; // 1-based page index whose builder throws synchronously
}
interface CallRecord {
  table: string;
  orders: { column: string; ascending: boolean }[];
  range: [number, number];
  filters: { column: string; operator: string; value: string }[];
}

/**
 * Build the membership listing rows for a set of product rows (every product is
 * a master member). Tests that are ABOUT membership pass
 * `external_channel_listings` explicitly instead.
 */
function listingsFor(productRows: readonly unknown[]): Record<string, unknown>[] {
  return productRows.map((r, i) => ({ id: `l${i}`, product_id: (r as { id?: unknown }).id }));
}

function fakePagedClient(cfg: Record<string, FakeTableCfg>): { client: CatalogReadClient; calls: CallRecord[] } {
  // Unless a test configures membership itself, every configured product is a
  // member — so pre-existing paging/failure tests keep exercising what they were
  // written for rather than silently emptying the catalog.
  if (!("external_channel_listings" in cfg)) {
    cfg = { ...cfg, external_channel_listings: { rows: listingsFor(cfg.products?.rows ?? []) } };
  }
  const calls: CallRecord[] = [];
  const counts: Record<string, number> = {};
  const client: CatalogReadClient = {
    from(table: string) {
      const orders: { column: string; ascending: boolean }[] = [];
      const filters: { column: string; operator: string; value: string }[] = [];
      let pending: CatalogQueryResult = { data: [], error: null };
      const builder: CatalogRangeBuilder = {
        order(column: string, options: { ascending: boolean }) {
          orders.push({ column, ascending: options.ascending });
          return builder;
        },
        filter(column: string, operator: string, value: string) {
          filters.push({ column, operator, value });
          return builder;
        },
        range(from: number, to: number) {
          const n = (counts[table] = (counts[table] ?? 0) + 1);
          calls.push({
            table,
            orders: orders.map((o) => ({ ...o })),
            range: [from, to],
            filters: filters.map((f) => ({ ...f })),
          });
          const t = cfg[table] ?? {};
          if (t.throwAtCall === n) throw new Error("BUILDER BOOM SECRET");
          if (t.failAtCall === n) {
            pending = { data: null, error: { message: "PAGE SECRET", code: "42P01", hint: "SHINT" } };
          } else {
            const all = t.rows ?? [];
            // The server never returns more than SERVER_MAX rows in one response.
            const end = Math.min(to, from + SERVER_MAX - 1);
            pending = { data: all.slice(from, end + 1), error: null };
          }
          return builder;
        },
        then<TResult1 = CatalogQueryResult, TResult2 = never>(
          onfulfilled?: ((value: CatalogQueryResult) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ): PromiseLike<TResult1 | TResult2> {
          return Promise.resolve(pending).then(onfulfilled, onrejected);
        },
      };
      return { select: () => builder };
    },
  };
  return { client, calls };
}

const rangesFor = (calls: CallRecord[], table: string): [number, number][] =>
  calls.filter((c) => c.table === table).map((c) => c.range);
const ordersFor = (calls: CallRecord[], table: string): { column: string; ascending: boolean }[][] =>
  calls.filter((c) => c.table === table).map((c) => c.orders);

function makeProducts(n: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: `p${i}`, sku: `SKU-${i}`, barcode: `B-${i}`, name_ar: `منتج ${i}`, name_en: `Product ${i}`, price: i, discount_price: null, image_url: `https://img/${i}.jpg`, approval: "Approved" });
  }
  return out;
}
function makeVariants(parentIds: string[]): Record<string, unknown>[] {
  return parentIds.map((pid, i) => ({ id: `v${i}`, parent_product_id: pid }));
}

// ── Catalog membership: ACTIVE snoonu:malikas listings only ──────────────────

test("membership: only products with an active snoonu:malikas listing are visible", async () => {
  const products = makeProducts(10);
  // Members: p0, p3, p7 — the rest are outside the master and must not appear.
  const { client } = fakePagedClient({
    products: { rows: products },
    product_variants: { rows: [] },
    external_channel_listings: { rows: [{ id: "l0", product_id: "p0" }, { id: "l1", product_id: "p3" }, { id: "l2", product_id: "p7" }] },
  });
  const res = await loadMasterCatalog(client, { project: PROJECTOR });
  assert.equal(res.status, "ok");
  assert.deepEqual(res.products.map((p) => p.id).sort(), ["p0", "p3", "p7"]);
  assert.equal(res.products.length, 3, "count is derived from membership, never hardcoded");
});

test("membership: the listing read is filtered to snoonu:malikas + active and selects product_id only", async () => {
  const { client, calls } = fakePagedClient({ products: { rows: makeProducts(2) }, product_variants: { rows: [] } });
  await loadMasterCatalog(client, { project: PROJECTOR });
  const listingCalls = calls.filter((c) => c.table === "external_channel_listings");
  assert.ok(listingCalls.length >= 1, "membership read issued");
  for (const c of listingCalls) {
    assert.deepEqual(c.filters, [
      { column: "storefront_key", operator: "eq", value: "snoonu:malikas" },
      { column: "mapping_status", operator: "eq", value: "active" },
    ]);
    assert.deepEqual(
      c.orders.map((o) => o.column),
      ["product_id", "id"],
      "deterministic order with a unique tie-breaker",
    );
  }
});

test("membership: an archived / other-storefront listing does not admit a product", async () => {
  // The fake applies no filtering itself; these rows stand in for what the
  // FILTERED query returns — only p1 comes back, so only p1 is visible.
  const { client } = fakePagedClient({
    products: { rows: makeProducts(3) },
    product_variants: { rows: [] },
    external_channel_listings: { rows: [{ id: "l0", product_id: "p1" }] },
  });
  const res = await loadMasterCatalog(client, { project: PROJECTOR });
  assert.deepEqual(res.products.map((p) => p.id), ["p1"]);
});

test("membership: no active listings → empty catalog, not the whole products table", async () => {
  const { client } = fakePagedClient({
    products: { rows: makeProducts(5) },
    product_variants: { rows: [] },
    external_channel_listings: { rows: [] },
  });
  const res = await loadMasterCatalog(client, { project: PROJECTOR });
  assert.equal(res.status, "ok");
  assert.deepEqual(res.products, [], "fails empty, never falls back to unscoped");
});

test("membership: listing read failure fails CLOSED (never renders the unscoped catalog)", async () => {
  const { client } = fakePagedClient({
    products: { rows: makeProducts(5) },
    product_variants: { rows: [] },
    external_channel_listings: { failAtCall: 1 },
  });
  const res = await loadMasterCatalog(client, { project: PROJECTOR });
  assert.equal(res.status, "error");
  assert.deepEqual(res.products, []);
  const json = JSON.stringify(res);
  for (const leak of ["PAGE SECRET", "42P01", "SHINT"]) assert.ok(!json.includes(leak), `leaked: ${leak}`);
});

test("membership: listing builder throw fails CLOSED without leaking", async () => {
  const { client } = fakePagedClient({
    products: { rows: makeProducts(5) },
    product_variants: { rows: [] },
    external_channel_listings: { throwAtCall: 1 },
  });
  const res = await loadMasterCatalog(client, { project: PROJECTOR });
  assert.equal(res.status, "error");
  assert.ok(!JSON.stringify(res).includes("BOOM"), "builder error not exposed");
});

test("membership: malformed listing rows are ignored, never admitted", async () => {
  const { client } = fakePagedClient({
    products: { rows: makeProducts(4) },
    product_variants: { rows: [] },
    external_channel_listings: {
      rows: [null, 42, "p0", { id: "l1" }, { id: "l2", product_id: null }, { id: "l3", product_id: "" }, { id: "l4", product_id: "p2" }],
    },
  });
  const res = await loadMasterCatalog(client, { project: PROJECTOR });
  assert.deepEqual(res.products.map((p) => p.id), ["p2"]);
});

test("membership: a listing pointing at a non-existent product adds no phantom row", async () => {
  const { client } = fakePagedClient({
    products: { rows: makeProducts(2) },
    product_variants: { rows: [] },
    external_channel_listings: { rows: [{ id: "l0", product_id: "p0" }, { id: "l1", product_id: "ghost-id" }] },
  });
  const res = await loadMasterCatalog(client, { project: PROJECTOR });
  assert.deepEqual(res.products.map((p) => p.id), ["p0"]);
});

test("membership: duplicate listings for one product do not duplicate the visible row", async () => {
  const { client } = fakePagedClient({
    products: { rows: makeProducts(3) },
    product_variants: { rows: [] },
    external_channel_listings: { rows: [{ id: "l0", product_id: "p1" }, { id: "l1", product_id: "p1" }, { id: "l2", product_id: "p1" }] },
  });
  const res = await loadMasterCatalog(client, { project: PROJECTOR });
  assert.deepEqual(res.products.map((p) => p.id), ["p1"], "exactly one visible row per product");
});

test("membership: summary cards, filtering, sorting and pagination all see the scoped set", async () => {
  const products = makeProducts(30);
  const memberIds = ["p0", "p1", "p2", "p3", "p4"];
  const { client } = fakePagedClient({
    products: { rows: products },
    product_variants: { rows: makeVariants(["p0"]) },
    external_channel_listings: { rows: memberIds.map((pid, i) => ({ id: `l${i}`, product_id: pid })) },
  });
  const res = await loadMasterCatalog(client, { project: PROJECTOR });
  assert.equal(res.products.length, 5);
  // Every downstream helper consumes this same array.
  assert.equal(summarizeCatalog(res.products).totalProducts, 5, "cards scoped");
  assert.equal(summarizeCatalog(res.products).withVariants, 1, "variant card scoped");
  assert.equal(sortCatalogProducts(res.products, "sku_asc").length, 5, "sorting scoped");
  assert.equal(filterCatalogProducts(res.products, { query: "", filter: "all" }).length, 5, "filtering scoped");
  assert.equal(paginateCatalog(res.products, 1).totalPages, 1, "pagination scoped");
  // A product outside the master is unreachable by search.
  assert.equal(filterCatalogProducts(res.products, { query: "SKU-29", filter: "all" }).length, 0);
});

test("membership: listing cap marks the result partial rather than claiming completeness", async () => {
  const products = makeProducts(3);
  const many = Array.from({ length: 20001 }, (_, i) => ({ id: `l${i}`, product_id: i === 0 ? "p0" : `x${i}` }));
  const { client } = fakePagedClient({
    products: { rows: products },
    product_variants: { rows: [] },
    external_channel_listings: { rows: many },
  });
  const res = await loadMasterCatalog(client, { project: PROJECTOR });
  assert.equal(res.status, "ok");
  assert.equal(res.partial, true, "capped membership read is flagged partial");
});

test("products: 1146 rows across two pages → all preserved, partial false, ranges 0..999 then 1000..1999", async () => {
  const products = makeProducts(1146);
  const { client, calls } = fakePagedClient({ products: { rows: products }, product_variants: { rows: [] } });
  const res = await loadMasterCatalog(client, { project: PROJECTOR });
  assert.equal(res.status, "ok");
  assert.equal(res.products.length, 1146, "all rows across both pages preserved");
  assert.equal(res.partial, false);
  assert.deepEqual(rangesFor(calls, "products"), [
    [0, 999],
    [1000, 1999],
  ]);
});

test("products exactly 1000 → performs next-page check, returns 1000, partial false", async () => {
  const { client, calls } = fakePagedClient({ products: { rows: makeProducts(1000) }, product_variants: { rows: [] } });
  const res = await loadMasterCatalog(client, { project: PROJECTOR });
  assert.equal(res.products.length, 1000);
  assert.equal(res.partial, false);
  assert.deepEqual(rangesFor(calls, "products"), [
    [0, 999],
    [1000, 1999],
  ], "a second page is requested to prove the source ended");
});

test("products over PRODUCT_CAP → returns only 5000, partial true, never exceeds the cap", async () => {
  const { client } = fakePagedClient({ products: { rows: makeProducts(5001) }, product_variants: { rows: [] } });
  const res = await loadMasterCatalog(client, { project: PROJECTOR });
  assert.equal(res.products.length, 5000, "capped to PRODUCT_CAP");
  assert.ok(res.products.length <= 5000, "does not exceed the cap");
  assert.equal(res.partial, true);
});

test("products page 2 failure → status error, products [], raw error not exposed", async () => {
  const { client } = fakePagedClient({ products: { rows: makeProducts(1500), failAtCall: 2 }, product_variants: { rows: [] } });
  const res = await loadMasterCatalog(client, { project: PROJECTOR });
  assert.equal(res.status, "error");
  assert.equal(res.products.length, 0, "no partial first-page success");
  const json = JSON.stringify(res);
  for (const leak of ["PAGE SECRET", "42P01", "SHINT"]) assert.ok(!json.includes(leak), `leaked: ${leak}`);
});

test("variants: >1000 counted across pages, duplicate parent ids across the boundary counted correctly", async () => {
  // 600 × p1 then 600 × p2 → page1 = 600 p1 + 400 p2, page2 = 200 p2.
  const variantParents = [...Array(600).fill("p1"), ...Array(600).fill("p2")];
  const { client, calls } = fakePagedClient({
    products: { rows: [{ id: "p1", sku: "S1" }, { id: "p2", sku: "S2" }, { id: "p3", sku: "S3" }] },
    product_variants: { rows: makeVariants(variantParents) },
  });
  const res = await loadMasterCatalog(client, { project: PROJECTOR });
  assert.equal(res.status, "ok");
  assert.equal(res.partial, false);
  const byId = new Map(res.products.map((p) => [p.id, p.variantCount]));
  assert.equal(byId.get("p1"), 600, "p1 counted across pages");
  assert.equal(byId.get("p2"), 600, "p2 (crossing the page boundary) counted correctly");
  assert.equal(byId.get("p3"), 0);
  assert.deepEqual(rangesFor(calls, "product_variants"), [
    [0, 999],
    [1000, 1999],
  ]);
});

test("variants over VARIANT_CAP → partial true, products still render", async () => {
  const { client } = fakePagedClient({
    products: { rows: [{ id: "p1", sku: "S1" }] },
    product_variants: { rows: makeVariants(Array(20001).fill("p1")) },
  });
  const res = await loadMasterCatalog(client, { project: PROJECTOR });
  assert.equal(res.status, "ok");
  assert.equal(res.partial, true);
  assert.equal(res.products.length, 1);
});

test("variants page 2 failure → all variant rows discarded, products render with variantCount 0, partial true", async () => {
  const { client } = fakePagedClient({
    products: { rows: [{ id: "p1", sku: "S1" }, { id: "p2", sku: "S2" }] },
    product_variants: { rows: makeVariants([...Array(1000).fill("p1"), ...Array(200).fill("p2")]), failAtCall: 2 },
  });
  const res = await loadMasterCatalog(client, { project: PROJECTOR });
  assert.equal(res.status, "ok", "products still render");
  assert.equal(res.partial, true);
  assert.ok(res.products.length > 0);
  for (const p of res.products) assert.equal(p.variantCount, 0, "no partial variant counts");
  const json = JSON.stringify(res);
  for (const leak of ["PAGE SECRET", "42P01", "SHINT"]) assert.ok(!json.includes(leak), `leaked: ${leak}`);
});

test("deterministic ordering: every products page uses sku asc then id asc", async () => {
  const { client, calls } = fakePagedClient({ products: { rows: makeProducts(1500) }, product_variants: { rows: [] } });
  await loadMasterCatalog(client, { project: PROJECTOR });
  const orderSets = ordersFor(calls, "products");
  assert.ok(orderSets.length >= 2);
  for (const o of orderSets) {
    assert.deepEqual(o, [
      { column: "sku", ascending: true },
      { column: "id", ascending: true },
    ]);
  }
});

test("deterministic ordering: every variants page uses parent_product_id asc then id asc", async () => {
  const { client, calls } = fakePagedClient({
    products: { rows: [{ id: "p1", sku: "S1" }] },
    product_variants: { rows: makeVariants(Array(1500).fill("p1")) },
  });
  await loadMasterCatalog(client, { project: PROJECTOR });
  const orderSets = ordersFor(calls, "product_variants");
  assert.ok(orderSets.length >= 2);
  for (const o of orderSets) {
    assert.deepEqual(o, [
      { column: "parent_product_id", ascending: true },
      { column: "id", ascending: true },
    ]);
  }
});

test("page ranges never overlap and never skip", async () => {
  const { client, calls } = fakePagedClient({ products: { rows: makeProducts(3200) }, product_variants: { rows: makeVariants(Array(2100).fill("p0")) } });
  await loadMasterCatalog(client, { project: PROJECTOR });
  for (const table of ["products", "product_variants"]) {
    const ranges = rangesFor(calls, table);
    ranges.forEach(([from, to], i) => {
      assert.equal(from, i * 1000, `${table} page ${i} starts contiguously`);
      assert.equal(to, i * 1000 + 999, `${table} page ${i} spans exactly PAGE_SIZE`);
    });
  }
});

test("paginated read: builder throw is caught → products fail closed, no raw leak", async () => {
  const { client } = fakePagedClient({ products: { rows: makeProducts(1500), throwAtCall: 2 }, product_variants: { rows: [] } });
  const res = await loadMasterCatalog(client, { project: PROJECTOR });
  assert.equal(res.status, "error");
  assert.equal(res.products.length, 0);
  assert.ok(!JSON.stringify(res).includes("BOOM"), "builder error not exposed");
});

test("paginated read does not mutate the input row arrays", async () => {
  const products = makeProducts(1200);
  const variants = makeVariants([...Array(1000).fill("p0"), ...Array(100).fill("p1")]);
  const pSnap = JSON.parse(JSON.stringify(products));
  const vSnap = JSON.parse(JSON.stringify(variants));
  const { client } = fakePagedClient({ products: { rows: products }, product_variants: { rows: variants } });
  await loadMasterCatalog(client, { project: PROJECTOR });
  assert.deepEqual(products, pSnap, "product rows not mutated");
  assert.deepEqual(variants, vSnap, "variant rows not mutated");
});

// ════════════════════════════════════════════════════════════════════════════
// Phase UI.2A — Catalog Control Center (sorting, filters, pagination)
// ════════════════════════════════════════════════════════════════════════════

// ── parseCatalogPage ─────────────────────────────────────────────────────────

test("parseCatalogPage: valid positive integers pass through", () => {
  assert.equal(parseCatalogPage("1"), 1);
  assert.equal(parseCatalogPage("23"), 23);
  assert.equal(parseCatalogPage("007"), 7);
});

test("parseCatalogPage: invalid / non-string / negative / zero / NaN / huge → 1", () => {
  for (const bad of [undefined, null, "", "0", "-3", "1.5", "abc", "2e3", " 5 ", "12x", "NaN", "99999999999999999999", [] as unknown as string, {} as unknown as string, 5 as unknown as string]) {
    assert.equal(parseCatalogPage(bad), 1, `page=${JSON.stringify(bad)}`);
  }
});

test("parseCatalogPage: array picks first usable string", () => {
  assert.equal(parseCatalogPage(["4", "9"]), 4);
});

// ── parseCatalogControls (sort) ──────────────────────────────────────────────

test("parseCatalogControls: empty → defaults (readiness, page 1, all)", () => {
  assert.deepEqual(parseCatalogControls({}), DEFAULT_CONTROLS);
  assert.deepEqual(parseCatalogControls(null), DEFAULT_CONTROLS);
});

test("parseCatalogControls: every valid sort value parses", () => {
  for (const s of ["readiness", "name_ar", "name_en", "sku", "price_asc", "price_desc", "variants_desc"]) {
    assert.equal(parseCatalogControls({ sort: s }).sort, s);
  }
});

test("parseCatalogControls: unknown / hostile sort → readiness", () => {
  assert.equal(parseCatalogControls({ sort: "__proto__" }).sort, "readiness");
  assert.equal(parseCatalogControls({ sort: "DROP" }).sort, "readiness");
  assert.equal(parseCatalogControls({ sort: ["x"] }).sort, "readiness");
});

test("parseCatalogControls: query trimmed + capped, filter validated, page validated", () => {
  const c = parseCatalogControls({ query: `  ${"a".repeat(200)}  `, filter: "approved", sort: "sku", page: "3" });
  assert.equal(c.query.length, 80);
  assert.equal(c.filter, "approved");
  assert.equal(c.sort, "sku");
  assert.equal(c.page, 3);
  assert.equal(parseCatalogControls({ filter: "nonsense" }).filter, "all");
});

// ── Price / discount / approval detection ────────────────────────────────────

test("hasValidPrice: positive finite only", () => {
  assert.equal(hasValidPrice(product({ price: 10 })), true);
  assert.equal(hasValidPrice(product({ price: 0 })), false);
  assert.equal(hasValidPrice(product({ price: -5 })), false);
  assert.equal(hasValidPrice(product({ price: null })), false);
});

test("hasValidDiscount: valid only when 0 < discount < price", () => {
  assert.equal(hasValidDiscount(product({ price: 100, discountPrice: 80 })), true);
  assert.equal(hasValidDiscount(product({ price: 100, discountPrice: 100 })), false, "equal is not a discount");
  assert.equal(hasValidDiscount(product({ price: 100, discountPrice: 120 })), false, "higher is not a discount");
  assert.equal(hasValidDiscount(product({ price: 100, discountPrice: 0 })), false);
  assert.equal(hasValidDiscount(product({ price: 100, discountPrice: null })), false);
  assert.equal(hasValidDiscount(product({ price: null, discountPrice: 50 })), false, "no base price");
});

test("isApproved: only exact 'approved' (case/space-insensitive); raw text never leaks", () => {
  assert.equal(isApproved(product({ approval: "Approved" })), true);
  assert.equal(isApproved(product({ approval: "  approved " })), true);
  assert.equal(isApproved(product({ approval: "Rejected" })), false);
  assert.equal(isApproved(product({ approval: "staff_pending" })), false);
  assert.equal(isApproved(product({ approval: null })), false);
});

test("getApprovalLabel: only the two fixed labels, never raw approval", () => {
  assert.equal(getApprovalLabel(product({ approval: "Approved" })), "معتمد");
  for (const raw of ["Rejected", "staff_pending", "WEIRD_RAW_STATUS", "<script>", null]) {
    const label = getApprovalLabel(product({ approval: raw as string | null }));
    assert.ok(label === "معتمد" || label === "غير معتمد", `label must be fixed, got ${label}`);
    if (typeof raw === "string") assert.ok(!label.includes(raw), `raw approval ${raw} leaked into label`);
  }
});

// ── Readiness priority ───────────────────────────────────────────────────────

test("readinessPriority: ordering missing_multiple < sku < barcode < image < price < not_approved < complete", () => {
  const missingMultiple = product({ sku: null, barcode: null });
  const missingSku = product({ sku: null });
  const missingBarcode = product({ barcode: null });
  const missingImage = product({ imageUrl: null });
  const missingPrice = product({ price: null });
  const notApproved = product({ approval: "Rejected" });
  const complete = product({ approval: "Approved" });
  assert.equal(readinessPriority(missingMultiple), 0);
  assert.equal(readinessPriority(missingSku), 1);
  assert.equal(readinessPriority(missingBarcode), 2);
  assert.equal(readinessPriority(missingImage), 3);
  assert.equal(readinessPriority(missingPrice), 4);
  assert.equal(readinessPriority(notApproved), 5);
  assert.equal(readinessPriority(complete), 6);
});

// ── Sorting ──────────────────────────────────────────────────────────────────

test("default readiness sort: most-incomplete first, complete last, id tie-break", () => {
  const rows = [
    product({ id: "c", approval: "Approved" }), // complete → 6
    product({ id: "a", sku: null, barcode: null }), // missing_multiple → 0
    product({ id: "b", sku: null }), // missing_sku → 1
    product({ id: "a2", sku: null, barcode: null }), // missing_multiple → 0 (tie with a)
  ];
  const out = sortCatalogProducts(rows, "readiness");
  assert.deepEqual(out.map((p) => p.id), ["a", "a2", "b", "c"]);
});

test("sort name_ar / name_en / sku are deterministic with id tie-break", () => {
  const rows = [
    product({ id: "2", nameAr: "باء", sku: "S2" }),
    product({ id: "1", nameAr: "ألف", sku: "S1" }),
    product({ id: "3", nameAr: "ألف", sku: "S1" }), // tie on name/sku → id
  ];
  assert.deepEqual(sortCatalogProducts(rows, "name_ar").map((p) => p.id), ["1", "3", "2"]);
  assert.deepEqual(sortCatalogProducts(rows, "sku").map((p) => p.id), ["1", "3", "2"]);
});

test("sort price_asc / price_desc; missing prices always sort last", () => {
  const rows = [
    product({ id: "hi", price: 90 }),
    product({ id: "lo", price: 10 }),
    product({ id: "none", price: null }),
    product({ id: "zero", price: 0 }),
  ];
  const asc = sortCatalogProducts(rows, "price_asc").map((p) => p.id);
  assert.deepEqual(asc.slice(0, 2), ["lo", "hi"], "valid prices ascending");
  assert.deepEqual(asc.slice(2).sort(), ["none", "zero"], "missing/zero last");
  const desc = sortCatalogProducts(rows, "price_desc").map((p) => p.id);
  assert.deepEqual(desc.slice(0, 2), ["hi", "lo"], "valid prices descending");
  assert.deepEqual(desc.slice(2).sort(), ["none", "zero"], "missing/zero still last");
});

test("sort variants_desc: most variants first, id tie-break", () => {
  const rows = [product({ id: "a", variantCount: 1 }), product({ id: "b", variantCount: 5 }), product({ id: "c", variantCount: 5 })];
  assert.deepEqual(sortCatalogProducts(rows, "variants_desc").map((p) => p.id), ["b", "c", "a"]);
});

test("sort does not mutate the input array", () => {
  const rows = [product({ id: "2", price: 5 }), product({ id: "1", price: 9 })];
  const snap = JSON.parse(JSON.stringify(rows));
  sortCatalogProducts(rows, "price_asc");
  assert.deepEqual(rows, snap);
});

// ── Expanded filters ─────────────────────────────────────────────────────────

test("filters: complete / missing_multiple", () => {
  const rows = [product({ id: "ok" }), product({ id: "mm", sku: null, barcode: null }), product({ id: "one", sku: null })];
  assert.deepEqual(filterCatalogProducts(rows, { query: "", filter: "complete" }).map((p) => p.id), ["ok"]);
  assert.deepEqual(filterCatalogProducts(rows, { query: "", filter: "missing_multiple" }).map((p) => p.id), ["mm"]);
});

test("filters: approved / not_approved", () => {
  const rows = [product({ id: "a", approval: "Approved" }), product({ id: "r", approval: "Rejected" }), product({ id: "n", approval: null })];
  assert.deepEqual(filterCatalogProducts(rows, { query: "", filter: "approved" }).map((p) => p.id), ["a"]);
  assert.deepEqual(filterCatalogProducts(rows, { query: "", filter: "not_approved" }).map((p) => p.id).sort(), ["n", "r"]);
});

test("filters: has_discount / missing_price", () => {
  const rows = [
    product({ id: "disc", price: 100, discountPrice: 70 }),
    product({ id: "nodisc", price: 100, discountPrice: 100 }),
    product({ id: "noprice", price: null }),
  ];
  assert.deepEqual(filterCatalogProducts(rows, { query: "", filter: "has_discount" }).map((p) => p.id), ["disc"]);
  assert.deepEqual(filterCatalogProducts(rows, { query: "", filter: "missing_price" }).map((p) => p.id), ["noprice"]);
});

// ── Summary (new KPI counts) ─────────────────────────────────────────────────

test("summary counts discount / missing price / complete / missing multiple over whole list", () => {
  const rows = [
    product({ id: "1", price: 100, discountPrice: 60 }), // discount, complete
    product({ id: "2", price: null }), // missing price, complete(sku/barcode/image)
    product({ id: "3", sku: null, barcode: null }), // missing multiple
    product({ id: "4" }), // complete
  ];
  const s = summarizeCatalog(rows);
  assert.equal(s.withDiscount, 1);
  assert.equal(s.missingPrice, 1);
  assert.equal(s.missingMultiple, 1);
  assert.equal(s.complete, 3, "sku/barcode/image present on 1,2,4");
});

// ── Pagination ───────────────────────────────────────────────────────────────

const makeList = (n: number): MasterCatalogProduct[] => Array.from({ length: n }, (_, i) => product({ id: `p${String(i).padStart(5, "0")}` }));

test("paginate: PAGE_SIZE is 50", () => {
  assert.equal(PAGE_SIZE, 50);
});

test("paginate: 0 products → one empty page, no false emptiness", () => {
  const r = paginateCatalog([], 1);
  assert.equal(r.totalItems, 0);
  assert.equal(r.totalPages, 1);
  assert.equal(r.page, 1);
  assert.equal(r.items.length, 0);
});

test("paginate: 1 product", () => {
  const r = paginateCatalog(makeList(1), 1);
  assert.equal(r.totalItems, 1);
  assert.equal(r.totalPages, 1);
  assert.equal(r.items.length, 1);
});

test("paginate: exactly 50 → one full page", () => {
  const r = paginateCatalog(makeList(50), 1);
  assert.equal(r.totalPages, 1);
  assert.equal(r.items.length, 50);
});

test("paginate: 51 → two pages (50 + 1)", () => {
  const p1 = paginateCatalog(makeList(51), 1);
  assert.equal(p1.totalPages, 2);
  assert.equal(p1.items.length, 50);
  assert.equal(p1.startIndex, 0);
  const p2 = paginateCatalog(makeList(51), 2);
  assert.equal(p2.page, 2);
  assert.equal(p2.items.length, 1);
  assert.equal(p2.startIndex, 50);
});

test("paginate: 1146 → 23 pages, last page has 46", () => {
  const list = makeList(1146);
  const p1 = paginateCatalog(list, 1);
  assert.equal(p1.totalPages, 23);
  assert.equal(p1.items.length, 50);
  const last = paginateCatalog(list, 23);
  assert.equal(last.items.length, 1146 - 22 * 50); // 46
});

test("paginate: out-of-range page is clamped to the last page (never false-empty)", () => {
  const list = makeList(1146);
  const r = paginateCatalog(list, 100);
  assert.equal(r.page, 23, "clamped to last real page");
  assert.ok(r.items.length > 0, "shows the last page, not an empty state");
});

test("paginate: pages never overlap and cover everything in order", () => {
  const list = makeList(120); // 3 pages: 50 + 50 + 20
  const seen: string[] = [];
  for (let pg = 1; pg <= 3; pg++) seen.push(...paginateCatalog(list, pg).items.map((p) => p.id));
  assert.equal(seen.length, 120);
  assert.equal(new Set(seen).size, 120, "no duplicates across pages");
  assert.deepEqual(seen, list.map((p) => p.id), "contiguous, in order");
});

// ── catalogHref (state preservation) ─────────────────────────────────────────

test("catalogHref: page 1 with defaults → clean base path", () => {
  assert.equal(catalogHref(DEFAULT_CONTROLS, 1), "/v2/catalog");
});

test("catalogHref: preserves query/filter/sort and sets page", () => {
  const controls: CatalogControls = { query: "cream", filter: "approved", sort: "price_asc", page: 1 };
  const href = catalogHref(controls, 3);
  const url = new URL(href, "https://x.test");
  assert.equal(url.pathname, "/v2/catalog");
  assert.equal(url.searchParams.get("query"), "cream");
  assert.equal(url.searchParams.get("filter"), "approved");
  assert.equal(url.searchParams.get("sort"), "price_asc");
  assert.equal(url.searchParams.get("page"), "3");
});

test("catalogHref: omits default filter/sort and page 1", () => {
  const href = catalogHref({ query: "x", filter: "all", sort: "readiness", page: 5 }, 1);
  const url = new URL(href, "https://x.test");
  assert.equal(url.searchParams.get("query"), "x");
  assert.equal(url.searchParams.get("filter"), null);
  assert.equal(url.searchParams.get("sort"), null);
  assert.equal(url.searchParams.get("page"), null);
});

test("catalogHref: query value is URL-encoded, never reflected raw", () => {
  const href = catalogHref({ query: "a&b <x>", filter: "all", sort: "readiness", page: 1 }, 2);
  assert.ok(!href.includes("<x>"), "raw angle brackets not reflected");
  assert.ok(!href.includes("a&b <"), "raw ampersand/space not reflected");
  const url = new URL(href, "https://x.test");
  assert.equal(url.searchParams.get("query"), "a&b <x>");
});

// ── Option lists ─────────────────────────────────────────────────────────────

test("filter + sort option lists have safe fixed values", () => {
  assert.equal(CATALOG_FILTER_OPTIONS[0]!.value, "all");
  const filterValues = CATALOG_FILTER_OPTIONS.map((o) => o.value);
  for (const v of ["complete", "missing_multiple", "approved", "not_approved", "has_discount", "missing_price"]) {
    assert.ok(filterValues.includes(v as (typeof filterValues)[number]), `filter option ${v} present`);
  }
  assert.equal(CATALOG_SORT_OPTIONS[0]!.value, "readiness");
  assert.equal(CATALOG_SORT_OPTIONS.length, 7);
});

// ── Page/component source scans (Phase UI.2A) ────────────────────────────────

test("catalog page wires controls → sort → paginate and stays read-only", () => {
  const raw = readFileSync(new URL("../../app/(v2)/v2/catalog/page.tsx", import.meta.url), "utf8");
  const src = strip(raw);
  assert.ok(/parseCatalogControls\s*\(/.test(src), "parses controls");
  assert.ok(/sortCatalogProducts\s*\(/.test(src), "sorts");
  assert.ok(/paginateCatalog\s*\(/.test(src), "paginates");
  assert.ok(/export const dynamic = "force-dynamic"/.test(src), "force-dynamic");
  assert.ok(/تعذر تحميل كتالوج ماليكاس\./.test(src), "constant load error");
  for (const [re, msg] of [
    [/\bfetch\s*\(/, "fetch("],
    [/\.rpc\s*\(/, ".rpc("],
    [/\.insert\s*\(/, ".insert("],
    [/\.update\s*\(/, ".update("],
    [/\.upsert\s*\(/, ".upsert("],
    [/\.delete\s*\(/, ".delete("],
    [/createAdminClient/, "createAdminClient"],
    [/service_role/, "service_role"],
    [/process\.env/, "process.env"],
    [/console\./, "console."],
    [/dangerouslySetInnerHTML/, "dangerouslySetInnerHTML"],
    [/select\(\s*["']\*["']\s*\)/, 'select("*")'],
  ] as const) {
    assert.ok(!re.test(src), `forbidden in page: ${msg}`);
  }
});

test("MasterCatalog component: read-only, no bulk/edit controls, no raw approval, lazy images", () => {
  // Since UI.3C.1 the results list lives in the client component; both halves
  // must stay read-only.
  const serverSrc = strip(readFileSync(new URL("../../components/v2/catalog/MasterCatalog.tsx", import.meta.url), "utf8"));
  const resultsSrc = strip(
    readFileSync(new URL("../../components/v2/catalog/MasterCatalogPreview.tsx", import.meta.url), "utf8"),
  );

  for (const [name, src] of [["server", serverSrc], ["results", resultsSrc]] as const) {
    for (const [re, msg] of [
      [/dangerouslySetInnerHTML/, "dangerouslySetInnerHTML"],
      [/process\.env/, "process.env"],
      [/\bfetch\s*\(/, "fetch("],
      [/\.rpc\s*\(/, ".rpc("],
      [/console\./, "console."],
      [/type="checkbox"/, "checkbox (bulk select)"],
      [/<button[^>]*type="submit"[^>]*>[\s\S]*?(حذف|تعديل|أرشفة|delete|edit)/i, "mutation button"],
    ] as const) {
      assert.ok(!re.test(src), `forbidden in ${name}: ${msg}`);
    }
    // Raw approval text is never rendered on either side.
    assert.ok(
      !/\.approval\b(?!\s*[),])/.test(src.replace(/getApprovalLabel|getPreviewApprovalLabel/g, "")),
      `raw .approval not rendered directly in ${name}`,
    );
  }

  // The Server Component stays free of client handlers…
  assert.ok(!/onClick/.test(serverSrc), "server half has no onClick handler");
  // …while the results list intentionally opens the preview on click.
  assert.ok(/onClick=/.test(resultsSrc), "results open the preview on click");
  assert.ok(/loading="lazy"/.test(resultsSrc), "images lazy-loaded");
  assert.ok(/getPreviewApprovalLabel/.test(resultsSrc), "approval shown via fixed-label helper");
});

// ════════════════════════════════════════════════════════════════════════════
// Phase UI.2B — Read-only Product Detail
// ════════════════════════════════════════════════════════════════════════════

// ── parseProductId ───────────────────────────────────────────────────────────

test("parseProductId: accepts a non-empty string within max length", () => {
  assert.equal(parseProductId("p1"), "p1");
  assert.equal(parseProductId("gid://shopify/Product/123"), "gid://shopify/Product/123");
});

test("parseProductId: rejects non-string / empty / whitespace / too long → null", () => {
  for (const bad of [undefined, null, "", "   ", 5 as unknown as string, {} as unknown as string, ["p"] as unknown as string, "a".repeat(201)]) {
    assert.equal(parseProductId(bad), null, `id=${JSON.stringify(bad)}`);
  }
});

// ── projectCatalogVariants ───────────────────────────────────────────────────

test("projectCatalogVariants: keeps only whitelisted catalog-safe fields", () => {
  const out = projectCatalogVariants([
    { id: "v1", parent_product_id: "p1", variant_name: "أحمر", variant_name_en: "Red", sku: "MK-1-R", barcode: "B-R", price: 12 },
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(Object.keys(out[0]!).sort(), ["barcode", "id", "price", "sku", "variantName", "variantNameEn"].sort());
  assert.equal(out[0]!.variantName, "أحمر");
  assert.equal(out[0]!.variantNameEn, "Red");
  assert.equal(out[0]!.price, 12);
});

test("projectCatalogVariants: never copies stock/inventory/platform/order/customer/raw fields", () => {
  const out = projectCatalogVariants([
    {
      id: "v1",
      parent_product_id: "p1",
      variant_name: "X",
      sku: "S",
      barcode: "B",
      price: 5,
      stock_quantity: 99,
      inventory: { qty: 3 },
      channel_status: "active",
      platform_status: "approved",
      shopify_id: "gid://s/1",
      order_id: "O1",
      customer: { phone: "+974" },
      raw: { secret: "SECRETV" },
    },
  ]);
  const json = JSON.stringify(out);
  for (const bad of ["stock", "inventory", "channel", "platform", "shopify", "order_id", "customer", "+974", "SECRETV", "parent_product_id"]) {
    assert.ok(!json.includes(bad), `leaked: ${bad}`);
  }
});

test("projectCatalogVariants: skips non-object rows, never coerces, never mutates input", () => {
  const rows: unknown[] = [null, 5, "x", { id: 123, variant_name: 456, sku: {}, price: "10" }];
  const snap = JSON.parse(JSON.stringify(rows));
  const out = projectCatalogVariants(rows);
  assert.equal(out.length, 1, "only the one object row is kept");
  assert.equal(out[0]!.id, null, "numeric id → null (not coerced)");
  assert.equal(out[0]!.variantName, null, "numeric name → null");
  assert.equal(out[0]!.sku, null, "object sku → null");
  assert.equal(out[0]!.price, null, "string price → null");
  assert.deepEqual(rows, snap, "input not mutated");
});

test("getVariantDisplayName: Arabic first, then English, else dash", () => {
  assert.equal(getVariantDisplayName({ id: "1", variantName: "كبير", variantNameEn: "Large", sku: null, barcode: null, price: null }), "كبير");
  assert.equal(getVariantDisplayName({ id: "1", variantName: null, variantNameEn: "Large", sku: null, barcode: null, price: null }), "Large");
  assert.equal(getVariantDisplayName({ id: "1", variantName: null, variantNameEn: null, sku: null, barcode: null, price: null }), "—");
});

// ── loadCatalogProduct (fake .eq client) ─────────────────────────────────────

interface EqTableCfg {
  rows?: unknown[];
  fail?: boolean;
  throwOnCall?: boolean;
}
interface EqCall {
  table: string;
  columns: string;
  eq: [string, string];
  limit: number;
}

function fakeEqClient(cfg: Record<string, EqTableCfg>): { client: CatalogDetailReadClient; calls: EqCall[] } {
  const calls: EqCall[] = [];
  const client: CatalogDetailReadClient = {
    from(table: string) {
      let columns = "";
      let eqPair: [string, string] = ["", ""];
      let pending: CatalogQueryResult = { data: [], error: null };
      const resolve = () => {
        const t = cfg[table] ?? {};
        if (t.fail) pending = { data: null, error: { message: "DETAIL SECRET", code: "42P01", hint: "SHINT" } };
        else pending = { data: t.rows ?? [], error: null };
      };
      const builder: CatalogDetailFilterBuilder = {
        filter(column: string, operator: string, value: string) {
          if (operator === "eq") eqPair = [column, value];
          return builder;
        },
        limit(count: number) {
          const t = cfg[table] ?? {};
          if (t.throwOnCall) throw new Error("BUILDER BOOM SECRET");
          calls.push({ table, columns, eq: eqPair, limit: count });
          resolve();
          return builder;
        },
        then<TResult1 = CatalogQueryResult, TResult2 = never>(
          onfulfilled?: ((value: CatalogQueryResult) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ): PromiseLike<TResult1 | TResult2> {
          return Promise.resolve(pending).then(onfulfilled, onrejected);
        },
      };
      return {
        select: (cols: string) => {
          columns = cols;
          return builder;
        },
      };
    },
  };
  return { client, calls };
}

const productRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "p1",
  sku: "MK-1",
  barcode: "B-1",
  name_ar: "منتج",
  name_en: "Product",
  price: 100,
  discount_price: 70,
  image_url: "https://img/x.jpg",
  approval: "Approved",
  ...over,
});

test("loadCatalogProduct: product success + variants → product with correct variantCount and variants", async () => {
  const { client, calls } = fakeEqClient({
    products: { rows: [productRow({ id: "p1" })] },
    product_variants: {
      rows: [
        { id: "v1", parent_product_id: "p1", variant_name: "أحمر", variant_name_en: "Red", sku: "S1", barcode: "B1", price: 90 },
        { id: "v2", parent_product_id: "p1", variant_name: "أزرق", variant_name_en: "Blue", sku: "S2", barcode: "B2", price: 95 },
      ],
    },
  });
  const res = await loadCatalogProduct(client, "p1", { project: DETAIL_PROJECTOR });
  assert.equal(res.status, "ok");
  assert.ok(res.product);
  assert.equal(res.product!.id, "p1");
  assert.equal(res.product!.variantCount, 2, "count derived from variant rows");
  assert.equal(res.variants.length, 2);
  assert.equal(res.variants[0]!.variantName, "أحمر");
  // correct eq + explicit columns + no forbidden columns
  const prodCall = calls.find((c) => c.table === "products")!;
  const varCall = calls.find((c) => c.table === "product_variants")!;
  assert.deepEqual(prodCall.eq, ["id", "p1"]);
  assert.deepEqual(varCall.eq, ["parent_product_id", "p1"]);
  assert.ok(!prodCall.columns.includes("*") && !varCall.columns.includes("*"), "no select(*)");
  assert.ok(!varCall.columns.includes("stock_quantity"), "variant columns exclude stock_quantity");
});

test("loadCatalogProduct: product missing → status ok, product null (safe not-found)", async () => {
  const { client } = fakeEqClient({ products: { rows: [] } });
  const res = await loadCatalogProduct(client, "nope", { project: DETAIL_PROJECTOR });
  assert.equal(res.status, "ok");
  assert.equal(res.product, null);
  assert.deepEqual(res.variants, []);
});

test("loadCatalogProduct: invalid id → safe not-found without querying", async () => {
  const { client, calls } = fakeEqClient({ products: { rows: [productRow()] } });
  for (const bad of ["", "   ", "a".repeat(201), 5 as unknown as string, null as unknown as string]) {
    const res = await loadCatalogProduct(client, bad, { project: DETAIL_PROJECTOR });
    assert.equal(res.status, "ok");
    assert.equal(res.product, null);
  }
  assert.equal(calls.length, 0, "no query issued for invalid ids");
});

test("loadCatalogProduct: product read failure → status error, no leak", async () => {
  const { client } = fakeEqClient({ products: { fail: true } });
  const res = await loadCatalogProduct(client, "p1", { project: DETAIL_PROJECTOR });
  assert.equal(res.status, "error");
  assert.equal(res.product, null);
  const json = JSON.stringify(res);
  for (const leak of ["DETAIL SECRET", "42P01", "SHINT"]) assert.ok(!json.includes(leak), `leaked: ${leak}`);
});

test("loadCatalogProduct: product builder throw → status error, no leak", async () => {
  const { client } = fakeEqClient({ products: { throwOnCall: true } });
  const res = await loadCatalogProduct(client, "p1", { project: DETAIL_PROJECTOR });
  assert.equal(res.status, "error");
  assert.ok(!JSON.stringify(res).includes("BOOM"), "builder error not exposed");
});

test("loadCatalogProduct: variant read failure is non-fatal → product shows, variants empty, no leak", async () => {
  const { client } = fakeEqClient({
    products: { rows: [productRow({ id: "p1" })] },
    product_variants: { fail: true },
  });
  const res = await loadCatalogProduct(client, "p1", { project: DETAIL_PROJECTOR });
  assert.equal(res.status, "ok", "product still renders");
  assert.ok(res.product);
  assert.deepEqual(res.variants, [], "no partial variant data");
  const json = JSON.stringify(res);
  for (const leak of ["DETAIL SECRET", "42P01", "SHINT"]) assert.ok(!json.includes(leak), `leaked: ${leak}`);
});

test("loadCatalogProduct: only products / product_variants tables are queried", async () => {
  const { client, calls } = fakeEqClient({
    products: { rows: [productRow()] },
    product_variants: { rows: [] },
  });
  await loadCatalogProduct(client, "p1", { project: DETAIL_PROJECTOR });
  for (const c of calls) {
    assert.ok(c.table === "products" || c.table === "product_variants", `unexpected table ${c.table}`);
  }
});

// ── Detail read-layer source scan ────────────────────────────────────────────

test("read source (detail additions): SELECT/eq-only, no writes/RPC/fetch/admin/env/logging/select(*)", () => {
  const src = strip(readFileSync(new URL("./master-catalog-read.ts", import.meta.url), "utf8"));
  for (const [re, msg] of [
    [/\bfetch\s*\(/, "fetch("],
    [/\.rpc\s*\(/, ".rpc("],
    [/\.insert\s*\(/, ".insert("],
    [/\.update\s*\(/, ".update("],
    [/\.upsert\s*\(/, ".upsert("],
    [/\.delete\s*\(/, ".delete("],
    [/createAdminClient/, "createAdminClient"],
    [/service_role/, "service_role"],
    [/process\.env/, "process.env"],
    [/console\./, "console."],
    [/select\(\s*["']\*["']\s*\)/, 'select("*")'],
    [/stock_quantity/, "stock_quantity"],
    [/:\s*any\b/, ": any"],
  ] as const) {
    assert.ok(!re.test(src), `forbidden in read source: ${msg}`);
  }
  assert.ok(/\.filter\(/.test(src), "uses a parameterized .filter equality");
  assert.ok(/["']id["']\s*,\s*id/.test(src), "product read filters by id (\"id\", id)");
  assert.ok(/["']parent_product_id["']\s*,\s*id/.test(src), "variant read filters by parent_product_id (\"parent_product_id\", id)");
});

// ── Detail page + component source scans ─────────────────────────────────────

test("detail page: force-dynamic, wired to loadCatalogProduct, safe states, no id reflection, read-only", () => {
  const raw = readFileSync(new URL("../../app/(v2)/v2/catalog/[id]/page.tsx", import.meta.url), "utf8");
  const src = strip(raw);
  assert.ok(/export const dynamic = "force-dynamic"/.test(src), "force-dynamic");
  assert.ok(/parseProductId\s*\(/.test(src), "validates id");
  assert.ok(/loadCatalogProduct\s*\(/.test(src), "calls loadCatalogProduct");
  assert.ok(/تعذر تحميل كتالوج ماليكاس\./.test(src), "constant load error");
  assert.ok(/لا يوجد منتج بهذا المعرّف\./.test(src), "constant not-found");
  for (const [re, msg] of [
    [/\bfetch\s*\(/, "fetch("],
    [/\.rpc\s*\(/, ".rpc("],
    [/\.insert\s*\(/, ".insert("],
    [/\.update\s*\(/, ".update("],
    [/\.upsert\s*\(/, ".upsert("],
    [/\.delete\s*\(/, ".delete("],
    [/createAdminClient/, "createAdminClient"],
    [/service_role/, "service_role"],
    [/process\.env/, "process.env"],
    [/console\./, "console."],
    [/dangerouslySetInnerHTML/, "dangerouslySetInnerHTML"],
    [/select\(\s*["']\*["']\s*\)/, 'select("*")'],
  ] as const) {
    assert.ok(!re.test(src), `forbidden in detail page: ${msg}`);
  }
});

test("ProductDetail component: read-only, lazy image, fixed approval, no stock/platform/order/PII", () => {
  const raw = readFileSync(new URL("../../components/v2/catalog/ProductDetail.tsx", import.meta.url), "utf8");
  const src = strip(raw);
  assert.ok(/loading="lazy"/.test(src), "product image lazy-loaded");
  assert.ok(/getApprovalLabel/.test(src), "approval via fixed-label helper");
  for (const [re, msg] of [
    [/dangerouslySetInnerHTML/, "dangerouslySetInnerHTML"],
    [/process\.env/, "process.env"],
    [/\bfetch\s*\(/, "fetch("],
    [/\.rpc\s*\(/, ".rpc("],
    [/console\./, "console."],
    [/type="checkbox"/, "checkbox (bulk select)"],
    [/onClick/, "onClick handler"],
    [/stock_quantity|\bstock\b|\binventory\b|channel_status|platform_status|\border_id\b|\bcustomer\b/, "stock/platform/order/customer field"],
  ] as const) {
    assert.ok(!re.test(src), `forbidden in ProductDetail: ${msg}`);
  }
});

test("MasterCatalog reaches the detail route through the preview (desktop + mobile)", () => {
  const serverSrc = readFileSync(new URL("../../components/v2/catalog/MasterCatalog.tsx", import.meta.url), "utf8");
  const resultsSrc = readFileSync(
    new URL("../../components/v2/catalog/MasterCatalogPreview.tsx", import.meta.url),
    "utf8",
  );
  // Since UI.3C.1 the href is built ONCE in the projection (which carries the
  // active controls) and the preview renders it, instead of each row linking.
  assert.ok(
    /toMasterCatalogPreviewItems\(items, controls\)/.test(serverSrc),
    "controls are threaded into the projection",
  );
  assert.ok(/href=\{item\.detailHref\}/.test(resultsSrc), "the preview links to the detail route");
  assert.ok(resultsSrc.includes("فتح صفحة المنتج"), "explicit secondary action");
});

// ════════════════════════════════════════════════════════════════════════════
// Phase UI.2C — Catalog ↔ Detail navigation state preservation
// ════════════════════════════════════════════════════════════════════════════

function controls(over: Partial<CatalogControls> = {}): CatalogControls {
  return { ...DEFAULT_CONTROLS, ...over };
}

function queryPart(href: string): string {
  const i = href.indexOf("?");
  return i === -1 ? "" : href.slice(i + 1);
}

function hrefParams(href: string): Record<string, string> {
  const usp = new URLSearchParams(queryPart(href));
  const obj: Record<string, string> = {};
  for (const [k, v] of usp) obj[k] = v;
  return obj;
}

// ── catalogDetailHref ────────────────────────────────────────────────────────

test("catalogDetailHref: default controls → clean URL, no query string", () => {
  assert.equal(catalogDetailHref("p1", DEFAULT_CONTROLS), "/v2/catalog/p1");
});

test("catalogDetailHref: encodes normal and special-character ids as a path segment", () => {
  assert.equal(catalogDetailHref("gid://shopify/Product/12 34", DEFAULT_CONTROLS), `/v2/catalog/${encodeURIComponent("gid://shopify/Product/12 34")}`);
  assert.ok(!catalogDetailHref("a/b?c#d", DEFAULT_CONTROLS).includes("a/b?c#d"), "raw special chars not present");
  assert.ok(catalogDetailHref("a/b?c#d", DEFAULT_CONTROLS).startsWith("/v2/catalog/"), "stays under /v2/catalog");
});

test("catalogDetailHref: includes a non-empty query", () => {
  assert.deepEqual(hrefParams(catalogDetailHref("p1", controls({ query: "serum" }))), { query: "serum" });
});

test("catalogDetailHref: includes a non-default filter", () => {
  assert.deepEqual(hrefParams(catalogDetailHref("p1", controls({ filter: "approved" }))), { filter: "approved" });
});

test("catalogDetailHref: includes a non-default sort", () => {
  assert.deepEqual(hrefParams(catalogDetailHref("p1", controls({ sort: "price_asc" }))), { sort: "price_asc" });
});

test("catalogDetailHref: includes a page greater than 1 (and omits page 1)", () => {
  assert.deepEqual(hrefParams(catalogDetailHref("p1", controls({ page: 3 }))), { page: "3" });
  assert.equal(catalogDetailHref("p1", controls({ page: 1 })), "/v2/catalog/p1");
});

test("catalogDetailHref: includes all active controls in canonical order query→filter→sort→page", () => {
  const href = catalogDetailHref("p1", controls({ query: "serum", filter: "approved", sort: "price_asc", page: 3 }));
  assert.equal(queryPart(href), "query=serum&filter=approved&sort=price_asc&page=3");
});

test("catalogDetailHref: omits default/empty controls and never emits arbitrary params", () => {
  const href = catalogDetailHref("p1", controls({ query: "", filter: "all", sort: "readiness", page: 1 }));
  assert.equal(href, "/v2/catalog/p1");
  const keys = Object.keys(hrefParams(catalogDetailHref("p1", controls({ query: "x", filter: "approved", sort: "sku", page: 2 }))));
  for (const k of keys) assert.ok(["query", "filter", "sort", "page"].includes(k), `unexpected param ${k}`);
});

test("catalogDetailHref: does not mutate the input controls", () => {
  const c = controls({ query: "serum", filter: "approved", sort: "price_asc", page: 3 });
  const snap = JSON.parse(JSON.stringify(c));
  catalogDetailHref("p1", c);
  assert.deepEqual(c, snap);
});

// ── Round-trip: catalogDetailHref → parseCatalogControls ─────────────────────

test("round-trip: detail URL params re-parse to the original validated controls", () => {
  const cases: CatalogControls[] = [
    DEFAULT_CONTROLS,
    controls({ query: "serum" }),
    controls({ filter: "missing_price" }),
    controls({ sort: "variants_desc" }),
    controls({ page: 7 }),
    controls({ query: "night cream", filter: "has_discount", sort: "price_desc", page: 12 }),
    controls({ query: "كريم مرطب" }),
    controls({ query: "a&b=c d/e?f#g" }),
  ];
  for (const c of cases) {
    const parsed = parseCatalogControls(hrefParams(catalogDetailHref("p1", c)));
    assert.deepEqual(parsed, c, `round-trip failed for ${JSON.stringify(c)}`);
  }
});

// ── Detail page wiring / source assertions ───────────────────────────────────

test("detail page: accepts searchParams, parses via parseCatalogControls, builds return link via catalogHref", () => {
  const raw = readFileSync(new URL("../../app/(v2)/v2/catalog/[id]/page.tsx", import.meta.url), "utf8");
  const src = strip(raw);
  assert.ok(/searchParams/.test(src), "accepts searchParams");
  assert.ok(/parseCatalogControls\s*\(/.test(src), "uses parseCatalogControls");
  assert.ok(/backHref\s*=\s*catalogHref\s*\(/.test(src), "return link built via catalogHref");
  // raw searchParams are never copied into an href
  assert.ok(!/href=\{[^}]*searchParams/.test(src), "raw searchParams not used in an href");
  assert.ok(!/href=\{[^}]*\bsp\b/.test(src), "raw sp not used in an href");
  // the same safe backHref is used across states
  const backLinkUses = (src.match(/href=\{backHref\}/g) ?? []).length;
  assert.ok(backLinkUses >= 2, "error and not-found states use backHref");
  assert.ok(/backHref=\{backHref\}/.test(src), "success state passes backHref to ProductDetail");
  // no hardcoded raw catalog href left behind
  assert.ok(!/href="\/v2\/catalog"/.test(src), "no hardcoded /v2/catalog href remains");
});

// ── MasterCatalog wiring / source assertions ─────────────────────────────────

test("MasterCatalog detail URLs come from catalogDetailHref; no manual query building", () => {
  const serverSrc = readFileSync(new URL("../../components/v2/catalog/MasterCatalog.tsx", import.meta.url), "utf8");
  const resultsSrc = readFileSync(
    new URL("../../components/v2/catalog/MasterCatalogPreview.tsx", import.meta.url),
    "utf8",
  );
  const viewSrc = readFileSync(new URL("./master-catalog-view.ts", import.meta.url), "utf8");
  // The single construction point is the projection.
  assert.ok(
    /detailHref: catalogDetailHref\(product\.id, controls\)/.test(viewSrc),
    "projection builds the href via catalogDetailHref",
  );
  for (const [name, src] of [["server", serverSrc], ["results", resultsSrc]] as const) {
    assert.ok(
      !/\/v2\/catalog\/\$\{encodeURIComponent\(/.test(src),
      `no manual detail URL construction in ${name}`,
    );
  }
});

// ── ProductDetail backHref ───────────────────────────────────────────────────

test("ProductDetail: accepts backHref (default /v2/catalog), renders the fixed label, no raw URL state", () => {
  const src = readFileSync(new URL("../../components/v2/catalog/ProductDetail.tsx", import.meta.url), "utf8");
  assert.ok(/backHref\s*=\s*"\/v2\/catalog"/.test(src), "default backHref is /v2/catalog");
  assert.ok(/href=\{backHref\}/.test(src), "back link uses backHref");
  assert.ok(/رجوع للكتالوج/.test(src), "fixed Arabic label rendered");
  assert.ok(!/searchParams/.test(src), "ProductDetail does not touch raw searchParams");
});

// ── UI.2C safety scan across changed files (incl. history/storage bans) ──────

test("UI.2C changed files: no writes/RPC/fetch/admin/env/logging/storage/history/dangerous html", () => {
  const files = [
    "./master-catalog-view.ts",
    "../../components/v2/catalog/MasterCatalog.tsx",
    "../../components/v2/catalog/ProductDetail.tsx",
    "../../app/(v2)/v2/catalog/[id]/page.tsx",
  ];
  for (const rel of files) {
    const src = strip(readFileSync(new URL(rel, import.meta.url), "utf8"));
    for (const [re, msg] of [
      [/\bfetch\s*\(/, "fetch("],
      [/\.rpc\s*\(/, ".rpc("],
      [/\.insert\s*\(/, ".insert("],
      [/\.update\s*\(/, ".update("],
      [/\.upsert\s*\(/, ".upsert("],
      [/\.delete\s*\(/, ".delete("],
      [/createAdminClient/, "createAdminClient"],
      [/service_role/, "service_role"],
      [/process\.env/, "process.env"],
      [/console\./, "console."],
      [/dangerouslySetInnerHTML/, "dangerouslySetInnerHTML"],
      [/select\(\s*["']\*["']\s*\)/, 'select("*")'],
      [/localStorage/, "localStorage"],
      [/sessionStorage/, "sessionStorage"],
      [/history\.(pushState|replaceState)/, "history state manipulation"],
    ] as const) {
      assert.ok(!re.test(src), `forbidden in ${rel}: ${msg}`);
    }
  }
});

test("UI.2C: images stay lazy and no stock/platform/order/customer fields introduced in the detail UI", () => {
  const src = strip(readFileSync(new URL("../../components/v2/catalog/ProductDetail.tsx", import.meta.url), "utf8"));
  assert.ok(/loading="lazy"/.test(src), "product image lazy-loaded");
  assert.ok(/getApprovalLabel/.test(src), "approval via fixed-label helper");
  assert.ok(
    !/stock_quantity|\bstock\b|\binventory\b|channel_status|platform_status|\border_id\b|\bcustomer\b/.test(src),
    "no stock/platform/order/customer field",
  );
});

// ════════════════════════════════════════════════════════════════════════════
// Phase UI.4 — catalogEditHref (product editor entry, controls preserved)
// ════════════════════════════════════════════════════════════════════════════

test("catalogEditHref: default controls → clean URL, no query string", () => {
  assert.equal(catalogEditHref("p1", DEFAULT_CONTROLS), "/v2/catalog/p1/edit");
});

test("catalogEditHref: encodes special-character ids as one path segment", () => {
  assert.ok(!catalogEditHref("a/b?c#d", DEFAULT_CONTROLS).includes("a/b?c#d"), "raw special chars not present");
  assert.ok(catalogEditHref("a/b?c#d", DEFAULT_CONTROLS).startsWith("/v2/catalog/"), "stays under /v2/catalog");
  assert.ok(catalogEditHref("a/b?c#d", DEFAULT_CONTROLS).endsWith("/edit"), "edit segment survives encoding");
});

test("catalogEditHref: carries exactly the same controls query as catalogDetailHref", () => {
  const cases = [
    DEFAULT_CONTROLS,
    controls({ query: "serum" }),
    controls({ filter: "approved" }),
    controls({ sort: "price_asc" }),
    controls({ page: 3 }),
    controls({ query: "night cream", filter: "has_discount", sort: "price_desc", page: 12 }),
  ];
  for (const c of cases) {
    assert.equal(queryPart(catalogEditHref("p1", c)), queryPart(catalogDetailHref("p1", c)));
  }
});

test("catalogEditHref: canonical param order and no arbitrary params", () => {
  const href = catalogEditHref("p1", controls({ query: "serum", filter: "approved", sort: "price_asc", page: 3 }));
  assert.equal(queryPart(href), "query=serum&filter=approved&sort=price_asc&page=3");
  const keys = Object.keys(hrefParams(href));
  for (const k of keys) assert.ok(["query", "filter", "sort", "page"].includes(k), `unexpected param ${k}`);
});

test("catalogEditHref: round-trips through parseCatalogControls", () => {
  const c = controls({ query: "كريم مرطب", filter: "missing_price", sort: "variants_desc", page: 7 });
  const parsed = parseCatalogControls(hrefParams(catalogEditHref("p1", c)));
  assert.deepEqual(parsed, c);
});

test("catalogEditHref: does not mutate the input controls", () => {
  const c = controls({ query: "serum", filter: "approved", sort: "price_asc", page: 3 });
  const snap = JSON.parse(JSON.stringify(c));
  catalogEditHref("p1", c);
  assert.deepEqual(c, snap);
});
