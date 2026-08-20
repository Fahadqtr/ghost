// OPS.2 — Media Center guard (source scan §19). Proves the Media Center is media
// orchestration ONLY: the core is pure, the reader is read-only, recovery/upload
// DELEGATE to existing boundaries, and nothing here writes inventory /
// availability / ECL / barcode / channels / AI. Duplicates are never auto-deleted.
// node --conditions=react-server --experimental-strip-types --test lib/operations/media/ch-ops2-media-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const CORE = "lib/operations/media/media-core.ts";
const READER = "lib/operations/media/media-center.server.ts";
const ACTIONS = "app/(v2)/v2/operations/media-actions.ts";
const COMPONENT = "components/v2/operations/MediaCenter.tsx";
const PAGE = "app/(v2)/v2/operations/media/page.tsx";

test("core is PURE (no @/ imports, no server-only, no DB/SDK)", () => {
  const s = read(CORE);
  assert.equal(/from\s+["']@\//.test(s), false, "no @/ imports");
  assert.equal(/import\s+["']server-only["']/.test(s), false, "not server-only");
  assert.equal(/@anthropic-ai|openai|gemini/i.test(s), false, "no AI SDK");
});

test("reader is server-only and READ-ONLY (no mutations)", () => {
  const s = strip(read(READER));
  assert.ok(/import\s+["']server-only["']/.test(read(READER)), "reader is server-only");
  for (const w of [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/]) {
    assert.equal(w.test(s), false, `reader performs no ${w}`);
  }
});

test("no inventory / availability / ECL / barcode / channel writes anywhere in OPS.2", () => {
  for (const f of [CORE, READER, ACTIONS, COMPONENT, PAGE]) {
    const s = strip(read(f));
    for (const tbl of ["inventory", "external_channel_listings", "platform_status", "channel_products", "channel_variant_mappings"]) {
      assert.equal(new RegExp(`\\.from\\(["']${tbl}["']\\)`).test(s), false, `${f} does not touch table ${tbl}`);
    }
    for (const col of ["stock_quantity", "sold_quantity", "stock_status", "channel_status", "barcode"]) {
      assert.equal(new RegExp(`\\.update\\([^)]*${col}`).test(s), false, `${f} never updates ${col}`);
    }
  }
});

test("no AI generation anywhere in OPS.2 (media only)", () => {
  for (const f of [CORE, READER, ACTIONS, COMPONENT, PAGE]) {
    assert.equal(/@anthropic-ai|generateContent|gemini|openai/i.test(read(f)), false, `${f} invokes no AI`);
  }
});

test("recovery DELEGATES to the LIVE pipeline — OPS.2 re-implements no recovery logic", () => {
  const s = strip(read(ACTIONS));
  // MEDIA.1C-HOTFIX2: scan = live discovery batch; apply = MEDIA.1C recovery per
  // item. The legacy CH.6B SPI-port scan (hardcoded session_required) is gone.
  assert.ok(/scanSnoonuMissingImagesLive\(/.test(s) && /recoverSnoonuImage\(/.test(s), "delegates to the live scan + MEDIA.1C recovery");
  assert.equal(/scanSnoonuMissingImages\(|applySnoonuImageImports\(|image-recovery\.server/.test(s), false, "legacy CH.6B delegation removed");
  // the delegating action holds no DB/admin client and issues no queries of its own
  assert.equal(/createAdminClient\(|createClient\(|\.from\(/.test(s), false, "actions hold no DB client / issue no queries");
  // apply is writer-gated inside CH.6B (asserted by CH.6B's own guard); OPS.2 must
  // not add a second, weaker write path — no direct storePrimaryProductImage here.
  assert.equal(/storePrimaryProductImage/.test(s), false, "no parallel image write path in the action");
});

test("reader reuses the pure composer; performs no image fetch/write itself", () => {
  const s = strip(read(READER));
  assert.ok(/buildMediaDashboard\(|detectDuplicates\(/.test(s), "reader composes via the pure core");
  assert.equal(/storePrimaryProductImage|safeFetchImage|fetch\(/.test(s), false, "reader never fetches or stores an image");
});

test("duplicate detection never auto-deletes (report only)", () => {
  const core = strip(read(CORE));
  assert.equal(/\bdelete\b|removeProductImage|removeProductMedia/.test(core), false, "core has no delete/remove path");
  const comp = read(COMPONENT);
  assert.ok(/للقراءة فقط/.test(comp), "duplicate panel is labelled read-only");
});

test("client component holds no DB client, issues no queries, performs no server action of its own", () => {
  const s = read(COMPONENT);
  assert.ok(/"use client"/.test(s), "is a client component");
  for (const bad of [/createAdminClient/, /createClient\(/, /@\/lib\/supabase/, /\.from\(/, /"use server"/]) {
    assert.equal(bad.test(s), false, `component must not contain ${bad}`);
  }
  // manual upload reuses the existing per-product editor via a deep link, not a new writer
  assert.ok(/\/v2\/catalog\/\$\{[^}]+\}\/edit/.test(s), "links to the existing product media editor for manual upload");
});

test("page gates the recover affordance on the writer allow-list; render is read-only", () => {
  const s = strip(read(PAGE));
  assert.ok(/requireMalakWriter\(/.test(s) && /canWrite/.test(s), "page computes + passes canWrite");
  assert.ok(/loadMediaCenter\(/.test(s), "page loads the read-only view");
});
