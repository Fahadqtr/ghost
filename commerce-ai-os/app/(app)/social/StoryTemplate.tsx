import type { CSSProperties, ReactNode } from "react";
import { AD_FONT_HEADLINE, AD_FONT_BODY, AD_FONT_LATIN } from "@/lib/social/ad-fonts";

// Fixed 1080×1920 (Instagram Story 9:16) luxury creative, styled with INLINE
// styles only (so nodeToJpeg's SVG foreignObject can rasterize it).
//
// KEY RULE (same as AdTemplate): the image model NEVER renders Arabic — the
// scene is a TEXT-FREE photograph (or a designed gradient) and every Arabic word
// here is printed with embedded luxury fonts. The brand sits on the clear top of
// the scene; all copy lives in a bottom block, kept clear of the IG reply bar.
//
// THREE STYLES (cycled from the UI without re-generating):
//   card  — a floating frosted cream card with a gold hairline
//   sheet — a full-width cream sheet with a rounded top edge
//   band  — a full-width dark chocolate band, cream + gold text (bold)

export const STORY_W = 1080;
export const STORY_H = 1920;

export type StoryStyle = "card" | "sheet" | "band";
export const STORY_STYLES: StoryStyle[] = ["card", "sheet", "band"];

export interface StoryTemplateProps {
  sceneDataUrl?: string;    // wordless AI scene, data: URL ("" → gradient + product photo)
  productDataUrl?: string;  // original product photo, composited when there's no scene
  logoDataUrl?: string;     // MU monogram (black on white), data: URL — multiplied so white vanishes
  brandTop: string;         // "MALIKA'S"
  brandSub: string;         // "UNIVERSE BEAUTY"
  handle: string;           // "@malikas_universe"
  website?: string;         // "www.malikasuniverse.com" (store link)
  headline: string;
  headlineEn?: string;
  subtitle?: string;
  price?: string;           // formatted, e.g. "78 ر.ق" ("" → no badge)
  options?: string[];       // variant names (shades/sizes)
  framed?: boolean;         // busy/lifestyle photo → rounded card instead of multiply-melt
  style?: StoryStyle;       // visual variant (default "card")
}

const CREAM = "247,240,230";
const GOLD_RGB = "176,137,79";
const BAG = "M6 8h12l-1 11H7z M9 8a3 3 0 0 1 6 0";

interface Colors {
  ink: string; muted: string; gold: string;
  ctaBg: string; ctaFg: string;
  priceBg: string; priceBorder: string;
}
const LIGHT: Colors = { ink: "#38291b", muted: "#8c7a66", gold: "#b0894f", ctaBg: "#2c2013", ctaFg: "#f5efe4", priceBg: "rgba(255,253,248,0.92)", priceBorder: `rgba(${GOLD_RGB},0.5)` };
const DARK: Colors = { ink: "#f7efe2", muted: "#cdb891", gold: "#e6c079", ctaBg: "#f3ead9", ctaFg: "#2c2013", priceBg: "rgba(255,255,255,0.1)", priceBorder: "rgba(230,192,121,0.55)" };

export default function StoryTemplate(p: StoryTemplateProps) {
  const style = p.style ?? "card";
  const c = style === "band" ? DARK : LIGHT;

  const root: CSSProperties = {
    position: "absolute", top: 0, left: 0, width: STORY_W, height: STORY_H,
    fontFamily: AD_FONT_BODY, color: c.ink, overflow: "hidden", background: `rgb(${CREAM})`,
  };

  const backdrop = p.sceneDataUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={p.sceneDataUrl} alt="" style={{ position: "absolute", inset: 0, width: STORY_W, height: STORY_H, objectFit: "cover" }} />
  ) : (
    <>
      <div style={{ position: "absolute", inset: 0, background: `linear-gradient(160deg, rgb(${CREAM}) 0%, rgba(${GOLD_RGB},0.18) 100%)` }} />
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at 50% 32%, rgba(255,252,246,0.92) 0%, rgba(255,252,246,0) 50%)" }} />
    </>
  );

  // Composite the ORIGINAL product photo only when there's no scene.
  const product = !p.productDataUrl || p.sceneDataUrl ? null : p.framed ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={p.productDataUrl} alt="" style={{ position: "absolute", left: 230, top: 330, width: 620, height: 720, objectFit: "cover", borderRadius: 32, border: "1.5px solid rgba(255,253,248,0.85)", boxShadow: "0 30px 70px rgba(45,32,20,0.3)" }} />
  ) : (
    <>
      <div style={{ position: "absolute", left: 170, top: 300, width: 740, height: 800, borderRadius: "50%", background: "radial-gradient(circle, rgba(255,253,248,0.95) 0%, rgba(255,253,248,0) 66%)" }} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={p.productDataUrl} alt="" style={{ position: "absolute", left: 230, top: 330, width: 620, height: 720, objectFit: "contain", mixBlendMode: "multiply" }} />
    </>
  );

  const priceBadge = !p.price ? null : (
    <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", background: c.priceBg, border: `1.5px solid ${c.priceBorder}`, borderRadius: 26, padding: "12px 34px", direction: "rtl" }}>
      <span style={{ fontSize: 20, letterSpacing: 3, color: c.gold }}>سعر خاص</span>
      <span style={{ fontFamily: AD_FONT_HEADLINE, fontSize: 46, fontWeight: 700, color: c.ink, lineHeight: 1.1 }}>{p.price}</span>
    </div>
  );

  // The shared copy stack (brand-independent) — same in every style, recoloured.
  const copy: ReactNode = (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 18, direction: "rtl", textAlign: "center" }}>
      <div style={{ fontFamily: AD_FONT_HEADLINE, fontSize: 76, fontWeight: 700, lineHeight: 1.18, color: c.ink }}>{p.headline}</div>
      {p.headlineEn ? (
        <div style={{ fontFamily: AD_FONT_LATIN, fontSize: 28, fontWeight: 400, letterSpacing: 5, textTransform: "uppercase", color: c.gold, direction: "ltr" }}>{p.headlineEn}</div>
      ) : null}
      {p.subtitle ? <div style={{ fontSize: 31, fontWeight: 300, color: c.muted, lineHeight: 1.5 }}>{p.subtitle}</div> : null}

      {p.options?.length ? (
        <div style={{ display: "flex", flexDirection: "row-reverse", flexWrap: "wrap", gap: 10, justifyContent: "center" }}>
          {p.options.slice(0, 6).map((o, i) => (
            <span key={i} style={{ fontSize: 22, color: c.ink, background: c.priceBg, border: `1px solid ${c.priceBorder}`, borderRadius: 17, padding: "7px 20px" }}>{o}</span>
          ))}
        </div>
      ) : null}

      {priceBadge}

      <div style={{ background: c.ctaBg, color: c.ctaFg, borderRadius: 44, padding: "22px 52px", fontSize: 32, fontWeight: 800, letterSpacing: 1, direction: "rtl", display: "flex", alignItems: "center", gap: 16, boxShadow: "0 12px 30px rgba(30,22,14,0.3)", marginTop: 6 }}>
        <span>اطلبيه الآن</span>
        <span style={{ width: 1, height: 28, background: "rgba(150,130,100,0.4)" }} />
        <span style={{ fontFamily: AD_FONT_LATIN, fontSize: 20, fontWeight: 400, letterSpacing: 4, direction: "ltr" }}>SHOP NOW</span>
        <svg width={30} height={30} viewBox="0 0 24 24" fill="none" stroke={c.ctaFg} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" xmlns="http://www.w3.org/2000/svg"><path d={BAG} /></svg>
      </div>

      {/* store link + handle — forced LTR so "@" and "www" read correctly */}
      {p.website ? (
        <div style={{ fontFamily: AD_FONT_LATIN, fontSize: 27, fontWeight: 400, letterSpacing: 2.5, textTransform: "uppercase", color: c.ink, direction: "ltr", marginTop: 4 }}>{p.website}</div>
      ) : null}
      <div style={{ fontFamily: AD_FONT_LATIN, fontSize: 23, letterSpacing: 2, color: c.muted, direction: "ltr" }}>{p.handle}</div>
    </div>
  );

  // Brand lockup — on the clear TOP of the scene (dark ink reads on the light
  // upper area in every style).
  const brand = (
    <div style={{ position: "absolute", top: 130, left: 0, right: 0, textAlign: "center", fontFamily: AD_FONT_LATIN }}>
      {p.logoDataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={p.logoDataUrl} alt="" style={{ height: 104, width: 104, objectFit: "contain", mixBlendMode: "multiply", margin: "0 auto", display: "block" }} />
      ) : null}
      <div style={{ fontSize: 44, fontWeight: 400, letterSpacing: 8, lineHeight: 1, color: "#38291b", marginTop: p.logoDataUrl ? 8 : 0 }}>{p.brandTop}</div>
      <div style={{ fontSize: 17, letterSpacing: 12, color: "#8c7a66", marginTop: 9 }}>{p.brandSub}</div>
    </div>
  );

  const topScrim = <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: 440, background: `linear-gradient(180deg, rgba(${CREAM},0.72) 0%, rgba(${CREAM},0.4) 52%, rgba(${CREAM},0) 100%)` }} />;

  // --- card: floating frosted panel -----------------------------------------
  if (style === "card") {
    return (
      <div style={root}>
        {backdrop}{product}{topScrim}
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 620, background: `linear-gradient(0deg, rgba(${CREAM},0.7) 0%, rgba(${CREAM},0.2) 62%, rgba(${CREAM},0) 100%)` }} />
        {brand}
        <div style={{ position: "absolute", left: 48, right: 48, bottom: 150 }}>
          <div style={{ background: "rgba(255,252,247,0.9)", border: `1px solid rgba(${GOLD_RGB},0.35)`, borderRadius: 42, padding: "44px 44px 34px", boxShadow: "0 22px 64px rgba(45,32,20,0.22)" }}>
            {copy}
          </div>
        </div>
      </div>
    );
  }

  // --- sheet: full-width cream sheet, rounded top ---------------------------
  if (style === "sheet") {
    return (
      <div style={root}>
        {backdrop}{product}{topScrim}
        {brand}
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, background: "rgba(255,252,247,0.94)", borderTop: `2px solid rgba(${GOLD_RGB},0.3)`, borderRadius: "60px 60px 0 0", padding: "58px 60px 200px", boxShadow: "0 -20px 60px rgba(45,32,20,0.16)" }}>
          {copy}
        </div>
      </div>
    );
  }

  // --- band: bold dark chocolate band ---------------------------------------
  return (
    <div style={root}>
      {backdrop}{product}{topScrim}
      {brand}
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, background: "linear-gradient(0deg, #241a10 0%, #2c2013 82%, rgba(44,32,19,0) 100%)", borderTop: `2px solid rgba(230,192,121,0.35)`, padding: "70px 60px 200px" }}>
        {copy}
      </div>
    </div>
  );
}
