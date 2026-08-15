// INV.4E — function-level guard for the archive/restore server actions + the
// mirror-retirement of the daily writers.
//
// Pins that app/(app)/products/archive/actions.ts:
//   * archives via the archive_product_bundle RPC and restores via the
//     restore_product_archive RPC;
//   * performs NO direct product / inventory / variant / shelf / channel write of
//     its own (the atomic RPCs own every mutation);
//   * maps restore reasons to fixed Arabic (never a raw DB message);
//   * runs only a best-effort, READ-ONLY reconcile after a successful restore;
//   * never mutates stock_status (availability).
// Plus: movements.ts stays a legacy direct writer (untouched by INV.4E).
//
// PURE — source scan only. Run:
// node --conditions=react-server --experimental-strip-types --test lib/inventory/inv-4e-writer-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const ARCHIVE = strip(read("app/(app)/products/archive/actions.ts"));

// Any direct write to a live catalog table (insert/update/upsert/delete).
const directWrite = (table: string) =>
  new RegExp(`\\.from\\(\\s*["']${table}["']\\s*\\)\\s*\\.(insert|update|upsert|delete)`);

// ── archive/restore route through the atomic RPCs ─────────────────────────────

test("archive uses the archive_product_bundle RPC", () => {
  assert.ok(/\.rpc\(\s*["']archive_product_bundle["']/.test(ARCHIVE), "archiveAndDeleteProducts calls the archive RPC");
});

test("restore uses the restore_product_archive RPC", () => {
  assert.ok(/\.rpc\(\s*["']restore_product_archive["']/.test(ARCHIVE), "restoreFromArchive calls the restore RPC");
});

// ── no direct dependent-row write remains in the action ───────────────────────

test("archive action performs NO direct product/inventory/variant/shelf/channel write", () => {
  for (const t of ["inventory", "product_variants", "shelf_stock", "variant_shelf_stock", "channel_products"]) {
    assert.equal(directWrite(t).test(ARCHIVE), false, `no direct ${t} write (the RPC owns it)`);
  }
  // The only products write allowed is NONE — archive/restore both go via RPC.
  assert.equal(/\.from\(\s*["']products["']\s*\)\s*\.(insert|update|upsert|delete)/.test(ARCHIVE), false,
    "no direct products insert/update/delete (RPCs only)");
});

test("restore no longer re-inserts dependents verbatim (that is the RPC's job now)", () => {
  assert.equal(/\.from\(\s*["']inventory["']\s*\)\s*\.insert/.test(ARCHIVE), false, "no client-side inventory re-insert");
  assert.equal(/\.from\(\s*["']product_variants["']\s*\)\s*\.insert/.test(ARCHIVE), false, "no client-side variant re-insert");
});

// ── safety: fixed Arabic messages, read-only verification, no availability ─────

test("restore maps reasons to fixed Arabic and never surfaces a raw DB message", () => {
  assert.ok(/RESTORE_REASON_AR/.test(ARCHIVE), "a fixed reason→Arabic map exists");
  assert.ok(/restoreReasonAr\(/.test(ARCHIVE), "restore maps the RPC reason to Arabic");
  // no `error.message` from a restore path leaking to the client
  assert.equal(/return \{ error: [a-zA-Z_.]*\.message \}/.test(ARCHIVE), false, "no raw DB message returned");
});

test("post-restore verification is READ-ONLY reconcile (never a repair write)", () => {
  assert.ok(/import \{ reconcile \} from "@\/lib\/inventory\/reconcile"/.test(read("app/(app)/products/archive/actions.ts")),
    "imports the read-only reconcile");
  assert.ok(/await reconcile\(admin, result\.productId\)/.test(ARCHIVE), "verifies via reconcile after a successful restore");
  // reconcile is read-only by contract (lib/inventory/reconcile.ts) — the action
  // must not itself write anything to fix a surprising verdict.
});

test("archive/restore never mutate stock_status (availability boundary)", () => {
  assert.equal(/stock_status/.test(ARCHIVE), false, "archive/restore never touch availability");
});

// ── out-of-scope writers stay as they were ────────────────────────────────────

test("movements.ts stays a legacy direct writer (untouched by INV.4E)", () => {
  const mv = strip(read("lib/inventory/movements.ts"));
  assert.ok(/\.from\(\s*["']inventory["']\s*\)\s*\.update\(/.test(mv), "movements still does its direct RMW (INV.4E leaves it)");
});
