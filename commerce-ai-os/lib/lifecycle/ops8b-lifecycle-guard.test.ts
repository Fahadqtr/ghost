// OPS.8B — lifecycle transition guard. Source-scan proofs (node:test has no DB):
//   • only the approved boundary writes products.lifecycle_state (§8, §21)
//   • lifecycle transitions never touch channel publication (§17)
//   • lifecycle transitions never touch inventory / availability (§18)
//   • no READY/ARCHIVED/PUBLISHED/HIDDEN is ever stored (§21)
//   • the boundary authenticates (writer + owner), audits, and is stale-safe (§9,§19)
//   • no hard delete is exposed; archive/restore stay a separate certified path (§21)
//   • the pure modules stay pure (no IO) (§2)
// node --conditions=react-server --experimental-strip-types --test lib/lifecycle/ops8b-lifecycle-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const BOUNDARY = "lib/lifecycle/transition.server.ts";
const ENGINE = "lib/lifecycle/transitions.ts";
const READER = "lib/lifecycle/lifecycle-read.server.ts";
const SIGNAL = "lib/operations/lifecycle-signal.ts";
const STATE = "lib/lifecycle/state.ts";
const ROUTE_ACTION = "app/(v2)/v2/catalog/[id]/actions.ts";
const PANEL = "components/v2/catalog/LifecyclePanel.tsx";

// The full lifecycle surface that must observe the separation rules.
const LIFECYCLE_FILES = [BOUNDARY, ENGINE, READER, SIGNAL, STATE, ROUTE_ACTION, PANEL];

// ── recursive walk of lib/ + app/, skipping tests ─────────────────────────────
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

// ── §8 + §21: only the approved boundary WRITES lifecycle_state ────────────────
test("only the approved boundary writes products.lifecycle_state", () => {
  const writePattern = /update\(\s*\{\s*lifecycle_state/;
  const writers = [...walk("lib"), ...walk("app")].filter((f) => writePattern.test(read(f)));
  assert.deepEqual(writers, [BOUNDARY], `unexpected lifecycle_state writer(s): ${writers.join(", ")}`);
});

test("the boundary write is guarded on the from-state (optimistic concurrency)", () => {
  const s = read(BOUNDARY);
  assert.ok(/update\(\{ lifecycle_state: to \}\)/.test(s), "writes only lifecycle_state = to");
  assert.ok(/\.eq\("id", productId\)\s*\.eq\("lifecycle_state", from\)/.test(s), "guards on id AND from-state");
});

// ── §9 + §19: auth + stale-safe outcomes + audit ──────────────────────────────
test("boundary authenticates (writer minimum, owner for owner edges) and audits", () => {
  const s = read(BOUNDARY);
  assert.ok(/requireMalakWriter\(\)/.test(s), "writer gate present");
  assert.ok(/requireOwner\(\)/.test(s), "owner gate present");
  assert.ok(/insertAuditRow\(/.test(s), "appends an audit row");
  assert.ok(/action_type: "lifecycle_transition"/.test(s), "audit typed as lifecycle_transition");
  for (const outcome of ["UPDATED", "UNCHANGED", "BLOCKED", "STALE", "FAILED"]) {
    assert.ok(s.includes(`"${outcome}"`), `returns ${outcome}`);
  }
});

// ── §17: lifecycle NEVER touches channel publication ──────────────────────────
test("no lifecycle file writes channels / ECL / publish-unpublish", () => {
  const forbidden = [
    /\.from\(["']channel_products["']\)/,
    /\.from\(["']external_channel_listings["']\)/,
    /\.from\(["']talabat_queue["']\)/,
    /\brpc\(["']?[^"')]*publish/i,
    /\.publish\(/,
    /\.unpublish\(/,
  ];
  for (const f of LIFECYCLE_FILES) {
    const s = read(f);
    for (const re of forbidden) {
      assert.equal(re.test(s), false, `${f} must not match ${re}`);
    }
  }
});

// ── §18: lifecycle NEVER touches inventory / availability authority ───────────
test("no lifecycle file writes inventory / availability", () => {
  const forbidden = [
    /update\(\s*\{[^}]*stock_status/,
    /update\(\s*\{[^}]*stock_quantity/,
    /update\(\s*\{[^}]*sold_quantity/,
    /\.from\(["']shelf_stock["']\)/,
    /\.from\(["']variant_shelf_stock["']\)/,
    /\brpc\(["']inv_/,
    /@\/lib\/inventory\/engine/,
    /@\/lib\/availability\/engine/,
  ];
  for (const f of LIFECYCLE_FILES) {
    const s = read(f);
    for (const re of forbidden) {
      assert.equal(re.test(s), false, `${f} must not match ${re}`);
    }
  }
});

// ── §21: never STORE a derived / channel value as lifecycle_state ─────────────
test("no forbidden value is ever written as a lifecycle_state", () => {
  for (const bad of ["READY", "ARCHIVED", "PUBLISHED", "HIDDEN"]) {
    // a literal write like update({ lifecycle_state: "READY" }) must never appear
    const re = new RegExp(`lifecycle_state:\\s*["']${bad}["']`);
    for (const f of LIFECYCLE_FILES) {
      assert.equal(re.test(read(f)), false, `${f} must not store ${bad}`);
    }
  }
  // the boundary only ever writes the validated variable `to`, never a literal
  assert.ok(/isKnownLifecycleState\(targetState\)/.test(read(BOUNDARY)), "target is domain-validated");
});

// ── §21: no hard delete exposed; archive/restore stay separate ────────────────
test("no lifecycle file deletes products or exposes hard delete", () => {
  for (const f of LIFECYCLE_FILES) {
    const s = read(f);
    assert.equal(/\.from\(["']products["']\)\s*\.delete\(/.test(s), false, `${f} must not hard-delete products`);
    assert.equal(/deleteProduct\b/.test(s), false, `${f} must not reference hard delete`);
  }
});

// ── §2: the pure modules stay pure (no IO, no server-only) ────────────────────
test("engine + signal + state are pure (no DB client, no IO)", () => {
  for (const f of [ENGINE, SIGNAL, STATE]) {
    const s = read(f);
    for (const re of [/@\/lib\/supabase/, /createClient/, /createAdminClient/, /\.rpc\(/, /fetch\(/, /"use server"/, /["']server-only["']/]) {
      assert.equal(re.test(s), false, `${f} must not contain ${re}`);
    }
  }
});

// ── §11: legacy platform_status writer stays compat-only, causes no drift ──────
test("legacy setProductStatus writes platform_status only, never lifecycle_state", () => {
  const s = read("app/(app)/products/actions.ts");
  assert.ok(/platform_status: value/.test(s), "legacy writer still sets platform_status (compat kept)");
  assert.equal(/update\(\s*\{\s*lifecycle_state/.test(s), false, "legacy writer never writes lifecycle_state");
});

// ── product page exposes the lifecycle review surface ─────────────────────────
test("the V2 product page renders the lifecycle review section", () => {
  const s = read("app/(v2)/v2/catalog/[id]/page.tsx");
  assert.ok(/id="lifecycle"/.test(s), "#lifecycle section present");
  assert.ok(/LifecyclePanel/.test(s), "renders LifecyclePanel");
  assert.ok(/loadProductLifecycle/.test(s), "loads the lifecycle view");
});
