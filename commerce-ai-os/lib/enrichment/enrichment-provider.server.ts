import "server-only";
// CH.6E / AI.FIX.1 — AI provider boundary (SERVER-ONLY).
//
// Business logic depends on this NARROW interface, never on a provider SDK type.
// The default implementation is Anthropic-backed (Claude Sonnet 5 via the existing
// env/model convention); candidate detection, prompt construction, validation,
// preview and apply never import the SDK — so the provider/model can change here
// without touching the rest of CH.6E. This file makes the model call and nothing
// else (no DB, no writes).
//
// AI.FIX.1 hardening:
//   • uses the provider's structured-output mechanism (Anthropic
//     `output_config.format`, json_schema) to CONSTRAIN output to the exact
//     enrichment schema instead of hoping free prose is valid JSON;
//   • sizes max_tokens (ENRICHMENT_MAX_TOKENS) to fit adaptive thinking + the four
//     fields — the DIAG.AI.1 root cause was a 1500 cap the thinking pass alone
//     could exhaust;
//   • returns structured diagnostic metadata (text + stop_reason + token usage +
//     request id) instead of text only, so failures are classifiable;
//   • disables the SDK's built-in retries (maxRetries: 0) so the single-retry
//     policy in enrichment-diagnostics is the ONLY retry (no hidden loops).
//
// AI.FIX.2 endpoint fix (DIAG.AI.2 root cause):
//   Structured output (`output_config.format`) is wired in the installed SDK ONLY
//   through the BETA messages surface, which sends the required
//   `structured-outputs-2025-12-15` beta header. AI.FIX.1 sent it on the non-beta
//   `client.messages.create`, which omits that header → the provider rejected the
//   request (~400) → systematic PROVIDER_ERROR. This calls `client.beta.messages
//   .create` with that beta so there is ONE deterministic structured-output
//   contract. Model, budget, schema, validator, retry taxonomy are unchanged.
//
// It never returns or logs the API key or any auth header.

import Anthropic from "@anthropic-ai/sdk";
import { ENRICHMENT_OUTPUT_SCHEMA } from "./enrichment-prompt.ts";
import { ENRICHMENT_MAX_TOKENS, type ProviderResponse } from "./enrichment-diagnostics.ts";

/** Beta required by the installed SDK to send `output_config.format`. */
export const STRUCTURED_OUTPUT_BETA = "structured-outputs-2025-12-15";

/** The single method the enrichment pipeline needs: (system,user) → structured response. */
export interface EnrichmentProvider {
  readonly model: string;
  /** Generate a structured provider response. Throws only on transport error. */
  generate(system: string, user: string): Promise<ProviderResponse>;
}

export type { ProviderResponse } from "./enrichment-diagnostics.ts";

/** Anthropic-backed provider. Model + key come from the existing env conventions. */
export function createAnthropicEnrichmentProvider(): EnrichmentProvider {
  const model = process.env.STAFF_MALAK_MODEL || "claude-sonnet-5";
  return {
    model,
    async generate(system: string, user: string): Promise<ProviderResponse> {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
      // maxRetries: 0 — the enrichment single-retry policy owns retries.
      const client = new Anthropic({ apiKey, maxRetries: 0 });
      // Structured output goes through the BETA surface + its required beta header.
      const resp = await client.beta.messages.create({
        model,
        max_tokens: ENRICHMENT_MAX_TOKENS,
        system,
        messages: [{ role: "user", content: [{ type: "text", text: user }] }],
        // Structured output: constrain the model to the exact enrichment schema.
        output_config: { format: { type: "json_schema", schema: ENRICHMENT_OUTPUT_SCHEMA } },
        betas: [STRUCTURED_OUTPUT_BETA],
      });
      const text = resp.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      // _request_id is a safe, non-enumerable id the SDK attaches to responses.
      const requestId = (resp as { _request_id?: string | null })._request_id ?? null;
      return {
        text,
        stopReason: resp.stop_reason ?? null,
        usage: {
          input_tokens: resp.usage.input_tokens,
          output_tokens: resp.usage.output_tokens,
          thinking_tokens: resp.usage.output_tokens_details?.thinking_tokens ?? null,
        },
        requestId,
      };
    },
  };
}
