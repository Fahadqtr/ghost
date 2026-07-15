// Pure builders for FLORA technique-run requests. DB/API-free so they can be
// unit-tested. FLORA runs a saved canvas "technique" by slug: you POST a run
// with typed `inputs`, then poll until `outputs[].url` is ready.
// Ref: docs.flora.ai — POST /api/v1/techniques/{slug}/runs, GET …/runs/{runId}.

export interface FloraInputField { id: string; type: string; value: string }

export interface FloraRunInput {
  imageUrl: string;
  prompt?: string | null;
  negativePrompt?: string | null;
  // Input field ids are defined by the technique the owner builds on the canvas;
  // they're configurable via env so we never hard-code the wrong schema.
  fieldIds?: { image?: string; prompt?: string; negative?: string };
}

/** Build the `inputs` array for a technique run. Only includes provided fields. */
export function buildFloraInputs(opts: FloraRunInput): FloraInputField[] {
  const ids = opts.fieldIds ?? {};
  // Input `type` uses FLORA's camelCase enum: imageUrl | videoUrl | text
  // (the public-API-reference docs show IMAGE_URL/TEXT, but the live API
  // rejects those — it validates against imageUrl/text).
  const inputs: FloraInputField[] = [
    { id: ids.image || "input_image", type: "imageUrl", value: opts.imageUrl },
  ];
  const prompt = String(opts.prompt ?? "").trim();
  if (prompt) inputs.push({ id: ids.prompt || "visual_prompt", type: "text", value: prompt });
  const neg = String(opts.negativePrompt ?? "").trim();
  if (neg) inputs.push({ id: ids.negative || "negative_prompt", type: "text", value: neg });
  return inputs;
}

/**
 * Parse the required image-input id from a FLORA 400 validation body.
 * FLORA auto-generates the input id from the canvas node (e.g. "imgi-271-9-jpg")
 * and it changes whenever the technique is rebuilt, so we read it back from the
 * error and retry — no hard-coded id needed.
 * e.g. Missing required input "imgi-271-9-jpg" (imageUrl); Unknown input "input_image"
 */
export function parseMissingImageInputId(body: string | null | undefined): string | undefined {
  let text = String(body ?? "");
  // Prefer the clean (unescaped) message when the body is JSON.
  try { const j: any = JSON.parse(text); const msg = j?.error?.message ?? j?.message; if (typeof msg === "string") text = msg; } catch { /* raw text */ }
  // Tolerate JSON-escaped quotes (\") when parsing the raw body.
  const m = /Missing required input\s+\\?"([^"\\]+)\\?"\s*\(\s*(?:imageUrl|IMAGE_URL)\s*\)/i.exec(text);
  return m ? m[1] : undefined;
}

/** Normalise a FLORA run's status into our shared vocabulary. */
export function floraStatus(raw: string | null | undefined, hasOutput: boolean):
  "pending" | "completed" | "failed" | "unknown" {
  const s = String(raw ?? "").toLowerCase();
  if (hasOutput || s.includes("complet") || s.includes("succeed") || s.includes("success")) return "completed";
  if (s.includes("fail") || s.includes("error") || s.includes("cancel")) return "failed";
  if (s.includes("pending") || s.includes("queue") || s.includes("run") || s.includes("process") || s === "") return "pending";
  return "unknown";
}

/** Pull the first video (or any) output URL from a run's outputs array. */
export function firstFloraOutputUrl(outputs: any): string | undefined {
  if (!Array.isArray(outputs)) return undefined;
  const vid = outputs.find((o: any) => typeof o?.url === "string" && /\.(mp4|mov|webm)(\?|$)/i.test(o.url));
  if (vid) return vid.url;
  const any = outputs.find((o: any) => typeof o?.url === "string");
  return any?.url;
}

export interface TechniqueInput { id: string; type: string }

/**
 * Pull the declared inputs from a technique-metadata response. The exact shape
 * is undocumented, so we look in the common places (inputs / data.inputs /
 * technique.inputs / schema.inputs) and read id+type defensively. Used to verify
 * a published technique actually exposes a text input (e.g. visual_prompt)
 * BEFORE turning on FLORA_SEND_PROMPT.
 */
export function parseTechniqueInputs(json: any): TechniqueInput[] {
  const arr: any =
    json?.inputs ?? json?.data?.inputs ?? json?.technique?.inputs ??
    json?.schema?.inputs ?? json?.data?.technique?.inputs ?? null;
  const list: any[] = Array.isArray(arr) ? arr : (arr && typeof arr === "object" ? Object.values(arr) : []);
  const out: TechniqueInput[] = [];
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    const id = it.id ?? it.name ?? it.key ?? it.inputId ?? it.slug;
    const type = it.type ?? it.inputType ?? it.kind ?? "";
    if (id) out.push({ id: String(id), type: String(type) });
  }
  return out;
}

/** Does the technique expose a text input usable as the motion prompt? */
export function hasPromptInput(inputs: TechniqueInput[], preferredId?: string): { ok: boolean; matched?: TechniqueInput } {
  const wanted = String(preferredId || "").trim().toLowerCase();
  // Prefer an exact id match (e.g. visual_prompt), else any text-typed input,
  // else an input whose id looks prompt-like.
  const byId = wanted ? inputs.find((i) => i.id.toLowerCase() === wanted) : undefined;
  if (byId) return { ok: true, matched: byId };
  const byType = inputs.find((i) => /text|string|prompt/i.test(i.type));
  if (byType) return { ok: true, matched: byType };
  const byName = inputs.find((i) => /prompt|visual|motion|text/i.test(i.id));
  return byName ? { ok: true, matched: byName } : { ok: false };
}
