// INV.6 — variant-grain Shopify inventory identity.
//
// The defect these tests pin: a canonical product with variants was resolved by
// its bare product SKU. On Shopify that SKU exists only on an UNMAPPED LEGACY
// twin (several variants all repeating it), while the product the ECL actually
// maps is a different Shopify product whose variants carry suffixed SKUs. The
// write therefore landed on the wrong product, and on one arbitrary variant of
// it.
//
// Fixtures mirror three real, live-verified products:
//   mk1121  2 variants — legacy twin ACTIVE+published, mapped parent DRAFT
//   mk1158  5 variants — Out of Stock; all five must be zeroed
//   mk1284  5 variants — legacy twin holds a NEGATIVE quantity we must not touch
//
// No production read or write happens here; every shape is hand-built.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/shopify/variant-inventory.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  isVariantGrainProduct,
  planInventoryGrainBatch,
  planProductInventoryGrain,
  syncVariantInventory,
  type CanonicalProductInventoryInput,
  type VariantInventoryDeps,
} from "./variant-inventory.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), "utf8");
/** Source with comments stripped — assertions must never match our own prose. */
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const PV = (n: string) => `gid://shopify/ProductVariant/${n}`;
const P = (n: string) => `gid://shopify/Product/${n}`;

// ── real-shaped fixtures ─────────────────────────────────────────────────────

/** mk1121 — legacy twin 9296133980398 is ACTIVE+published; mapped parent is DRAFT. */
const mk1121 = (): CanonicalProductInventoryInput => ({
  productId: "268c738e",
  sku: "mk1121",
  variants: [
    { id: "v1", sku: "mk1121-1-rose-finch", stockQuantity: 0 },
    { id: "v2", sku: "mk1121-2-peony-ballet", stockQuantity: 0 },
  ],
  listings: [
    { variantId: null, externalProductId: P("9483894685934") },
    { variantId: "v1", variantSku: "mk1121-1-rose-finch", externalProductId: P("9483894685934"), externalVariantId: PV("51328003768558") },
    { variantId: "v2", variantSku: "mk1121-2-peony-ballet", externalProductId: P("9483894685934"), externalVariantId: PV("51328003735790") },
  ],
});

/** mk1158 — 5 shades, Out of Stock. */
const mk1158 = (): CanonicalProductInventoryInput => ({
  productId: "67b6a6cf",
  sku: "mk1158",
  variants: [1, 2, 3, 4, 5].map((i) => ({ id: `s${i}`, sku: `mk1158-${i}`, stockQuantity: 0 })),
  listings: [
    { variantId: null, externalProductId: P("9483896815854") },
    ...[1, 2, 3, 4, 5].map((i) => ({
      variantId: `s${i}`, variantSku: `mk1158-${i}`,
      externalProductId: P("9483896815854"), externalVariantId: PV(`4948581649636${i}`),
    })),
  ],
});

/** mk1284 — 5 shades; the legacy twin carries a -1 we must never address. */
const mk1284 = (): CanonicalProductInventoryInput => ({
  productId: "36192fbc",
  sku: "mk1284",
  variants: [1, 2, 3, 4, 5].map((i) => ({ id: `b${i}`, sku: `mk1284-${i}`, stockQuantity: 0 })),
  listings: [
    { variantId: null, externalProductId: P("9483895046382") },
    ...[1, 2, 3, 4, 5].map((i) => ({
      variantId: `b${i}`, variantSku: `mk1284-${i}`,
      externalProductId: P("9483895046382"), externalVariantId: PV(`4948621597105${i}`),
    })),
  ],
});

/** Every Shopify variant id that belongs to a LEGACY twin — never a valid target. */
const LEGACY_VARIANT_GIDS = new Set([
  PV("48096805028078"), PV("48110524858606"),                                   // mk1121 legacy
  PV("48096812040430"), PV("48116453277934"), PV("48116453310702"),
  PV("48116453343470"), PV("48116453376238"),                                   // mk1158 legacy
  PV("48096817578222"), PV("48116455538926"), PV("48116455571694"),
  PV("48116455604462"), PV("48116455637230"),                                   // mk1284 legacy (last = qty -1)
]);

const okDeps = (sink: { items: { inventoryItemId: string; quantity: number }[][] }): VariantInventoryDeps => ({
  configured: () => true,
  resolveLocationId: async () => ({ locationId: "loc" }),
  resolveInventoryItemIdByVariantGid: async (gid) => {
    assert.equal(LEGACY_VARIANT_GIDS.has(gid), false, `legacy variant ${gid} must never be a write target`);
    return { inventoryItemId: `item-for-${gid.split("/").pop()}` };
  },
  setQuantities: async (_loc, items) => { sink.items.push(items); return { ok: true }; },
});

// ── 1. simple product ────────────────────────────────────────────────────────
test("1. a product with no canonical variants stays on the safe SKU path", () => {
  const plan = planProductInventoryGrain({ productId: "p", sku: "mk2100", variants: [], listings: [] }, "CANONICAL");
  assert.equal(plan.grain, "SIMPLE");
  assert.equal(plan.grain === "SIMPLE" && plan.sku, "mk2100");
  assert.equal(isVariantGrainProduct({ variants: [] }), false);
  assert.equal(isVariantGrainProduct({ variants: [{}] }), true);
});

// ── 2. complete ECL → exact variant-GID targets ──────────────────────────────
test("2. a variant product with complete ECL plans exact variant-GID targets", () => {
  const plan = planProductInventoryGrain(mk1121(), "CANONICAL");
  assert.equal(plan.grain, "VARIANT");
  if (plan.grain !== "VARIANT") return;
  assert.equal(plan.parentGid, P("9483894685934"));
  assert.deepEqual(plan.targets.map((t) => t.externalVariantId), [PV("51328003768558"), PV("51328003735790")]);
  // No target may be a bare SKU or a legacy variant.
  for (const t of plan.targets) assert.equal(LEGACY_VARIANT_GIDS.has(t.externalVariantId), false);
});

// ── 3. quantity preservation ─────────────────────────────────────────────────
test("3. each canonical stock_quantity maps to its own external_variant_id", () => {
  const input = mk1158();
  input.variants = [10, 20, 30, 40, 50].map((q, i) => ({ id: `s${i + 1}`, sku: `mk1158-${i + 1}`, stockQuantity: q }));
  const plan = planProductInventoryGrain(input, "CANONICAL");
  assert.equal(plan.grain, "VARIANT");
  if (plan.grain !== "VARIANT") return;
  assert.deepEqual(
    plan.targets.map((t) => [t.externalVariantId, t.quantity]),
    [1, 2, 3, 4, 5].map((i) => [PV(`4948581649636${i}`), i * 10]),
  );
  // Product-level collapse would show one target carrying the 150 total.
  assert.equal(plan.targets.some((t) => t.quantity === 150), false);
});

// ── 4. OOS variant product → every variant zeroed ────────────────────────────
test("4. an Out-of-Stock variant product zeroes ALL mapped variants", async () => {
  const sink = { items: [] as { inventoryItemId: string; quantity: number }[][] };
  const plans = planInventoryGrainBatch([mk1158()], "ZERO");
  const s = await syncVariantInventory(plans, okDeps(sink));
  assert.equal(s.synced, 1);
  assert.equal(s.variantsWritten, 5, "all five shades must be written");
  assert.equal(sink.items.length, 1);
  assert.equal(sink.items[0]!.length, 5);
  assert.deepEqual([...new Set(sink.items[0]!.map((i) => i.quantity))], [0]);
});

test("4b. ZERO mode ignores non-zero canonical quantities (scope stays OOS-zero-only)", () => {
  const input = mk1284();
  input.variants = input.variants.map((v) => ({ ...v, stockQuantity: 7 }));
  const plan = planProductInventoryGrain(input, "ZERO");
  assert.equal(plan.grain, "VARIANT");
  if (plan.grain !== "VARIANT") return;
  assert.deepEqual([...new Set(plan.targets.map((t) => t.quantity))], [0]);
});

// ── 5–6. the legacy twin is never selected, even when it looks healthier ─────
test("5. a legacy bare-SKU twin is never a target when a variant mapping exists", async () => {
  const sink = { items: [] as { inventoryItemId: string; quantity: number }[][] };
  const plans = planInventoryGrainBatch([mk1121(), mk1158(), mk1284()], "ZERO");
  const s = await syncVariantInventory(plans, okDeps(sink)); // deps assert on every legacy gid
  assert.equal(s.synced, 3);
  assert.equal(s.variantsWritten, 12);
  const written = sink.items.flat().map((i) => i.inventoryItemId);
  for (const gid of LEGACY_VARIANT_GIDS) {
    assert.equal(written.includes(`item-for-${gid.split("/").pop()}`), false, `${gid} was written`);
  }
});

test("6. mapped parent DRAFT still wins over an ACTIVE published legacy twin", () => {
  // The planner is told the MAPPED parent's status; DRAFT is operational.
  const draftMapped = { ...mk1121(), parentStatus: "DRAFT" };
  assert.equal(planProductInventoryGrain(draftMapped, "ZERO").grain, "VARIANT");
  // Nothing about the legacy twin's ACTIVE/published state can enter the plan:
  // the planner consumes ECL only.
  const src = code("./variant-inventory.ts");
  for (const banned of ["publication", "onlineStoreUrl", "handle", "search"]) {
    assert.equal(new RegExp(banned, "i").test(src), false, `planner must not consider ${banned}`);
  }
});

// ── 7–11. fail-closed conditions ─────────────────────────────────────────────
test("7. a missing variant ECL row blocks the WHOLE product", () => {
  const input = mk1158();
  input.listings = input.listings.filter((l) => l.variantId !== "s3"); // 4 of 5
  const plan = planProductInventoryGrain(input, "ZERO");
  assert.equal(plan.grain, "BLOCKED");
  assert.equal(plan.grain === "BLOCKED" && plan.reason, "INCOMPLETE_VARIANT_MAPPING");
});

test("7b. a blocked product writes NOTHING — no partial 4-of-5", async () => {
  const input = mk1158();
  input.listings = input.listings.filter((l) => l.variantId !== "s3");
  const sink = { items: [] as { inventoryItemId: string; quantity: number }[][] };
  const s = await syncVariantInventory(planInventoryGrainBatch([input], "ZERO"), okDeps(sink));
  assert.equal(s.synced, 0);
  assert.equal(s.variantsWritten, 0);
  assert.deepEqual(sink.items, [], "not a single quantity may be set for a blocked product");
});

test("8. a null external_variant_id blocks the whole product", () => {
  const input = mk1284();
  input.listings = input.listings.map((l) => (l.variantId === "b2" ? { ...l, externalVariantId: null } : l));
  const plan = planProductInventoryGrain(input, "ZERO");
  assert.equal(plan.grain === "BLOCKED" && plan.reason, "MISSING_EXTERNAL_VARIANT_ID");
});

test("9. duplicate variant mappings fail closed (either side of the 1:1)", () => {
  const dupCanonical = mk1121();
  dupCanonical.listings = [...dupCanonical.listings, { variantId: "v1", externalProductId: P("9483894685934"), externalVariantId: PV("999") }];
  assert.equal(planProductInventoryGrain(dupCanonical, "ZERO").grain === "BLOCKED" && planProductInventoryGrain(dupCanonical, "ZERO").reason, "DUPLICATE_VARIANT_MAPPING");

  const dupExternal = mk1121();
  dupExternal.listings = dupExternal.listings.map((l) =>
    l.variantId === "v2" ? { ...l, externalVariantId: PV("51328003768558") } : l);
  const p = planProductInventoryGrain(dupExternal, "ZERO");
  assert.equal(p.grain === "BLOCKED" && p.reason, "DUPLICATE_VARIANT_MAPPING");
});

test("10. an ARCHIVED mapped parent fails closed at BOTH layers", async () => {
  const archived = { ...mk1158(), parentStatus: "ARCHIVED" };
  const plan = planProductInventoryGrain(archived, "ZERO");
  assert.equal(plan.grain === "BLOCKED" && plan.reason, "PARENT_ARCHIVED");

  // …and when the status was unknown at plan time, the resolver still refuses.
  const sink = { items: [] as { inventoryItemId: string; quantity: number }[][] };
  const s = await syncVariantInventory(planInventoryGrainBatch([mk1158()], "ZERO"), {
    ...okDeps(sink),
    resolveInventoryItemIdByVariantGid: async () => ({ inventoryItemId: "", reason: "archived_parent" }),
  });
  assert.equal(s.synced, 0);
  assert.deepEqual(sink.items, []);
  assert.equal(s.perProduct[0]!.result === "blocked" && s.perProduct[0]!.reason, "archived_parent");
});

test("11. a canonical/mapping SKU disagreement fails closed", () => {
  const input = mk1121();
  input.listings = input.listings.map((l) => (l.variantId === "v2" ? { ...l, variantSku: "mk1121-9-wrong" } : l));
  const plan = planProductInventoryGrain(input, "ZERO");
  assert.equal(plan.grain === "BLOCKED" && plan.reason, "SKU_MISMATCH");
});

test("11b. other incoherent-identity shapes block too", () => {
  const noParent = { ...mk1121(), listings: mk1121().listings.filter((l) => l.variantId !== null) };
  assert.equal(planProductInventoryGrain(noParent, "ZERO").grain === "BLOCKED" && planProductInventoryGrain(noParent, "ZERO").reason, "PARENT_MAPPING_MISSING");

  const noVariantRows = { ...mk1121(), listings: mk1121().listings.filter((l) => l.variantId === null) };
  const p2 = planProductInventoryGrain(noVariantRows, "ZERO");
  assert.equal(p2.grain === "BLOCKED" && p2.reason, "NO_VARIANT_MAPPINGS");

  const foreign = mk1121();
  foreign.listings = foreign.listings.map((l) => (l.variantId === "v2" ? { ...l, externalProductId: P("9999") } : l));
  const p3 = planProductInventoryGrain(foreign, "ZERO");
  assert.equal(p3.grain === "BLOCKED" && p3.reason, "VARIANT_PARENT_MISMATCH");

  const unknown = mk1121();
  unknown.listings = [...unknown.listings, { variantId: "ghost", externalProductId: P("9483894685934"), externalVariantId: PV("777") }];
  const p4 = planProductInventoryGrain(unknown, "ZERO");
  assert.equal(p4.grain === "BLOCKED" && p4.reason, "UNKNOWN_VARIANT_MAPPING");

  const noQty = mk1121();
  noQty.variants = noQty.variants.map((v) => ({ ...v, stockQuantity: null }));
  const p5 = planProductInventoryGrain(noQty, "CANONICAL");
  assert.equal(p5.grain === "BLOCKED" && p5.reason, "MISSING_QUANTITY");
});

// ── 12. no first-variant selection survives for canonical variant products ───
test("12. planning is order-independent and never picks a first variant", () => {
  const a = mk1284();
  const b = mk1284();
  b.variants = [...b.variants].reverse();
  b.listings = [b.listings[0]!, ...b.listings.slice(1).reverse()];
  const pa = planProductInventoryGrain(a, "ZERO");
  const pb = planProductInventoryGrain(b, "ZERO");
  assert.equal(pa.grain, "VARIANT");
  assert.equal(pb.grain, "VARIANT");
  if (pa.grain !== "VARIANT" || pb.grain !== "VARIANT") return;
  assert.equal(pa.targets.length, 5);
  assert.equal(pb.targets.length, 5);
  assert.deepEqual(
    new Set(pa.targets.map((t) => t.externalVariantId)),
    new Set(pb.targets.map((t) => t.externalVariantId)),
    "reordering inputs must not change which variants are written",
  );
});

// ── 13–14. wiring guards ─────────────────────────────────────────────────────
test("13. PR #695 archived-SKU safety is untouched", () => {
  const admin = code("./admin.ts");
  assert.match(admin, /export async function resolveInventoryItemIdBySku/);
  assert.match(admin, /productVariants\(first:\s*100/, "SKU resolver still fetches many candidates");
  assert.equal(/productVariants\(first:\s*1[,)\s]/.test(admin), false, "first:1 SKU lookup stays banned");
  assert.match(admin, /selectOperational\(/, "SKU resolver still uses the operational rule");
  assert.match(admin, /reason:\s*"ambiguous"/, "SKU resolver still fails closed");
});

test("14. both write paths route variant products through the exact-GID resolver", () => {
  const admin = code("./admin.ts");
  // The variant resolver addresses a GID and never issues a SKU search.
  const fn = admin.slice(admin.indexOf("export async function resolveInventoryItemIdByVariantGid"));
  const body = fn.slice(0, fn.indexOf("export async function pushVariantInventoryToShopify"));
  assert.match(body, /node\(id: \$id\)/, "must fetch the exact ProductVariant by GID");
  // The hazard is a SKU *search*, not the word "sku" (the body legitimately
  // reads node.sku to validate). Ban the query filter and the search field.
  assert.equal(/sku:\s*["'`$]/.test(body), false, "no sku: search filter may appear in the variant resolver");
  assert.equal(/productVariants\(/.test(body), false, "the variant resolver must not run a variant search");
  assert.match(body, /isOperationalShopifyProduct\(node\.product\)/, "must reject an ARCHIVED parent");

  // Nightly/manual OOS sync: variant products are excluded from the SKU matcher.
  const sync = code("./inventory-sync.ts");
  assert.match(sync, /variantParents/, "OOS list must be split by grain");
  assert.match(sync, /planInventoryGrainBatch\(inputs, "ZERO"\)/, "variant products get ZERO targets");
  assert.match(sync, /ours = oosAll\.filter\(\(o\) => !variantParents\.has\(o\.id\)\)/, "variant products never reach planInventorySync");

  // Inventory page: same split, canonical quantities.
  const actions = code("../../app/(app)/inventory/actions.ts");
  assert.match(actions, /isVariantGrainProduct\(input\)/);
  assert.match(actions, /planProductInventoryGrain\(input, "CANONICAL"\)/);
  assert.match(actions, /pushVariantInventoryToShopify\(/);
});

test("15. the reconcile-to-Shopify zero push is grain-split and archived-safe", () => {
  const avail = code("../../app/(app)/import-export/availability-actions.ts");
  // Was: bare-SKU match across EVERY product (archived included), zeroing every
  // variant of the legacy twin. Both holes must stay closed.
  assert.match(avail, /isOperationalShopifyProduct\(p\)/, "must skip retired listings");
  assert.match(avail, /planInventoryGrainBatch\(variantInputs, "ZERO"\)/, "variant products go through exact GIDs");
  assert.match(avail, /!variantSkus\.has\(s\)/, "variant SKUs must be excluded from bare-SKU matching");
});
