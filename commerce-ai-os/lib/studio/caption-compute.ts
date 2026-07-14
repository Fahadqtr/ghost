// Pure helpers for the Malika AI Studio Caption Engine + Final Reel Composer.
// Split a script into short synced caption lines, time them to the voice length,
// and expose brand/logo defaults. DB/API-free so they can be unit-tested.

import type { CaptionCue, LogoPosition } from "@/lib/social/compose-compute";

export type CaptionLanguage = "ar" | "en" | "ar_en";
export const DEFAULT_CAPTION_LANGUAGE: CaptionLanguage = "ar";
export const LOGO_POSITIONS: LogoPosition[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
export const DEFAULT_LOGO_POSITION: LogoPosition = "top-right";
export const DEFAULT_CTA = "اطلبي الآن";
export const DEFAULT_MAX_CAPTION_CHARS = 42; // keep lines short so they never overflow the safe area

/**
 * Split a script into short caption lines: break on sentence punctuation and
 * newlines, then wrap any long piece onto ≤ maxChars-word-boundary lines so no
 * single caption is too long for a 9:16 safe area.
 */
export function splitCaptions(script: string, maxChars = DEFAULT_MAX_CAPTION_CHARS): string[] {
  const pieces = String(script ?? "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!؟?،…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const piece of pieces) {
    if (piece.length <= maxChars) { out.push(piece); continue; }
    // wrap long pieces on word boundaries
    let line = "";
    for (const word of piece.split(" ")) {
      if ((line + " " + word).trim().length > maxChars && line) { out.push(line.trim()); line = word; }
      else { line = (line + " " + word).trim(); }
    }
    if (line.trim()) out.push(line.trim());
  }
  return out;
}

/**
 * Distribute caption lines evenly across the reel duration, weighted by length
 * so longer lines stay on screen a touch longer. Returns timed cues (seconds).
 */
export function timeCaptions(lines: string[], totalSec: number): CaptionCue[] {
  const clean = lines.map((l) => String(l ?? "").trim()).filter(Boolean);
  const total = totalSec && totalSec > 0 ? totalSec : Math.max(6, clean.length * 2);
  if (!clean.length) return [];
  const weights = clean.map((l) => Math.max(1, l.length));
  const sum = weights.reduce((a, b) => a + b, 0);
  let t = 0;
  return clean.map((text, i) => {
    const dur = Math.max(0.8, (weights[i] / sum) * total);
    const cue: CaptionCue = { text, time: Math.round(t * 100) / 100, duration: Math.round(dur * 100) / 100 };
    t += dur;
    return cue;
  });
}

/** Pair Arabic + English lines for bilingual captions (Arabic on top). */
export function bilingualCaptions(ar: string[], en: string[]): string[] {
  const n = Math.max(ar.length, en.length);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = (ar[i] ?? "").trim();
    const e = (en[i] ?? "").trim();
    out.push([a, e].filter(Boolean).join("\n"));
  }
  return out;
}

/** Build the small brand line under the CTA from optional product name + handle. */
export function buildBrandLine(productName?: string | null, handle?: string | null): string {
  const p = String(productName ?? "").trim();
  const h = String(handle ?? "").trim();
  return [p, h].filter(Boolean).join("  ·  ");
}
