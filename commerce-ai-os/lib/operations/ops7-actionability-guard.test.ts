// OPS.7 — Operations Actionability Wiring guard (source scan §11).
//
// Proves this phase is routing/orchestration only: the resolver + barcode-filter
// are pure; the Operations UI stays read-only (navigation, no writes/actions);
// the page adds no direct table write and does not duplicate the full Action
// list (ownership split — it embeds only the summary strip); the hardened legacy
// lifecycle actions gate BEFORE any write; and no hard-delete is exposed from V2.
// node --conditions=react-server --experimental-strip-types --test lib/operations/ops7-actionability-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  const rest = src.slice(start + 1);
  const next = rest.indexOf("\nexport ");
  return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
}
function firstIdx(body: string, toks: string[]): number {
  let min = Infinity;
  for (const t of toks) { const i = body.indexOf(t); if (i !== -1 && i < min) min = i; }
  return min;
}

const ISSUE_RESOLVER = "lib/operations/issue-resolver.ts";
const BARCODE_FILTER = "lib/operations/barcode-filter.ts";
const OPS_CENTER_UI = "components/v2/operations/OperationsCenter.tsx";
const OPS_DASH_UI = "components/v2/operations/OperationsDashboard.tsx";
const OWNER_STRIP = "components/v2/operations/OwnerActionsStrip.tsx";
const OPS_PAGE = "app/(v2)/v2/operations/page.tsx";
const PRODUCTS_ACTIONS = "app/(app)/products/actions.ts";
const CHANNELS_ACTIONS = "app/(app)/channels/actions.ts";

const WRITES = [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /createAdminClient/, /createClient\(/];
const BUSINESS = [/scanMissingProducts\(/, /computeAnalytics\(/, /loadOperationsDashboard\(/, /writeProductAvailability/, /inv_[a-z]/, /external_channel_listings/];

// ── the resolver + barcode-filter are pure routing (no detection, no IO) ──────
test("issue-resolver + barcode-filter are pure (no @/ runtime import, no IO/writes/clock/business logic)", () => {
  for (const f of [ISSUE_RESOLVER, BARCODE_FILTER]) {
    const raw = read(f);
    assert.equal(/from\s+["']@\//.test(raw), false, `${f} has no @/ runtime import`);
    assert.equal(/import\s+["']server-only["']/.test(raw), false, `${f} not server-only`);
    const s = strip(raw);
    for (const bad of [...WRITES, ...BUSINESS, /\.from\(/, /fetch\(/, /process\.env/, /Date\.now/, /new Date\(/]) {
      assert.equal(bad.test(s), false, `${f} must not contain ${bad}`);
    }
  }
});

// ── the Operations UI stays read-only navigation ──────────────────────────────
test("Operations UI components perform no writes, no server actions, no data client", () => {
  for (const f of [OPS_CENTER_UI, OPS_DASH_UI, OWNER_STRIP]) {
    const s = strip(read(f));
    for (const bad of [...WRITES, /@\/lib\/supabase/, /"use server"/, /\.from\(/, /fetch\(/]) {
      assert.equal(bad.test(s), false, `${f} must not contain ${bad}`);
    }
  }
  // they navigate via next/link only
  assert.ok(/from\s+["']next\/link["']/.test(read(OWNER_STRIP)), "strip navigates via next/link");
});

// ── the page adds no direct table write and keeps the ownership split ──────────
test("operations page embeds the Owner-Actions summary (not a duplicated action list) and writes no table", () => {
  const s = strip(read(OPS_PAGE));
  assert.ok(/loadActionCenter\(/.test(s), "reuses the AI.1 read model");
  assert.ok(/OwnerActionsStrip/.test(s), "renders the summary strip");
  assert.ok(/<Suspense/.test(s), "streams the summary (does not block the dashboard scan)");
  // ownership split: the page must NOT render the full Action Center list component
  assert.equal(/<ActionCenter\b/.test(s), false, "no duplicated full action list in Operations");
  for (const w of [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/]) {
    assert.equal(w.test(s), false, `operations page issues no direct table write (${w})`);
  }
});

// ── §7 legacy lifecycle actions gate BEFORE any write ─────────────────────────
test("deleteProduct is OWNER-gated before the hard delete", () => {
  const body = fnBody(read(PRODUCTS_ACTIONS), "deleteProduct");
  const gate = body.indexOf("requireOwner");
  assert.notEqual(gate, -1, "deleteProduct calls requireOwner");
  const write = firstIdx(body, [".delete(", ".rpc(", "createClient("]);
  assert.ok(gate < write, `owner gate precedes the delete (gate@${gate} < write@${write})`);
  assert.equal(/isSignedIn\(\)/.test(body), false, "no longer login-only");
});

test("setProductStatus + setChannelStatus are writer-gated before any write", () => {
  const sps = fnBody(read(PRODUCTS_ACTIONS), "setProductStatus");
  assert.ok(sps.indexOf("requireMalakWriter") !== -1 && sps.indexOf("requireMalakWriter") < firstIdx(sps, [".update(", ".from("]), "setProductStatus writer-gated before write");
  const scs = fnBody(read(CHANNELS_ACTIONS), "setChannelStatus");
  assert.ok(scs.indexOf("requireMalakWriter") !== -1 && scs.indexOf("requireMalakWriter") < firstIdx(scs, [".update(", ".upsert(", ".from("]), "setChannelStatus writer-gated before write");
});

// ── no hard-delete exposed from V2 ────────────────────────────────────────────
test("no V2 Operations surface exposes the hard-delete action", () => {
  for (const f of [OPS_CENTER_UI, OPS_DASH_UI, OWNER_STRIP, OPS_PAGE, ISSUE_RESOLVER]) {
    assert.equal(/deleteProduct\b/.test(read(f)), false, `${f} must not reference the hard-delete action`);
  }
});
