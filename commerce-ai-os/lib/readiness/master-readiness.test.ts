import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  computeMasterReadiness,
  countMasterGap,
  scopeReadiness,
  type MembershipLike,
  type ReadinessLike,
} from "./master-readiness.ts";

const strip = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const scopeOf = (...ids: string[]): MembershipLike => ({ ok: true, ids: new Set(ids), total: ids.length });
const UNAVAILABLE: MembershipLike = { ok: false, ids: new Set(), total: 0 };

/** Certified-shaped readiness row. */
function row(productId: string, readyToPublish: boolean, failing: string[] = []): ReadinessLike {
  const codes = ["name", "image", "sku", "barcode", "price", "category"];
  return {
    productId,
    readyToPublish,
    checks: codes.map((code) => ({ code, passed: !failing.includes(code) })),
  };
}

// ── 1. outside-master products never enter readiness totals ───────────────────

test("outside-master products do not enter readiness totals", () => {
  const scope = scopeOf("m1", "m2");
  const readiness = [row("m1", true), row("m2", false), row("outside1", true), row("outside2", true)];
  const r = computeMasterReadiness(readiness, scope);
  assert.equal(r.scanned, 2, "only master rows counted");
  assert.equal(r.ready, 1);
  assert.equal(r.blocked, 1);
  assert.equal(r.masterTotal, 2);
});

// ── 2. a PENDING-SNOONU outside-master shell cannot appear blocked ────────────

test("an outside-master PENDING-SNOONU shell cannot appear in the blocked count", () => {
  const scope = scopeOf("m1");
  // A shell: not ready, every field missing — but outside the master.
  const shell = row("pending-shell", false, ["name", "image", "sku", "barcode", "price", "category"]);
  const r = computeMasterReadiness([row("m1", true), shell], scope);
  assert.equal(r.blocked, 0, "the shell is not launch work");
  assert.equal(r.ready, 1);
  assert.equal(countMasterGap([row("m1", true), shell], scope, "image"), 0, "nor in blocker counts");
});

// ── 3 & 4. master products follow the certified readiness predicate ───────────

test("a master product that is ready to publish counts as ready", () => {
  const scope = scopeOf("m1");
  assert.equal(computeMasterReadiness([row("m1", true)], scope).ready, 1);
});

test("a master product that is NOT ready counts as blocked (approval-pending included)", () => {
  const scope = scopeOf("m1");
  // Every field passes, but the certified engine says not ready (e.g. approval
  // pending) — readiness is NOT redefined here, it is taken as given.
  const r = computeMasterReadiness([row("m1", false)], scope);
  assert.equal(r.blocked, 1);
  assert.equal(r.ready, 0);
  assert.equal(countMasterGap([row("m1", false)], scope, "image"), 0, "blocked for a non-field reason");
});

test("readiness is NOT approval-only: a complete row can still be blocked", () => {
  const scope = scopeOf("m1", "m2");
  const r = computeMasterReadiness([row("m1", false), row("m2", true)], scope);
  assert.equal(r.ready, 1, "only the certified readyToPublish rows are ready");
});

// ── 5. READY + BLOCKED === scanned ────────────────────────────────────────────

test("READY + BLOCKED equals the scanned master total", () => {
  const scope = scopeOf("a", "b", "c", "d");
  const r = computeMasterReadiness([row("a", true), row("b", true), row("c", false), row("d", false)], scope);
  assert.equal(r.ready + r.blocked, r.scanned);
  assert.equal(r.scanned, scope.total, "full scan coverage");
  assert.equal(r.percent, 50);
});

test("a partial scan reports scanned separately from masterTotal, never reconciled", () => {
  const scope = scopeOf("a", "b", "c", "d");
  const r = computeMasterReadiness([row("a", true), row("b", false)], scope); // only 2 of 4 scanned
  assert.equal(r.scanned, 2);
  assert.equal(r.masterTotal, 4);
  assert.equal(r.ready + r.blocked, r.scanned, "invariant holds against scanned, not masterTotal");
});

// ── 9. membership read failure fails closed ───────────────────────────────────

test("membership read failure fails CLOSED — no counts, never an unscoped fallback", () => {
  const readiness = [row("a", true), row("b", true), row("c", true)];
  const r = computeMasterReadiness(readiness, UNAVAILABLE);
  assert.equal(r.available, false);
  assert.equal(r.ready, 0);
  assert.equal(r.blocked, 0);
  assert.equal(r.percent, null);
  assert.deepEqual(scopeReadiness(readiness, UNAVAILABLE), [], "nothing leaks through");
  assert.equal(countMasterGap(readiness, UNAVAILABLE, "image"), 0);
});

test("percent is null (never 0 or 100) when nothing was scanned", () => {
  assert.equal(computeMasterReadiness([], scopeOf("a")).percent, null);
});

test("malformed readiness input is ignored, never admitted", () => {
  const scope = scopeOf("a");
  assert.equal(computeMasterReadiness(null, scope).scanned, 0);
  assert.equal(computeMasterReadiness(undefined, scope).scanned, 0);
});

// ── field-gap counting is master-scoped ──────────────────────────────────────

test("countMasterGap counts only master products failing that certified check", () => {
  const scope = scopeOf("m1", "m2");
  const readiness = [
    row("m1", false, ["image"]),
    row("m2", true),
    row("outside", false, ["image", "price"]),
  ];
  assert.equal(countMasterGap(readiness, scope, "image"), 1, "outside-master gap excluded");
  assert.equal(countMasterGap(readiness, scope, "price"), 0);
});

// ── 7 & 8. shared semantics + no hardcoded runtime counts ────────────────────

test("Launch and Export consume the SAME shared readiness helper as Home", () => {
  const exportSrc = strip(readFileSync(new URL("../export/export-center.server.ts", import.meta.url), "utf8"));
  const launchSrc = strip(readFileSync(new URL("../catalog/launch/launch-workspace.server.ts", import.meta.url), "utf8"));
  const homeSrc = strip(readFileSync(new URL("../home/home-dashboard.server.ts", import.meta.url), "utf8"));

  for (const [name, src] of [["export", exportSrc], ["home", homeSrc]] as const) {
    assert.ok(/computeMasterReadiness\s*\(/.test(src), `${name} uses the shared readiness counter`);
  }
  for (const [name, src] of [["export", exportSrc], ["launch", launchSrc], ["home", homeSrc]] as const) {
    assert.ok(/master-scope\.server|loadMasterScope/.test(src), `${name} uses the shared membership seam`);
  }
  // Launch derives its blocker counts from the scoped scan, not catalog-wide
  // head counts: getCeoKpis must not feed missingImage/Price/Category any more.
  assert.ok(/countMasterGap\s*\(/.test(launchSrc), "launch uses the shared gap counter");
  assert.equal(/missingImage:\s*numOr\(ceo/.test(launchSrc), false, "launch no longer takes gaps from getCeoKpis");
  // The old unscoped baseline shape must be gone from the export reader.
  assert.equal(/readiness\.filter\(\(r\) => r\.readyToPublish\)\.length/.test(exportSrc), false,
    "export no longer counts readiness over every product");
});

test("no literal master/readiness counts are used as runtime logic", () => {
  for (const rel of [
    "./master-readiness.ts",
    "../export/export-center.server.ts",
    "../catalog/launch/launch-workspace.server.ts",
    "../home/home-dashboard.server.ts",
  ]) {
    const src = strip(readFileSync(new URL(rel, import.meta.url), "utf8"));
    for (const n of ["1343", "1292", "1530", "1418", "51"]) {
      assert.equal(new RegExp(`\\b${n}\\b`).test(src), false, `${rel} must not hardcode ${n}`);
    }
  }
});

test("the shared readiness module is pure: no I/O, no client, no writes", () => {
  const src = strip(readFileSync(new URL("./master-readiness.ts", import.meta.url), "utf8"));
  for (const [re, msg] of [
    [/\bfetch\s*\(/, "fetch("],
    [/\.rpc\s*\(/, ".rpc("],
    [/\.update\s*\(/, ".update("],
    [/\.insert\s*\(/, ".insert("],
    [/\.delete\s*\(/, ".delete("],
    [/createClient/, "createClient"],
    [/server-only/, "server-only"],
    [/Date\.now/, "Date.now"],
  ] as const) {
    assert.equal(re.test(src), false, `pure module must not contain ${msg}`);
  }
});

// ── 6. full canonical export stays unscoped ──────────────────────────────────

test("the full canonical export route is untouched and stays all-products", () => {
  const src = readFileSync(new URL("../../app/api/v2/catalog/export/route.ts", import.meta.url), "utf8");
  assert.equal(/loadExportCenter/.test(src), false, "full export does not use the operational baseline");
  assert.equal(/master-scope|loadMasterScope|computeMasterReadiness/.test(src), false,
    "full canonical export must NOT be restricted to the master");
});
