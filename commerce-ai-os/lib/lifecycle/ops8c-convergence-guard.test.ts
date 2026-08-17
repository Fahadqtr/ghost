// OPS.8C — lifecycle convergence + Action Center wiring guard (source scan).
//
// Proves (§18):
//   • lifecycle_state sole writer remains the canonical boundary
//   • legacy setProductStatus delegates to the boundary, never writes lifecycle_state
//   • archive + restore are OWNER-only
//   • the Action Center lifecycle source is READ-ONLY (no writes, no transition import)
//   • no synthetic STOP/RESTORE/ARCHIVE candidates; no new heuristic scanner
//   • no channel / inventory / availability writes; no hard delete
// node --conditions=react-server --experimental-strip-types --test lib/lifecycle/ops8c-convergence-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const BOUNDARY = "lib/lifecycle/transition.server.ts";
const ARCHIVE = "app/(app)/products/archive/actions.ts";
const PRODUCTS = "app/(app)/products/actions.ts";
const LIFECYCLE_SOURCE = "lib/actions/lifecycle-source.server.ts";
const ADAPTERS = "lib/actions/action-sources.ts";
const CENTER = "lib/actions/action-center.server.ts";
const DRAWER = "components/v2/actions/ReviewDrawer.tsx";

/** Body of an exported function from its declaration to the next top-level export. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `located ${name}`);
  const after = src.indexOf("\nexport ", start + 1);
  return src.slice(start, after < 0 ? src.length : after);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

// ── §18: lifecycle_state sole writer remains the canonical boundary ───────────
test("only the canonical boundary writes lifecycle_state (repo-wide)", () => {
  const writers = [...walk("lib"), ...walk("app")].filter((f) => /update\(\s*\{\s*lifecycle_state/.test(read(f)));
  assert.deepEqual(writers, [BOUNDARY]);
});

// ── §2: legacy setProductStatus converges through the boundary ────────────────
test("setProductStatus delegates to the lifecycle boundary and never writes lifecycle_state", () => {
  const body = fnBody(read(PRODUCTS), "setProductStatus");
  assert.ok(/transitionProductLifecycle\(/.test(body), "delegates to the canonical boundary");
  assert.equal(/update\(\s*\{\s*lifecycle_state/.test(body), false, "never writes lifecycle_state directly");
  assert.ok(/platform_status: value/.test(body), "keeps the platform_status compat mirror");
  // the boundary result gates the mirror write (blocked/stale/failed short-circuits)
  assert.ok(/BLOCKED|STALE|FAILED/.test(body), "surfaces boundary outcomes");
});

// ── §1 + §15: archive + restore are OWNER-only ────────────────────────────────
test("archiveAndDeleteProducts and restoreFromArchive are owner-gated", () => {
  const src = read(ARCHIVE);
  for (const fn of ["archiveAndDeleteProducts", "restoreFromArchive"]) {
    const body = fnBody(src, fn);
    assert.ok(/requireOwner\s*\(/.test(body), `${fn} gates on requireOwner()`);
    assert.equal(/requireMalakWriter\s*\(/.test(body), false, `${fn} is no longer writer-gated`);
    // owner check precedes any admin RPC / write
    assert.ok(body.indexOf("requireOwner") < body.indexOf(".rpc("), `${fn} authorizes before the RPC`);
  }
});

// ── §8 + §15: Action Center lifecycle source is READ-ONLY ─────────────────────
test("lifecycle Action Center source performs no writes and imports no transition", () => {
  for (const f of [LIFECYCLE_SOURCE, ADAPTERS, CENTER, DRAWER]) {
    const s = read(f);
    assert.equal(/transitionProductLifecycle/.test(s), false, `${f} must not import/call the transition boundary`);
    assert.equal(/runLifecycleTransition/.test(s), false, `${f} must not call the transition action`);
    for (const re of [/\.update\(/, /\.insert\(/, /\.delete\(/, /\.upsert\(/, /\.rpc\(/]) {
      assert.equal(re.test(s), false, `${f} must not write (${re})`);
    }
  }
});

// ── §5 + §10/§12/§13: no synthetic candidates, no new heuristic scanner ───────
test("lifecycle adapter emits only READY_FOR_ACTIVATION (no synthetic candidates)", () => {
  const s = read(ADAPTERS);
  const fn = s.slice(s.indexOf("export function actionsFromLifecycle"));
  assert.ok(/type: "READY_FOR_ACTIVATION"/.test(fn), "emits READY_FOR_ACTIVATION");
  for (const t of ["STOP_CANDIDATE", "RESTORE_CANDIDATE", "ARCHIVE_CANDIDATE"]) {
    assert.equal(new RegExp(`type: "${t}"`).test(fn), false, `${t} must not be emitted`);
  }
});

test("lifecycle source is not a heuristic scanner (no time/sales inference)", () => {
  const s = read(LIFECYCLE_SOURCE);
  for (const re of [/\b180\b/, /days?/i, /Date\.now/, /new Date/, /sold_quantity/, /deadStock/, /lastSold|last_sold/]) {
    assert.equal(re.test(s), false, `lifecycle source must not contain ${re}`);
  }
  // it only applies the certified readiness + lifecycle engines
  assert.ok(/computeProductReadiness/.test(s) && /resolveLifecycleState/.test(s), "reuses certified engines");
});

// ── channel / inventory / availability separation + no hard delete ────────────
test("lifecycle source + adapter touch no channel/inventory/availability, no hard delete", () => {
  for (const f of [LIFECYCLE_SOURCE, ADAPTERS]) {
    const s = read(f);
    for (const re of [
      /channel_products/,
      /external_channel_listings/,
      /stock_status/,
      /\.from\(["']products["']\)\s*\.delete\(/,
      /@\/lib\/inventory\/engine/,
      /@\/lib\/availability\/engine/,
    ]) {
      assert.equal(re.test(s), false, `${f} must not match ${re}`);
    }
  }
});

// ── §9: Operations ARCHIVED count reuses product_archive (no second scanner) ──
test("operations page derives ARCHIVED from product_archive (head count)", () => {
  const s = read("app/(v2)/v2/operations/page.tsx");
  assert.ok(/from\(\s*["']product_archive["']\s*\)/.test(s), "reads product_archive");
  assert.ok(/count:\s*["']exact["']/.test(s) && /head:\s*true/.test(s), "uses a head count (no row scan)");
  assert.ok(/buildLifecycleBreakdown\(items, archivedCount\)/.test(s), "passes archived count into the breakdown");
});
