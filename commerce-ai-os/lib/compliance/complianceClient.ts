// Supabase-backed ComplianceClient (service-role, server only).
// The only compliance file that imports Supabase, so checker/gate/agent stay
// unit-testable without a DB.

import { createAdminClient } from "../supabase/admin";
import { DEFAULT_RULES } from "./checker";
import type {
  ComplianceClient,
  ComplianceLogRow,
  RulesConfig,
} from "./types";

type RuleRow = { rule_key: string; rule_value: unknown; active: boolean };

/** Assemble a RulesConfig from compliance_rules rows; per-key fallback to the
 *  seed defaults. (Empty/unreadable table is handled by the caller — fail-closed.) */
export function assembleRules(rows: RuleRow[]): RulesConfig {
  const map = new Map<string, unknown>();
  for (const r of rows) if (r.active) map.set(r.rule_key, r.rule_value);
  const get = <T>(k: string, dflt: T): T => (map.has(k) ? (map.get(k) as T) : dflt);
  return {
    valid_categories: get("valid_categories", DEFAULT_RULES.valid_categories),
    forbidden_terms_en: get("forbidden_terms_en", DEFAULT_RULES.forbidden_terms_en),
    forbidden_terms_ar: get("forbidden_terms_ar", DEFAULT_RULES.forbidden_terms_ar),
    format_rules: get("format_rules", DEFAULT_RULES.format_rules),
    fabrication_patterns: get("fabrication_patterns", DEFAULT_RULES.fabrication_patterns),
    category_fallback: get("category_fallback", DEFAULT_RULES.category_fallback),
    on_label_claims: get("on_label_claims", DEFAULT_RULES.on_label_claims),
    image_rules: get("image_rules", DEFAULT_RULES.image_rules),
    medical_jargon_exceptions: get("medical_jargon_exceptions", DEFAULT_RULES.medical_jargon_exceptions),
  };
}

/** loop_key the compliance loop reports under (Live Memory Layer wiring). */
export const COMPLIANCE_LOOP_KEY = "listing_pipeline";
export const COMPLIANCE_AGENT_KEY = "compliance";

export function createSupabaseComplianceClient(): ComplianceClient {
  const db = createAdminClient();

  return {
    async getRules(): Promise<RulesConfig> {
      const { data, error } = await db
        .from("compliance_rules")
        .select("rule_key, rule_value, active");
      // Fail closed (spec §7): never run checks without rules.
      if (error) throw new Error(`compliance_rules unreadable: ${error.message}`);
      if (!data || data.length === 0)
        throw new Error("compliance_rules is empty — refusing to run checks (fail-closed)");
      return assembleRules(data as RuleRow[]);
    },

    async recordVerdict(verdict, opts = {}) {
      const failed = verdict.checks.filter((c) => c.severity !== "PASS");
      const { data, error } = await db
        .from("compliance_log")
        .insert({
          product_sku: verdict.sku,
          draft_id: opts.draftId ?? null,
          checker_version: opts.checkerVersion ?? "v1",
          overall: verdict.overall,
          publish_allowed: verdict.publish_allowed,
          needs_human: verdict.needs_human,
          failed_checks: failed,
          notes: opts.notes ?? null,
        })
        .select("*")
        .single();
      if (error) return { ok: false, error: error.message };

      // Mirror the verdict into the Live Memory Layer (loop_log) — spec §6.
      const event =
        verdict.overall === "BLOCK" ? "blocked" : verdict.overall === "PASS" ? "completed" : "completed";
      await db.from("loop_log").insert({
        agent_key: COMPLIANCE_AGENT_KEY,
        loop_key: COMPLIANCE_LOOP_KEY,
        event,
        detail: `Compliance ${verdict.overall} for ${verdict.sku}`,
        payload: {
          sku: verdict.sku,
          overall: verdict.overall,
          publish_allowed: verdict.publish_allowed,
          needs_human: verdict.needs_human,
        },
      });

      return { ok: true, data: data as ComplianceLogRow };
    },

    async getLatestLog(sku: string): Promise<ComplianceLogRow | null> {
      const { data, error } = await db
        .from("compliance_log")
        .select("*")
        .eq("product_sku", sku)
        .order("run_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`compliance_log read failed: ${error.message}`);
      return (data as ComplianceLogRow | null) ?? null;
    },
  };
}
