// MEDIA.2 — Bulk Snoonu Image Recovery guard (source scan). Proves the bulk
// surface is ORCHESTRATION ONLY around the certified per-product pipeline:
//   • the pure model stays pure; the UI holds no DB client / fetch / env and
//     recovers ONLY through the per-item server action (MEDIA.1C inside);
//   • the bulk loop is sequential, records failures without aborting, and
//     cancel is checked at the top of the loop (after the current product);
//   • bulk selection is structurally SAFE-only (safeRecoveryRows) and every
//     call pins the previewed SPI; NEEDS_REVIEW recovers only via an explicit
//     per-row approval — never inside runBulk;
//   • no inventory / price / lifecycle / ECL / channel-publish tokens anywhere;
//   • the action recovers exactly ONE product per call (no second bulk write
//     path server-side) and adds no DB/media logic of its own.
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/merchant/bulk-recovery-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const MODEL = "lib/adapters/snoonu/merchant/bulk-recovery.ts";
const COMPONENT = "components/v2/operations/SnoonuBulkRecovery.tsx";
const MEDIA_CENTER = "components/v2/operations/MediaCenter.tsx";
const ACTIONS = "app/(v2)/v2/operations/media-actions.ts";

const DB_TOKENS = [/createAdminClient/, /createClient\(/, /@\/lib\/supabase/, /\.from\(/, /\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/];
const WRITE_BOUNDARIES = [/storePrimaryProductImage/, /safeFetchImage/, /imageStore/, /writeEclMapping/];
const FORBIDDEN_DOMAINS = [/stock_quantity/, /sold_quantity/, /\bprice\b/i, /lifecycle/i, /external_channel_listings/, /platform_status/, /publishTo/i];

test("pure bulk model: pure, and free of IO / writes / secrets", () => {
  const raw = read(MODEL);
  assert.equal(/import\s+["']server-only["']/.test(raw), false, "model stays pure");
  assert.equal(/from\s+["']@\//.test(raw), false, "no @/ import");
  const s = strip(raw);
  for (const bad of [/process\.env/, /\bfetch\(/, /Date\.now/, ...DB_TOKENS, ...WRITE_BOUNDARIES, ...FORBIDDEN_DOMAINS]) {
    assert.equal(bad.test(s), false, `${MODEL} must not contain ${bad}`);
  }
});

test("bulk UI is a client component with NO DB client, NO fetch, NO env, NO write boundary", () => {
  const raw = read(COMPONENT);
  assert.ok(/^"use client";/.test(raw), "client component");
  const s = strip(raw);
  // `.delete(` is excluded here only because the selection Set uses Set.delete;
  // any DB chain is still impossible — `.from(` and every client factory are banned.
  const componentDbTokens = DB_TOKENS.filter((r) => r.source !== /\.delete\(/.source);
  for (const bad of [/"use server"/, /process\.env/, /\bfetch\(/, ...componentDbTokens, ...WRITE_BOUNDARIES, ...FORBIDDEN_DOMAINS]) {
    assert.equal(bad.test(s), false, `${COMPONENT} must not contain ${bad}`);
  }
});

test("every recovery in the bulk UI goes through the per-item action, SPI pinned", () => {
  const s = strip(read(COMPONENT));
  // exactly ONE call site: recoverOne() wraps the action; runBulk + approveReview reuse it
  assert.equal((s.match(/recoverOneSnoonuImageAction\(/g) ?? []).length, 1, "single action call site");
  assert.ok(/recoverOneSnoonuImageAction\(storefront,\s*row\.productId,\s*row\.spi/.test(s), "the previewed SPI is pinned on every call (stale protection)");
});

test("bulk loop: sequential, failure-isolated, cancel checked at the top of the loop", () => {
  const s = strip(read(COMPONENT));
  const loop = /for \(const row of rows\) \{([\s\S]*?)\n    \}/.exec(s)?.[1] ?? "";
  assert.ok(loop.length > 0, "sequential for-of loop exists");
  assert.ok(/if \(cancelRef\.current\) break;/.test(loop), "cancel is checked BEFORE starting the next product (never mid-recovery)");
  assert.ok(/await recoverOne\(row\)/.test(loop), "one awaited recovery per iteration (sequential, no Promise.all)");
  assert.equal(/Promise\.all/.test(s), false, "no parallel recovery fan-out");
  // one failure never aborts: recoverOne catches and returns FAILED for that item only
  assert.ok(/catch \{\s*return \{ productId: row\.productId[\s\S]{0,120}status: "FAILED"/.test(s), "a thrown item is recorded as FAILED and the loop continues");
});

test("bulk selection is structurally SAFE-only; review approval is explicit per-row", () => {
  const s = strip(read(COMPONENT));
  assert.ok(/safeRecoveryRows\(/.test(s), "eligible rows come from the pure SAFE filter");
  assert.ok(/reviewQueueRows\(/.test(s), "review queue uses the pure NEEDS_REVIEW filter");
  // runBulk is invoked with safeRows / selectedRows only — never with reviewRows
  assert.ok(/runBulk\(safeRows\)/.test(s) && /runBulk\(selectedRows\)/.test(s), "bulk runs on SAFE rows only");
  assert.equal(/runBulk\(reviewRows\)/.test(s), false, "review rows are NEVER bulk-recovered");
  assert.ok(/approveReview\(/.test(s), "review recovery requires the explicit per-row approve handler");
});

test("final report + CSV come from the pure model (BOM prepended at save time)", () => {
  const s = strip(read(COMPONENT));
  assert.ok(/summarizeBulk\(/.test(s), "report aggregated by the pure model");
  assert.ok(/buildBulkCsv\(/.test(s), "CSV built by the pure model");
  assert.ok(/\\uFEFF/.test(s), "UTF-8 BOM for Excel-safe Arabic");
});

test("Media Center renders the bulk workspace and keeps no recovery logic of its own", () => {
  const s = strip(read(MEDIA_CENTER));
  assert.ok(/<SnoonuBulkRecovery canWrite=\{canWrite\} initialStorefront=\{initialStorefront\} \/>/.test(s), "MediaCenter delegates to SnoonuBulkRecovery");
  assert.equal(/scanSnoonuImageRecoveryAction|recoverSnoonuImagesAction|recoverOneSnoonuImageAction/.test(s), false, "no recovery action wiring remains in MediaCenter");
});

test("server action recovers exactly ONE product per call through MEDIA.1C — no second bulk path", () => {
  const s = strip(read(ACTIONS));
  assert.ok(/export async function recoverOneSnoonuImageAction\(/.test(s), "per-item action exists");
  assert.equal((s.match(/recoverSnoonuImage\(/g) ?? []).length, 1, "exactly one recovery call site server-side");
  assert.ok(/recoverSnoonuImage\(\{ productId: id, storefrontKey: sf, confirmedSpi: spi \}\)/.test(s), "delegates verbatim to the MEDIA.1C orchestrator");
  assert.equal(/for\s*\(|\.map\(|while\s*\(/.test(s.split("recoverOneSnoonuImageAction")[1] ?? ""), false, "the action holds no loop — bulk pacing lives client-side (cancel/progress)");
  for (const bad of [...DB_TOKENS, ...WRITE_BOUNDARIES]) {
    assert.equal(bad.test(s), false, `${ACTIONS} must not contain ${bad}`);
  }
});

test("review-queue deep link points at the existing discovery page (no duplicate review UI)", () => {
  const raw = read(COMPONENT);
  assert.ok(/\/v2\/operations\/media\/discovery\?productId=/.test(raw), "multi-candidate review reuses the MEDIA.1B/1C discovery page");
});
