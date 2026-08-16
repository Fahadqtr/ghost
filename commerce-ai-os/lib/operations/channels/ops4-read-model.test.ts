// OPS.4 — read-model unit tests (§13): Snoonu operational mapping, live bounded
// gap counts (incl. Talabat variant grain, Rafeeq needs_review, UNKNOWN behavior),
// activity normalization/filtering (no synthetic events), and deep-link parsing +
// validation. Pure — node:test loads the modules directly.
// node --conditions=react-server --experimental-strip-types --test lib/operations/channels/ops4-read-model.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { mapSnoonuOperational } from "./snoonu-operational.ts";
import { buildGapCounts, ECL_GAP_STOREFRONTS, type GapCountsInput } from "./gap-counts.ts";
import {
  normalizeAuditRow,
  normalizeTalabatOrder,
  mergeActivity,
  filterActivity,
  parseActivityFilters,
  activityLink,
  type ActivityEvent,
} from "./activity.ts";
import {
  validStorefront,
  validChannel,
  validGapStatus,
  tabForStatus,
  resolveStorefront,
  validFromList,
  sanitizeSkuParam,
} from "./deep-link.ts";
import { GAP_STATUSES } from "../../missing-products/discovery-model.ts";

// ── Snoonu operational mapping (§1) ────────────────────────────────────────────
test("merchant session state maps to operational state — connected only when authenticated", () => {
  assert.equal(mapSnoonuOperational("authenticated", { lastReadAt: "t" }).state, "CONNECTED");
  assert.equal(mapSnoonuOperational("authenticated", { lastReadAt: "t" }).connected, true);
  assert.equal(mapSnoonuOperational("session_required").state, "SESSION_REQUIRED");
  assert.equal(mapSnoonuOperational("session_required").connected, false);
  assert.equal(mapSnoonuOperational("otp_required").state, "SESSION_REQUIRED");
  assert.equal(mapSnoonuOperational("otp_required").reason, "otp_required");
  assert.equal(mapSnoonuOperational("error", { readError: "x" }).state, "ERROR");
  assert.equal(mapSnoonuOperational(null).state, "UNKNOWN");
  // STALE only when explicitly flagged on an authenticated read
  assert.equal(mapSnoonuOperational("authenticated", { staleFlag: true }).state, "STALE");
});

test("operational mapping never leaks session material and never fakes connected", () => {
  const s = mapSnoonuOperational("session_required");
  assert.equal(s.lastReadAt, null);
  assert.equal(s.connected, false);
  // even an error carries only a safe message, never a token
  const e = mapSnoonuOperational("error", { readError: "safe message" });
  assert.equal(e.readError, "safe message");
  assert.equal(e.connected, false);
});

// ── gap counts (§5/§6/§7) ──────────────────────────────────────────────────────
const gapInput = (over: Partial<GapCountsInput> = {}): GapCountsInput => ({
  productsTotal: 100,
  variantsTotal: 250,
  ecl: {
    "snoonu:malikas": { activeMapped: 60, needsReview: 2 },
    "snoonu:pure_seoul": { activeMapped: 40, needsReview: 0 },
    "talabat:malikas": { activeMapped: 180, needsReview: 1 },
    "rafeeq:malikas": { activeMapped: 30, needsReview: 5 },
  },
  shopifyPresence: { available: true, mapped: 70, missing: 10, review: 1 },
  ...over,
});

test("ECL gap counts: mapped/internal_only from active listings + denominator", () => {
  const g = buildGapCounts(gapInput());
  assert.equal(g["snoonu:malikas"].mapped, 60);
  assert.equal(g["snoonu:malikas"].internalOnly, 40); // 100 - 60
  assert.equal(g["snoonu:malikas"].source, "ecl");
});

test("Talabat gap counts are VARIANT-grain (§6) — variant total is the denominator", () => {
  const g = buildGapCounts(gapInput());
  assert.equal(g["talabat:malikas"].grain, "variant");
  assert.equal(g["talabat:malikas"].mapped, 180);
  assert.equal(g["talabat:malikas"].internalOnly, 70); // 250 variants - 180, NOT product-based
});

test("Rafeeq needs_review + conflicts are the exact ECL count (§7)", () => {
  const g = buildGapCounts(gapInput());
  assert.equal(g["rafeeq:malikas"].needsReview, 5);
  assert.equal(g["rafeeq:malikas"].conflicts, 5);
});

test("Shopify uses presence (no ECL identity); missing_ecl + external_only are UNKNOWN everywhere", () => {
  const g = buildGapCounts(gapInput());
  assert.equal(g["shopify:malikas"].source, "presence");
  assert.equal(g["shopify:malikas"].mapped, 70);
  assert.equal(g["shopify:malikas"].internalOnly, 10);
  for (const k of Object.keys(g)) {
    assert.equal(g[k].missingEcl, null, `${k} missing_ecl is UNKNOWN`);
    assert.equal(g[k].externalOnly, null, `${k} external_only is UNKNOWN`);
  }
});

test("a count that cannot be derived cheaply is UNKNOWN, never an estimate", () => {
  // ECL read missing for a storefront → all UNKNOWN for it
  const g1 = buildGapCounts(gapInput({ ecl: { "snoonu:malikas": undefined, "snoonu:pure_seoul": undefined, "talabat:malikas": undefined, "rafeeq:malikas": undefined } }));
  assert.equal(g1["rafeeq:malikas"].source, "unknown");
  assert.equal(g1["rafeeq:malikas"].mapped, null);
  // denominator unknown → internal_only UNKNOWN (mapped still known)
  const g2 = buildGapCounts(gapInput({ productsTotal: null }));
  assert.equal(g2["snoonu:malikas"].mapped, 60);
  assert.equal(g2["snoonu:malikas"].internalOnly, null);
  // Shopify presence unavailable → UNKNOWN
  const g3 = buildGapCounts(gapInput({ shopifyPresence: { available: false, mapped: 0, missing: 0, review: 0 } }));
  assert.equal(g3["shopify:malikas"].source, "unknown");
});

test("ECL gap storefronts exclude Shopify (which uses presence)", () => {
  assert.equal(ECL_GAP_STOREFRONTS.includes("shopify:malikas"), false);
  assert.equal(ECL_GAP_STOREFRONTS.includes("rafeeq:malikas"), true);
});

// ── activity normalization + filtering (§3/§4) ─────────────────────────────────
test("audit rows normalize with channel/storefront from details, status, ref, link", () => {
  const e = normalizeAuditRow({ id: "1", created_at: "2026-08-16T10:00:00Z", action_type: "availability_sync_apply", sku: "S1", product_id: "p1", details: { storefront: "snoonu:malikas" }, status: "committed" });
  assert.ok(e);
  assert.equal(e!.channel, "snoonu");
  assert.equal(e!.storefront, "snoonu:malikas");
  assert.equal(e!.status, "ok");
  assert.equal(e!.ref, "p1");
  assert.equal(e!.source, "audit");
  assert.equal(e!.link, "/v2/operations/availability-sync");
});

test("audit rows with no channel/storefront fall back to channel 'internal'", () => {
  const e = normalizeAuditRow({ id: "2", created_at: "2026-08-16T10:00:00Z", action_type: "set_price", sku: "S2", status: "committed" });
  assert.equal(e!.channel, "internal");
  assert.equal(e!.storefront, null);
});

test("no synthetic events — a row without a usable timestamp is dropped", () => {
  assert.equal(normalizeAuditRow({ action_type: "set_price" }), null);
  assert.equal(normalizeTalabatOrder({ order_code: "x" }), null);
});

test("talabat orders normalize to the talabat storefront with a real status", () => {
  const e = normalizeTalabatOrder({ id: "o1", order_code: "T-1", received_at: "2026-08-16T09:00:00Z", status: "DELIVERED", processing_status: "processed" });
  assert.equal(e!.channel, "talabat");
  assert.equal(e!.storefront, "talabat:malikas");
  assert.equal(e!.status, "ok");
  assert.equal(e!.eventType, "talabat_order");
});

test("merge sorts newest-first and bounds the feed", () => {
  const a: ActivityEvent[] = [
    { id: "1", timestamp: "2026-08-10T00:00:00Z", channel: "internal", storefront: null, eventType: "set_price", ref: null, summary: "", status: "ok", source: "audit", link: "/v2/catalog" },
    { id: "2", timestamp: "2026-08-16T00:00:00Z", channel: "talabat", storefront: "talabat:malikas", eventType: "talabat_order", ref: "T-2", summary: "", status: "ok", source: "talabat", link: "/x" },
  ];
  const merged = mergeActivity([a], 1);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "2"); // newest
});

test("activity filtering by channel / storefront / event / status", () => {
  const events: ActivityEvent[] = [
    { id: "1", timestamp: "t", channel: "snoonu", storefront: "snoonu:malikas", eventType: "availability_sync_apply", ref: null, summary: "", status: "ok", source: "audit", link: "/x" },
    { id: "2", timestamp: "t", channel: "talabat", storefront: "talabat:malikas", eventType: "talabat_order", ref: null, summary: "", status: "error", source: "talabat", link: "/x" },
  ];
  assert.equal(filterActivity(events, parseActivityFilters({ a_channel: "snoonu" })).length, 1);
  assert.equal(filterActivity(events, parseActivityFilters({ a_status: "error" }))[0].id, "2");
  assert.equal(filterActivity(events, parseActivityFilters({ a_status: "nonsense" })).length, 2); // bad status ignored
  assert.equal(filterActivity(events, parseActivityFilters({ a_storefront: "talabat:malikas" })).length, 1);
});

test("activity links only ever point at existing v2 workflow routes", () => {
  for (const t of ["availability_sync_apply", "barcode_complete", "catalog_enrich", "ch6f_import", "talabat_order", "set_price", "unknown_event"]) {
    assert.match(activityLink(t, "internal"), /^\/v2\//);
  }
});

// ── deep-link parsing + validation (§8/§9) ─────────────────────────────────────
test("deep-link params validate against canonical registries; junk → null", () => {
  assert.equal(validStorefront("snoonu:malikas"), "snoonu:malikas");
  assert.equal(validStorefront("snoonu:evil"), null);
  assert.equal(validStorefront("'; DROP TABLE"), null);
  assert.equal(validChannel("snoonu"), "snoonu");
  assert.equal(validChannel("hax"), null);
  assert.equal(validGapStatus("NEEDS_REVIEW"), "NEEDS_REVIEW");
  assert.equal(validGapStatus("nonsense"), null);
});

test("all emitted deep-link statuses are real CH.6F GapStatus values", () => {
  for (const st of ["MISSING_ECL", "INTERNAL_ONLY", "EXTERNAL_ONLY", "NEEDS_REVIEW"]) {
    assert.ok((GAP_STATUSES as readonly string[]).includes(st));
  }
});

test("tabForStatus routes conflicts→problems, EXTERNAL_ONLY→external, else internal", () => {
  assert.equal(tabForStatus("NEEDS_REVIEW"), "problems");
  assert.equal(tabForStatus("EXTERNAL_ONLY"), "external");
  assert.equal(tabForStatus("MISSING_ECL"), "internal");
});

test("resolveStorefront prefers explicit storefront, falls back to first-of-channel, honors allow-list", () => {
  assert.equal(resolveStorefront({ storefront: "rafeeq:malikas" }), "rafeeq:malikas");
  assert.equal(resolveStorefront({ channel: "snoonu" }), "snoonu:malikas"); // first snoonu storefront
  assert.equal(resolveStorefront({ storefront: "shopify:malikas" }, ["snoonu:malikas", "snoonu:pure_seoul"]), null); // not in allow-list
  assert.equal(resolveStorefront({ storefront: "junk" }), null);
});

test("brand/category validate against the loaded list; sku is sanitized (no filter syntax)", () => {
  assert.equal(validFromList("Innisfree", ["Innisfree", "COSRX"]), "Innisfree");
  assert.equal(validFromList("Nope", ["Innisfree"]), null);
  assert.equal(sanitizeSkuParam("SKU-123"), "SKU-123");
  assert.equal(sanitizeSkuParam("' OR 1=1 --"), null);
  assert.equal(sanitizeSkuParam(""), null);
});
