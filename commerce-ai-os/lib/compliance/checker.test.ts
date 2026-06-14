// Phase 2 tests — malika-compliance-checker-spec.md §6 checklist (12 cases).
// Run: node --experimental-strip-types --test lib/compliance/checker.test.ts
//
// Cases 1–11 drive the deterministic engine (runChecks) with DEFAULT_RULES
// (mirrors the seeded compliance_rules — incl. decision A1's 17 categories).
// Case 12 exercises the publish gate via an in-memory ComplianceClient.

import test from "node:test";
import assert from "node:assert/strict";

import { runChecks, DEFAULT_RULES } from "./checker.ts";
import {
  assertPublishAllowed,
  guardedPublish,
  PublishBlockedError,
} from "./publishGate.ts";
import { parseVerdict } from "./agent.ts";
import type {
  CheckName,
  ComplianceClient,
  ComplianceLogRow,
  Draft,
  Verdict,
} from "./types.ts";

const R = DEFAULT_RULES;
const sev = (v: Verdict, name: CheckName) => v.checks.find((c) => c.name === name)!.severity;

// A clean, fully-valid draft (uses a REAL category — "Face Care" — per A1).
const clean: Draft = {
  sku: "MCB-ZERO-PORE-PAD-70",
  title_en: "Medicube Zero Pore Pad 2.0 70 Pads",
  title_ar: "ميديكيوب باد المسام صفر 2.0 70 قطعة",
  name_en: "Zero Pore Pad 2.0",
  name_ar: "باد المسام صفر 2.0",
  main_category: "Face Care",
  desc_en: "Daily exfoliating pads that visibly refine the look of pores.",
  desc_ar: "باد تقشير يومي ينعّم مظهر المسام.",
  keywords_en: "pore pad, exfoliating, toner pad, medicube, korean skincare, bha, daily care",
  keywords_ar: "باد مسام, تقشير, تونر باد, ميديكيوب, العناية الكورية, عناية يومية",
  size: "70 Pads",
  price: 89,
  discount_price: null,
  platform_prices: { shopify: 89, snoonu: 89, talabat: 89, rafeeq: 89 },
  image_url: "https://cdn.example.com/mcb-zero-pore-pad-70.jpg",
};

// 1 ---------------------------------------------------------------------------
test("§6.1 clean draft → PASS, publish_allowed=true", () => {
  const v = runChecks(clean, R);
  assert.equal(v.overall, "PASS");
  assert.equal(v.publish_allowed, true);
});

// 2 ---------------------------------------------------------------------------
test("§6.2 يعالج in desc_ar → BLOCK (medical), needs_human", () => {
  const v = runChecks({ ...clean, desc_ar: "كريم يعالج حب الشباب نهائياً" }, R);
  assert.equal(sev(v, "medical_claims"), "BLOCK");
  assert.equal(v.overall, "BLOCK");
  assert.equal(v.needs_human, true);
});

// 3 ---------------------------------------------------------------------------
test("§6.3 'cures acne' in desc_en → BLOCK (medical)", () => {
  const v = runChecks({ ...clean, desc_en: "A formula that cures acne fast." }, R);
  assert.equal(sev(v, "medical_claims"), "BLOCK");
  assert.equal(v.overall, "BLOCK");
});

// 4 ---------------------------------------------------------------------------
test("§6.4 Talabat price ≠ others, no discount → BLOCK (price)", () => {
  const v = runChecks(
    { ...clean, platform_prices: { shopify: 89, snoonu: 89, talabat: 95, rafeeq: 89 }, discount_price: null },
    R
  );
  assert.equal(sev(v, "price_consistency"), "BLOCK");
  assert.equal(v.overall, "BLOCK");
});

// 5 ---------------------------------------------------------------------------
test("§6.5 Talabat price ≠ others, discount set → PASS on price", () => {
  const v = runChecks(
    { ...clean, platform_prices: { shopify: 89, snoonu: 89, talabat: 95, rafeeq: 89 }, discount_price: 79 },
    R
  );
  assert.equal(sev(v, "price_consistency"), "PASS");
  assert.equal(v.overall, "PASS");
});

// 6 ---------------------------------------------------------------------------
test("§6.6 missing title_ar → BLOCK (format)", () => {
  const v = runChecks({ ...clean, title_ar: "" }, R);
  assert.equal(sev(v, "format"), "BLOCK");
  assert.equal(v.overall, "BLOCK");
});

// 7 ---------------------------------------------------------------------------
test("§6.7 SKU 'mcb zero pad' (spaces/lowercase) → BLOCK (format)", () => {
  const v = runChecks({ ...clean, sku: "mcb zero pad" }, R);
  assert.equal(sev(v, "format"), "BLOCK");
  assert.equal(v.overall, "BLOCK");
});

// 8 ---------------------------------------------------------------------------
test("§6.8 main_category 'Skincare' (not locked) → WARN, recommend fallback", () => {
  const v = runChecks({ ...clean, main_category: "Skincare" }, R);
  assert.equal(sev(v, "category"), "WARN");
  assert.equal(v.overall, "WARN");
  assert.equal(v.publish_allowed, true);
  assert.match(v.checks.find((c) => c.name === "category")!.detail, /Uncategorized/);
});

// 9 ---------------------------------------------------------------------------
test("§6.9 only 3 keywords_en → WARN (required_fields)", () => {
  const v = runChecks({ ...clean, keywords_en: "pore pad, exfoliating, toner pad" }, R);
  assert.equal(sev(v, "required_fields"), "WARN");
  assert.equal(v.overall, "WARN");
});

// 10 --------------------------------------------------------------------------
test("§6.10 invented 'ships in 2 hours' → WARN (fabricated)", () => {
  const v = runChecks({ ...clean, desc_en: "Great pads. Ships in 2 hours across Doha." }, R);
  assert.equal(sev(v, "fabricated_data"), "WARN");
  assert.equal(v.overall, "WARN");
});

// 11 --------------------------------------------------------------------------
test("§6.11 http:// (not https) image → BLOCK (image)", () => {
  const v = runChecks({ ...clean, image_url: "http://cdn.example.com/x.jpg" }, R);
  assert.equal(sev(v, "image"), "BLOCK");
  assert.equal(v.overall, "BLOCK");
});

// 12 --------------------------------------------------------------------------
class FakeComplianceClient implements ComplianceClient {
  rows: ComplianceLogRow[] = [];
  private seq = 1;
  async getRules() {
    return R;
  }
  async recordVerdict(v: Verdict, opts: { draftId?: number | null; notes?: string } = {}) {
    const row: ComplianceLogRow = {
      id: this.seq,
      product_sku: v.sku,
      draft_id: opts.draftId ?? null,
      checker_version: "v1",
      run_at: new Date(Date.now() + this.seq).toISOString(),
      overall: v.overall,
      publish_allowed: v.publish_allowed,
      needs_human: v.needs_human,
      failed_checks: v.checks.filter((c) => c.severity !== "PASS"),
      reviewed_by: null,
      reviewed_at: null,
      published_after: false,
      notes: opts.notes ?? null,
    };
    this.seq++;
    this.rows.push(row);
    return { ok: true as const, data: row };
  }
  async getLatestLog(sku: string) {
    const m = this.rows.filter((r) => r.product_sku === sku);
    return m.length ? m[m.length - 1] : null;
  }
}

test("§6.12 publish gate refuses when latest verdict publish_allowed=false", async () => {
  const db = new FakeComplianceClient();
  const sku = "MCB-ZERO-PORE-PAD-70";

  // fail-closed: no verdict on record at all
  await assert.rejects(() => assertPublishAllowed(db, sku), PublishBlockedError);

  // a BLOCK verdict → gate refuses, and guardedPublish never runs the publish fn
  await db.recordVerdict({ sku, overall: "BLOCK", publish_allowed: false, needs_human: true, checks: [] });
  await assert.rejects(() => assertPublishAllowed(db, sku), PublishBlockedError);
  let ran = false;
  await assert.rejects(
    () => guardedPublish(db, sku, async () => { ran = true; return "PUBLISHED"; }),
    PublishBlockedError
  );
  assert.equal(ran, false, "publish fn must not run while blocked");

  // a newer PASS verdict → gate allows
  await db.recordVerdict({ sku, overall: "PASS", publish_allowed: true, needs_human: false, checks: [] });
  const out = await guardedPublish(db, sku, async () => { ran = true; return "PUBLISHED"; });
  assert.equal(out, "PUBLISHED");
  assert.equal(ran, true);
});

// Bonus — agent parser is fail-closed (not one of the 12, but enforces safety).
test("agent parseVerdict is fail-closed on malformed output", () => {
  const bad = parseVerdict("the model refused to answer", "MCB-X");
  assert.equal(bad.overall, "BLOCK");
  assert.equal(bad.publish_allowed, false);
  assert.equal(bad.needs_human, true);
});
