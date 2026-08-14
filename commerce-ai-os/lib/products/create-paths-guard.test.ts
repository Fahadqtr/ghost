// P2 — create-path characterization guard. Enumerates EVERY runtime site that
// inserts a `products` row and pins each one's current behavior, so that:
//   • a new ad-hoc `products.insert` path cannot appear unnoticed (the enumerated
//     set must exactly match the classified registry below), and
//   • the later convergence PRs (P3+) have a documented, test-locked baseline.
//
// This guard pins CURRENT behavior — it does not assert the desired end state.
// When a path is intentionally migrated in a later PR, its entry here is updated
// in the same PR, which is the visible record that the change was deliberate.
//
// The eight conceptual create paths map onto SEVEN physical insert sites (V2
// Create and V2 Import both route through the one core insert):
//   1. V2 Create      → lib/products/product-create.ts  (createProductCore)   CANONICAL
//   2. V2 Import      → lib/products/product-create.ts  (createProductCore)   CANONICAL
//   3. Malak commit   → app/api/malak/commit/route.ts                          ADAPTER CANDIDATE
//   4. Staff add      → app/staff/actions.ts                                   ADAPTER CANDIDATE
//   5. Shopify import → app/(app)/import-export/shopify-actions.ts             ADAPTER CANDIDATE
//   6. Snoonu import  → app/(app)/import-export/snoonu-actions.ts              ADAPTER CANDIDATE (batch)
//   7. Pure Seoul imp → app/(app)/import-export/pure-seoul-actions.ts          ADAPTER CANDIDATE (batch)
//   8. Archive restore→ app/(app)/products/archive/actions.ts                  EXEMPT (restore, not create)
//
// PURE — no DB, no network, no React. Source scan only.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/create-paths-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function runtimeFiles(dirs: readonly string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    for (const entry of readdirSync(join(ROOT, dir), { recursive: true })) {
      const rel = join(dir, String(entry));
      if (!/\.(ts|tsx)$/.test(rel) || /\.test\.(ts|tsx)$/.test(rel)) continue;
      if (!statSync(join(ROOT, rel)).isFile()) continue;
      out.push(rel);
    }
  }
  return out;
}

/** Matches a `.from("products").insert(` write, tolerating the newline the core
 *  puts between `.from(...)` and `.insert(`. */
const PRODUCTS_INSERT = /\.from\(\s*["']products["']\s*\)\s*\.insert\b/;

type Classification = "canonical" | "adapter-candidate" | "exempt";

interface PathEntry {
  file: string;
  label: string;
  classification: Classification;
  client: "agnostic" | "session" | "admin";
  seed: "inventorySeed" | "inline-partial" | "snapshot" | "none";
  variants: "batch-stamped" | "per-row-loop" | "verbatim" | "none";
  rollback: boolean;
  note: string;
}

// The authoritative registry of product-INSERT sites. Every runtime file that
// inserts a `products` row MUST appear here. Adding a new create path without a
// registry entry fails the enumeration test below.
const REGISTRY: PathEntry[] = [
  {
    file: "lib/products/product-create.ts",
    label: "createProductCore (V2 Create + V2 Import)",
    classification: "canonical",
    client: "agnostic", // caller injects a session client
    seed: "inventorySeed",
    variants: "batch-stamped",
    rollback: true,
    note: "The shared spine. Session client by contract; compensating rollback + 23505 detection.",
  },
  {
    file: "app/api/malak/commit/route.ts",
    label: "Malak AI commit",
    classification: "adapter-candidate",
    client: "admin",
    seed: "inventorySeed", // P1-adopted (was byte-identical)
    variants: "none",
    rollback: false,
    note: "Admin client + signed token. No barcode, no rollback (inventory insert unchecked).",
  },
  {
    file: "app/staff/actions.ts",
    label: "Staff add product",
    classification: "adapter-candidate",
    client: "admin",
    seed: "inventorySeed", // P3-adopted (was inline-partial; low_stock_threshold came from DB default 5)
    variants: "per-row-loop",
    rollback: false,
    note: "Admin client. Own SKU (nextStaffSku) + 200-prefix barcodes; per-variant tolerance; gallery.",
  },
  {
    file: "app/(app)/import-export/shopify-actions.ts",
    label: "Shopify import",
    classification: "adapter-candidate",
    client: "admin",
    seed: "inventorySeed", // P3-adopted (was {product_id, stock_quantity}; threshold+sold came from DB defaults 5/0)
    variants: "none",
    rollback: false,
    note: "Admin client, per-row loop. Uses Shopify's SKU; app-side sku/title dedup; inventory swallowed.",
  },
  {
    file: "app/(app)/import-export/snoonu-actions.ts",
    label: "Snoonu import",
    classification: "adapter-candidate",
    client: "admin",
    seed: "inventorySeed", // P1-adopted (was byte-identical)
    variants: "none",
    rollback: false,
    note: "Admin client, BATCH-200. Own mk#### SKU + 29-prefix EAN-13; stamps snoonu_id; app dedup.",
  },
  {
    file: "app/(app)/import-export/pure-seoul-actions.ts",
    label: "Pure Seoul import",
    classification: "adapter-candidate",
    client: "admin",
    seed: "inventorySeed", // P1-adopted (was byte-identical)
    variants: "none",
    rollback: false,
    note: "Admin client, BATCH-200. Own SKU/barcode; stamps pure_seoul_id; fuzzy-name dedup.",
  },
  {
    file: "app/(app)/products/archive/actions.ts",
    label: "Archive restore",
    classification: "exempt",
    client: "admin",
    seed: "snapshot", // re-inserts the archived inventory rows verbatim
    variants: "verbatim",
    rollback: false,
    note: "EXEMPT — restore semantics, not create. Resurrects the ORIGINAL id/sku/barcode/inventory/" +
      "variants/channel_products from a product_archive snapshot. Minting a fresh product (new id, " +
      "zero seed, re-stamped parents) would destroy restore fidelity, so it must NOT use createProductCore.",
  },
];

// ── 1. Enumeration: the set of products.insert sites == the registry ──────────

test("every runtime products.insert site is a classified create path (no new ad-hoc path)", () => {
  const found = runtimeFiles(["app", "lib"]).filter((rel) => PRODUCTS_INSERT.test(read(rel)));
  const registered = REGISTRY.map((e) => e.file);
  assert.deepEqual(
    [...found].sort(),
    [...registered].sort(),
    "products.insert sites must exactly match the classified registry — a new/removed path needs a registry update",
  );
});

test("every registry file still actually inserts a products row", () => {
  for (const e of REGISTRY) {
    assert.ok(PRODUCTS_INSERT.test(read(e.file)), `${e.file} (${e.label}) must still insert products`);
  }
});

// ── 2. Canonical paths route through createProductCore ────────────────────────

test("V2 Create and V2 Import both go through createProductCore", () => {
  for (const rel of ["app/(v2)/v2/catalog/new/actions.ts", "app/(v2)/v2/catalog/import/actions.ts"]) {
    const src = read(rel);
    assert.ok(/from\s+["']@\/lib\/products\/product-create["']/.test(src), `${rel} imports the core`);
    assert.ok(/createProductCore\(/.test(src), `${rel} calls createProductCore`);
    assert.equal(PRODUCTS_INSERT.test(src), false, `${rel} does not insert products directly`);
  }
});

test("createProductCore has the compensating rollback + inventorySeed", () => {
  const src = read("lib/products/product-create.ts");
  assert.ok(/const rollback =/.test(src), "core defines a rollback");
  assert.ok(/\.\.\.inventorySeed\(/.test(src), "core seeds inventory via inventorySeed");
  assert.ok(/23505/.test(src), "core detects duplicate identity via 23505");
});

// ── 3. Non-canonical minting paths are NOT yet migrated (baseline lock) ────────
// P1 changed only the inventory-seed literal at the byte-identical sites; no path
// was pointed at createProductCore. This pins that until an explicit later PR.

test("no non-canonical create path calls createProductCore yet", () => {
  for (const e of REGISTRY) {
    if (e.classification === "canonical") continue;
    assert.equal(
      /createProductCore\(/.test(read(e.file)),
      false,
      `${e.label} must not call createProductCore in P1/P2 (migration is P3+)`,
    );
  }
});

test("adapter-candidate paths use the admin client (a real convergence blocker)", () => {
  for (const e of REGISTRY) {
    if (e.classification !== "adapter-candidate") continue;
    assert.ok(/createAdminClient/.test(read(e.file)), `${e.label} uses the admin client`);
  }
});

// ── 4. Seed adoption baseline (mirrors inventory-seed.test.ts, per registry) ───

test("inventorySeed adoption matches the registry's seed classification", () => {
  for (const e of REGISTRY) {
    const usesSeed = /\.\.\.inventorySeed\(/.test(read(e.file));
    if (e.seed === "inventorySeed") assert.ok(usesSeed, `${e.label} should use inventorySeed`);
    else assert.equal(usesSeed, false, `${e.label} should NOT use inventorySeed yet (seed=${e.seed})`);
  }
});

// ── 5. Archive restore is explicitly EXEMPT ───────────────────────────────────

test("archive restore is registered EXEMPT and preserves original identity (not a create)", () => {
  const entry = REGISTRY.find((e) => e.file.endsWith("archive/actions.ts"));
  assert.ok(entry, "archive restore is in the registry");
  assert.equal(entry!.classification, "exempt", "archive restore is EXEMPT");
  const src = read("app/(app)/products/archive/actions.ts");
  // Restore re-inserts the snapshot's original product object; it must not mint a
  // fresh product through the core.
  assert.equal(/createProductCore\(/.test(src), false, "restore does not use the create core");
  assert.equal(/\.\.\.inventorySeed\(/.test(src), false, "restore does not synthesize a fresh seed");
  assert.ok(/product_archive/.test(src), "restore reads from the product_archive snapshot");
});

// ── 6. Exactly one canonical path definition ──────────────────────────────────

test("there is exactly one canonical create core", () => {
  const canon = REGISTRY.filter((e) => e.classification === "canonical");
  assert.equal(canon.length, 1, "one canonical core");
  assert.equal(canon[0].file, "lib/products/product-create.ts");
});
