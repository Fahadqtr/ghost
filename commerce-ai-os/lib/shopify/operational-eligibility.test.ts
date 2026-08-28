// SHOPIFY.ARCHIVED.1 — an ARCHIVED Shopify product must NEVER be selected as
// the operational target of a write, by SKU or by title, regardless of the
// order Shopify returns results in.
//
// Fixtures use the real first-wave duplicate SKUs (mk2215, mk2218, mk2219,
// mk2220, mk2223, mk2224). Each of those currently exists on the live store as
// ONE ACTIVE product plus ONE ARCHIVED shell that still carries the same SKU.
// No production read or write happens here — the shapes are hand-built.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/shopify/operational-eligibility.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  SHOPIFY_ARCHIVED_STATUS,
  buildOperationalIndex,
  isOperationalShopifyProduct,
  isOperationalShopifyStatus,
  normalizeShopifyStatus,
  selectOperational,
} from "./operational-eligibility.ts";
import {
  diffShopify,
  indexShopify,
  planInventorySync,
  type OurProductRow,
  type ShopifyProductLite,
} from "../shopify-diff.ts";
import { syncStockBySku, type ShopifyStockPushDeps } from "./stock-push.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), "utf8");
/** Source with comments stripped — assertions must never match our own prose. */
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** The six live duplicate SKUs from the first-wave cleanup. */
const FIRST_WAVE = ["mk2215", "mk2218", "mk2219", "mk2220", "mk2223", "mk2224"] as const;

const prod = (over: Partial<ShopifyProductLite>): ShopifyProductLite => ({
  id: "gid://shopify/Product/1",
  title: "Bubble Morning Rays Brightening Eye Cream (15Ml)",
  status: "ACTIVE",
  variants: [{ id: "gid://shopify/ProductVariant/1", sku: "mk2219", price: "79.00", compareAtPrice: null, inventoryItemId: "gid://shopify/InventoryItem/1", inventoryQuantity: 5 }],
  ...over,
});

/** The live product (9296…) and the archived shell (9420…) for one SKU. */
const livePair = (sku: string) => ({
  live: prod({ id: `gid://shopify/Product/9296-${sku}`, status: "ACTIVE", variants: [{ id: `v-live-${sku}`, sku, price: "79.00", compareAtPrice: null, inventoryItemId: `ii-live-${sku}`, inventoryQuantity: 5 }] }),
  shell: prod({ id: `gid://shopify/Product/9420-${sku}`, status: "ARCHIVED", variants: [{ id: `v-shell-${sku}`, sku, price: "79.00", compareAtPrice: null, inventoryItemId: `ii-shell-${sku}`, inventoryQuantity: 1 }] }),
});

const our = (over: Partial<OurProductRow>): OurProductRow => ({
  id: "p1", sku: "mk2219", name_en: "Bubble Morning Rays Brightening Eye Cream (15Ml)", name_ar: null,
  price: 79, discount_price: null, approval: "Approved", ...over,
});

// ── 1. same SKU: ACTIVE live + ARCHIVED shell → the ACTIVE one wins ──────────
test("1. duplicate SKU (ACTIVE live + ARCHIVED shell) resolves to the ACTIVE product", () => {
  for (const sku of FIRST_WAVE) {
    const { live, shell } = livePair(sku);
    const hit = indexShopify([live, shell]).match(sku, null);
    assert.equal(hit?.p.id, live.id, `${sku} must resolve to the live product`);
    assert.equal(hit?.v.inventoryItemId, `ii-live-${sku}`);
  }
});

// ── 2. archived shell returned FIRST → still must not be selected ────────────
test("2. archived shell listed first is still never selected (order-independent)", () => {
  for (const sku of FIRST_WAVE) {
    const { live, shell } = livePair(sku);
    const hit = indexShopify([shell, live]).match(sku, null);
    assert.equal(hit?.p.id, live.id, `${sku}: shell-first ordering must not change the answer`);
    assert.notEqual(hit?.p.status, SHOPIFY_ARCHIVED_STATUS);
  }
  // …and the raw selector is order-independent too.
  const a = { status: "ARCHIVED", id: "shell" };
  const b = { status: "ACTIVE", id: "live" };
  const forward = selectOperational([a, b], (c) => c.id);
  const reverse = selectOperational([b, a], (c) => c.id);
  assert.equal(forward.ok && forward.match.id, "live");
  assert.equal(reverse.ok && reverse.match.id, "live");
});

// ── 3. only an ARCHIVED product carries the SKU → no operational match ───────
test("3. archived-only SKU yields NO match (never the archived product)", () => {
  const { shell } = livePair("mk2219");
  const idx = indexShopify([shell]);
  assert.equal(idx.match("mk2219", null), undefined);
  assert.equal(idx.blockedSkus.get("mk2219"), "ARCHIVED_ONLY");

  const sel = selectOperational([{ status: "ARCHIVED", id: "shell" }], (c) => c.id);
  assert.equal(sel.ok, false);
  assert.equal(sel.reason, "ARCHIVED_ONLY");
  assert.equal(sel.match, null);
});

// ── 4. two eligible products share a SKU → ambiguous, fail closed ────────────
test("4. two eligible products on one SKU fail closed as AMBIGUOUS", () => {
  const a = prod({ id: "A", status: "ACTIVE", variants: [{ id: "va", sku: "mk2219", price: "1.00", compareAtPrice: null, inventoryItemId: "ia", inventoryQuantity: 1 }] });
  const b = prod({ id: "B", status: "ACTIVE", title: "Other title", variants: [{ id: "vb", sku: "mk2219", price: "2.00", compareAtPrice: null, inventoryItemId: "ib", inventoryQuantity: 2 }] });
  const idx = indexShopify([a, b]);
  assert.equal(idx.match("mk2219", null), undefined, "two ACTIVE claimants ⇒ no match");
  assert.equal(idx.blockedSkus.get("mk2219"), "AMBIGUOUS");

  // A blocked SKU must NOT silently fall through to the title fallback.
  assert.equal(idx.match("mk2219", "Bubble Morning Rays Brightening Eye Cream (15Ml)"), undefined);
});

test("4b. one ACTIVE + one DRAFT on a SKU resolves to ACTIVE (documented preference)", () => {
  const active = prod({ id: "A", status: "ACTIVE", variants: [{ id: "va", sku: "mk2223", price: "1.00", compareAtPrice: null, inventoryItemId: "ia", inventoryQuantity: 1 }] });
  const draft = prod({ id: "B", status: "DRAFT", title: "Other", variants: [{ id: "vb", sku: "mk2223", price: "2.00", compareAtPrice: null, inventoryItemId: "ib", inventoryQuantity: 2 }] });
  assert.equal(indexShopify([draft, active]).match("mk2223", null)?.p.id, "A");
  // Two DRAFTs and no ACTIVE has no winner — fail closed rather than guess.
  const d2 = prod({ id: "C", status: "DRAFT", title: "Third", variants: [{ id: "vc", sku: "mk2223", price: "3.00", compareAtPrice: null, inventoryItemId: "ic", inventoryQuantity: 3 }] });
  assert.equal(indexShopify([draft, d2]).match("mk2223", null), undefined);
});

// ── 5. title fallback: ACTIVE + ARCHIVED same title → ACTIVE ─────────────────
test("5. title fallback skips the archived twin and returns the ACTIVE one", () => {
  const title = "Cherry Bag Charm – Gold & Red";
  const live = prod({ id: "LIVE", status: "ACTIVE", title, variants: [{ id: "v1", sku: "", price: "48.00", compareAtPrice: null, inventoryItemId: "i1", inventoryQuantity: 1 }] });
  const shell = prod({ id: "SHELL", status: "ARCHIVED", title, variants: [{ id: "v2", sku: "", price: "48.00", compareAtPrice: null, inventoryItemId: "i2", inventoryQuantity: 1 }] });
  assert.equal(indexShopify([shell, live]).match(null, title)?.p.id, "LIVE");
});

// ── 6. two eligible products share a title → ambiguous, fail closed ──────────
test("6. two eligible products on one title fail closed", () => {
  const title = "Eye & Lips Massager – White";
  const a = prod({ id: "A", status: "ACTIVE", title, variants: [{ id: "v1", sku: "", price: "38.00", compareAtPrice: null, inventoryItemId: "i1", inventoryQuantity: 1 }] });
  const b = prod({ id: "B", status: "ACTIVE", title, variants: [{ id: "v2", sku: "", price: "38.00", compareAtPrice: null, inventoryItemId: "i2", inventoryQuantity: 1 }] });
  const idx = indexShopify([a, b]);
  assert.equal(idx.match(null, title), undefined);
  assert.deepEqual([...idx.blockedTitles.values()], ["AMBIGUOUS"]);
  assert.equal(idx.byTitle.size, 0, "neither claimant may be resolvable by title");
});

// ── 7. the inventory resolver never returns an ARCHIVED parent's item ────────
test("7. inventory planner never targets an archived product's inventory item", () => {
  for (const sku of FIRST_WAVE) {
    const { live, shell } = livePair(sku);
    const plan = planInventorySync([{ id: `p-${sku}`, sku, name_en: null, stock: 0 }], [shell, live]);
    assert.equal(plan.matched, 1);
    assert.equal(plan.changes.length, 1);
    assert.equal(plan.changes[0]!.inventoryItemId, `ii-live-${sku}`, `${sku} must not be written to the shell`);
  }
});

test("7b. archived-only SKU is reported unmatched — no inventory write is planned", () => {
  const { shell } = livePair("mk2224");
  const plan = planInventorySync([{ id: "p1", sku: "mk2224", name_en: null, stock: 3 }], [shell]);
  assert.equal(plan.matched, 0);
  assert.equal(plan.unmatched, 1);
  assert.deepEqual(plan.changes, []);
});

test("7c. the stock push surfaces archived_only / ambiguous_sku and writes nothing", async () => {
  const calls: string[] = [];
  const deps = (reason: "archived_only" | "ambiguous"): ShopifyStockPushDeps => ({
    configured: () => true,
    resolveLocationId: async () => ({ locationId: "loc" }),
    resolveInventoryItemId: async () => ({ inventoryItemId: "", reason }),
    setQuantity: async () => { calls.push("write"); return { ok: true }; },
  });
  const a = await syncStockBySku([{ sku: "mk2219", quantity: 0 }], deps("archived_only"));
  assert.deepEqual(a.perItem[0]!.result, { synced: false, reason: "archived_only" });
  const b = await syncStockBySku([{ sku: "mk2219", quantity: 0 }], deps("ambiguous"));
  assert.deepEqual(b.perItem[0]!.result, { synced: false, reason: "ambiguous_sku" });
  assert.equal(a.pushed + b.pushed, 0);
  assert.deepEqual(calls, [], "no quantity may be written when nothing operational resolved");
});

test("7d. resolveInventoryItemIdBySku reads parent status, never uses first:1, re-asserts the SKU", () => {
  const src = code("./admin.ts");
  const fn = src.slice(src.indexOf("export async function resolveInventoryItemIdBySku"));
  const body = fn.slice(0, fn.indexOf("export async function pushInventoryStockToShopify"));
  assert.match(body, /productVariants\(first:\s*100/, "must fetch many candidates");
  assert.equal(/productVariants\(first:\s*1[,)\s]/.test(body), false, "first:1 SKU lookup is banned");
  assert.match(body, /product \{ id status \}/, "must read the PARENT product status");
  assert.match(body, /selectOperational\(/, "must go through the central eligibility rule");
  assert.match(body, /reason:\s*"ambiguous"/, "must fail closed on ambiguity");
});

// ── 8. no automatic ARCHIVED → ACTIVE status plan ────────────────────────────
test("8. a retired shell is never planned back to ACTIVE", () => {
  const { shell } = livePair("mk2220");
  // Even if the archived product is somehow the only candidate, no status change.
  const d = diffShopify([our({ sku: "mk2220", approval: "Approved" })], [shell]);
  const anyStatusPlan = d.updated.flatMap((u) => u.changes).filter((c) => c.field === "status");
  assert.deepEqual(anyStatusPlan, [], "no status change may be planned against an archived product");
  assert.equal(d.counts.matched, 0, "an archived-only SKU is not an operational match");

  // And a live DRAFT is still planned to ACTIVE — the guard is archived-only.
  const draft = prod({ id: "D", status: "DRAFT", variants: [{ id: "v", sku: "mk2220", price: "79.00", compareAtPrice: null, inventoryItemId: "i", inventoryQuantity: 1 }] });
  const d2 = diffShopify([our({ sku: "mk2220", approval: "Approved", price: 79 })], [draft]);
  assert.ok(
    d2.updated.some((u) => u.changes.some((c) => c.field === "status" && c.new === "ACTIVE")),
    "normal DRAFT → ACTIVE planning must still work",
  );
});

test("8b. archived products stay visible to reporting (onlyShopify), not hidden", () => {
  const { live, shell } = livePair("mk2218");
  const d = diffShopify([our({ sku: "mk2218", price: 79 })], [live, shell]);
  const ids = d.onlyShopify.map((p) => p.shopify_id);
  assert.ok(ids.includes(shell.id), "the archived shell must still be reported to admins");
  assert.equal(d.onlyShopify.find((p) => p.shopify_id === shell.id)?.status, "ARCHIVED");
});

// ── 9. preview: an archived shell alone must not raise IDENTITY_CONFLICT ─────
test("9. preview builds its SKU index from operational products only", () => {
  const src = code("../export/shopify/preview.ts");
  // The call may carry an explicit type argument — match with or without one.
  assert.match(src, /buildOperationalIndex(<[^>]*>)?\(/, "SKU ownership must come from the operational index");
  assert.equal(
    /if \(sk !== "" && !liveVariantBySku\.has\(sk\)\)/.test(src),
    false,
    "the old first-wins SKU index must be gone",
  );
  // GID-keyed lookups stay historical so an archived-but-mapped product resolves.
  assert.match(src, /liveByGid\.set\(lp\.id, lp\)/);
  // A genuine two-live-owner collision is still reported as a conflict.
  assert.match(src, /reason !== "AMBIGUOUS"/);
});

// ── 10. catalog-v2 ambiguous-SKU fail-safe is untouched ──────────────────────
test("10. catalog-v2 ambiguous-SKU safety behaviour is preserved", () => {
  const src = code("../catalog-v2/shopify-catalog-view.ts");
  assert.match(src, /grp\.length > 1\) return ambiguous\(MATCH_REASON\.ambiguous_sku\)/);
  assert.match(src, /grp\.length === 1\) return matched\(grp\[0\]!, "matched_sku"/);
});

// ── 11. the rule itself ──────────────────────────────────────────────────────
test("11. isOperationalShopifyProduct: ARCHIVED out, ACTIVE/DRAFT in, case/space tolerant", () => {
  assert.equal(isOperationalShopifyProduct({ status: "ACTIVE" }), true);
  assert.equal(isOperationalShopifyProduct({ status: "DRAFT" }), true);
  assert.equal(isOperationalShopifyProduct({ status: "ARCHIVED" }), false);
  assert.equal(isOperationalShopifyProduct({ status: " archived " }), false);
  assert.equal(isOperationalShopifyProduct({ status: null }), true, "unknown status is not a retirement signal");
  assert.equal(isOperationalShopifyProduct(null), false);
  assert.equal(isOperationalShopifyStatus("Archived"), false);
  assert.equal(normalizeShopifyStatus(" active "), "ACTIVE");
});

test("12. selectOperational counts the same product once, and reports NONE vs ARCHIVED_ONLY", () => {
  // Same product seen twice (two variants of one product) is NOT ambiguity.
  const dup = selectOperational(
    [{ status: "ACTIVE", id: "P" }, { status: "ACTIVE", id: "P" }],
    (c) => c.id,
  );
  assert.equal(dup.ok, true);
  assert.equal(dup.ok && dup.match.id, "P");

  const none = selectOperational([] as { status: string; id: string }[], (c) => c.id);
  assert.equal(none.ok, false);
  assert.equal(none.reason, "NONE");
});

test("13. buildOperationalIndex omits blocked keys from `resolved` (callers fail closed)", () => {
  const rows = [
    { status: "ACTIVE", id: "A", keys: ["ok"] },
    { status: "ACTIVE", id: "B", keys: ["dup"] },
    { status: "ACTIVE", id: "C", keys: ["dup"] },
    { status: "ARCHIVED", id: "D", keys: ["retired"] },
  ];
  const { resolved, blocked } = buildOperationalIndex(rows, (r) => r.keys, (r) => r.id);
  assert.equal(resolved.get("ok")?.id, "A");
  assert.equal(resolved.has("dup"), false);
  assert.equal(resolved.has("retired"), false);
  assert.equal(blocked.get("dup"), "AMBIGUOUS");
  assert.equal(blocked.get("retired"), "ARCHIVED_ONLY");
});

// ── 14. no first-wins SKU/title matcher may come back ────────────────────────
test("14. the retired first-wins matchers are gone from every operational path", () => {
  const diff = code("../shopify-diff.ts");
  assert.equal(/if \(k && !bySku\.has\(k\)\) bySku\.set/.test(diff), false, "old first-wins SKU index");
  assert.equal(/if \(!byTitle\.has\(normTitle\(p\.title\)\)\)/.test(diff), false, "old first-wins title index");
  assert.match(diff, /buildOperationalIndex(<[^>]*>)?\(/);
  assert.match(diff, /liveStatus !== SHOPIFY_ARCHIVED_STATUS/);

  const adapter = code("../../app/(app)/import-export/shopify-adapter.server.ts");
  assert.equal(/bySku\.set\(String\(v\.sku\)\.toLowerCase\(\), p\.id\)/.test(adapter), false, "old last-wins unpublish map");
  assert.match(adapter, /indexShopify\(/, "unpublish must use the operational matcher");

  const actions = code("../../app/(app)/import-export/shopify-actions.ts");
  assert.match(actions, /isOperationalShopifyProduct\(sp\)/, "missing-image push must skip archived products");
});
