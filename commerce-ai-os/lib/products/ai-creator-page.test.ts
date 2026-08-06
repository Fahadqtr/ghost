// Phase UI.5 — AI product creator: identity-snapshot reader behaviour + page/
// action/component safety scans (.tsx verified by source scan, as node cannot
// execute .tsx — same pattern as the other V2 suites).
// Run: node --conditions=react-server --experimental-strip-types --test lib/products/ai-creator-page.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadIdentitySnapshot } from "./catalog-identity-read.ts";

const PAGE_SRC = readFileSync(new URL("../../app/(v2)/v2/catalog/new/page.tsx", import.meta.url), "utf8");
const ACTIONS_SRC = readFileSync(new URL("../../app/(v2)/v2/catalog/new/actions.ts", import.meta.url), "utf8");
const LOADING_SRC = readFileSync(new URL("../../app/(v2)/v2/catalog/new/loading.tsx", import.meta.url), "utf8");
const WIZARD_SRC = readFileSync(new URL("../../components/v2/catalog/AiProductCreator.tsx", import.meta.url), "utf8");
const MASTER_SRC = readFileSync(new URL("../../components/v2/catalog/MasterCatalog.tsx", import.meta.url), "utf8");
const DETAIL_SRC = readFileSync(new URL("../../app/(v2)/v2/catalog/[id]/page.tsx", import.meta.url), "utf8");

// ── identity snapshot reader (runtime, fake paged client) ────────────────────

function makeClient(over: Record<string, unknown> = {}) {
  const o = {
    products: [{ id: "p1", sku: "mk10", barcode: "111", name_en: "A", name_ar: "أ", size: null, color: null }] as unknown[],
    variants: [{ id: "v1", sku: "mk10-1", barcode: "222", variant_name: "و", variant_name_en: "P", size: null, color: null }] as unknown[],
    productsError: null as unknown,
    variantsError: null as unknown,
    ...over,
  };
  return {
    from(table: string) {
      return {
        select(_c: string) {
          return {
            order(_col: string, _opts: { ascending: boolean }) {
              return {
                range(from: number, to: number) {
                  const src = table === "products" ? o.products : o.variants;
                  const err = table === "products" ? o.productsError : o.variantsError;
                  if (err) return Promise.resolve({ data: null, error: err });
                  return Promise.resolve({ data: src.slice(from, to + 1), error: null });
                },
              };
            },
          };
        },
      };
    },
  };
}

test("snapshot: collects skus and barcodes from BOTH products and variants", async () => {
  const res = await loadIdentitySnapshot(makeClient());
  assert.equal(res.status, "ok");
  if (res.status !== "ok") return;
  assert.deepEqual(res.snapshot.skus.sort(), ["mk10", "mk10-1"]);
  assert.ok(res.snapshot.barcodes.has("111") && res.snapshot.barcodes.has("222"));
  assert.equal(res.snapshot.rows.length, 2);
  assert.equal(res.snapshot.rows.find((r) => r.kind === "variant")?.nameEn, "P");
  assert.equal(res.snapshot.partial, false);
});

test("snapshot: any read failure -> status error (never a throw, never raw text)", async () => {
  assert.equal((await loadIdentitySnapshot(makeClient({ productsError: { message: "boom" } }))).status, "error");
  assert.equal((await loadIdentitySnapshot(makeClient({ variantsError: { message: "boom" } }))).status, "error");
});

// ── actions source scan ───────────────────────────────────────────────────────

test("actions: auth on every step, session client for DB, shared core, fixed messages", () => {
  assert.ok(ACTIONS_SRC.startsWith('"use server"'), "use server");
  assert.equal(ACTIONS_SRC.split("isSignedIn()").length - 1, 3, "all three actions gate on the session");
  assert.ok(ACTIONS_SRC.includes("createProductCore"), "shared create core — no inline SQL-ish logic");
  assert.ok(ACTIONS_SRC.includes("loadIdentitySnapshot(supabase)"), "identity scans use the session client");
  assert.ok(ACTIONS_SRC.includes("validateAiProductInput"), "server-side validation");
  assert.ok(ACTIONS_SRC.includes("CREATE_MESSAGES"), "fixed Arabic messages");
  assert.ok(ACTIONS_SRC.includes("upsert: false"), "storage upload never replaces an existing image");
  assert.ok(ACTIONS_SRC.includes(".remove([filename])"), "image removed when the create fails");
  assert.ok(ACTIONS_SRC.includes('approval: ""'), "new product is forced un-approved");
  assert.ok(ACTIONS_SRC.includes('platform_status: ""'), "no platform status -> no sync pickup");
  assert.ok(ACTIONS_SRC.includes("created=1"), "success banner signal");
});

test("actions: admin client is used for STORAGE ONLY — every db call is the session client", () => {
  // The only permitted admin usages are storage upload/getPublicUrl/remove.
  const adminCalls = ACTIONS_SRC.match(/admin\.(?!storage)/g) ?? [];
  assert.deepEqual(adminCalls, [], "admin.<anything but storage> is forbidden");
  assert.ok(!ACTIONS_SRC.includes("admin.from("), "no admin table access");
  assert.ok(!ACTIONS_SRC.includes("admin.rpc("), "no admin rpc");
});

test("actions: nothing leaks — no raw errors, no AI raw text, no storage paths in messages", () => {
  for (const banned of [".rpc(", "error.message", "console.log", "SQLSTATE", "resp.content.toString"]) {
    assert.ok(!ACTIONS_SRC.includes(banned), `actions must not contain ${banned}`);
  }
  assert.ok(!/return\s*\{\s*error:\s*`/.test(ACTIONS_SRC), "no template-string error messages");
});

test("actions: seller note and model output go through the pinned prompt + whitelist parser", () => {
  assert.ok(ACTIONS_SRC.includes("buildVisionExtractPrompt"), "pinned prompt");
  assert.ok(ACTIONS_SRC.includes("parseVisionExtract"), "whitelist parser — raw model text never returned");
});

test("actions: the AI call has an explicit deadline and bounded retries", () => {
  assert.ok(ACTIONS_SRC.includes("timeout: 60_000"), "explicit provider timeout");
  assert.ok(ACTIONS_SRC.includes("maxRetries: 1"), "bounded retries");
});

test("actions: image collision is checked across EVERY supported extension before upload", () => {
  assert.ok(ACTIONS_SRC.includes(".list("), "storage listing pre-check exists");
  assert.ok(ACTIONS_SRC.includes("Object.values(ALLOWED_MEDIA)"), "all extensions checked, not just the uploaded one");
  const listAt = ACTIONS_SRC.indexOf(".list(");
  const uploadAt = ACTIONS_SRC.indexOf(".upload(");
  assert.ok(listAt > 0 && listAt < uploadAt, "pre-check runs BEFORE the upload");
});

test("actions: a failed image cleanup is reported with a fixed message and logged safely", () => {
  assert.ok(ACTIONS_SRC.includes("image_cleanup_failed"), "fixed cleanup-needs-review message");
  assert.ok(ACTIONS_SRC.includes("console.error"), "internal log exists");
  assert.ok(!/console\.error\([^)]*base64/i.test(ACTIONS_SRC), "the log never contains image data");
  assert.ok(!/console\.error\([^)]*(rmErr|upErr|error)\b/.test(ACTIONS_SRC), "the log never contains an error object");
});

// ── page + loading + wizard scans ─────────────────────────────────────────────

test("page: force-dynamic server component, session client, degrades brands, renders the wizard", () => {
  assert.ok(PAGE_SRC.includes('export const dynamic = "force-dynamic"'));
  assert.ok(PAGE_SRC.includes('from "@/lib/supabase/server"'));
  assert.ok(PAGE_SRC.includes("AiProductCreator"));
  assert.ok(!PAGE_SRC.includes("createAdminClient"));
  assert.ok(LOADING_SRC.includes("animate-pulse"), "loading skeleton exists");
});

test("wizard: client component with the full step/guard contract", () => {
  assert.ok(WIZARD_SRC.startsWith('"use client"'));
  for (const required of [
    "prepareImage",            // in-browser downscale before anything is sent
    "renumberVariantSkus",     // variant skus always renumber from the main
    "validateAiProductInput",  // pre-submit validation
    "beforeunload",            // unsaved-changes guard
    "disabled={busy",          // double-submit guards
    'accept="image/jpeg,image/png,image/webp"',
    "تغيير الصورة",
    "حذف الصورة",
    "إعادة التحليل",
    "حفظ المنتج",
    "إلغاء",
    "لا يمكن الحفظ",           // exact duplicate blocks saving
    "imageStale",              // changing the image clears stale AI panels
    "نتائج التحليل السابقة أُخفيت",
    "ثقة منخفضة",              // low-confidence review warning
    "encodeURIComponent(m.id)", // safe links to matched products
  ]) {
    assert.ok(WIZARD_SRC.includes(required), `wizard must contain ${required}`);
  }
});

test("wizard: no client uuids, no direct supabase/AI access, no window.alert, no original filename use", () => {
  for (const banned of [
    "randomUUID", "crypto.", "window.alert", "@supabase/", "@/lib/supabase",
    "Anthropic", "file.name", "Date.now",
  ]) {
    assert.ok(!WIZARD_SRC.includes(banned), `wizard must not contain ${banned}`);
  }
});

// ── catalog entry + detail banner ────────────────────────────────────────────

test("catalog page links to the creator and the detail page shows the created banner", () => {
  assert.ok(MASTER_SRC.includes('href="/v2/catalog/new"'), "entry button target");
  assert.ok(MASTER_SRC.includes("إضافة منتج بالذكاء الاصطناعي"), "entry button label");
  assert.ok(DETAIL_SRC.includes('sp.created === "1"'), "strict literal created check");
  assert.ok(DETAIL_SRC.includes("تم إنشاء المنتج"), "created banner");
});
