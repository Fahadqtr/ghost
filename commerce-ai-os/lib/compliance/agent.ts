// Agent #9 — the silent Compliance Checker (Claude API).
//
// Uses the system prompt VERBATIM from malika-compliance-checker-spec.md §3.
// The deterministic engine (checker.ts) is what gates publishing; this agent is
// the spec-required silent LLM layer for the fuzzy checks (medical nuance,
// fabricated data). It returns ONLY JSON and we parse it FAIL-CLOSED: any
// malformed/empty/errored response becomes a BLOCK + needs_human.
//
// NOTE: the prompt text says "11 locked categories" / "Trending Products" as in
// the spec. At runtime the real `valid_categories` (the 17, per decision A1) and
// `category_fallback` are injected via the config object, and checker.ts is
// authoritative for the gate.
//
// No @anthropic-ai/sdk import at module top — it is loaded lazily inside
// runComplianceAgent so this file is importable in tests without the SDK.

import type { Draft, RulesConfig, Severity, Verdict } from "./types";

export const COMPLIANCE_SYSTEM_PROMPT = `You are the COMPLIANCE CHECKER for Malika's Universe Trading, a Qatar beauty/K-beauty retailer.

You are a silent internal gatekeeper. You do NOT write listings and you do NOT talk to customers.
Your ONLY job: receive one product-listing draft and decide whether it is safe to publish.

You receive a JSON draft. You run all 7 checks. You return ONLY a JSON verdict — no prose, no
markdown, no explanation outside the JSON.

RULES YOU ENFORCE (from the system rulebook):
1. MEDICAL CLAIMS (BLOCK): The description (EN or AR) must contain NO medical, diagnostic, curative,
   or allergy-clearance claims. Forbidden terms are provided in \`forbidden_terms\`. "Clinically proven"
   is allowed ONLY if \`on_label_claims\` confirms it appears on the packaging.
2. IMAGE (BLOCK): image_url must be HTTPS and present. White background required; no text overlay.
   If you cannot verify the background from metadata, set this check to WARN, not BLOCK.
3. FORMAT (BLOCK): Validate title_en, title_ar, and sku against \`format_rules\`. Both AR and EN must exist.
4. PRICE CONSISTENCY (BLOCK): price must be identical across all listed platforms unless a
   \`discount_price\` is explicitly set. Mismatch with no discount field = BLOCK.
5. CATEGORY (WARN): main_category must be one of the 11 locked categories in \`valid_categories\`.
   If not, recommend routing to "Trending Products".
6. REQUIRED FIELDS (WARN): name_en, name_ar, desc_en, desc_ar, keywords_en (5–10), keywords_ar (5–10),
   size, price, image_url must all be non-empty.
7. FABRICATED DATA (WARN): Flag any ingredient, delivery time, stock figure, or origin claim that is
   not present in the input draft fields (i.e. invented by the Maker).

NEVER invent data. NEVER soften a BLOCK to make a draft pass. If unsure between WARN and BLOCK on a
medical/price/format issue, choose BLOCK and set "needs_human": true.

OUTPUT — return EXACTLY this JSON shape and nothing else:
{
  "sku": "<sku from draft>",
  "overall": "PASS | WARN | BLOCK",
  "publish_allowed": true | false,
  "needs_human": true | false,
  "checks": [
    {"name": "medical_claims", "severity": "PASS|WARN|BLOCK", "detail": "<short reason>", "evidence": "<offending text or null>"},
    {"name": "image", "severity": "...", "detail": "...", "evidence": "..."},
    {"name": "format", "severity": "...", "detail": "...", "evidence": "..."},
    {"name": "price_consistency", "severity": "...", "detail": "...", "evidence": "..."},
    {"name": "category", "severity": "...", "detail": "...", "evidence": "..."},
    {"name": "required_fields", "severity": "...", "detail": "...", "evidence": "..."},
    {"name": "fabricated_data", "severity": "...", "detail": "...", "evidence": "..."}
  ]
}

publish_allowed = false whenever overall = BLOCK. Otherwise true.`;

/** Model id per spec §3.1. */
export const COMPLIANCE_MODEL = "claude-opus-4-8";

const SEVERITIES: Severity[] = ["PASS", "WARN", "BLOCK"];

/** A hard BLOCK verdict used whenever we cannot trust the model output. */
export function failClosedVerdict(sku: string, reason: string): Verdict {
  return {
    sku,
    overall: "BLOCK",
    publish_allowed: false,
    needs_human: true,
    checks: [
      { name: "medical_claims", severity: "BLOCK", detail: reason, evidence: null },
    ],
  };
}

/** Parse the model's text into a Verdict, FAIL-CLOSED on anything suspicious. */
export function parseVerdict(raw: string, sku: string): Verdict {
  if (!raw || !raw.trim()) return failClosedVerdict(sku, "empty model response");
  // Strip ```json fences / surrounding prose; grab the outermost JSON object.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start)
    return failClosedVerdict(sku, "no JSON object in model response");
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return failClosedVerdict(sku, "model response was not valid JSON");
  }
  const overall = obj.overall;
  if (typeof overall !== "string" || !SEVERITIES.includes(overall as Severity))
    return failClosedVerdict(sku, "missing/invalid overall");

  const ov = overall as Severity;
  // Re-derive the safety fields in code; never trust the model to set them.
  return {
    sku: typeof obj.sku === "string" && obj.sku ? obj.sku : sku,
    overall: ov,
    publish_allowed: ov !== "BLOCK",
    needs_human: ov === "BLOCK" || obj.needs_human === true,
    checks: Array.isArray(obj.checks) ? (obj.checks as Verdict["checks"]) : [],
  };
}

export interface AgentDeps {
  apiKey?: string;
  /** Injectable transport for tests; defaults to the Anthropic SDK. */
  call?: (system: string, userJson: string) => Promise<string>;
}

/** Run the silent checker via Claude. Fail-closed on any error. */
export async function runComplianceAgent(
  draft: Draft,
  rules: RulesConfig,
  deps: AgentDeps = {}
): Promise<Verdict> {
  const userJson = JSON.stringify({
    draft,
    config: {
      valid_categories: rules.valid_categories,
      forbidden_terms: [...rules.forbidden_terms_en, ...rules.forbidden_terms_ar],
      format_rules: rules.format_rules,
      on_label_claims: rules.on_label_claims,
      category_fallback: rules.category_fallback,
    },
  });

  try {
    const call = deps.call ?? (await defaultCall(deps.apiKey));
    const text = await call(COMPLIANCE_SYSTEM_PROMPT, userJson);
    return parseVerdict(text, draft.sku);
  } catch (e) {
    return failClosedVerdict(draft.sku, `agent error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Lazily build the real Anthropic transport. */
async function defaultCall(apiKey?: string) {
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: key });
  return async (system: string, userJson: string): Promise<string> => {
    const msg = await client.messages.create({
      model: COMPLIANCE_MODEL,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: userJson }],
    });
    return msg.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
  };
}
