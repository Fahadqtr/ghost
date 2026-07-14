// Pure helpers for the Malika AI Studio Caption Engine + Final Reel Composer.
// Split a script into short synced caption lines, time them to the voice length,
// and expose brand/logo defaults. DB/API-free so they can be unit-tested.

import type { CaptionCue, LogoPosition } from "@/lib/social/compose-compute";

export type CaptionLanguage = "ar" | "en" | "ar_en";
export const DEFAULT_CAPTION_LANGUAGE: CaptionLanguage = "ar";
export const LOGO_POSITIONS: LogoPosition[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
export const DEFAULT_LOGO_POSITION: LogoPosition = "top-right";
export const DEFAULT_CTA = "اطلبي الآن";
export const DEFAULT_MAX_CAPTION_CHARS = 38; // keep lines short so they never overflow the safe area
export const CTA_TAIL_SEC = 2.5; // the CTA only appears in the last ~2.5s of the reel

/**
 * Split a script into short caption lines: break on sentence punctuation and
 * newlines, then wrap any long piece onto ≤ maxChars-word-boundary lines so no
 * single caption is too long for a 9:16 safe area.
 */
export function splitCaptions(script: string, maxChars = DEFAULT_MAX_CAPTION_CHARS): string[] {
  // Split on SENTENCE ends (. ! ؟ ? …) and newlines — NOT on commas, so a clause
  // like «بسيط، عملي، ويستاهل» stays one caption instead of fragmenting.
  const pieces = String(script ?? "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!؟?…])\s+|\n+/)
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

/** Per-character alignment returned by ElevenLabs /with-timestamps. */
export interface CharAlignment { chars: string[]; starts: number[]; ends: number[] }

const isSpace = (c: string): boolean => !c || /\s/.test(c);

/**
 * Sync caption lines to the ACTUAL voice using ElevenLabs character timestamps:
 * walk the character stream and, for each line, take the real start time of its
 * first character and end time of its last. Falls back to null (→ weighted
 * timing) when the lines don't match the audio stream (e.g. translated captions).
 */
export function alignCaptions(lines: string[], al: CharAlignment): CaptionCue[] | null {
  const { chars, starts, ends } = al || ({} as CharAlignment);
  if (!Array.isArray(chars) || !chars.length || chars.length !== starts?.length || chars.length !== ends?.length) return null;
  const clean = lines.map((l) => String(l ?? "").trim()).filter(Boolean);
  if (!clean.length) return null;
  let i = 0, totalTarget = 0, totalMatched = 0;
  const cues: CaptionCue[] = [];
  for (const line of clean) {
    const target = Array.from(line).filter((c) => !isSpace(c));
    totalTarget += target.length;
    while (i < chars.length && isSpace(chars[i])) i++;
    const startIdx = Math.min(i, chars.length - 1);
    let m = 0;
    while (i < chars.length && m < target.length) {
      if (isSpace(chars[i])) { i++; continue; }
      if (chars[i] === target[m]) { m++; i++; }
      else { i++; } // punctuation/diacritic in the stream we didn't split on
    }
    totalMatched += m;
    const endIdx = Math.max(startIdx, i - 1);
    const t = Number(starts[startIdx]) || 0;
    const e = Number(ends[endIdx]) || t;
    cues.push({ text: line, time: Math.max(0, Math.round(t * 100) / 100), duration: Math.max(0.5, Math.round((e - t) * 100) / 100) });
  }
  // If most characters didn't line up, the lines aren't this audio → fall back.
  if (!totalTarget || totalMatched / totalTarget < 0.6) return null;
  return cues;
}

/** The time window (last CTA_TAIL_SEC, bounded) where the CTA fades in near the end. */
export function ctaWindow(totalSec: number, tail = CTA_TAIL_SEC): { time: number; duration: number } {
  const t = totalSec && totalSec > 0 ? totalSec : tail;
  const dur = Math.min(tail, Math.max(1.4, t * 0.4));
  return { time: Math.max(0, Math.round((t - dur) * 100) / 100), duration: Math.round(dur * 100) / 100 };
}

/**
 * Split N video shots evenly across the reel so a single FLORA clip is never
 * stretched/looped to cover the whole voiceover. Each shot gets a time slice;
 * the last slice absorbs the rounding remainder.
 */
export function planShots(videoUrls: string[], totalSec: number): { source: string; time: number; duration: number }[] {
  const urls = videoUrls.map((u) => String(u ?? "").trim()).filter((u) => /^https?:\/\//i.test(u));
  const total = totalSec && totalSec > 0 ? totalSec : 12;
  if (urls.length <= 1) return urls.length ? [{ source: urls[0], time: 0, duration: Math.round(total * 100) / 100 }] : [];
  const per = total / urls.length;
  return urls.map((source, idx) => {
    const time = Math.round(idx * per * 100) / 100;
    const end = idx === urls.length - 1 ? total : (idx + 1) * per;
    return { source, time, duration: Math.round((end - time) * 100) / 100 };
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
