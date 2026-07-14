// Pure builder for the Creatomate render "source" — the composition JSON that
// layers the generated 9:16 video with a voiceover (AI or a real uploaded human
// voice), background music, the Malika logo, an «اطلب الآن» CTA, and optional
// on-screen Arabic captions. DB/API-free so it can be unit-tested.

export type LogoPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export interface CaptionCue { text: string; time: number; duration: number } // seconds

export interface ComposeInput {
  videoUrl: string;
  audioUrl?: string | null;   // voiceover (ElevenLabs synth OR an uploaded human voice)
  musicUrl?: string | null;
  logoUrl?: string | null;
  logoPosition?: LogoPosition | null; // default top-right
  ctaText?: string | null;
  brandText?: string | null;
  subtitle?: string | null;   // single static Arabic caption (fallback)
  captions?: CaptionCue[] | null; // timed captions synced to the voice
  durationSec?: number | null; // known voice length; when absent the comp auto-fits to the audio
}

// Small logo (~12% wide) with generous safe margins so it never crops or
// overflows the 9:16 frame. Anchors are centred, so these are the logo's centre.
export const LOGO_WIDTH_PCT = 12;
/** Logo corner → Creatomate x/y centre (kept inside the 9:16 safe area). */
export function logoCoords(pos?: LogoPosition | null): { x: string; y: string } {
  switch (pos) {
    case "top-left": return { x: "13%", y: "9%" };
    case "bottom-left": return { x: "13%", y: "70%" };   // above captions/CTA
    case "bottom-right": return { x: "87%", y: "70%" };
    case "top-right": default: return { x: "87%", y: "9%" };
  }
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
  // Known duration → bound + set it. Unknown but we have audio (e.g. an uploaded
  // human voice we can't measure) → omit duration so Creatomate auto-fits the
  // composition to the audio track; the looping video fills whatever that is.
  const hasDur = !!(opts.durationSec && opts.durationSec > 0);
  const autoFit = !hasDur && !!opts.audioUrl;
  const duration = hasDur ? resolveReelDuration(opts.durationSec) : (autoFit ? undefined : DEFAULT_REEL_SEC);

  const withDur = (el: Record<string, unknown>): Record<string, unknown> =>
    duration ? { ...el, duration } : el;

  const elements: Record<string, unknown>[] = [
    // The product video fills the frame and LOOPS so it never runs out and leaves
    // a black screen while the voiceover keeps going.
    withDur({ type: "video", track: 1, source: opts.videoUrl, fit: "cover", volume: "0%", loop: true }),
  ];
  // Soft background music bed (low volume so the voiceover stays on top), looped.
  if (opts.musicUrl) {
    elements.push(withDur({ type: "audio", track: 2, source: opts.musicUrl, volume: "16%", loop: true }));
  }
  // Voiceover on its own track (AI synth or a real uploaded human voice). When
  // auto-fitting, this track drives the composition length.
  if (opts.audioUrl) {
    elements.push({ type: "audio", track: 3, source: opts.audioUrl, volume: "100%" });
  }
  // Brand logo — configurable corner (default top-right), small (~12% wide) and
  // fit:"contain" so its aspect ratio is preserved and it never crops/overflows.
  if (opts.logoUrl) {
    const lc = logoCoords(opts.logoPosition);
    elements.push({ type: "image", track: 4, source: opts.logoUrl, width: `${LOGO_WIDTH_PCT}%`, fit: "contain", x: lc.x, y: lc.y, x_anchor: "50%", y_anchor: "50%" });
  }
  // «اطلبي الآن» CTA — a premium/minimal pill in the bottom safe area: smaller
  // type, clear padding, subtle shadow. Never sits on the very edge and never
  // covers the product or captions.
  const cta = String(opts.ctaText ?? "").trim();
  if (cta) {
    elements.push({
      type: "text", track: 5, text: cta,
      y: "84%", width: "80%", x: "50%", x_anchor: "50%", y_anchor: "50%",
      font_family: "Cairo", font_weight: "700", font_size: "6vmin",
      fill_color: "#ffffff",
      shadow_color: "rgba(0,0,0,0.45)", shadow_blur: "1.6vmin", shadow_x: "0", shadow_y: "0.3vmin",
      background_color: "rgba(124,58,237,0.94)",
      background_x_padding: "5.5%", background_y_padding: "2.8%", background_border_radius: "40%",
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
  // Burned-in captions in the 9:16 safe area (lower-middle — above the CTA, never
  // covers the product/face). A subtle dark scrim behind the text keeps Arabic
  // readable over any footage. Most reels are watched muted, so captions matter.
  const captionStyle = {
    y: "68%", width: "84%", x: "50%", x_anchor: "50%", y_anchor: "50%",
    font_family: "Cairo", font_weight: "700", font_size: "5vmin",
    fill_color: "#ffffff",
    stroke_color: "#000000", stroke_width: "0.35vmin",
    shadow_color: "rgba(0,0,0,0.55)", shadow_blur: "1.6vmin", shadow_x: "0", shadow_y: "0.3vmin",
    background_color: "rgba(0,0,0,0.34)",
    background_x_padding: "4%", background_y_padding: "2%", background_border_radius: "12%",
    text_transform: "none",
  } as const;
  const cues = Array.isArray(opts.captions) ? opts.captions.filter((c) => c && String(c.text ?? "").trim()) : [];
  if (cues.length) {
    // Timed captions synced to the voice — one element per cue.
    for (const c of cues) {
      elements.push({ type: "text", track: 7, text: String(c.text).trim(), time: Math.max(0, c.time), duration: Math.max(0.4, c.duration), ...captionStyle });
    }
  } else {
    const sub = String(opts.subtitle ?? "").trim();
    if (sub) elements.push({ type: "text", track: 7, text: sub, ...captionStyle });
  }
  const source: Record<string, unknown> = { output_format: "mp4", width: 1080, height: 1920, elements };
  if (duration) source.duration = duration;
  return source;
}
