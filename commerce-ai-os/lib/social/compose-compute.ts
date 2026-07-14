// Pure builder for the Creatomate render "source" — the composition JSON that
// layers the generated 9:16 video with the Arabic voiceover, the Malika logo,
// and an «اطلب الآن» call-to-action. DB/API-free so it can be unit-tested.

export interface ComposeInput {
  videoUrl: string;
  audioUrl?: string | null;
  musicUrl?: string | null;
  logoUrl?: string | null;
  ctaText?: string | null;
  brandText?: string | null;
  durationSec?: number | null;
}

// Clamp the final reel length: never shorter than 6s, never a runaway clip.
export const MIN_REEL_SEC = 6;
export const MAX_REEL_SEC = 30;
export const DEFAULT_REEL_SEC = 12;

/** Resolve the composition length from the voiceover duration (+ a tail), bounded. */
export function resolveReelDuration(durationSec?: number | null): number {
  const base = durationSec && durationSec > 0 ? durationSec + 0.6 : DEFAULT_REEL_SEC;
  return Math.round(Math.min(MAX_REEL_SEC, Math.max(MIN_REEL_SEC, base)) * 100) / 100;
}

/** Build a 1080×1920 mp4 composition source for Creatomate. */
export function buildComposeSource(opts: ComposeInput): Record<string, unknown> {
  const duration = resolveReelDuration(opts.durationSec);
  const elements: Record<string, unknown>[] = [
    // The product video fills the frame and LOOPS for the whole duration, so it
    // never runs out and leaves a black screen while the voiceover keeps going.
    { type: "video", track: 1, source: opts.videoUrl, fit: "cover", volume: "0%", loop: true, duration },
  ];
  // Soft background music bed (low volume so the voiceover stays on top), looped
  // and trimmed to the composition — gives a produced, less-bare feel.
  if (opts.musicUrl) {
    elements.push({ type: "audio", track: 2, source: opts.musicUrl, volume: "16%", loop: true, duration });
  }
  // Arabic voiceover on its own track (replaces the silent/AI audio).
  if (opts.audioUrl) {
    elements.push({ type: "audio", track: 3, source: opts.audioUrl, volume: "100%" });
  }
  // Brand logo, top corner, small.
  if (opts.logoUrl) {
    elements.push({ type: "image", track: 4, source: opts.logoUrl, width: "22%", x: "83%", y: "8%", x_anchor: "50%", y_anchor: "50%" });
  }
  // «اطلب الآن» CTA — a clean bottom banner with a soft scrim + outline so text
  // stays legible over any footage (looks more polished than a flat pill).
  const cta = String(opts.ctaText ?? "").trim();
  if (cta) {
    elements.push({
      type: "text", track: 5, text: cta,
      y: "88%", width: "86%", x: "50%", x_anchor: "50%", y_anchor: "50%",
      font_family: "Cairo", font_weight: "800", font_size: "8.5vmin",
      fill_color: "#ffffff",
      shadow_color: "rgba(0,0,0,0.55)", shadow_blur: "2vmin", shadow_x: "0", shadow_y: "0.4vmin",
      background_color: "rgba(124,58,237,0.92)",
      background_x_padding: "7%", background_y_padding: "3.5%", background_border_radius: "36%",
      text_transform: "none",
    });
  }
  // Optional brand line above the CTA (store name / handle) for a professional feel.
  const brand = String(opts.brandText ?? "").trim();
  if (brand) {
    elements.push({
      type: "text", track: 6, text: brand,
      y: "77%", width: "86%", x: "50%", x_anchor: "50%", y_anchor: "50%",
      font_family: "Cairo", font_weight: "700", font_size: "5vmin",
      fill_color: "#ffffff",
      shadow_color: "rgba(0,0,0,0.6)", shadow_blur: "2.4vmin", shadow_x: "0", shadow_y: "0.4vmin",
      text_transform: "none",
    });
  }
  return { output_format: "mp4", width: 1080, height: 1920, duration, elements };
}
