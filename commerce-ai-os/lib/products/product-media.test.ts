// UX.4C-1 — Product media reads: pure reducer + server reader + guards.
// PURE — scripted fake client; no database, no network, no rendering.
//
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/product-media.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { EMPTY_PRODUCT_MEDIA, toProductMediaState } from "./product-media.ts";
import { loadProductMedia } from "./product-media-read.ts";

const IMG = (n: string) => `https://x.supabase.co/storage/v1/object/public/product-images/${n}`;

// ── reducer: primary selection ───────────────────────────────────────────────

test("image_url matching a gallery row => that row is primary", () => {
  const rows = [
    { id: "r1", url: IMG("mk10.jpg"), filename: "mk10.jpg", is_primary: false, sort_order: 2 },
    { id: "r2", url: IMG("mk10-2.jpg"), filename: "mk10-2.jpg", is_primary: true, sort_order: 1 },
  ];
  const s = toProductMediaState(IMG("mk10.jpg"), "mk10.jpg", rows);
  assert.equal(s.primary?.url, IMG("mk10.jpg"), "image_url wins over is_primary");
  assert.equal(s.primary?.id, "r1");
  assert.equal(s.primary?.isPrimary, true);
  // the stale is_primary row is demoted
  const demoted = s.images.find((i) => i.id === "r2");
  assert.equal(demoted?.isPrimary, false, "is_primary does NOT override image_url");
});

test("fallback to is_primary ONLY when there is no image_url", () => {
  const rows = [
    { id: "r1", url: IMG("a.jpg"), filename: "a.jpg", is_primary: false, sort_order: 0 },
    { id: "r2", url: IMG("b.jpg"), filename: "b.jpg", is_primary: true, sort_order: 5 },
  ];
  const s = toProductMediaState("", null, rows);
  assert.equal(s.primary?.id, "r2", "the is_primary row is chosen");
  assert.equal(s.primary?.isPrimary, true);
});

test("no image_url and no is_primary => first row by order is primary", () => {
  const rows = [
    { id: "r1", url: IMG("a.jpg"), is_primary: false, sort_order: 3 },
    { id: "r2", url: IMG("b.jpg"), is_primary: false, sort_order: 1 },
  ];
  const s = toProductMediaState(null, null, rows);
  assert.equal(s.primary?.id, "r2", "lowest sort_order becomes primary");
});

test("image_url exists but NO product_images row => primary is synthesized (id null)", () => {
  const s = toProductMediaState(IMG("mk99.jpg"), "mk99.jpg", []);
  assert.equal(s.primary?.url, IMG("mk99.jpg"));
  assert.equal(s.primary?.id, null, "synthesized from image_url, no gallery row");
  assert.equal(s.primary?.filename, "mk99.jpg");
  assert.equal(s.primary?.isPrimary, true);
  assert.equal(s.images.length, 1);
});

test("image_url set, no match, plus extra gallery rows => synthesized primary first, extras follow", () => {
  const rows = [
    { id: "r1", url: IMG("extra1.jpg"), is_primary: false, sort_order: 2 },
    { id: "r2", url: IMG("extra2.jpg"), is_primary: false, sort_order: 1 },
  ];
  const s = toProductMediaState(IMG("main.jpg"), null, rows);
  assert.equal(s.images[0].url, IMG("main.jpg"), "synthesized primary leads");
  assert.equal(s.images[0].id, null);
  assert.deepEqual(s.images.slice(1).map((i) => i.id), ["r2", "r1"], "extras ordered by sort_order");
  assert.equal(s.images.slice(1).every((i) => !i.isPrimary), true);
});

// ── reducer: ordering + empties + dedup ──────────────────────────────────────

test("deterministic order: primary first, then sort_order asc, stable on ties", () => {
  const rows = [
    { id: "p", url: IMG("p.jpg"), is_primary: false, sort_order: 9 },
    { id: "a", url: IMG("a.jpg"), is_primary: false, sort_order: 1 },
    { id: "b", url: IMG("b.jpg"), is_primary: false, sort_order: 1 },
    { id: "c", url: IMG("c.jpg"), is_primary: false, sort_order: 0 },
  ];
  const s = toProductMediaState(IMG("p.jpg"), null, rows);
  assert.deepEqual(s.images.map((i) => i.id), ["p", "c", "a", "b"], "primary, then sort asc, ties keep input order");
});

test("empty gallery and no image_url => empty state", () => {
  const s = toProductMediaState(null, null, []);
  assert.deepEqual(s, { primary: null, images: [] });
});

test("rows without a usable url are dropped; duplicate urls collapse (first wins)", () => {
  const rows = [
    { id: "r1", url: "", is_primary: true, sort_order: 0 },
    { id: "r2", url: IMG("dup.jpg"), is_primary: false, sort_order: 1 },
    { id: "r3", url: IMG("dup.jpg"), is_primary: false, sort_order: 2 },
  ];
  const s = toProductMediaState(null, null, rows);
  assert.equal(s.images.length, 1, "empty-url dropped, dup collapsed");
  assert.equal(s.primary?.id, "r2", "first occurrence of the url wins");
});

test("non-numeric sort_order is treated as 0 without throwing", () => {
  const rows = [
    { id: "r1", url: IMG("a.jpg"), is_primary: false, sort_order: null },
    { id: "r2", url: IMG("b.jpg"), is_primary: false, sort_order: "x" },
  ];
  const s = toProductMediaState(null, null, rows);
  assert.equal(s.images.length, 2);
  assert.equal(s.primary?.id, "r1", "0/0 tie keeps input order");
});

// ── reader: fake client ──────────────────────────────────────────────────────

function makeClient(over: {
  products?: { data: unknown[] | null; error: unknown };
  images?: { data: unknown[] | null; error: unknown };
} = {}) {
  const o = {
    products: over.products ?? { data: [{ image_url: IMG("mk10.jpg"), image_filename: "mk10.jpg" }], error: null },
    images: over.images ?? {
      data: [{ id: "r1", url: IMG("mk10.jpg"), filename: "mk10.jpg", is_primary: true, sort_order: 0 }],
      error: null,
    },
  };
  const calls: string[] = [];
  // Inject the REAL reducer so the reader never resolves an extensionless value
  // import under node:test (same pattern as master-catalog-read).
  const opts = { reduce: { toProductMediaState } } as const;
  const client = {
    from(table: string) {
      return {
        select(_c: string) {
          return {
            filter(col: string, _op: string, value: string) {
              calls.push(`${table}:${col}=${value}`);
              const out = table === "products" ? o.products : o.images;
              const builder = Object.assign(Promise.resolve(out), {
                limit: (_n: number) => Promise.resolve(out),
              });
              return builder;
            },
          };
        },
      };
    },
  };
  return { client, calls, opts };
}

test("reader: scopes BOTH reads to the given product id", async () => {
  const { client, calls, opts } = makeClient();
  const res = await loadProductMedia(client, "prod-123", opts);
  assert.equal(res.status, "ok");
  assert.ok(calls.includes("products:id=prod-123"), "products read scoped by id");
  assert.ok(calls.includes("product_images:product_id=prod-123"), "gallery read scoped by product_id");
  assert.equal(res.state.primary?.url, IMG("mk10.jpg"));
});

test("reader: an invalid id short-circuits to empty with NO query", async () => {
  const { client, calls, opts } = makeClient();
  const res = await loadProductMedia(client, "   ", opts);
  assert.equal(res.status, "ok");
  assert.deepEqual(res.state, EMPTY_PRODUCT_MEDIA);
  assert.equal(calls.length, 0, "no query issued for an invalid id");
});

test("reader: a products-read failure fails closed (status error, empty state)", async () => {
  const { client, opts } = makeClient({ products: { data: null, error: { message: "boom" } } });
  const res = await loadProductMedia(client, "p1", opts);
  assert.equal(res.status, "error");
  assert.deepEqual(res.state, EMPTY_PRODUCT_MEDIA);
});

test("reader: a missing product => ok + empty state", async () => {
  const { client, opts } = makeClient({ products: { data: [], error: null } });
  const res = await loadProductMedia(client, "p1", opts);
  assert.equal(res.status, "ok");
  assert.deepEqual(res.state, EMPTY_PRODUCT_MEDIA);
});

test("reader: a gallery-read failure is NON-fatal — primary still comes from image_url", async () => {
  const { client, opts } = makeClient({ images: { data: null, error: { message: "boom" } } });
  const res = await loadProductMedia(client, "p1", opts);
  assert.equal(res.status, "ok");
  assert.equal(res.state.primary?.url, IMG("mk10.jpg"), "image_url drives the primary");
  assert.equal(res.state.primary?.id, null, "no gallery row available");
});

// ── guards: read-only, integrations, no schema change ────────────────────────

function src(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

test("the reader is READ-ONLY: no write / rpc / admin / storage", () => {
  const READER = src("./product-media-read.ts");
  for (const bad of [
    ".insert(", ".update(", ".upsert(", ".delete(", ".rpc(",
    "createAdminClient", ".storage(",
  ]) {
    assert.equal(READER.includes(bad), false, `reader must not contain ${bad}`);
  }
  assert.ok(READER.includes('import "server-only"'), "reader is server-only");
});

test("the reducer is PURE: no I/O, no framework imports", () => {
  const PURE = src("./product-media.ts");
  for (const bad of ['import "server-only"', "createClient", "supabase", "fetch(", ".from(", '"react"', "useState"]) {
    assert.equal(PURE.includes(bad), false, `reducer must not contain ${bad}`);
  }
});

test("the ProductMedia component is READ-ONLY: no upload / delete / set-primary controls or actions", () => {
  const CMP = src("../../components/v2/catalog/ProductMedia.tsx");
  for (const bad of [
    "<button", "onClick", "onChange", "<input", "<form",
    "uploadProductImage", "removeProductImage", "storePrimary", "image-actions",
    ".insert(", ".update(", ".delete(", ".storage", "use client",
  ]) {
    assert.equal(CMP.includes(bad), false, `read-only component must not contain ${bad}`);
  }
  assert.ok(CMP.includes("لا توجد صور لهذا المنتج"), "renders the empty state");
});

test("the detail page renders ProductMedia from the shared reader", () => {
  const PAGE = src("../../app/(v2)/v2/catalog/[id]/page.tsx");
  assert.ok(PAGE.includes("import ProductMedia"), "imports the component");
  assert.ok(PAGE.includes("loadProductMedia"), "uses the shared reader");
  assert.ok(PAGE.includes("<ProductMedia"), "renders it");
});

test("the edit page renders read-only ProductMedia above the form", () => {
  const PAGE = src("../../app/(v2)/v2/catalog/[id]/edit/page.tsx");
  assert.ok(PAGE.includes("import ProductMedia"), "imports the component");
  assert.ok(PAGE.includes("loadProductMedia"), "uses the shared reader");
  assert.ok(PAGE.includes("<ProductMedia"), "renders it");
});

test("no schema change: the new modules add no CREATE/ALTER TABLE or migration", () => {
  for (const rel of ["./product-media.ts", "./product-media-read.ts"]) {
    const s = src(rel);
    assert.equal(/create\s+table|alter\s+table|drop\s+table/i.test(s), false, `${rel} defines no DDL`);
  }
});
