// OPS.3 — Channel Command Center guard (source scan §20). Proves the Command
// Center is channel ORCHESTRATION only: the composer is pure & performs no IO; the
// reader is server-only, read-only, reuses the SINGLE aggregated operations read
// (no per-card scan, no heavy discovery scan) and the pure composer; the component
// is presentational (links + native GET form only). It performs NO direct writes —
// no inventory / availability / ECL / barcode / image writes, no auto-publish, no
// Rafeeq conflict auto-resolution — Snoonu stores never leak across each other,
// and Talabat variant flattening is preserved.
// node --conditions=react-server --experimental-strip-types --test lib/operations/channels/ch-ops3-channels-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GAP_STATUSES } from "../../missing-products/discovery-model.ts";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const COMPOSER = "lib/operations/channels/channel-center.ts";
const READER = "lib/operations/channels/channel-center.server.ts";
const COMPONENT = "components/v2/operations/ChannelCommandCenter.tsx";
const PAGE = "app/(v2)/v2/operations/channels/page.tsx";

// ── composer purity + no IO ────────────────────────────────────────────────────
test("composer is PURE (no @/ imports, no server-only, no DB/SDK)", () => {
  const s = read(COMPOSER);
  assert.equal(/from\s+["']@\//.test(s), false, "no @/ imports");
  assert.equal(/import\s+["']server-only["']/.test(s), false, "not server-only");
  assert.equal(/@anthropic-ai|openai|gemini/i.test(s), false, "no AI SDK");
});

test("composer performs NO IO and NO writes (orchestration only)", () => {
  const s = strip(read(COMPOSER));
  for (const bad of [/\.from\(/, /\.select\(/, /\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /createClient/, /createAdminClient/, /fetch\(/, /writeEclMapping/, /requireMalakWriter/]) {
    assert.equal(bad.test(s), false, `composer must not contain ${bad}`);
  }
});

test("composer never references inventory/availability/ECL/channel write tables or columns", () => {
  const s = strip(read(COMPOSER));
  for (const tok of ["stock_quantity", "sold_quantity", "stock_status", "channel_status", "external_channel_listings", "inventory", "platform_status", "channel_products", "channel_variant_mappings", "barcode_value"]) {
    assert.equal(new RegExp(tok).test(s), false, `composer must not reference ${tok}`);
  }
});

test("composer only links to EXISTING workflow routes (no parallel screens)", () => {
  const s = read(COMPOSER);
  const routes = (s.match(/\/v2\/[a-z/-]+/g) ?? []).map((r) => r.replace(/[)"'`].*$/, ""));
  const allowed = [
    "/v2/catalog",
    "/v2/catalog/shopify",
    "/v2/operations",
    "/v2/operations/channels",
    "/v2/operations/missing-products",
    "/v2/operations/media",
    "/v2/operations/ai-enrichment",
    "/v2/operations/barcode-completion",
    "/v2/operations/availability-sync",
  ];
  for (const r of routes) assert.ok(allowed.includes(r), `route ${r} is an existing workflow`);
});

// ── reader: server-only, read-only, reuse (no per-card / no heavy scan) ─────────
test("reader is server-only and performs NO writes", () => {
  assert.ok(/import\s+["']server-only["']/.test(read(READER)), "reader is server-only");
  const s = strip(read(READER));
  for (const w of [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /createAdminClient/, /writeEclMapping/, /requireMalakWriter/, /importOneProduct/, /applyEclRepairs/]) {
    assert.equal(w.test(s), false, `reader performs no ${w}`);
  }
});

test("reader reuses the SINGLE aggregated read + pure composer (no per-card / heavy discovery scan)", () => {
  const s = strip(read(READER));
  assert.ok(/loadOperationsDashboard\(/.test(s), "reader reuses the operations aggregated read");
  assert.ok(/buildChannelCenter\(/.test(s), "reader composes via the pure composer");
  // must NOT trigger the CH.6F full discovery scan (5 catalog scans) per render
  assert.equal(/readOnlyGapReport|scanMissingProducts|scanInternal/.test(s), false, "no heavy per-storefront discovery scan");
});

test("external-identity search reuses the ECL durable resolver (read-only), never fuzzy", () => {
  const s = strip(read(READER));
  assert.ok(/createDurableIdentityResolver\(/.test(s) && /createExternalListingReader\(/.test(s), "reuses the durable ECL resolver over the read-only listing reader");
  assert.ok(/resolveInternalListing\(/.test(s), "resolves internal listing by exact identity");
});

// ── no auto-publish / no Rafeeq conflict auto-resolution ───────────────────────
test("no auto-publish and no Rafeeq conflict auto-resolution anywhere in OPS.3", () => {
  for (const f of [COMPOSER, READER, COMPONENT, PAGE]) {
    const s = strip(read(f));
    for (const bad of [/autoResolve/i, /resolveConflict/i, /\bpublish\(/i, /autoPublish/i, /"Fix ?All"/i, /fixAll/i]) {
      assert.equal(bad.test(s), false, `${f} must not contain ${bad}`);
    }
  }
  // contested Rafeeq rows are handed to MANUAL review (NEEDS_REVIEW), never resolved
  assert.ok(/NEEDS_REVIEW/.test(read(COMPOSER)), "Rafeeq conflicts link to manual NEEDS_REVIEW");
});

// ── Snoonu store isolation ─────────────────────────────────────────────────────
test("Snoonu stores are isolated — malikas is gated by its own reader flag, never folded into pure_seoul", () => {
  const s = read(COMPOSER);
  assert.ok(/snoonuMalikasReaderAvailable/.test(s), "malikas gated on its own reader flag");
  assert.ok(/"snoonu:malikas"/.test(s) && /"snoonu:pure_seoul"/.test(s), "both Snoonu storefronts are distinct cases");
});

// ── Talabat variant flattening preserved ───────────────────────────────────────
test("Talabat variant flattening is preserved (variant grain + a caveat note)", () => {
  const s = read(COMPOSER);
  assert.ok(/listingGrain === "variant"/.test(s), "variant grain drives the caveat");
  assert.ok(/TALABAT_GRAIN_NOTE|على مستوى المتغيّر/.test(s), "carries a variant-grain caveat");
  assert.ok(/VARIANT_MAPPING_GAP/.test(s), "Talabat gaps are variant mapping gaps");
});

// ── component: presentational, links + native GET only ─────────────────────────
test("component is presentational — no data client, no queries, no writes", () => {
  const s = read(COMPONENT);
  for (const bad of [/createAdminClient/, /createClient\(/, /@\/lib\/supabase/, /\.from\(/, /\.rpc\(/, /\.insert\(/, /\.update\(/, /"use server"/, /@anthropic-ai/]) {
    assert.equal(bad.test(s), false, `component must not contain ${bad}`);
  }
  // navigation only: next/link + a native GET search form (no server-action form)
  assert.ok(/from "next\/link"/.test(s), "navigates via next/link");
  assert.equal(/action=\{/.test(s), false, "no server-action form (no action={)");
  assert.ok(/method="get"/.test(s), "search is a native GET form");
});

// ── page: composes from the reader, renders the component, no writes on render ──
test("page loads the read-only view and renders the command center", () => {
  const s = strip(read(PAGE));
  assert.ok(/loadChannelCenter\(/.test(s), "page loads the read-only view");
  assert.ok(/<ChannelCommandCenter/.test(s), "page renders the command center");
  for (const bad of [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /createAdminClient/, /"use server"/, /requireMalakWriter/]) {
    assert.equal(bad.test(s), false, `page must not contain ${bad}`);
  }
});

// ── deep-link status params are valid CH.6F GapStatus values (reuse, not drift) ─
test("missing-products deep-link statuses are real CH.6F GapStatus values", () => {
  const s = read(COMPOSER);
  // deep-link statuses are the 2nd argument of missingProductsLink(sf, "STATUS")
  const statuses = Array.from(s.matchAll(/missingProductsLink\([^,)]+,\s*"([A-Z_]+)"\)/g)).map((m) => m[1]);
  assert.ok(statuses.length > 0, "there are deep-linked statuses");
  for (const st of statuses) {
    assert.ok((GAP_STATUSES as readonly string[]).includes(st), `${st} is a real GapStatus`);
  }
});

// ── OPS.1 links to OPS.3 (§1) ──────────────────────────────────────────────────
test("the main operations page links to the Channel Command Center", () => {
  const s = read("app/(v2)/v2/operations/page.tsx");
  assert.ok(/\/v2\/operations\/channels/.test(s), "OPS.1 links to /v2/operations/channels");
});
