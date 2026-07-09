import type { CSSProperties } from "react";
import { AD_FONT_HEADLINE, AD_FONT_BODY, AD_FONT_LATIN } from "@/lib/social/ad-fonts";

// Fixed 1080×1920 (Instagram Story 9:16) luxury creative, styled with INLINE
// styles only (so nodeToJpeg's SVG foreignObject can rasterize it).
//
// KEY RULE (same as AdTemplate): the image model NEVER renders Arabic — the
// scene is a TEXT-FREE photograph (or a designed gradient) and every Arabic word
// here is printed with embedded luxury fonts. Safe margins keep the brand clear
// of the IG profile bar (top) and the CTA/handle clear of the reply bar (bottom).

export const STORY_W = 1080;
export const STORY_H = 1920;

export interface StoryTemplateProps {
  sceneDataUrl?: string;    // wordless AI scene, data: URL ("" → gradient + product photo)
  productDataUrl?: string;  // original product photo, composited when there's no scene
  logoDataUrl?: string;     // MU monogram (black on white), data: URL — multiplied so white vanishes
  brandTop: string;         // "MALIKA'S"
  brandSub: string;         // "UNIVERSE BEAUTY"
  handle: string;           // "@malikas_universe"
  headline: string;
  headlineEn?: string;
  subtitle?: string;
  price?: string;           // formatted, e.g. "78 ر.ق" ("" → no badge)
  options?: string[];       // variant names (shades/sizes)
  framed?: boolean;         // busy/lifestyle photo → rounded card instead of multiply-melt
}

const INK = "#38291b", MUTED = "#8c7a66", GOLD = "#b0894f", DARK = "#2c2013";
const CREAM = "247,240,230";
const GOLD_RGB = "176,137,79";

const glow: CSSProperties = { textShadow: "0 0 20px rgba(255,253,248,0.92), 0 1px 5px rgba(255,253,248,0.8)" };
const BAG = "M6 8h12l-1 11H7z M9 8a3 3 0 0 1 6 0";

export default function StoryTemplate(p: StoryTemplateProps) {
  const root: CSSProperties = {
    position: "absolute", top: 0, left: 0, width: STORY_W, height: STORY_H,
    fontFamily: AD_FONT_BODY, color: INK, overflow: "hidden", background: `rgb(${CREAM})`,
  };

  const backdrop = p.sceneDataUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={p.sceneDataUrl} alt="" style={{ position: "absolute", inset: 0, width: STORY_W, height: STORY_H, objectFit: "cover" }} />
  ) : (
    <>
      <div style={{ position: "absolute", inset: 0, background: `linear-gradient(160deg, rgb(${CREAM}) 0%, rgba(${GOLD_RGB},0.18) 100%)` }} />
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at 50% 34%, rgba(255,252,246,0.92) 0%, rgba(255,252,246,0) 52%)" }} />
    </>
  );

  // Composite the ORIGINAL product photo only when there's no scene.
  const product = !p.productDataUrl || p.sceneDataUrl ? null : p.framed ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={p.productDataUrl} alt="" style={{ position: "absolute", left: 210, top: 360, width: 660, height: 760, objectFit: "cover", borderRadius: 32, border: "1.5px solid rgba(255,253,248,0.85)", boxShadow: "0 30px 70px rgba(45,32,20,0.3)" }} />
  ) : (
    <>
      <div style={{ position: "absolute", left: 150, top: 320, width: 780, height: 840, borderRadius: "50%", background: "radial-gradient(circle, rgba(255,253,248,0.95) 0%, rgba(255,253,248,0) 66%)" }} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={p.productDataUrl} alt="" style={{ position: "absolute", left: 210, top: 360, width: 660, height: 760, objectFit: "contain", mixBlendMode: "multiply" }} />
    </>
  );

  const priceBadge = !p.price ? null : (
    <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", background: "rgba(255,253,248,0.9)", border: `1.5px solid rgba(${GOLD_RGB},0.5)`, borderRadius: 26, padding: "12px 34px", direction: "rtl" }}>
      <span style={{ fontSize: 20, letterSpacing: 3, color: GOLD }}>سعر خاص</span>
      <span style={{ fontFamily: AD_FONT_HEADLINE, fontSize: 46, fontWeight: 700, color: INK, lineHeight: 1.1 }}>{p.price}</span>
    </div>
  );

  return (
    <div style={root}>
      {backdrop}
      {product}

      {/* top & bottom scrims for text legibility over any scene */}
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: 460, background: `linear-gradient(180deg, rgba(${CREAM},0.72) 0%, rgba(${CREAM},0.4) 52%, rgba(${CREAM},0) 100%)` }} />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 900, background: `linear-gradient(0deg, rgba(${CREAM},0.9) 0%, rgba(${CREAM},0.66) 46%, rgba(${CREAM},0.2) 82%, rgba(${CREAM},0) 100%)` }} />

      {/* brand lockup — kept below the IG profile bar */}
      <div style={{ position: "absolute", top: 150, left: 0, right: 0, textAlign: "center", fontFamily: AD_FONT_LATIN }}>
        {p.logoDataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.logoDataUrl} alt="" style={{ height: 110, width: 110, objectFit: "contain", mixBlendMode: "multiply", margin: "0 auto", display: "block" }} />
        ) : null}
        <div style={{ fontSize: 46, fontWeight: 400, letterSpacing: 8, lineHeight: 1, color: INK, marginTop: p.logoDataUrl ? 10 : 0 }}>{p.brandTop}</div>
        <div style={{ fontSize: 18, letterSpacing: 13, color: MUTED, marginTop: 10 }}>{p.brandSub}</div>
      </div>

      {/* copy block — anchored above the reply-bar safe zone */}
      <div style={{ position: "absolute", left: 70, right: 70, bottom: 240, display: "flex", flexDirection: "column", alignItems: "center", gap: 20, direction: "rtl", textAlign: "center" }}>
        <div style={{ fontFamily: AD_FONT_HEADLINE, fontSize: 74, fontWeight: 700, lineHeight: 1.18, color: INK, ...glow }}>{p.headline}</div>
        {p.headlineEn ? (
          <div style={{ fontFamily: AD_FONT_LATIN, fontSize: 28, fontWeight: 400, letterSpacing: 5, textTransform: "uppercase", color: GOLD, direction: "ltr", ...glow }}>{p.headlineEn}</div>
        ) : null}
        {p.subtitle ? <div style={{ fontSize: 30, fontWeight: 300, color: MUTED, lineHeight: 1.5, ...glow }}>{p.subtitle}</div> : null}

        {p.options?.length ? (
          <div style={{ display: "flex", flexDirection: "row-reverse", flexWrap: "wrap", gap: 10, justifyContent: "center" }}>
            {p.options.slice(0, 6).map((o, i) => (
              <span key={i} style={{ fontSize: 22, color: INK, background: "rgba(255,253,248,0.85)", border: `1px solid rgba(${GOLD_RGB},0.4)`, borderRadius: 17, padding: "7px 20px" }}>{o}</span>
            ))}
          </div>
        ) : null}

        {priceBadge}

        <div style={{ background: DARK, color: "#f5efe4", borderRadius: 44, padding: "22px 52px", fontSize: 32, fontWeight: 800, letterSpacing: 1, direction: "rtl", display: "flex", alignItems: "center", gap: 16, boxShadow: "0 12px 30px rgba(30,22,14,0.3)", marginTop: 6 }}>
          <span>اطلبيه الآن</span>
          <span style={{ width: 1, height: 28, background: "rgba(245,239,228,0.4)" }} />
          <span style={{ fontFamily: AD_FONT_LATIN, fontSize: 20, fontWeight: 400, letterSpacing: 4, direction: "ltr" }}>SHOP NOW</span>
          <svg width={30} height={30} viewBox="0 0 24 24" fill="none" stroke="#f5efe4" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" xmlns="http://www.w3.org/2000/svg"><path d={BAG} /></svg>
        </div>

        <div style={{ fontFamily: AD_FONT_LATIN, fontSize: 24, letterSpacing: 2, color: MUTED }}>{p.handle}</div>
      </div>
    </div>
  );
}
