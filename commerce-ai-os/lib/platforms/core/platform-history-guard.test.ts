// Phase UI.9.4 — safety scans for the platform-history UI + reader + page wiring
// (.tsx can't be executed by node, so they're verified by source scan — same
// pattern as the other V2 suites). Guards: server-only + read-only reader, no
// raw metadata in the section, Server Component (no client JS), empty state, and
// the product page actually mounts the section.
// Run: node --conditions=react-server --experimental-strip-types --test lib/platforms/core/platform-history-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const READER = readFileSync(new URL("../../operations/platform-history-read.ts", import.meta.url), "utf8");
const SECTION = readFileSync(new URL("../../../components/v2/catalog/PlatformHistory.tsx", import.meta.url), "utf8");
const PAGE = readFileSync(new URL("../../../app/(v2)/v2/catalog/[id]/page.tsx", import.meta.url), "utf8");
const PROVIDER = readFileSync(new URL("../../operations/timeline/providers/platform-provider.ts", import.meta.url), "utf8");

test("reader is server-only and READ-only (no admin/service role/write/RPC)", () => {
  assert.ok(READER.includes('import "server-only"'), "reader must be server-only");
  for (const bad of ["createAdminClient", "service_role", "SERVICE_ROLE", ".insert(", ".update(", ".delete(", ".rpc("]) {
    assert.equal(READER.includes(bad), false, `reader must not contain ${bad}`);
  }
});

test("reader derives from platform_snapshots — no new table/migration", () => {
  assert.equal(/create\s+table/i.test(READER), false);
  // It reaches snapshots through the store abstraction, never a bespoke table name.
  assert.equal(READER.includes("platform_snapshots"), false);
});

test("section is a Server Component (no client JS)", () => {
  assert.equal(SECTION.includes('"use client"'), false);
  assert.equal(SECTION.includes("useState"), false);
  assert.equal(SECTION.includes("onClick"), false);
});

test("section renders heading + empty state", () => {
  assert.ok(SECTION.includes("سجل المنصات"), "section heading");
  assert.ok(SECTION.includes("لا يوجد سجل منصات بعد"), "empty state");
});

test("section never renders raw metadata values", () => {
  // The section reads only whitelisted fields via the view helpers. The boolean
  // `.metadataChanged` flag is allowed; a raw `.metadata` value access is not.
  assert.equal(/\.metadata(?!Changed)/.test(SECTION), false);
  assert.equal(SECTION.includes("payloadHash"), false);
  assert.equal(SECTION.includes("JSON.stringify"), false);
});

test("provider copy is values-free (labels only)", () => {
  // The provider builds titles/descriptions from labels, never from field values.
  assert.equal(PROVIDER.includes("f.after"), false);
  assert.equal(PROVIDER.includes("f.before"), false);
});

test("product page mounts the section via the reader", () => {
  assert.ok(PAGE.includes("loadProductPlatformHistory"), "page calls the reader");
  assert.ok(PAGE.includes("<PlatformHistory"), "page renders the section");
  // best-effort isolation: the reader call is guarded so it can't break the page
  assert.ok(PAGE.includes("platformHistory = null"), "reader failure is isolated");
});
