// Tests for the shared product-save core (Phase UI.4). PURE — no database, no
// network: the Supabase client is a scripted fake and every production dep
// (text cleaners, category list, diff planner) is injected, so node loads this
// without touching Next or Supabase.
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/product-save.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import {
  toProductRow,
  toVariantPayload,
  updateProductCore,
  syncProductVariants,
  variantSyncMessage,
  friendlyWriteError,
  VARIANT_SYNC_MESSAGES,
  type ProductInput,
  type ProductSaveDeps,
  type InventoryAdapter,
  type InventorySetAbsoluteResult,
  type VariantInput,
} from "./product-save.ts";
import { planVariantDiff } from "./variant-diff.ts";

// ── fixtures ─────────────────────────────────────────────────────────────────

const DEPS: ProductSaveDeps = {
  cleanText: (v) => (v ?? "").trim(),
  cleanDescriptionText: (v) => (v ?? "").trim(),
  categories: ["Korean Skincare", "Makeup"],
  planVariantDiff,
};

// INV.4D — a recording inventory adapter (the injected service-role port).
function makeAdapter(result?: InventorySetAbsoluteResult) {
  const calls: { inventoryId: string; quantity: number }[] = [];
  const adapter: InventoryAdapter = {
    async setAbsolute(inventoryId, quantity) {
      calls.push({ inventoryId, quantity });
      return result ?? { ok: true, before: 3, after: quantity, productId: "p1" };
    },
  };
  return { adapter, calls };
}
/** opts for updateProductCore: DEPS + a (possibly custom) inventory adapter. */
function opts(result?: InventorySetAbsoluteResult) {
  const { adapter, calls } = makeAdapter(result);
  return { deps: { ...DEPS, inventory: adapter }, invCalls: calls };
}
// A successful variant-sync RPC body (parent rollup applied).
const rpcVariant = (parentBefore: number, parentStock: number) => ({
  data: { ok: true, status: "applied", hasVariants: true, parentBefore, parentStock, variantChanges: [] },
  error: null,
});
// A successful simple-product sync (no variants remain).
const rpcSimple = { data: { ok: true, status: "applied", hasVariants: false, parentBefore: 0, parentStock: null, variantChanges: [] }, error: null };

function variant(over: Partial<VariantInput> = {}): VariantInput {
  return {
    variant_name: "وردي",
    variant_name_en: "Pink",
    sku: "V-1",
    barcode: "111",
    color: "pink",
    size: "M",
    price: "35",
    stock_quantity: "4",
    ...over,
  };
}

function input(over: Partial<ProductInput> = {}): ProductInput {
  return {
    sku: "P-1",
    barcode: "999",
    name_en: "Serum",
    name_ar: "سيروم",
    brand_id: "",
    main_category: "Korean Skincare",
    sub_category: "",
    product_type: "",
    color: "",
    size: "",
    price: "120",
    discount_price: "",
    cost: "60",
    stock_quantity: "7",
    stock_status: "In Stock",
    platform_status: "",
    approval: "",
    rejection_reason: "",
    image_filename: "",
    image_url: "",
    description_en: "",
    description_ar: "",
    keywords_en: "",
    keywords_ar: "",
    notes: "",
    variants: [],
    ...over,
  };
}

// Scripted fake client. Every call is recorded so tests can assert both the
// write ORDER and the exact RPC payload.
interface FakeCall {
  kind: string;
  table?: string;
  fn?: string;
  values?: Record<string, unknown>;
  args?: Record<string, unknown>;
  column?: string;
  value?: string;
}

function makeClient(over: Record<string, unknown> = {}) {
  const o = {
    productsBefore: { data: { name_en: "Old name", approval: null }, error: null },
    productsUpdate: { error: null as { code?: string; message: string } | null },
    invSelect: { data: { id: "inv-1", stock_quantity: 3 } as Record<string, unknown> | null, error: null },
    invUpdate: { error: null as { message: string } | null },
    invInsert: { error: null as { message: string } | null },
    variantSelect: { data: [{ id: "va" }, { id: "vb" }] as unknown[] | null, error: null as unknown },
    rpc: { data: { ok: true } as unknown, error: null as unknown },
    ...over,
  };
  const calls: FakeCall[] = [];
  const client = {
    from(table: string) {
      return {
        select(_columns: string) {
          return {
            filter(column: string, _op: string, value: string) {
              return {
                then<T>(
                  onOk: (v: { data: unknown[] | null; error: unknown }) => T,
                  onErr?: (e: unknown) => T,
                ) {
                  calls.push({ kind: "select-list", table, column, value });
                  const out = table === "product_variants" ? o.variantSelect : { data: [], error: null };
                  return Promise.resolve(out as { data: unknown[] | null; error: unknown }).then(onOk, onErr);
                },
                maybeSingle() {
                  calls.push({ kind: "select-single", table, column, value });
                  const out =
                    table === "products" ? o.productsBefore : table === "inventory" ? o.invSelect : { data: null, error: null };
                  return Promise.resolve(out as { data: Record<string, unknown> | null; error: unknown });
                },
              };
            },
          };
        },
        update(values: Record<string, unknown>) {
          return {
            filter(column: string, _op: string, value: string) {
              calls.push({ kind: "update", table, values, column, value });
              return Promise.resolve(table === "products" ? o.productsUpdate : o.invUpdate);
            },
          };
        },
        insert(values: Record<string, unknown>) {
          calls.push({ kind: "insert", table, values });
          return Promise.resolve(o.invInsert);
        },
      };
    },
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ kind: "rpc", fn, args });
      return Promise.resolve(o.rpc);
    },
  };
  return { client, calls };
}

// ── toVariantPayload: the identity rules, in one pure function ───────────────

test("toVariantPayload: an existing variant's id passes through verbatim", () => {
  const payload = toVariantPayload([variant({ id: "11111111-2222-3333-4444-555555555555" })]);
  assert.equal(payload[0].id, "11111111-2222-3333-4444-555555555555");
});

test("toVariantPayload: a new row (no id / blank id) is sent with id null — never a client uuid", () => {
  const payload = toVariantPayload([variant(), variant({ id: "" }), variant({ id: "   " })]);
  for (const p of payload) assert.equal(p.id, null);
});

test("toVariantPayload: trims a padded id but never rewrites it", () => {
  assert.equal(toVariantPayload([variant({ id: "  va  " })])[0].id, "va");
});

test("toVariantPayload: blank text fields become null, numbers become real numbers", () => {
  const p = toVariantPayload([variant({ barcode: "  ", price: "35", stock_quantity: "" })])[0];
  assert.equal(p.barcode, null);
  assert.equal(p.price, 35);
  assert.equal(p.stock_quantity, null);
});

test("toVariantPayload: non-array input yields an empty payload", () => {
  assert.deepEqual(toVariantPayload(undefined as unknown as VariantInput[]), []);
});

// ── toProductRow ─────────────────────────────────────────────────────────────

test("toProductRow: rejects a category outside the locked list", async () => {
  await assert.rejects(
    () => toProductRow(input({ main_category: "Weapons" }), DEPS),
    /Invalid category/,
  );
});

test("toProductRow: maps blanks to null and numeric strings to numbers", async () => {
  const row = await toProductRow(input({ sub_category: "  ", price: "120", discount_price: "" }), DEPS);
  assert.equal(row.sub_category, null);
  assert.equal(row.price, 120);
  assert.equal(row.discount_price, null);
  assert.equal(row.main_category, "Korean Skincare");
});

// ── syncProductVariants: pre-check happens BEFORE the RPC ────────────────────

test("syncProductVariants: a foreign id aborts with the fixed message and no RPC call", async () => {
  const { client, calls } = makeClient();
  const r = await syncProductVariants(client, "p1", [variant({ id: "not-mine" })], DEPS);
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.message, VARIANT_SYNC_MESSAGES.unknown_variant_id);
  assert.ok(!calls.some((c) => c.kind === "rpc"), "RPC must not be called");
});

test("syncProductVariants: a duplicated id aborts with the fixed message and no RPC call", async () => {
  const { client, calls } = makeClient();
  const r = await syncProductVariants(client, "p1", [variant({ id: "va" }), variant({ id: "va", sku: "V-2" })], DEPS);
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.message, VARIANT_SYNC_MESSAGES.duplicate_variant_id);
  assert.ok(!calls.some((c) => c.kind === "rpc"), "RPC must not be called");
});

test("syncProductVariants: happy path sends the payload with retained ids verbatim and new rows as null, returns parent totals", async () => {
  const { client, calls } = makeClient({ rpc: rpcVariant(3, 9) });
  const r = await syncProductVariants(
    client,
    "p1",
    [variant({ id: "va" }), variant({ sku: "V-9", barcode: "222" })],
    DEPS,
  );
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.hasVariants, true);
    assert.equal(r.parentBefore, 3);
    assert.equal(r.parentStock, 9);
  }
  const rpc = calls.find((c) => c.kind === "rpc");
  assert.ok(rpc, "RPC called");
  assert.equal(rpc?.fn, "sync_product_variants");
  assert.equal(rpc?.args?.p_product_id, "p1");
  const sent = rpc?.args?.p_variants as { id: string | null }[];
  assert.deepEqual(sent.map((v) => v.id), ["va", null]);
});

test("syncProductVariants: an omitted existing variant is simply not in the payload (delete decided by the RPC)", async () => {
  const { client, calls } = makeClient({ rpc: rpcVariant(3, 3) });
  const r = await syncProductVariants(client, "p1", [variant({ id: "va" })], DEPS);
  assert.ok(r.ok);
  const sent = (calls.find((c) => c.kind === "rpc")?.args?.p_variants ?? []) as { id: string | null }[];
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, "va");
});

test("syncProductVariants: shelf/channel/quantity/shelf-managed refusals map to their exact Arabic messages", async () => {
  for (const code of [
    "variant_has_shelf_stock", "variant_has_channel_mapping",
    "variant_invalid_quantity", "variant_stock_managed_by_shelves", "variant_parent_shelf_conflict",
  ] as const) {
    const { client } = makeClient({ rpc: { data: { ok: false, error: code }, error: null } });
    const r = await syncProductVariants(client, "p1", [variant({ id: "va" })], DEPS);
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.message, VARIANT_SYNC_MESSAGES[code]);
  }
});

test("syncProductVariants: rpc transport error and unknown/hostile codes fall back to the generic fixed message", async () => {
  const hostile = [
    { rpc: { data: null, error: { message: "boom" } } },
    { rpc: { data: { ok: false, error: "__proto__" }, error: null } },
    { rpc: { data: { ok: false, error: "constructor" }, error: null } },
    { rpc: { data: { ok: false }, error: null } },
    { rpc: { data: "nonsense", error: null } },
  ];
  for (const over of hostile) {
    const { client } = makeClient(over);
    const r = await syncProductVariants(client, "p1", [variant({ id: "va" })], DEPS);
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.message, VARIANT_SYNC_MESSAGES.variant_sync_failed);
  }
});

test("variantSyncMessage: fixed vocabulary only, never echoes the code", () => {
  assert.equal(variantSyncMessage("unknown_variant_id"), VARIANT_SYNC_MESSAGES.unknown_variant_id);
  assert.equal(variantSyncMessage("nonsense_code"), VARIANT_SYNC_MESSAGES.variant_sync_failed);
  assert.ok(!variantSyncMessage("nonsense_code").includes("nonsense_code"));
  assert.equal(variantSyncMessage(42), VARIANT_SYNC_MESSAGES.variant_sync_failed);
});

// ── updateProductCore ────────────────────────────────────────────────────────

test("updateProductCore: VARIANT product — parent stock comes from the atomic rollup, never the top-level form; metadata write excludes stock", async () => {
  const { client, calls } = makeClient({ rpc: rpcVariant(3, 9) });
  const { deps, invCalls } = opts();
  // top-level form says 7, but the parent must be the RPC's Σ-variants (9).
  const res = await updateProductCore(client, "p1", input({ stock_quantity: "7", variants: [variant({ id: "va" })] }), deps);
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.hasVariants, true);
    assert.equal(res.stockBefore, 3);
    assert.equal(res.stockAfter, 9); // NOT 7
    assert.equal(res.stockChanged, true);
  }
  assert.equal(invCalls.length, 0, "no setAbsolute for a variant product");
  // metadata update must NOT carry stock_quantity; the mirror write (2nd) carries it.
  const prodUpdates = calls.filter((c) => c.kind === "update" && c.table === "products");
  assert.equal("stock_quantity" in (prodUpdates[0].values ?? {}), false, "metadata patch excludes stock");
  assert.equal(prodUpdates[1].values?.stock_quantity, 9, "mirror = authoritative parent stock");
  const kinds = calls.map((c) => `${c.kind}:${c.table ?? c.fn}`);
  assert.deepEqual(kinds, [
    "select-single:products",
    "update:products",
    "select-single:inventory",
    "select-list:product_variants",
    "rpc:sync_product_variants",
    "update:products",
  ]);
});

test("updateProductCore: SIMPLE product with a changed stock calls the Engine adapter (setAbsolute) and mirrors the result", async () => {
  const { client, calls } = makeClient({ rpc: rpcSimple });
  const { deps, invCalls } = opts({ ok: true, before: 3, after: 7, productId: "p1" });
  const res = await updateProductCore(client, "p1", input({ stock_quantity: "7" }), deps);
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.hasVariants, false);
    assert.equal(res.stockBefore, 3);
    assert.equal(res.stockAfter, 7);
    assert.equal(res.stockChanged, true);
  }
  assert.deepEqual(invCalls, [{ inventoryId: "inv-1", quantity: 7 }]);
  const mirror = calls.filter((c) => c.kind === "update" && c.table === "products").at(-1);
  assert.equal(mirror?.values?.stock_quantity, 7);
});

test("updateProductCore: SIMPLE product with UNCHANGED stock does NOT call the Engine (metadata-only save)", async () => {
  const { client } = makeClient({ rpc: rpcSimple, invSelect: { data: { id: "inv-1", stock_quantity: 7 }, error: null } });
  const { deps, invCalls } = opts();
  const res = await updateProductCore(client, "p1", input({ stock_quantity: "7" }), deps);
  assert.ok(res.ok);
  if (res.ok) { assert.equal(res.stockChanged, false); assert.equal(res.stockAfter, 7); }
  assert.equal(invCalls.length, 0, "no Engine call when stock is unchanged");
});

test("updateProductCore: a shelf-tracked simple product surfaces the Engine reason on a stock change", async () => {
  const { client } = makeClient({ rpc: rpcSimple });
  const { deps } = opts({ ok: false, reason: "product_has_shelf_rows" });
  const res = await updateProductCore(client, "p1", input({ stock_quantity: "99" }), deps);
  assert.ok(!res.ok);
  if (!res.ok) { assert.equal(res.stage, "inventory_sync"); assert.equal(res.reason, "product_has_shelf_rows"); }
});

test("updateProductCore: invalid category fails as invalid_input before ANY database call", async () => {
  const { client, calls } = makeClient();
  const { deps } = opts();
  const res = await updateProductCore(client, "p1", input({ main_category: "Weapons" }), deps);
  assert.ok(!res.ok);
  if (!res.ok) assert.equal(res.stage, "invalid_input");
  assert.equal(calls.length, 0);
});

test("updateProductCore: duplicate SKU/barcode (23505) is flagged for the V2 mapping and keeps the legacy string", async () => {
  const { client } = makeClient({
    productsUpdate: { error: { code: "23505", message: 'duplicate key value violates unique constraint "products_sku_key"' } },
  });
  const { deps } = opts();
  const res = await updateProductCore(client, "p1", input(), deps);
  assert.ok(!res.ok);
  if (!res.ok) {
    assert.equal(res.stage, "product_update");
    assert.equal(res.duplicateIdentity, true);
    assert.equal(res.message, "A product with this SKU or barcode already exists. Please use a unique value.");
  }
});

test("updateProductCore: generic product-update failure keeps the legacy message and is NOT flagged duplicate", async () => {
  const { client } = makeClient({ productsUpdate: { error: { code: "XX000", message: "some backend text" } } });
  const { deps } = opts();
  const res = await updateProductCore(client, "p1", input(), deps);
  assert.ok(!res.ok);
  if (!res.ok) {
    assert.equal(res.stage, "product_update");
    assert.notEqual(res.duplicateIdentity, true);
  }
});

test("updateProductCore: MISSING inventory row FAILS CLOSED (no lazy seed, no variant sync)", async () => {
  const { client, calls } = makeClient({ invSelect: { data: null, error: null } });
  const { deps, invCalls } = opts();
  const res = await updateProductCore(client, "p1", input(), deps);
  assert.ok(!res.ok);
  if (!res.ok) { assert.equal(res.stage, "inventory_sync"); assert.equal(res.reason, "inventory_missing"); }
  assert.ok(!calls.some((c) => c.kind === "insert"), "NEVER seeds an inventory row from the editor");
  assert.ok(!calls.some((c) => c.kind === "rpc"), "variant sync must not run");
  assert.equal(invCalls.length, 0, "no Engine call");
});

test("updateProductCore: a variant-sync refusal surfaces as stage variant_sync with the fixed Arabic message", async () => {
  const { client } = makeClient({ rpc: { data: { ok: false, error: "variant_has_shelf_stock" }, error: null } });
  const { deps } = opts();
  const res = await updateProductCore(client, "p1", input({ variants: [variant({ id: "va" })] }), deps);
  assert.ok(!res.ok);
  if (!res.ok) {
    assert.equal(res.stage, "variant_sync");
    assert.equal(res.message, VARIANT_SYNC_MESSAGES.variant_has_shelf_stock);
  }
});

// ── friendlyWriteError (legacy string contract) ──────────────────────────────

test("friendlyWriteError: 23505 → duplicate wording; null → fallback; other → raw message (legacy contract)", () => {
  assert.match(friendlyWriteError({ code: "23505", message: "x" }, "f"), /already exists/);
  assert.equal(friendlyWriteError(null, "fallback"), "fallback");
  assert.equal(friendlyWriteError({ message: "raw text" }, "f"), "raw text");
});
