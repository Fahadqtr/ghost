import "server-only";
// OPS.5 — AI Center assembler (SERVER-ONLY, READ-ONLY).
//
// One read-only assembly for /v2/operations/ai. It reuses the EXISTING CH.6E
// candidate scanner ONCE (read-only, signed-in) — never a per-card rescan (§17) —
// reads the real applied-enrichment history from malak_audit (`catalog_enrich`),
// and derives a SAFE provider-configured boolean from env presence (never the
// key). It performs NO writes and issues NO model calls: generation and apply are
// delegated to the existing CH.6E server actions from the client. Assembly then
// runs through the PURE ai-center composer.

import { createClient } from "@/lib/supabase/server";
import { safeError } from "@/lib/security/safe-error";
import { scanEnrichmentCandidates } from "@/lib/enrichment/enrichment.server";
import {
  buildAiCenter,
  filterCandidates,
  scanFiltersFrom,
  type AiCenterModel,
  type AiFilters,
  type AiHistoryEvent,
  type CcCandidate,
} from "./ai-center.ts";

const NOT_SIGNED_IN = "غير مسجّل الدخول.";
const LOAD_FAILED = "تعذّر تحميل مركز الذكاء.";
const APPLIED_LIMIT = 60;

interface OrderedResult { data: unknown[] | null; error: unknown | null }
interface Ordered extends PromiseLike<OrderedResult> { limit(n: number): PromiseLike<OrderedResult> }
interface EqBuilder { eq(col: string, val: string): { order(c: string, o: { ascending: boolean }): Ordered } }
interface AuditReadClient { from(table: string): { select(cols: string): EqBuilder } }

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** Bounded, read-only history of REAL applied enrichments (audit `catalog_enrich`). */
async function loadAppliedHistory(client: AuditReadClient): Promise<AiHistoryEvent[]> {
  try {
    const { data, error } = await client
      .from("malak_audit")
      .select("id, created_at, sku, field, new_value, status")
      .eq("action_type", "catalog_enrich")
      .order("created_at", { ascending: false })
      .limit(APPLIED_LIMIT);
    if (error || !Array.isArray(data)) return [];
    return data
      .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
      .map((r) => {
        const ts = str(r.created_at);
        if (!ts) return null;
        const field = str(r.field);
        return {
          id: str(r.id) ?? `${ts}:${field ?? ""}`,
          timestamp: ts,
          sku: str(r.sku),
          field,
          summary: `طُبّق إثراء${field ? ` (${field})` : ""}`,
          status: str(r.status) ?? "done",
        } as AiHistoryEvent;
      })
      .filter((e): e is AiHistoryEvent => e !== null);
  } catch {
    return [];
  }
}

export interface AiCenterView {
  model: AiCenterModel;
  filters: AiFilters;
  /** whether the AI provider is CONFIGURED — a safe boolean, never the key. */
  providerConfigured: boolean;
  degraded: boolean;
}

export async function loadAiCenter(filters: AiFilters): Promise<AiCenterView | { error: string }> {
  try {
    // The scanner enforces the signed-in policy itself; surface its error.
    const scan = await scanEnrichmentCandidates(scanFiltersFrom(filters));
    if ("error" in scan) return { error: scan.error === NOT_SIGNED_IN ? NOT_SIGNED_IN : LOAD_FAILED };

    const client = createClient() as unknown as AuditReadClient;
    const appliedRecently = await loadAppliedHistory(client);

    // language/quality are post-scan pure filters (brand/category/field/sku were
    // applied by the scanner). Arabic/English stay independent.
    const candidates = filterCandidates(scan.rows as unknown as CcCandidate[], filters);

    // SAFE provider signal: presence of the key only — never its value (§16).
    const providerConfigured = !!process.env.ANTHROPIC_API_KEY;
    const lastSuccessAt = appliedRecently[0]?.timestamp ?? null;

    const model = buildAiCenter({
      summary: { scanned: scan.summary.scanned, candidates: scan.summary.candidates, missingKeywords: scan.summary.missingKeywords, missingDescriptions: scan.summary.missingDescriptions, weakContent: scan.summary.weakContent },
      candidates,
      appliedRecently,
      provider: { configured: providerConfigured, lastSuccessAt },
    });

    return { model, filters, providerConfigured, degraded: false };
  } catch (e) {
    return { error: safeError("ops5_ai_center_load", e, LOAD_FAILED) };
  }
}
