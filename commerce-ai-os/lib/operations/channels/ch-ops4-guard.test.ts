// OPS.4 — Channel Operations Completion guard (source scan §14). Proves the four
// gap-closers are READ-ONLY orchestration: pure cores stay pure; the new server
// readers are server-only and issue no writes; no new event-writer ledger exists;
// merchant session material never reaches the client; the CH.6F classifier is not
// duplicated; Talabat variant grain is preserved; and Rafeeq conflicts remain
// manual. Deep-link params are validated against canonical registries.
// node --conditions=react-server --experimental-strip-types --test lib/operations/channels/ch-ops4-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const PURE = [
  "lib/operations/channels/snoonu-operational.ts",
  "lib/operations/channels/gap-counts.ts",
  "lib/operations/channels/activity.ts",
  "lib/operations/channels/deep-link.ts",
];
const READERS = [
  "lib/operations/channels/snoonu-malikas-reader.server.ts",
  "lib/operations/channels/gap-counts.server.ts",
  "lib/operations/channels/activity.server.ts",
];
const COMPONENT = "components/v2/operations/ChannelCommandCenter.tsx";

const WRITE_PATTERNS = [/\.insert\(/, /\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /createAdminClient/];

// ── pure cores stay pure ────────────────────────────────────────────────────────
test("OPS.4 pure cores are PURE (no @/ imports, no server-only, no DB/SDK)", () => {
  for (const f of PURE) {
    const s = read(f);
    assert.equal(/from\s+["']@\//.test(s), false, `${f} has no @/ imports`);
    assert.equal(/import\s+["']server-only["']/.test(s), false, `${f} is not server-only`);
    assert.equal(/@anthropic-ai|openai|gemini/i.test(s), false, `${f} has no AI SDK`);
    const t = strip(s);
    for (const w of [...WRITE_PATTERNS, /\.from\(/, /createClient/, /fetch\(/, /process\.env/]) {
      assert.equal(w.test(t), false, `${f} performs no IO (${w})`);
    }
  }
});

// ── new server readers are server-only + READ-ONLY (no writes) ──────────────────
test("OPS.4 server readers are server-only and introduce NO writes", () => {
  for (const f of READERS) {
    assert.ok(/import\s+["']server-only["']/.test(read(f)), `${f} is server-only`);
    const s = strip(read(f));
    for (const w of WRITE_PATTERNS) assert.equal(w.test(s), false, `${f} performs no ${w}`);
  }
});

test("no inventory / availability / ECL / channel write columns or publish/sync mutation", () => {
  for (const f of [...PURE, ...READERS]) {
    const s = strip(read(f));
    for (const col of ["stock_quantity", "sold_quantity", "stock_status", "channel_status", "inv_sell", "applySnoonuAvailability", "applyBarcodeCompletion", "writeEclMapping", "applyEclRepairs", "importOneProduct"]) {
      assert.equal(new RegExp(col).test(s), false, `${f} must not reference ${col}`);
    }
  }
});

// ── no new event-writer ledger (§14) ────────────────────────────────────────────
test("the activity model READS existing sources — it creates no new write-side ledger", () => {
  const core = strip(read("lib/operations/channels/activity.ts"));
  const reader = strip(read("lib/operations/channels/activity.server.ts"));
  // the reader only selects/orders/limits; never inserts an event anywhere
  for (const w of WRITE_PATTERNS) assert.equal(w.test(reader), false, `activity reader performs no ${w}`);
  assert.ok(/\.select\(/.test(reader) && /\.order\(/.test(reader) && /\.limit\(/.test(reader), "activity reader is a bounded read");
  assert.ok(/malak_audit/.test(reader) && /talabat_orders/.test(reader), "reads existing recorded sources");
  // the pure core never invents an id/timestamp (no clock/random) → no synthetic events
  assert.equal(/Date\.now|Math\.random|new Date\(/.test(core), false, "activity core has no clock/random (no synthesized events)");
});

// ── gap counts are bounded + do NOT duplicate the CH.6F classifier ──────────────
test("gap counts use bounded COUNT reads and never run the CH.6F scan/classifier", () => {
  const reader = strip(read("lib/operations/channels/gap-counts.server.ts"));
  assert.ok(/count:\s*["']exact["']/.test(reader) && /head:\s*true/.test(reader), "uses COUNT-only head queries (bounded)");
  for (const bad of ["scanMissingProducts", "readOnlyGapReport", "scanInternal", "computeSnoonuDiagnostics", "missing-products", "discovery"]) {
    assert.equal(reader.includes(bad), false, `gap reader must not reuse CH.6F ${bad}`);
  }
});

// ── Talabat variant grain preserved (§6) ────────────────────────────────────────
test("Talabat gap counts stay variant-grain (denominator is the variant total)", () => {
  const s = read("lib/operations/channels/gap-counts.ts");
  assert.ok(/listingGrain === "variant"/.test(s), "variant grain selects the variant denominator");
  assert.ok(/variantsTotal/.test(s), "a variant total is used as the denominator");
});

// ── Rafeeq conflicts remain manual (§7) ─────────────────────────────────────────
test("no auto-resolution of Rafeeq (or any) conflicts anywhere in OPS.4", () => {
  for (const f of [...PURE, ...READERS, "lib/operations/channels/channel-center.ts", COMPONENT]) {
    const s = strip(read(f));
    for (const bad of [/autoResolve/i, /resolveConflict/i, /autoPublish/i, /\bpublish\(/i]) {
      assert.equal(bad.test(s), false, `${f} must not contain ${bad}`);
    }
  }
});

// ── no merchant secrets client-side (§12) ───────────────────────────────────────
test("merchant session material never reaches the client", () => {
  const comp = read(COMPONENT);
  for (const bad of [/MERCHANT_SESSION/, /process\.env/, /createClient\(/, /@\/lib\/supabase/, /SNOONU_[A-Z_]*SESSION/]) {
    assert.equal(bad.test(comp), false, `component must not contain ${bad}`);
  }
  // the reader delegates to the CH.6B session factory and reads STATE only — it
  // holds no env/secret itself and returns no cookies/tokens (scan code, not comments)
  const reader = strip(read("lib/operations/channels/snoonu-malikas-reader.server.ts"));
  assert.ok(/createSnoonuMerchantSession\(/.test(reader), "delegates to the existing session factory");
  assert.equal(/process\.env|SNOONU_[A-Z_]*SESSION|cookie|token/i.test(reader), false, "reader holds no secret / returns no session material");
  // and it never persists a snapshot (no approved snoonu write boundary)
  assert.equal(/saveSnapshot|captureSnapshots|platform_snapshots/.test(reader), false, "reader persists nothing");
});

// ── deep-link safety (§9) ───────────────────────────────────────────────────────
test("deep-link validators check canonical registries — no arbitrary URL passthrough", () => {
  const s = read("lib/operations/channels/deep-link.ts");
  assert.ok(/storefronts\.ts/.test(s) && /channel-model\.ts/.test(s) && /discovery-model\.ts/.test(s), "validates against CH.5/CH.6F registries");
  // target pages consume params only through the validators (never raw)
  const pages = {
    "app/(v2)/v2/operations/missing-products/page.tsx": ["resolveStorefront", "validGapStatus"],
    "app/(v2)/v2/operations/availability-sync/page.tsx": ["resolveStorefront"],
    "app/(v2)/v2/operations/media/page.tsx": ["resolveStorefront"],
    "app/(v2)/v2/operations/ai-enrichment/page.tsx": ["validFromList"],
  };
  for (const [page, validators] of Object.entries(pages)) {
    const src = read(page);
    for (const v of validators) assert.ok(src.includes(v), `${page} validates params via ${v}`);
  }
});

// ── the command-center page + reader stay read-only ─────────────────────────────
test("the channel-center reader stays read-only and reuses the single aggregated read", () => {
  const s = strip(read("lib/operations/channels/channel-center.server.ts"));
  for (const w of WRITE_PATTERNS) assert.equal(w.test(s), false, `channel-center reader performs no ${w}`);
  assert.ok(/loadOperationsDashboard\(/.test(s), "reuses the single aggregated operations read");
  assert.ok(/loadChannelGapCounts\(/.test(s) && /loadSnoonuMalikasOperational\(/.test(s) && /loadChannelActivity\(/.test(s), "composes the OPS.4 readers");
});
