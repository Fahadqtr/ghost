// CAT-B — /v2/catalog becomes the INTERNAL master catalog.
//
// Before this change the catalog listed exactly the products holding an ACTIVE
// `snoonu:malikas` listing, so a product created internally (Excel import, New
// Product) was invisible until it was published to Snoonu. Visibility is now
// decided from internal product truth; Snoonu membership became a BADGE.
//
// The load-bearing safety property is that this only ever ADDS rows. Verified
// against production before the rule was written: of the 1343 products visible
// under the old scope, ZERO are PENDING-* and ZERO are STOPPED — so neither
// exclusion can hide anything that is visible today. The tests below pin that.
//
// The Supabase client and the pure projector are injected — no real database, no
// network, no server-only value import resolved.
// Run: node --conditions=react-server --experimental-strip-types --test lib/catalog-v2/master-catalog-internal-scope.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  loadMasterCatalog,
  type CatalogReadClient,
  type CatalogQueryResult,
  type CatalogRangeBuilder,
} from "./master-catalog-read.ts";
import { projectCatalogRows, toMasterCatalogPreviewItem, getPreviewChannelLabel } from "./master-catalog-view.ts";
import {
  isInternalCatalogProduct,
  snoonuChannelState,
  SNOONU_CHANNEL_LABEL,
  CATALOG_STOREFRONT_KEY,
  CATALOG_MAPPING_STATUS,
} from "./master-membership.ts";

const PROJECTOR = { projectCatalogRows };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

// ── Fake paginated Supabase-like client ──────────────────────────────────────

interface Filter {
  column: string;
  value: string;
}
interface Call {
  table: string;
  columns: string;
  filters: Filter[];
}

function fakeClient(rowsByTable: Record<string, unknown[]>): { client: CatalogReadClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: CatalogReadClient = {
    from(table: string) {
      let columns = "";
      const filters: Filter[] = [];
      const builder: CatalogRangeBuilder = {
        order() {
          return builder;
        },
        filter(column: string, _op: string, value: string) {
          filters.push({ column, value });
          return builder;
        },
        range(from: number, to: number) {
          calls.push({ table, columns, filters: filters.map((f) => ({ ...f })) });
          let all = rowsByTable[table] ?? [];
          // Honour the storefront filter the way PostgREST would.
          for (const f of filters) {
            all = all.filter((r) => (r as Record<string, unknown>)[f.column] === f.value);
          }
          const data = all.slice(from, to + 1);
          return { then: (res: (v: CatalogQueryResult) => unknown) => res({ data, error: null }) } as never;
        },
        then(res: (v: CatalogQueryResult) => unknown) {
          return Promise.resolve({ data: [], error: null }).then(res) as never;
        },
      };
      return {
        select(cols: string) {
          columns = cols;
          return builder;
        },
      };
    },
  };
  return { client, calls };
}

const p = (id: string, sku: string, lifecycle: string) => ({
  id,
  sku,
  barcode: "111",
  name_ar: "منتج",
  name_en: "Product",
  price: 10,
  discount_price: null,
  image_url: "u",
  approval: "approved",
  lifecycle_state: lifecycle,
});

const listing = (product_id: string, mapping_status: string) => ({
  product_id,
  mapping_status,
  storefront_key: CATALOG_STOREFRONT_KEY,
});

/** One row of every shape that matters, in one fixture. */
function fixture() {
  return {
    products: [
      p("id-active", "mk100", "ACTIVE"), // published + active on Snoonu
      p("id-inactive", "mk200", "ACTIVE"), // has a listing, not active
      p("id-new-draft", "mk2345", "DRAFT"), // ← the newly imported kind
      p("id-new-draft-2", "mk2395", "DRAFT"),
      p("id-pending", "PENDING-SNOONU-6a74bbd92503fb82f31f2866", "DRAFT"), // system intake
      p("id-stopped", "mk300", "STOPPED"), // deliberately stopped
      p("id-blank", "", "ACTIVE"), // malformed
    ],
    product_variants: [{ parent_product_id: "id-new-draft" }],
    external_channel_listings: [
      listing("id-active", CATALOG_MAPPING_STATUS),
      listing("id-inactive", "archived"),
      { ...listing("id-other", CATALOG_MAPPING_STATUS), storefront_key: "shopify:malikas" },
    ],
  };
}

async function load() {
  const { client, calls } = fakeClient(fixture());
  const result = await loadMasterCatalog(client, { project: PROJECTOR });
  return { result, calls };
}

// ── Visibility ───────────────────────────────────────────────────────────────

test("an ACTIVE Snoonu product still appears — the change only ever adds rows", async () => {
  const { result } = await load();
  assert.equal(result.status, "ok");
  const skus = result.products.map((x) => x.sku);
  assert.ok(skus.includes("mk100"), "the published product must still be listed");
});

test("an internally created, never-published product now appears", async () => {
  const { result } = await load();
  const skus = result.products.map((x) => x.sku);
  assert.ok(skus.includes("mk2345"), "mk2345 (DRAFT, no listing) must be visible");
  assert.ok(skus.includes("mk2395"), "mk2395 (DRAFT, no listing) must be visible");
});

test("a product whose Snoonu listing is not active still appears, distinctly", async () => {
  const { result } = await load();
  const row = result.products.find((x) => x.sku === "mk200");
  assert.ok(row, "mk200 must be listed");
  assert.equal(row?.channelState, "SNOONU_INACTIVE");
});

test("system intake placeholders and stopped products stay excluded", async () => {
  const { result } = await load();
  const skus = result.products.map((x) => x.sku);
  assert.ok(!skus.some((s) => (s ?? "").toUpperCase().startsWith("PENDING-")), "PENDING-* must stay hidden");
  assert.ok(!skus.includes("mk300"), "a STOPPED product must stay hidden");
  assert.ok(!skus.includes(""), "a blank SKU must stay hidden");
});

test("exactly the intended rows survive — nothing silently admitted", async () => {
  const { result } = await load();
  assert.deepEqual(result.products.map((x) => x.sku).sort(), ["mk100", "mk200", "mk2345", "mk2395"]);
});

// ── Channel evidence, never identity ─────────────────────────────────────────

test("channel state is classified per product from listing rows alone", async () => {
  const { result } = await load();
  const by = new Map(result.products.map((x) => [x.sku, x.channelState]));
  assert.equal(by.get("mk100"), "SNOONU_ACTIVE");
  assert.equal(by.get("mk200"), "SNOONU_INACTIVE");
  assert.equal(by.get("mk2345"), "NOT_PUBLISHED_TO_SNOONU");
  assert.equal(by.get("mk2395"), "NOT_PUBLISHED_TO_SNOONU");
});

test("an unpublished product gains NO external identity of any kind", async () => {
  const { result } = await load();
  for (const row of result.products) {
    const json = JSON.stringify(row);
    assert.doesNotMatch(json, /external_product_id|externalProductId|snoonu_spi/i);
    assert.ok(!Object.hasOwn(row as object, "external_product_id"));
  }
  // The reader must never even SELECT an external id — it cannot leak or invent one.
  const src = read("lib/catalog-v2/master-catalog-read.ts");
  assert.doesNotMatch(src, /external_product_id/, "the reader must not select external_product_id");
  assert.match(src, /const LISTING_COLUMNS = "product_id, mapping_status"/);
});

test("the listing read is scoped to snoonu:malikas and reads only two columns", async () => {
  const { calls } = await load();
  const ecl = calls.filter((c) => c.table === "external_channel_listings");
  assert.ok(ecl.length > 0, "the listing table must still be read");
  for (const c of ecl) {
    assert.equal(c.columns, "product_id, mapping_status");
    assert.deepEqual(c.filters, [{ column: "storefront_key", value: CATALOG_STOREFRONT_KEY }]);
  }
});

// ── Pure rules ───────────────────────────────────────────────────────────────

test("isInternalCatalogProduct withholds malformed, placeholder and stopped rows", () => {
  assert.equal(isInternalCatalogProduct("mk2345", "DRAFT"), true);
  assert.equal(isInternalCatalogProduct("mk100", "ACTIVE"), true);
  assert.equal(isInternalCatalogProduct("mk100", null), true);
  assert.equal(isInternalCatalogProduct("mk300", "STOPPED"), false);
  assert.equal(isInternalCatalogProduct("mk300", "stopped"), false, "case-insensitive");
  assert.equal(isInternalCatalogProduct("PENDING-SNOONU-abc", "DRAFT"), false);
  assert.equal(isInternalCatalogProduct("pending-snoonu-abc", "DRAFT"), false, "case-insensitive");
  assert.equal(isInternalCatalogProduct("", "ACTIVE"), false);
  assert.equal(isInternalCatalogProduct("   ", "ACTIVE"), false);
  assert.equal(isInternalCatalogProduct(null, "ACTIVE"), false);
  assert.equal(isInternalCatalogProduct(42, "ACTIVE"), false);
});

test("snoonuChannelState never collapses 'stopped' into 'never published'", () => {
  assert.equal(snoonuChannelState(true, true), "SNOONU_ACTIVE");
  assert.equal(snoonuChannelState(false, true), "SNOONU_INACTIVE");
  assert.equal(snoonuChannelState(false, false), "NOT_PUBLISHED_TO_SNOONU");
});

test("the badge label is a fixed Arabic string, never an id", () => {
  assert.equal(SNOONU_CHANNEL_LABEL.NOT_PUBLISHED_TO_SNOONU, "غير منشور على سنونو");
  for (const label of Object.values(SNOONU_CHANNEL_LABEL)) {
    assert.doesNotMatch(label, /[0-9a-f]{8}/i, "a label must never carry an external id");
  }
});

// ── Preview projection + counters ────────────────────────────────────────────

const CONTROLS = { query: "", filter: "all", sort: "readiness", page: 1 } as const;

test("the preview item carries the state, and defaults to never-published", async () => {
  const { result } = await load();
  const unpublished = result.products.find((x) => x.sku === "mk2345");
  assert.ok(unpublished);
  const item = toMasterCatalogPreviewItem(unpublished!, CONTROLS);
  assert.equal(item.channelState, "NOT_PUBLISHED_TO_SNOONU");
  assert.equal(getPreviewChannelLabel(item), "غير منشور على سنونو");

  // A product projected WITHOUT a state map (the detail path) must not claim
  // to be published.
  const [bare] = projectCatalogRows([{ id: "x", sku: "mk1", lifecycle_state: "ACTIVE" }], []);
  assert.equal(bare?.channelState, undefined);
  assert.equal(toMasterCatalogPreviewItem(bare!, CONTROLS).channelState, "NOT_PUBLISHED_TO_SNOONU");
});

test("counters count the internal catalog, and variant counts are unaffected", async () => {
  const { result } = await load();
  assert.equal(result.products.length, 4, "allCount feeds off this list");
  assert.equal(result.partial, false);
  assert.equal(result.products.find((x) => x.sku === "mk2345")?.variantCount, 1);
  assert.equal(result.products.find((x) => x.sku === "mk100")?.variantCount, 0);
});

test("a listing-read failure still fails closed — it never renders as a full catalog", async () => {
  const failing: CatalogReadClient = {
    from() {
      return {
        select() {
          const b = {
            order: () => b,
            filter: () => b,
            range: () => ({ then: (r: (v: CatalogQueryResult) => unknown) => r({ data: null, error: { m: 1 } }) }),
            then: (r: (v: CatalogQueryResult) => unknown) => r({ data: null, error: { m: 1 } }),
          } as never as CatalogRangeBuilder;
          return b;
        },
      };
    },
  };
  const res = await loadMasterCatalog(failing, { project: PROJECTOR });
  assert.equal(res.status, "error");
  assert.deepEqual(res.products, []);
});

// ── Blast radius: no other surface changed ───────────────────────────────────

test("only the catalog page consumes this reader — channel/export loaders are untouched", () => {
  // If another surface ever imports it, this test makes that a deliberate act.
  const page = read("app/(v2)/v2/catalog/page.tsx");
  assert.match(page, /loadMasterCatalog/);
  for (const rel of [
    "lib/export/snoonu/preview.server.ts",
    "lib/export/talabat/preview.server.ts",
    "lib/export/rafeeq/preview.server.ts",
    "lib/export/shopify/preview.server.ts",
    "lib/home/master-scope.server.ts",
  ]) {
    assert.doesNotMatch(read(rel), /loadMasterCatalog|isInternalCatalogProduct/,
      `${rel} must not consume the catalog reader or its visibility rule`);
  }
});

test("the ECL writers and Snoonu sync were not touched by this change", () => {
  const repair = read("lib/missing-products/ecl-repair-write.server.ts");
  assert.match(repair, /INSERT-ONLY/);
  assert.doesNotMatch(repair, /isInternalCatalogProduct|snoonuChannelState/);
  const sync = read("lib/snoonu/sync.server.ts");
  assert.doesNotMatch(sync, /isInternalCatalogProduct|snoonuChannelState/);
});
