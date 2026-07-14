// Pure builder for the Creatomate render "source" — the composition JSON that
// layers the generated 9:16 video with the Arabic voiceover, the Malika logo,
// and an «اطلب الآن» call-to-action. DB/API-free so it can be unit-tested.

export interface ComposeInput {
  videoUrl: string;
  audioUrl?: string | null;
  logoUrl?: string | null;
  ctaText?: string | null;
}

/** Build a 1080×1920 mp4 composition source for Creatomate. */
export function buildComposeSource(opts: ComposeInput): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [
    // The product video fills the frame.
    { type: "video", track: 1, source: opts.videoUrl, fit: "cover", volume: "0%" },
  ];
  // Arabic voiceover on its own track (replaces the silent/AI audio).
  if (opts.audioUrl) {
    elements.push({ type: "audio", track: 2, source: opts.audioUrl });
  }
  // Brand logo, top corner, small.
  if (opts.logoUrl) {
    elements.push({ type: "image", track: 3, source: opts.logoUrl, width: "24%", x: "84%", y: "9%", x_anchor: "50%", y_anchor: "50%" });
  }
  // «اطلب الآن» CTA pill near the bottom.
  const cta = String(opts.ctaText ?? "").trim();
  if (cta) {
    elements.push({
      type: "text", track: 4, text: cta,
      y: "86%", width: "80%", x: "50%", x_anchor: "50%", y_anchor: "50%",
      font_family: "Cairo", font_weight: "800", font_size: "8vmin",
      fill_color: "#ffffff", background_color: "#7c3aed",
      background_x_padding: "6%", background_y_padding: "3%", background_border_radius: "40%",
      text_transform: "none",
    });
  }
  return { output_format: "mp4", width: 1080, height: 1920, elements };
}
