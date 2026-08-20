// MEDIA.1C-HOTFIX3 — identity-search diagnostic guard (source scan). The
// diagnostic exists to produce RUNTIME evidence on the deployed app (transport
// outcome, raw vs exact-filtered counts, the portal's own identifier sample)
// for why identity searches do not SAFE_MATCH. It must stay OWNER-ONLY,
// READ-ONLY, and free of secret material.
// node --conditions=react-server --experimental-strip-types --test lib/adapters/snoonu/merchant/diagnostics-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const ADAPTER = "lib/adapters/snoonu/merchant/live-adapter.server.ts";
const DIAG = "lib/adapters/snoonu/merchant/diagnostics.server.ts";
const ACTION = "app/(v2)/v2/operations/media/discovery/actions.ts";
const PANEL = "components/v2/operations/SnoonuSearchDiagnostics.tsx";
const PAGE = "app/(v2)/v2/operations/media/discovery/page.tsx";

const WRITES = [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/];

test("adapter diagnostic: verified builders only; the sample exposes ONLY product identifiers", () => {
  const raw = read(ADAPTER);
  assert.ok(/diagnoseSnoonuSearchModes/.test(raw), "diagnostic exists");
  // requests are built ONLY by the verified pure builders (no invented body)
  assert.ok(/buildIdentitySearchBody\(config\.businessUnitId,\s*t\)/.test(raw), "identity modes use the verified builder");
  assert.ok(/buildNameSearchBody\(config\.businessUnitId,\s*t\)/.test(raw), "name mode uses the verified builder");
  // the sample carries product identifiers only — never config/header material
  const sampleBlock = /sample:\s*first\s*\?\s*\{([^}]*)\}/.exec(raw)?.[1] ?? "";
  assert.ok(sampleBlock.length > 0, "sample block present");
  assert.deepEqual(
    [...sampleBlock.matchAll(/(\w+):/g)].map((m) => m[1]).sort(),
    ["barcode", "name", "sku", "spi"],
    "sample fields are exactly spi/sku/barcode/name",
  );
});

test("diagnostics server: OWNER-ONLY, read-only, no secret in the return path", () => {
  const raw = read(DIAG);
  assert.ok(/import\s+["']server-only["']/.test(raw), "server-only");
  assert.ok(/requireOwner\(\)/.test(raw), "owner gate before any portal read");
  const s = strip(raw);
  for (const bad of [...WRITES, /storePrimaryProductImage/, /process\.env/, /\bfetch\(/, /console\./, /headers/, /Authorization/, /Cookie/, /password/i]) {
    assert.equal(bad.test(s), false, `${DIAG} must not contain ${bad}`);
  }
  assert.ok(/\.from\("products"\)[\s\S]*\.select\(/.test(raw), "reads the product read-only");
});

test("action + page: diagnostic reachable only through the gated action, rendered owner-only", () => {
  const action = read(ACTION);
  assert.ok(/diagnoseSnoonuIdentityAction/.test(action), "action exists");
  assert.ok(/runSnoonuIdentityDiagnostic\(/.test(action), "delegates to the owner-gated server module");
  const page = read(PAGE);
  assert.ok(/\{owner && view\?\.query\?\.productId \? <SnoonuSearchDiagnostics/.test(page), "panel renders for the owner only");
});

test("diagnostic panel: presentational — no direct IO, whitelisted imports only", () => {
  const raw = read(PANEL);
  assert.ok(/^"use client";/.test(raw), "client component");
  const s = strip(raw);
  for (const bad of [/\bfetch\(/, /createClient/, /\.from\(["'`]/, ...WRITES, /process\.env/, /localStorage/, /document\.cookie/]) {
    assert.equal(bad.test(s), false, `${PANEL} must not contain ${bad}`);
  }
  const imports = [...raw.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  for (const i of imports) {
    assert.ok(
      i === "react" || i.startsWith("@/app/(v2)/v2/operations/media/discovery/actions") || i.startsWith("@/lib/adapters/snoonu/merchant/"),
      `unexpected import in diagnostics panel: ${i}`,
    );
  }
});
