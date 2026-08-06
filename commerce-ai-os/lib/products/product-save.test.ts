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
  const msg = await syncProductVariants(client, "p1", [variant({ id: "not-mine" })], DEPS);
  assert.equal(msg, VARIANT_SYNC_MESSAGES.unknown_variant_id);
  assert.ok(!calls.some((c) => c.kind === "rpc"), "RPC must not be called");
});

test("syncProductVariants: a duplicated id aborts with the fixed message and no RPC call", async () => {
  const { client, calls } = makeClient();
  const msg = await syncProductVariants(client, "p1", [variant({ id: "va" }), variant({ id: "va", sku: "V-2" })], DEPS);
  assert.equal(msg, VARIANT_SYNC_MESSAGES.duplicate_variant_id);
  assert.ok(!calls.some((c) => c.kind === "rpc"), "RPC must not be called");
});

test("syncProductVariants: happy path sends the payload with retained ids verbatim and new rows as null", async () => {
  const { client, calls } = makeClient();
  const msg = await syncProductVariants(
    client,
    "p1",
    [variant({ id: "va" }), variant({ sku: "V-9", barcode: "222" })],
    DEPS,
  );
  assert.equal(msg, null);
  const rpc = calls.find((c) => c.kind === "rpc");
  assert.ok(rpc, "RPC called");
  assert.equal(rpc?.fn, "sync_product_variants");
  assert.equal(rpc?.args?.p_product_id, "p1");
  const sent = rpc?.args?.p_variants as { id: string | null }[];
  assert.deepEqual(sent.map((v) => v.id), ["va", null]);
});

test("syncProductVariants: an omitted existing variant is simply not in the payload (delete decided by the RPC)", async () => {
  const { client, calls } = makeClient();
  const msg = await syncProductVariants(client, "p1", [variant({ id: "va" })], DEPS);
  assert.equal(msg, null);
  const sent = (calls.find((c) => c.kind === "rpc")?.args?.p_variants ?? []) as { id: string | null }[];
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, "va");
});

test("syncProductVariants: shelf-stock and channel-mapping refusals map to their exact Arabic messages", async () => {
  for (const code of ["variant_has_shelf_stock", "variant_has_channel_mapping"] as const) {
    const { client } = makeClient({ rpc: { data: { ok: false, error: code }, error: null } });
    const msg = await syncProductVariants(client, "p1", [variant({ id: "va" })], DEPS);
    assert.equal(msg, VARIANT_SYNC_MESSAGES[code]);
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
    const msg = await syncProductVariants(client, "p1", [variant({ id: "va" })], DEPS);
    assert.equal(msg, VARIANT_SYNC_MESSAGES.variant_sync_failed);
  }
});

test("variantSyncMessage: fixed vocabulary only, never echoes the code", () => {
  assert.equal(variantSyncMessage("unknown_variant_id"), VARIANT_SYNC_MESSAGES.unknown_variant_id);
  assert.equal(variantSyncMessage("nonsense_code"), VARIANT_SYNC_MESSAGES.variant_sync_failed);
  assert.ok(!variantSyncMessage("nonsense_code").includes("nonsense_code"));
  assert.equal(variantSyncMessage(42), VARIANT_SYNC_MESSAGES.variant_sync_failed);
});

// ── updateProductCore ────────────────────────────────────────────────────────

test("updateProductCore: happy path — write order is product → inventory → variants, and stock numbers are reported", async () => {
  const { client, calls } = makeClient();
  const res = await updateProductCore(client, "p1", input({ variants: [variant({ id: "va" })] }), DEPS);
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.stockBefore, 3);
    assert.equal(res.stockAfter, 7);
    assert.equal((res.before as Record<string, unknown>).name_en, "Old name");
    assert.equal(res.row.name_ar, "سيروم");
  }
  const kinds = calls.map((c) => `${c.kind}:${c.table ?? c.fn}`);
  assert.deepEqual(kinds, [
    "select-single:products",
    "update:products",
    "select-single:inventory",
    "update:inventory",
    "select-list:product_variants",
    "rpc:sync_product_variants",
  ]);
});

test("updateProductCore: invalid category fails as invalid_input before ANY database call", async () => {
  const { client, calls } = makeClient();
  const res = await updateProductCore(client, "p1", input({ main_category: "Weapons" }), DEPS);
  assert.ok(!res.ok);
  if (!res.ok) assert.equal(res.stage, "invalid_input");
  assert.equal(calls.length, 0);
});

test("updateProductCore: duplicate SKU/barcode (23505) is flagged for the V2 mapping and keeps the legacy string", async () => {
  const { client } = makeClient({
    productsUpdate: { error: { code: "23505", message: 'duplicate key value violates unique constraint "products_sku_key"' } },
  });
  const res = await updateProductCore(client, "p1", input(), DEPS);
  assert.ok(!res.ok);
  if (!res.ok) {
    assert.equal(res.stage, "product_update");
    assert.equal(res.duplicateIdentity, true);
    assert.equal(res.message, "A product with this SKU or barcode already exists. Please use a unique value.");
  }
});

test("updateProductCore: generic product-update failure keeps the legacy message and is NOT flagged duplicate", async () => {
  const { client } = makeClient({ productsUpdate: { error: { code: "XX000", message: "some backend text" } } });
  const res = await updateProductCore(client, "p1", input(), DEPS);
  assert.ok(!res.ok);
  if (!res.ok) {
    assert.equal(res.stage, "product_update");
    assert.notEqual(res.duplicateIdentity, true);
  }
});

test("updateProductCore: inventory failure stops before the variant sync", async () => {
  const { client, calls } = makeClient({ invUpdate: { error: { message: "inv down" } } });
  const res = await updateProductCore(client, "p1", input({ variants: [variant({ id: "va" })] }), DEPS);
  assert.ok(!res.ok);
  if (!res.ok) assert.equal(res.stage, "inventory_sync");
  assert.ok(!calls.some((c) => c.kind === "rpc"), "variant sync must not run");
});

test("updateProductCore: missing inventory row is seeded via insert (stockBefore 0)", async () => {
  const { client, calls } = makeClient({ invSelect: { data: null, error: null } });
  const res = await updateProductCore(client, "p1", input(), DEPS);
  assert.ok(res.ok);
  if (res.ok) assert.equal(res.stockBefore, 0);
  const ins = calls.find((c) => c.kind === "insert" && c.table === "inventory");
  assert.ok(ins, "inventory seeded");
  assert.equal(ins?.values?.product_id, "p1");
  assert.equal(ins?.values?.stock_quantity, 7);
});

test("updateProductCore: a variant-sync refusal surfaces as stage variant_sync with the fixed Arabic message", async () => {
  const { client } = makeClient({ rpc: { data: { ok: false, error: "variant_has_shelf_stock" }, error: null } });
  const res = await updateProductCore(client, "p1", input({ variants: [variant({ id: "va" })] }), DEPS);
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
