// CH.6F — Missing Products Discovery guard (source scan §24). Proves the safety
// contract from the source text so a future edit can't silently break it:
//   • no direct product/inventory/availability writes outside the approved cores
//   • import routes through createProductCore + the inventory initializer, seed 0
//   • no channel-quantity → internal-quantity conversion
//   • no fuzzy/name/AI auto-matching
//   • no cross-store Snoonu SPI reuse (storefront_key scoping)
//   • Rafeeq conflicts never auto-resolved; Talabat variant flattening respected
//   • no legacy external-id column writes; ECL is the only durable identity
//   • every apply is writer-gated (CH.3b); scan is read-only
// node --conditions=react-server --experimental-strip-types --test lib/missing-products/ch6f-missing-products-guard.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const D = "lib/missing-products";
const PURE = [`${D}/discovery-model.ts`, `${D}/discovery-match.ts`, `${D}/discovery-classify.ts`, `${D}/discovery-plan.ts`];
const SOURCE = `${D}/discovery-source.server.ts`;
const ORCH = `${D}/discovery.server.ts`;
const ECL_WRITE = `${D}/ecl-repair-write.server.ts`;
const IMPORT = `${D}/catalog-import.server.ts`;
const SERVER = [SOURCE, ORCH, ECL_WRITE, IMPORT];
const ACTIONS = "app/(v2)/v2/operations/missing-products-actions.ts";
const COMPONENT = "components/v2/operations/MissingProducts.tsx";
const PAGE = "app/(v2)/v2/operations/missing-products/page.tsx";

test("pure modules stay pure (no @/ imports, no server-only, no SDK)", () => {
  for (const f of PURE) {
    const s = read(f);
    assert.equal(/from\s+["']@\//.test(s), false, `${f} pure`);
    assert.equal(/import\s+["']server-only["']/.test(s), false, `${f} not server-only`);
    assert.equal(/@anthropic-ai|openai|gemini/i.test(s), false, `${f} no AI SDK`);
  }
});

test("server modules are server-only", () => {
  for (const f of SERVER) assert.ok(/import\s+["']server-only["']/.test(read(f)), `${f} is server-only`);
});

test("storefront model mirrors the CH.5 registry (no drift)", () => {
  const model = read(`${D}/discovery-model.ts`);
  for (const k of ["shopify:malikas", "snoonu:malikas", "snoonu:pure_seoul", "talabat:malikas", "rafeeq:malikas"]) {
    assert.ok(model.includes(`"${k}"`), `model lists ${k}`);
  }
});

test("scan is read-only + the orchestrator/source perform NO direct table mutations", () => {
  for (const f of [ORCH, SOURCE]) {
    const s = strip(read(f));
    for (const w of [/\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/, /\.insert\(/]) {
      assert.equal(w.test(s), false, `${f} performs no direct table write (matched ${w})`);
    }
  }
});

test("ECL identity only — never reads or writes legacy id columns (§22)", () => {
  for (const f of [...SERVER, ACTIONS]) {
    const s = strip(read(f));
    for (const legacy of ["snoonu_id", "pure_seoul_id", "rafeeq_product_id"]) {
      // legacy columns may appear only as an identity_type STRING value, never as a products column write/read
      assert.equal(new RegExp(`\\.eq\\(["']${legacy}["']`).test(s), false, `${f} never filters on legacy column ${legacy}`);
      assert.equal(new RegExp(`update\\([^)]*${legacy}`).test(s), false, `${f} never writes legacy column ${legacy}`);
    }
  }
  // the durable identity table IS used, storefront-scoped
  const src = strip(read(SOURCE));
  assert.ok(/external_channel_listings/.test(src), "reads the ECL table");
  assert.ok(/storefront_key/.test(src), "storefront-scoped read (cross-store isolation §6)");
});

test("ECL read is storefront-scoped; the two Snoonu stores never share a snapshot source (no cross-store SPI reuse §6)", () => {
  const src = strip(read(SOURCE));
  assert.ok(/\.eq\("storefront_key",\s*storefront\)/.test(src), "filters by the exact storefront key");
  // Malikas + Pure Seoul map to DISTINCT snapshot platforms (null vs pure_seoul),
  // so SPI evidence can never leak across the two Snoonu storefronts.
  assert.ok(/"snoonu:malikas":\s*null/.test(src), "snoonu:malikas has no shared snapshot platform");
  assert.ok(/"snoonu:pure_seoul":\s*"pure_seoul"/.test(src), "pure_seoul reads its own platform only");
});

test("ECL write boundary is INSERT-only, whitelisted, forces active, no stock column", () => {
  const w = strip(read(ECL_WRITE));
  assert.ok(/\.insert\(/.test(w), "creates rows via insert");
  for (const forbidden of [/\.update\(/, /\.upsert\(/, /\.delete\(/, /\.rpc\(/]) {
    assert.equal(forbidden.test(w), false, `write boundary never ${forbidden} (no overwrite §12)`);
  }
  assert.ok(/mapping_status:\s*["']active["']/.test(w), "forces mapping_status active");
  for (const banned of ["stock_quantity", "channel_stock", "quantity", "availability", "channel_status", "stock_status"]) {
    assert.equal(new RegExp(`["']${banned}["']`).test(w), false, `ECL write never names ${banned}`);
  }
});

test("product import routes ONLY through the approved create core + inventory initializer, seed 0", () => {
  const imp = strip(read(IMPORT));
  assert.ok(/createProductCore\(/.test(imp), "uses createProductCore");
  assert.ok(/makeInventoryInitializer\(/.test(imp), "uses the RPC-protected inventory initializer");
  assert.ok(/seedQuantity:\s*0/.test(imp), "seeds inventory at 0 (policy, not channel quantity §2/§11)");
  assert.ok(/approval:\s*""/.test(imp) && /platform_status:\s*""/.test(imp), "imported products are unapproved + channel-invisible");
  // never a direct products/inventory/variants INSERT
  for (const tbl of ["products", "product_variants", "inventory"]) {
    assert.equal(new RegExp(`\\.from\\(["']${tbl}["']\\)`).test(imp), false, `${IMPORT} never touches table ${tbl} directly`);
  }
});

test("no channel-quantity → internal-quantity conversion anywhere (§2)", () => {
  for (const f of SERVER) {
    const s = strip(read(f));
    assert.equal(/channel_stock/.test(s), false, `${f} never reads channel_stock`);
    // no assignment of an external/channel quantity into a stock field
    assert.equal(/stock_quantity[^"']*=[^=]*(channel|external|snapshot)/i.test(s), false, `${f} never copies channel qty into stock`);
  }
});

test("no availability writes anywhere in the flow (§2)", () => {
  for (const f of SERVER) {
    const s = strip(read(f));
    assert.equal(/\.update\([^)]*stock_status/.test(s), false, `${f} never writes stock_status`);
    assert.equal(new RegExp(`\\.from\\(["']platform_status["']\\)`).test(s), false, `${f} never writes platform_status table`);
  }
});

test("no fuzzy / name / AI automatic matching (§4)", () => {
  for (const f of [...PURE, ...SERVER]) {
    const s = strip(read(f)); // strip so a comment saying "never fuzzy" doesn't count as usage
    assert.equal(/jaccard|fuzzy|levenshtein|similarity|semantic/i.test(s), false, `${f} uses no fuzzy/similarity matching`);
    assert.equal(/@anthropic-ai|openai|gemini|generateContent/i.test(s), false, `${f} uses no AI generation`);
  }
  // the matcher keys on ids/sku/barcode, never on the product name text
  const match = strip(read(`${D}/discovery-match.ts`));
  assert.equal(/name.*(match|includes|===|indexOf)/i.test(match), false, "matcher never compares names");
});

test("Rafeeq contested mappings are preserved as NEEDS_REVIEW, never auto-resolved (§7)", () => {
  const plan = strip(read(`${D}/discovery-plan.ts`));
  assert.ok(/needs_review/.test(plan) && /NEEDS_REVIEW/.test(plan), "needs_review ECL rows classify to NEEDS_REVIEW");
  // a NEEDS_REVIEW item is never a deterministic repair candidate
  assert.ok(/status === "MISSING_ECL" && it\.confidence === "DETERMINISTIC"/.test(plan), "only deterministic MISSING_ECL is repairable");
});

test("Talabat variant flattening respected — parent-level mapping never hides a missing variant (§8)", () => {
  const plan = strip(read(`${D}/discovery-plan.ts`));
  assert.ok(/VARIANT_CONFLICT/.test(plan), "emits VARIANT_CONFLICT");
  assert.ok(/parent.?level|eclProductLevel/.test(plan), "detects a product-level mapping on a variant-grain storefront");
});

test("every apply path is writer-gated (CH.3b) — twice: ECL repair AND import", () => {
  const orch = strip(read(ORCH));
  assert.ok((orch.match(/requireMalakWriter\(/g) ?? []).length >= 2, "ECL repair AND import both gate on the writer allow-list");
  // scan does NOT require the writer gate (read-only, signed-in only)
  assert.ok(/isSignedIn\(/.test(orch), "scan uses the signed-in gate");
});

test("every applied change is audited (actor, channel, storefront, identity, action, result, reason)", () => {
  const orch = strip(read(ORCH));
  assert.ok(/insertAuditRow\(/.test(orch), "records audit rows");
  for (const key of ["actor", "channel", "storefront", "external_identity", "action", "result", "reason"]) {
    assert.ok(new RegExp(key).test(orch), `audit carries ${key}`);
  }
});

test("actions delegate to the orchestrator — no DB/admin client, no direct queries", () => {
  const s = strip(read(ACTIONS));
  assert.equal(/createAdminClient\(|createClient\(/.test(s), false, "actions hold no DB client");
  assert.equal(/\.from\(/.test(s), false, "actions issue no direct queries");
});

test("client component holds no DB/admin client and issues no queries", () => {
  const s = read(COMPONENT);
  assert.ok(/"use client"/.test(s), "is a client component");
  for (const bad of [/createAdminClient/, /createClient\(/, /@\/lib\/supabase/, /\.from\(/, /@anthropic-ai/]) {
    assert.equal(bad.test(s), false, `component must not contain ${bad}`);
  }
});

test("page gates repair/import affordance on the writer allow-list", () => {
  const s = strip(read(PAGE));
  assert.ok(/requireMalakWriter\(/.test(s) && /canWrite/.test(s), "page computes + passes canWrite");
});

test("no product is created and no mapping written outside the approved boundaries", () => {
  // orchestrator writes ONLY via writeEclMapping + importOneProduct (create core)
  const orch = strip(read(ORCH));
  assert.ok(/writeEclMapping\(/.test(orch), "mappings only via the ECL boundary");
  assert.ok(/importOneProduct\(/.test(orch), "products only via the import boundary (create core)");
  assert.equal(/\.from\(["']external_channel_listings["']\)\s*\.insert/.test(orch), false, "orchestrator never inserts ECL directly");
});
