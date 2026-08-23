// SHOPIFY.VARIANT.REPAIR tests (pure — injected ports, no network, no DB).
// Run: node --conditions=react-server --experimental-strip-types --test lib/export/shopify/variant-repair.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_TITLE,
  effectiveVariantPrice,
  planVariantRepair,
  runVariantRepair,
  verifyRepairResult,
  type RepairInternalProduct,
  type RepairLiveProduct,
  type RepairLiveVariant,
  type VariantRepairPorts,
} from "./variant-repair.ts";

const GID = "gid://shopify/Product/9";

function internal(over: Partial<RepairInternalProduct> = {}): RepairInternalProduct {
  return {
    id: "p1",
    sku: "mk1597",
    price: 18,
    discountPrice: null,
    variants: [
      { id: "v1", name: "1 piece", sku: "mk1597-1", barcode: "6549277731086", price: 15 },
      { id: "v2", name: "3 pieces", sku: "mk1597-2", barcode: "6549277731087", price: 48 },
    ],
    ...over,
  };
}
function defaultOnly(): RepairLiveProduct {
  return {
    id: GID,
    hasOnlyDefaultVariant: true,
    variants: [{ id: "gid://shopify/ProductVariant/1", sku: "mk1597", barcode: "", title: DEFAULT_TITLE }],
  };
}
function liveWith(variants: RepairLiveVariant[], hasOnlyDefaultVariant = false): RepairLiveProduct {
  return { id: GID, hasOnlyDefaultVariant, variants };
}

// ── planning ─────────────────────────────────────────────────────────────────

test("plan: hasOnlyDefaultVariant=true + exactly one Default Title + complete internal variants → READY", () => {
  const plan = planVariantRepair(internal(), GID, defaultOnly());
  assert.equal(plan.status, "READY");
  assert.equal(plan.strategy, "REMOVE_STANDALONE_VARIANT");
  assert.equal(plan.standaloneVariantGid, "gid://shopify/ProductVariant/1");
  assert.deepEqual(plan.creates, [
    { internalVariantId: "v1", name: "1 piece", sku: "mk1597-1", barcode: "6549277731086", price: "15.00" },
    { internalVariantId: "v2", name: "3 pieces", sku: "mk1597-2", barcode: "6549277731087", price: "48.00" },
  ]);
});

test("plan: variant without explicit price inherits the parent EFFECTIVE price (discount ?? price)", () => {
  const p = internal({
    price: 239,
    discountPrice: 199,
    variants: [{ id: "v1", name: "iPhone 17", sku: "mk2229-1", barcode: "170310556834", price: null }],
  });
  const plan = planVariantRepair(p, GID, defaultOnly());
  assert.equal(plan.status, "READY");
  assert.equal(plan.creates[0]!.price, "199.00", "parent discountPrice wins over price");
  assert.equal(effectiveVariantPrice(p.variants[0]!, p), 199);
});

test("plan: missing price / sku / barcode / name each BLOCK (fail closed)", () => {
  const cases: [Partial<RepairInternalProduct["variants"][number]>, string][] = [
    [{ price: null }, "missing_price"],
    [{ sku: null }, "missing_sku"],
    [{ barcode: "  " }, "missing_barcode"],
    [{ name: "" }, "missing_name"],
  ];
  for (const [over, reason] of cases) {
    const p = internal({
      price: null, // no parent fallback for the price case
      variants: [{ id: "v1", name: "X", sku: "S1", barcode: "111111", price: 5, ...over }],
    });
    const plan = planVariantRepair(p, GID, defaultOnly());
    assert.equal(plan.status, "BLOCKED", reason);
    assert.ok(plan.reasons.includes(reason as never), `${reason} in ${plan.reasons}`);
    assert.deepEqual(plan.creates, [], "a blocked plan never carries creates");
  }
});

test("plan: duplicate SKU and duplicate barcode BLOCK", () => {
  const dupSku = planVariantRepair(
    internal({ variants: [
      { id: "v1", name: "A", sku: "SAME", barcode: "111111", price: 5 },
      { id: "v2", name: "B", sku: "same", barcode: "222222", price: 6 },
    ] }),
    GID,
    defaultOnly(),
  );
  assert.equal(dupSku.status, "BLOCKED");
  assert.ok(dupSku.reasons.includes("duplicate_sku"));

  const dupBarcode = planVariantRepair(
    internal({ variants: [
      { id: "v1", name: "A", sku: "S1", barcode: "111111", price: 5 },
      { id: "v2", name: "B", sku: "S2", barcode: "111111", price: 6 },
    ] }),
    GID,
    defaultOnly(),
  );
  assert.equal(dupBarcode.status, "BLOCKED");
  assert.ok(dupBarcode.reasons.includes("duplicate_barcode"));
});

test("plan: duplicate variant NAME (trim + case-insensitive) BLOCKS as duplicate_name", () => {
  // Real production case (mk1822 — Rhode Hailey Lip Balm Holder Iphone Case):
  // two internal variants share the option-value name "iPhone 17 Pro Max" with
  // distinct SKUs and barcodes. A single Shopify "Title" option cannot safely
  // represent both — the product must stay BLOCKED until the catalog is fixed.
  const mk1822 = planVariantRepair(
    internal({ variants: [
      { id: "v1", name: "iPhone 17 Pro Max", sku: "mk1822-2-iphone-17-pro-max", barcode: "7748513686251-2", price: 5 },
      { id: "v2", name: "iPhone 17 Pro Max", sku: "mk1822-3-iphone-17-pro-max", barcode: "7748513686251-3", price: 5 },
    ] }),
    GID,
    defaultOnly(),
  );
  assert.equal(mk1822.status, "BLOCKED");
  assert.deepEqual(mk1822.reasons, ["duplicate_name"], "precise single reason — SKUs and barcodes are distinct");
  assert.deepEqual(mk1822.creates, [], "never plans a create for an ambiguous option value");

  const caseInsensitive = planVariantRepair(
    internal({ variants: [
      { id: "v1", name: "iPhone 17 Pro Max", sku: "S1", barcode: "111111", price: 5 },
      { id: "v2", name: "  iphone 17 pro max  ", sku: "S2", barcode: "222222", price: 5 },
    ] }),
    GID,
    defaultOnly(),
  );
  assert.equal(caseInsensitive.status, "BLOCKED");
  assert.ok(caseInsensitive.reasons.includes("duplicate_name"), "normalized trim + case-insensitive comparison");
});

test("plan: one variant titled Default Title but hasOnlyDefaultVariant=false → BLOCKED (never trust title alone)", () => {
  const flagDisagrees = planVariantRepair(
    internal(),
    GID,
    liveWith([{ id: "gd", sku: "mk1597", barcode: "", title: DEFAULT_TITLE }], false),
  );
  assert.equal(flagDisagrees.status, "BLOCKED");
  assert.deepEqual(flagDisagrees.reasons, ["not_standalone_default"]);
  assert.equal(flagDisagrees.standaloneVariantGid, null, "no destructive target on contradictory evidence");

  // The contradiction in the other direction is just as blocked.
  const titleDisagrees = planVariantRepair(
    internal(),
    GID,
    liveWith([{ id: "g1", sku: "other", barcode: "", title: "Red" }], true),
  );
  assert.equal(titleDisagrees.status, "BLOCKED");
  assert.deepEqual(titleDisagrees.reasons, ["not_standalone_default"]);
});

test("plan: missing GID and empty internal variants BLOCK", () => {
  assert.equal(planVariantRepair(internal(), null, defaultOnly()).reasons[0], "no_product_gid");
  assert.equal(planVariantRepair(internal({ variants: [] }), GID, defaultOnly()).reasons[0], "no_internal_variants");
});

test("plan: unexpected live state (multi-variant, or single NON-default) BLOCKS", () => {
  const multi = planVariantRepair(internal(), GID, liveWith([
    { id: "g1", sku: "other-1", barcode: "", title: "Red" },
    { id: "g2", sku: "other-2", barcode: "", title: "Blue" },
  ]));
  assert.equal(multi.status, "BLOCKED");
  assert.ok(multi.reasons.includes("unexpected_live_state"));

  const singleReal = planVariantRepair(internal(), GID, liveWith([
    { id: "g1", sku: "not-planned", barcode: "", title: "Red" },
  ]));
  assert.equal(singleReal.status, "BLOCKED");
});

test("plan: PARTIAL earlier run (some planned SKUs live) BLOCKS as partial_live_state", () => {
  const plan = planVariantRepair(internal(), GID, liveWith([
    { id: "g1", sku: "mk1597-1", barcode: "6549277731086", title: "1 piece" },
    { id: "gd", sku: "mk1597", barcode: "", title: DEFAULT_TITLE },
  ]));
  assert.equal(plan.status, "BLOCKED");
  assert.ok(plan.reasons.includes("partial_live_state"));
});

// ── idempotency ──────────────────────────────────────────────────────────────

test("plan: exact planned set already live (no default, no extras) → ALREADY_DONE with eclWrites", () => {
  const plan = planVariantRepair(internal(), GID, liveWith([
    { id: "gA", sku: "mk1597-1", barcode: "6549277731086", title: "1 piece" },
    { id: "gB", sku: "MK1597-2", barcode: "6549277731087", title: "3 pieces" },
  ]));
  assert.equal(plan.status, "ALREADY_DONE");
  assert.deepEqual(plan.creates, [], "no mutation on a converged product");
  assert.deepEqual(plan.eclWrites.map((w) => [w.internalVariantId, w.variantGid]), [["v1", "gA"], ["v2", "gB"]]);
});

test("plan: SKU set matches but a BARCODE differs → NOT ALREADY_DONE, BLOCKED, zero eclWrites", () => {
  const plan = planVariantRepair(internal(), GID, liveWith([
    { id: "gA", sku: "mk1597-1", barcode: "WRONG-BARCODE", title: "1 piece" },
    { id: "gB", sku: "mk1597-2", barcode: "6549277731087", title: "3 pieces" },
  ]));
  assert.equal(plan.status, "BLOCKED");
  assert.deepEqual(plan.reasons, ["live_barcode_mismatch"]);
  assert.deepEqual(plan.eclWrites, [], "identity is NEVER persisted from a mismatched live state");
});

test("plan: SKU set matches but a NAME/title differs → NOT ALREADY_DONE, BLOCKED, zero eclWrites", () => {
  const plan = planVariantRepair(internal(), GID, liveWith([
    { id: "gA", sku: "mk1597-1", barcode: "6549277731086", title: "Wrong Name" },
    { id: "gB", sku: "mk1597-2", barcode: "6549277731087", title: "3 pieces" },
  ]));
  assert.equal(plan.status, "BLOCKED");
  assert.deepEqual(plan.reasons, ["live_name_mismatch"]);
  assert.deepEqual(plan.eclWrites, []);
});

// ── verify (Default Title replacement + ambiguity) ───────────────────────────

test("verify: all planned SKUs present exactly once, default gone → VERIFIED with per-variant GIDs", () => {
  const plan = planVariantRepair(internal(), GID, defaultOnly());
  const verdict = verifyRepairResult(plan, [
    { id: "gA", sku: "mk1597-1", barcode: "6549277731086", title: "1 piece" },
    { id: "gB", sku: "mk1597-2", barcode: "6549277731087", title: "3 pieces" },
  ]);
  assert.equal(verdict.status, "VERIFIED");
  assert.ok(verdict.status === "VERIFIED");
  assert.deepEqual(verdict.eclWrites.map((w) => w.variantGid), ["gA", "gB"]);
});

test("verify: Default Title still present / missing SKU / duplicate SKU → NEEDS_RECONCILIATION", () => {
  const plan = planVariantRepair(internal(), GID, defaultOnly());
  const stillDefault = verifyRepairResult(plan, [
    { id: "gd", sku: "mk1597", barcode: "", title: DEFAULT_TITLE },
    { id: "gA", sku: "mk1597-1", barcode: "", title: "1 piece" },
    { id: "gB", sku: "mk1597-2", barcode: "", title: "3 pieces" },
  ]);
  assert.equal(stillDefault.status, "NEEDS_RECONCILIATION");

  const missing = verifyRepairResult(plan, [{ id: "gA", sku: "mk1597-1", barcode: "", title: "1 piece" }]);
  assert.equal(missing.status, "NEEDS_RECONCILIATION");

  const dup = verifyRepairResult(plan, [
    { id: "gA", sku: "mk1597-1", barcode: "", title: "1 piece" },
    { id: "gA2", sku: "mk1597-1", barcode: "", title: "1 piece b" },
    { id: "gB", sku: "mk1597-2", barcode: "", title: "3 pieces" },
  ]);
  assert.equal(dup.status, "NEEDS_RECONCILIATION");
});

test("verify: correct SKU but WRONG BARCODE fails verification — zero eclWrites", () => {
  const plan = planVariantRepair(internal(), GID, defaultOnly());
  const verdict = verifyRepairResult(plan, [
    { id: "gA", sku: "mk1597-1", barcode: "WRONG-BARCODE", title: "1 piece" },
    { id: "gB", sku: "mk1597-2", barcode: "6549277731087", title: "3 pieces" },
  ]);
  assert.equal(verdict.status, "NEEDS_RECONCILIATION");
  assert.ok(verdict.status === "NEEDS_RECONCILIATION");
  assert.deepEqual(verdict.reasons, ["barcode_mismatch:mk1597-1"], "precise per-variant reason");
});

test("verify: correct SKU but WRONG NAME/title fails verification — zero eclWrites", () => {
  const plan = planVariantRepair(internal(), GID, defaultOnly());
  const verdict = verifyRepairResult(plan, [
    { id: "gA", sku: "mk1597-1", barcode: "6549277731086", title: "Wrong Name" },
    { id: "gB", sku: "mk1597-2", barcode: "6549277731087", title: "3 pieces" },
  ]);
  assert.equal(verdict.status, "NEEDS_RECONCILIATION");
  assert.ok(verdict.status === "NEEDS_RECONCILIATION");
  assert.deepEqual(verdict.reasons, ["name_mismatch:mk1597-1"]);
});

// ── execution through injected ports ─────────────────────────────────────────

interface PortLog { createCalls: number; eclCalls: { variantId: string; gid: string }[] }
function makePorts(over: Partial<VariantRepairPorts> = {}): { ports: VariantRepairPorts; log: PortLog } {
  const log: PortLog = { createCalls: 0, eclCalls: [] };
  const ports: VariantRepairPorts = {
    loadInternal: async () => internal(),
    loadProductGid: async () => ({ gid: GID, ambiguous: false }),
    readLive: async () => defaultOnly(),
    createVariants: async () => {
      log.createCalls++;
      return { ok: true };
    },
    rereadLive: async () => [
      { id: "gA", sku: "mk1597-1", barcode: "6549277731086", title: "1 piece" },
      { id: "gB", sku: "mk1597-2", barcode: "6549277731087", title: "3 pieces" },
    ],
    persistEcl: async (_p, _g, w) => {
      log.eclCalls.push({ variantId: w.internalVariantId, gid: w.variantGid });
      return { ok: true };
    },
    ...over,
  };
  return { ports, log };
}

test("execution: create succeeds → reread verified → ECL persisted per variant → REPAIRED", async () => {
  const { ports, log } = makePorts();
  const r = await runVariantRepair(ports, "p1");
  assert.equal(r.outcome, "REPAIRED");
  assert.equal(r.createdCount, 2);
  assert.equal(log.createCalls, 1, "exactly ONE mutation");
  assert.deepEqual(log.eclCalls, [
    { variantId: "v1", gid: "gA" },
    { variantId: "v2", gid: "gB" },
  ]);
  assert.equal(r.eclPersisted, 2);
});

test("execution: mutation failure (userErrors / partial result) → FAILED, ZERO identity writes", async () => {
  const { ports, log } = makePorts({ createVariants: async () => ({ ok: false, error: "boom" }) });
  const r = await runVariantRepair(ports, "p1");
  assert.equal(r.outcome, "FAILED");
  assert.deepEqual(log.eclCalls, [], "never persist identity after a failed mutation");
});

test("execution: reread mismatch after mutation → NEEDS_RECONCILIATION, ZERO identity writes", async () => {
  const { ports, log } = makePorts({
    rereadLive: async () => [{ id: "gA", sku: "mk1597-1", barcode: "", title: "1 piece" }], // one missing
  });
  const r = await runVariantRepair(ports, "p1");
  assert.equal(r.outcome, "NEEDS_RECONCILIATION");
  assert.deepEqual(log.eclCalls, []);
});

test("execution: ECL persistence failure after a verified mutation → NEEDS_RECONCILIATION (never silent)", async () => {
  const { ports } = makePorts({ persistEcl: async () => ({ ok: false }) });
  const r = await runVariantRepair(ports, "p1");
  assert.equal(r.outcome, "NEEDS_RECONCILIATION");
  assert.equal(r.eclFailed, 2);
});

test("idempotency: second run over a converged product makes NO mutation, only ECL persistence", async () => {
  const { ports, log } = makePorts({
    readLive: async () => liveWith([
      { id: "gA", sku: "mk1597-1", barcode: "6549277731086", title: "1 piece" },
      { id: "gB", sku: "mk1597-2", barcode: "6549277731087", title: "3 pieces" },
    ]),
  });
  const r = await runVariantRepair(ports, "p1");
  assert.equal(r.outcome, "ALREADY_DONE");
  assert.equal(log.createCalls, 0, "no second mutation ever");
  assert.equal(r.eclPersisted, 2, "identity persistence is idempotent and still runs");
});

test("execution: reread with SKU match but wrong BARCODE → NEEDS_RECONCILIATION, ZERO identity writes", async () => {
  const { ports, log } = makePorts({
    rereadLive: async () => [
      { id: "gA", sku: "mk1597-1", barcode: "WRONG-BARCODE", title: "1 piece" },
      { id: "gB", sku: "mk1597-2", barcode: "6549277731087", title: "3 pieces" },
    ],
  });
  const r = await runVariantRepair(ports, "p1");
  assert.equal(r.outcome, "NEEDS_RECONCILIATION");
  assert.ok(r.reasons.includes("barcode_mismatch:mk1597-1"));
  assert.deepEqual(log.eclCalls, [], "a barcode mismatch persists NOTHING");
});

test("execution: reread with SKU match but wrong NAME → NEEDS_RECONCILIATION, ZERO identity writes", async () => {
  const { ports, log } = makePorts({
    rereadLive: async () => [
      { id: "gA", sku: "mk1597-1", barcode: "6549277731086", title: "Wrong Name" },
      { id: "gB", sku: "mk1597-2", barcode: "6549277731087", title: "3 pieces" },
    ],
  });
  const r = await runVariantRepair(ports, "p1");
  assert.equal(r.outcome, "NEEDS_RECONCILIATION");
  assert.ok(r.reasons.includes("name_mismatch:mk1597-1"));
  assert.deepEqual(log.eclCalls, [], "a name mismatch persists NOTHING");
});

test("execution: would-be ALREADY_DONE live state with wrong barcode/name → BLOCKED, no mutation, ZERO ECL", async () => {
  const wrongBarcode = makePorts({
    readLive: async () => liveWith([
      { id: "gA", sku: "mk1597-1", barcode: "WRONG-BARCODE", title: "1 piece" },
      { id: "gB", sku: "mk1597-2", barcode: "6549277731087", title: "3 pieces" },
    ]),
  });
  const r1 = await runVariantRepair(wrongBarcode.ports, "p1");
  assert.equal(r1.outcome, "BLOCKED");
  assert.deepEqual(r1.reasons, ["live_barcode_mismatch"]);
  assert.equal(wrongBarcode.log.createCalls, 0);
  assert.deepEqual(wrongBarcode.log.eclCalls, []);

  const wrongName = makePorts({
    readLive: async () => liveWith([
      { id: "gA", sku: "mk1597-1", barcode: "6549277731086", title: "Wrong Name" },
      { id: "gB", sku: "mk1597-2", barcode: "6549277731087", title: "3 pieces" },
    ]),
  });
  const r2 = await runVariantRepair(wrongName.ports, "p1");
  assert.equal(r2.outcome, "BLOCKED");
  assert.deepEqual(r2.reasons, ["live_name_mismatch"]);
  assert.equal(wrongName.log.createCalls, 0);
  assert.deepEqual(wrongName.log.eclCalls, []);
});

test("execution: ambiguous product mapping → BLOCKED before any read/write", async () => {
  const { ports, log } = makePorts({ loadProductGid: async () => ({ gid: null, ambiguous: true }) });
  const r = await runVariantRepair(ports, "p1");
  assert.equal(r.outcome, "BLOCKED");
  assert.deepEqual(r.reasons, ["ambiguous_mapping"]);
  assert.equal(log.createCalls, 0);
});

// ── source pins (the server side keeps the safety contract) ──────────────────

const ROOT = process.cwd();
const src = (rel: string): string =>
  readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("admin: the bulk-create mutation uses REMOVE_STANDALONE_VARIANT and writes NO inventory quantity", () => {
  const admin = src("lib/shopify/admin.ts");
  assert.ok(admin.includes("strategy: REMOVE_STANDALONE_VARIANT"), "the canonical safe strategy");
  const start = admin.indexOf("export async function createProductVariantsBulk");
  const body = admin.slice(start, admin.indexOf("export async function", start + 10));
  assert.ok(!body.includes("inventorySetQuantities") && !body.includes("quantities"), "no quantity write in the repair path");
  assert.ok(body.includes("tracked: true"), "inventoryItem carries sku + tracked only");

  const fetchStart = admin.indexOf("export async function fetchShopifyProductVariants");
  const fetchBody = admin.slice(fetchStart, admin.indexOf("export async function", fetchStart + 10));
  assert.ok(fetchBody.includes("hasOnlyDefaultVariant"), "the reread fetches Shopify's own standalone-default flag");
});

test("server binder: writer gate BEFORE any work; single mutation port; certified ECL boundary", () => {
  const server = src("lib/export/shopify/variant-repair.server.ts");
  const gate = server.indexOf("requireWriterGate()");
  const work = server.indexOf("createAdminClient()");
  assert.ok(gate >= 0 && work > gate, "gate first");
  assert.ok(server.includes("createProductVariantsBulk"), "the ONE Shopify write");
  assert.ok(server.includes("writeEclMapping"), "identity through the certified ECL boundary");
  for (const token of ["updateVariantPrice", "inventorySetQuantities", "productUpdate", "productCreateMedia"]) {
    assert.ok(!server.includes(token), `repair never touches ${token}`);
  }
});
