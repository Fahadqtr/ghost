import "server-only";
// CH.6E — AI provider boundary (SERVER-ONLY).
//
// Business logic depends on this NARROW interface, never on a provider SDK type.
// The default implementation is Anthropic-backed (reusing the same env/model as
// the existing catalog enrichment), but candidate detection, prompt construction,
// validation, preview and apply never import the SDK — so the provider/model can
// change here without touching the rest of CH.6E. This file makes the model call
// and nothing else (no DB, no writes).

import Anthropic from "@anthropic-ai/sdk";

/** The single method the enrichment pipeline needs: text in → text out. */
export interface EnrichmentProvider {
  readonly model: string;
  /** Generate raw model text for a (system, user) pair. Throws on transport error. */
  generate(system: string, user: string): Promise<string>;
}

/** Anthropic-backed provider. Model + key come from the existing env conventions. */
export function createAnthropicEnrichmentProvider(): EnrichmentProvider {
  const model = process.env.STAFF_MALAK_MODEL || "claude-sonnet-5";
  return {
    model,
    async generate(system: string, user: string): Promise<string> {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
      const client = new Anthropic({ apiKey });
      const resp = await client.messages.create({
        model,
        max_tokens: 1500,
        system,
        messages: [{ role: "user", content: [{ type: "text", text: user }] }],
      });
      return resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    },
  };
}
