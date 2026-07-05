import type { CSSProperties, ReactNode } from "react";
import type { AdBullet } from "@/lib/social/ad-copy-compute";
import type { AdPalette, AdLayoutKey } from "@/lib/social/ad-variants";
import { AD_FONT_HEADLINE, AD_FONT_BODY, AD_FONT_LATIN } from "@/lib/social/ad-fonts";

// Fixed 1080×1350 (Instagram 4:5) luxury ad, styled with INLINE styles only
// (so nodeToJpeg's SVG foreignObject can rasterize it).
//
// KEY RULE: the product photo is the ORIGINAL catalog image, composited as-is
// (never AI-redrawn), over an AI-generated EMPTY backdrop (or the designed CSS
// background when no backdrop). Arabic is printed with embedded luxury fonts.
//
// THREE LAYOUTS (picked per product, rotate per tap — see ad-variants):
//   panel  — detailed left copy column, product right (editorial)
//   hero   — big centered product, minimal centered copy (Rhode-style)
//   banner — large product on top, solid info panel at the bottom (magazine)

export const AD_W = 1080;
export const AD_H = 1350;

export interface AdTemplateProps {
  productDataUrl?: string;  // product photo for fallback compositing ("" when the scene already contains it)
  backdropDataUrl?: string; // empty AI backdrop, data: URL ("" → CSS background)
  logoDataUrl?: string;     // MU monogram (black on white), data: URL — multiplied so white vanishes
  brandTop: string;         // "MALIKA'S"
  brandSub: string;         // "UNIVERSE BEAUTY"
  handle: string;           // "@malikas.universe"
  headline: string;
  headlineEn?: string;      // elegant English echo line under the Arabic headline
  subtitle: string;
  benefits: AdBullet[];     // up to 5 (title + optional sub)
  features: AdBullet[];     // up to 3 footer chips
  website?: string;         // "www.malikasuniverse.com" (store link line)
  palette?: AdPalette;      // per-product design variant colors
  frameProduct?: boolean;   // busy/lifestyle photo → elegant rounded card instead of multiply-melt
  layout?: AdLayoutKey;     // "panel" (default) | "hero" | "banner"
}

// Default palette (cream-gold) — overridden by the picked variant.
const DEFAULT_PALETTE: AdPalette = {
  ink: "#38291b", muted: "#8c7a66", gold: "#b0894f", dark: "#2c2013", panel: "247,240,230",
};

// Thin outline glyphs (elegant, matching the reference).
const BENEFIT_ICONS = [
  "M12 4l1.7 4.6L18 10l-4.3 1.4L12 16l-1.7-4.6L6 10l4.3-1.4z",                 // sparkle
  "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z M8.5 12l2.2 2.2L15.5 9.5",            // check-circle
  "M12 3s5 6 5 10a5 5 0 1 1-10 0c0-4 5-10 5-10z",                              // drop
  "M20 5C11 5 6 10 5 19c9 0 14-5 15-14z M5 19c4-6 8-9 13-11",                  // leaf
  "M12 20s-6.5-4-8.5-8A4.3 4.3 0 0 1 12 8a4.3 4.3 0 0 1 8.5 4c-2 4-8.5 8-8.5 8z", // heart
];
const FEATURE_ICONS = [
  "M12 3l7 3v5c0 4.5-3 7.5-7 8.5-4-1-7-4-7-8.5V6z",                            // shield
  "M6 8h12l-1 11H7z M9 8a3 3 0 0 1 6 0",                                        // bag
  "M20 5C11 5 6 10 5 19c9 0 14-5 15-14z",                                       // leaf
];
const BAG = "M6 8h12l-1 11H7z M9 8a3 3 0 0 1 6 0";

function Glyph({ d, size, color, w = 1.4 }: { d: string; size: number; color: string; w?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
      strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" xmlns="http://www.w3.org/2000/svg">
      <path d={d} />
    </svg>
  );
}

const hexRgb = (hex: string): string => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "176,137,79";
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
};

const rtl: CSSProperties = { direction: "rtl", textAlign: "right" };

// Soft light halo behind text so type stays legible DIRECTLY on the scene
// (no solid panels — the ad reads as one integrated photograph).
const glow: CSSProperties = { textShadow: "0 0 18px rgba(255,253,248,0.9), 0 1px 4px rgba(255,253,248,0.75)" };

/** The untouched product photo: framed card OR multiply-melt, at a given box. */
function ProductPhoto({ src, framed, box }: {
  src: string; framed: boolean;
  box: { right?: number; left?: number; top: number; width: number; height: number };
}) {
  if (framed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt="" style={{ position: "absolute", ...box, objectFit: "cover", borderRadius: 28, border: "1.5px solid rgba(255,253,248,0.85)", boxShadow: "0 26px 60px rgba(45,32,20,0.28)" }} />
    );
  }
  const cx = box.left != null ? box.left + box.width / 2 : undefined;
  return (
    <>
      <div style={{
        position: "absolute", top: box.top - 40, width: box.width + 80, height: box.height + 80, borderRadius: "50%",
        ...(box.left != null ? { left: (cx as number) - (box.width + 80) / 2 } : { right: (box.right as number) - 40 }),
        background: "radial-gradient(circle, rgba(255,253,248,0.95) 0%, rgba(255,253,248,0) 66%)",
      }} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" style={{ position: "absolute", ...box, objectFit: "contain", mixBlendMode: "multiply" }} />
    </>
  );
}

export default function AdTemplate(p: AdTemplateProps) {
  const pal = p.palette ?? DEFAULT_PALETTE;
  const { ink: INK, muted: MUTED, gold: GOLD, dark: DARK, panel: CREAM } = pal;
  const GOLD_RGB = hexRgb(GOLD);
  const layout = p.layout ?? "panel";
  const framed = !!p.frameProduct;

  const root: CSSProperties = {
    position: "absolute", top: 0, left: 0, width: AD_W, height: AD_H,
    fontFamily: AD_FONT_BODY, color: INK, overflow: "hidden", background: `rgb(${CREAM})`,
  };

  const backdrop = p.backdropDataUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={p.backdropDataUrl} alt="" style={{ position: "absolute", inset: 0, width: AD_W, height: AD_H, objectFit: "cover" }} />
  ) : (
    <>
      <div style={{ position: "absolute", inset: 0, background: `linear-gradient(135deg, rgb(${CREAM}) 0%, rgba(${GOLD_RGB},0.16) 100%)` }} />
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at 60% 34%, rgba(255,252,246,0.9) 0%, rgba(255,252,246,0) 48%)" }} />
    </>
  );

  const brandLockup = (centered = false) => (
    <div style={{ position: "absolute", top: centered ? 44 : 52, ...(centered ? { left: 0, right: 0, textAlign: "center" as const } : { left: 68 }), fontFamily: AD_FONT_LATIN }}>
      {p.logoDataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={p.logoDataUrl} alt="" style={{ height: 96, width: 96, objectFit: "contain", mixBlendMode: "multiply", ...(centered ? { margin: "0 auto", display: "block" } : {}) }} />
      ) : null}
      <div style={{ fontSize: centered ? 34 : 36, fontWeight: 400, letterSpacing: 6, lineHeight: 1, color: INK, marginTop: p.logoDataUrl ? 8 : 0 }}>{p.brandTop}</div>
      <div style={{ fontSize: 14, letterSpacing: 10, color: MUTED, marginTop: 8 }}>{p.brandSub}</div>
      {!centered && <div style={{ width: 58, height: 2, background: GOLD, marginTop: 14 }} />}
    </div>
  );

  const ctaPill = (
    <div style={{ background: DARK, color: "#f5efe4", borderRadius: 38, padding: "17px 40px", fontSize: 25, fontWeight: 800, letterSpacing: 1, direction: "rtl", display: "flex", alignItems: "center", gap: 13, boxShadow: "0 10px 26px rgba(30,22,14,0.28)" }}>
      <span>اطلبيه الآن</span>
      <span style={{ width: 1, height: 22, background: "rgba(245,239,228,0.4)" }} />
      <span style={{ fontFamily: AD_FONT_LATIN, fontSize: 16, fontWeight: 400, letterSpacing: 3, direction: "ltr" }}>SHOP NOW</span>
      <Glyph d={BAG} size={23} color="#f5efe4" />
    </div>
  );

  // Elegant English echo line under the Arabic headline (bilingual design).
  const headlineEnLine = (center = false): ReactNode => !p.headlineEn ? null : (
    <div style={{ fontFamily: AD_FONT_LATIN, fontSize: 24, fontWeight: 400, letterSpacing: 4, textTransform: "uppercase" as const, color: GOLD, marginTop: 12, direction: "ltr", textAlign: (center ? "center" : "right") as CSSProperties["textAlign"], ...glow }}>
      {p.headlineEn}
    </div>
  );

  const handleLine = (center = false): ReactNode => (
    <div style={{ fontFamily: AD_FONT_LATIN, fontSize: 19, letterSpacing: 2, color: MUTED, ...(center ? { textAlign: "center" as const } : {}) }}>{p.handle}</div>
  );

  // Store link — replaces the price badge (Fahad: no prices on the design).
  const websiteLine = (center = false): ReactNode => !p.website ? null : (
    <div style={{ fontFamily: AD_FONT_LATIN, fontSize: 21, letterSpacing: 2.5, textTransform: "uppercase" as const, color: INK, direction: "ltr", ...(center ? { textAlign: "center" as const } : {}), ...glow }}>{p.website}</div>
  );

  // ---------------------------------------------------------------- panel ----
  if (layout === "panel") {
    const benefits = p.benefits.slice(0, 5);
    return (
      <div style={root}>
        {backdrop}
        <div style={{ position: "absolute", inset: 0, background: `linear-gradient(90deg, rgba(${CREAM},0.66) 0%, rgba(${CREAM},0.44) 42%, rgba(${CREAM},0.16) 60%, rgba(${CREAM},0) 74%)` }} />
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 210, background: `linear-gradient(0deg, rgba(${CREAM},0.6) 0%, rgba(${CREAM},0) 100%)` }} />

        {p.productDataUrl ? <ProductPhoto src={p.productDataUrl} framed={framed}
          box={framed ? { right: 40, top: 388, width: 500, height: 620 } : { right: 28, top: 360, width: 560, height: 660 }} /> : null}

        {brandLockup()}

        <div style={{ position: "absolute", top: 252, left: 68, width: 424, ...rtl }}>
          <div style={{ fontFamily: AD_FONT_HEADLINE, fontSize: 54, fontWeight: 700, lineHeight: 1.22, color: INK, ...glow }}>{p.headline}</div>
          {headlineEnLine()}
          {p.subtitle ? <div style={{ fontSize: 22, fontWeight: 300, color: MUTED, marginTop: 12, lineHeight: 1.5, ...glow }}>{p.subtitle}</div> : null}
        </div>

        <div style={{ position: "absolute", top: 468, left: 68, width: 424 }}>
          {benefits.map((b, i) => (
            <div key={i} style={{
              display: "flex", flexDirection: "row", alignItems: "center", gap: 18,
              paddingBottom: 16, marginBottom: 16,
              borderBottom: i < benefits.length - 1 ? `1px solid rgba(${GOLD_RGB},0.22)` : "none",
            }}>
              <div style={{ width: 54, height: 54, borderRadius: 27, flexShrink: 0, border: `1.5px solid rgba(${GOLD_RGB},0.45)`, background: "rgba(255,253,248,0.6)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Glyph d={BENEFIT_ICONS[i % BENEFIT_ICONS.length]} size={26} color={GOLD} />
              </div>
              <div style={{ flex: 1, ...rtl }}>
                <div style={{ fontSize: 25, fontWeight: 800, color: INK, lineHeight: 1.3, ...glow }}>{b.title}</div>
                {b.sub ? <div style={{ fontSize: 17, fontWeight: 300, color: MUTED, marginTop: 3, lineHeight: 1.35, ...glow }}>{b.sub}</div> : null}
              </div>
            </div>
          ))}
        </div>

        <div style={{ position: "absolute", left: 68, bottom: 140, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 16 }}>
          {ctaPill}
          {websiteLine()}
          {handleLine()}
        </div>

        {p.features.length ? (
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 108, background: `rgba(${CREAM},0.5)`, display: "flex", flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-around", padding: "0 46px", borderTop: `1px solid rgba(${GOLD_RGB},0.2)` }}>
            {p.features.slice(0, 3).map((f, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "row-reverse", alignItems: "center", gap: 13 }}>
                <Glyph d={FEATURE_ICONS[i % FEATURE_ICONS.length]} size={30} color={GOLD} />
                <div style={{ ...rtl }}>
                  <div style={{ fontSize: 21, fontWeight: 800, color: INK, lineHeight: 1.25 }}>{f.title}</div>
                  {f.sub ? <div style={{ fontSize: 15, fontWeight: 300, color: MUTED, lineHeight: 1.25 }}>{f.sub}</div> : null}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  // ----------------------------------------------------------------- hero ----
  if (layout === "hero") {
    const chips = p.benefits.slice(0, 3);
    return (
      <div style={root}>
        {backdrop}
        <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: 420, background: `linear-gradient(180deg, rgba(${CREAM},0.62) 0%, rgba(${CREAM},0.4) 55%, rgba(${CREAM},0) 100%)` }} />
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 400, background: `linear-gradient(0deg, rgba(${CREAM},0.62) 0%, rgba(${CREAM},0.38) 55%, rgba(${CREAM},0) 100%)` }} />

        {p.productDataUrl ? <ProductPhoto src={p.productDataUrl} framed={framed}
          box={framed ? { left: 250, top: 430, width: 580, height: 560 } : { left: 220, top: 400, width: 640, height: 600 }} /> : null}

        {brandLockup(true)}

        <div style={{ position: "absolute", top: 252, left: 60, right: 60, direction: "rtl", textAlign: "center" }}>
          <div style={{ fontFamily: AD_FONT_HEADLINE, fontSize: 62, fontWeight: 700, lineHeight: 1.2, color: INK, ...glow }}>{p.headline}</div>
          {headlineEnLine(true)}
          {p.subtitle ? <div style={{ fontSize: 23, fontWeight: 300, color: MUTED, marginTop: 12, lineHeight: 1.5, ...glow }}>{p.subtitle}</div> : null}
        </div>

        {chips.length ? (
          <div style={{ position: "absolute", left: 40, right: 40, bottom: 258, display: "flex", flexDirection: "row-reverse", justifyContent: "center", gap: 16, flexWrap: "wrap" }}>
            {chips.map((b, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "row-reverse", alignItems: "center", gap: 10, background: "rgba(255,253,248,0.85)", border: `1.5px solid rgba(${GOLD_RGB},0.4)`, borderRadius: 30, padding: "12px 24px" }}>
                <Glyph d={BENEFIT_ICONS[i % BENEFIT_ICONS.length]} size={22} color={GOLD} />
                <span style={{ fontSize: 21, fontWeight: 800, color: INK, direction: "rtl" }}>{b.title}</span>
              </div>
            ))}
          </div>
        ) : null}

        <div style={{ position: "absolute", left: 0, right: 0, bottom: 148, display: "flex", flexDirection: "row-reverse", justifyContent: "center", alignItems: "center", gap: 18 }}>
          {ctaPill}
        </div>
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 96 }}>{websiteLine(true)}</div>
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 58 }}>{handleLine(true)}</div>
      </div>
    );
  }

  // ---------------------------------------------------------------- banner ---
  const cols = p.benefits.slice(0, 3);
  const PANEL_H = 486;
  return (
    <div style={root}>
      {backdrop}
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: 210, background: `linear-gradient(180deg, rgba(${CREAM},0.55) 0%, rgba(${CREAM},0) 100%)` }} />

      {p.productDataUrl ? <ProductPhoto src={p.productDataUrl} framed={framed}
        box={framed ? { left: 240, top: 172, width: 600, height: 620 } : { left: 210, top: 140, width: 660, height: 660 }} /> : null}

      {brandLockup()}

      {/* Solid bottom info panel */}
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: PANEL_H, background: `linear-gradient(0deg, rgba(${CREAM},0.85) 0%, rgba(${CREAM},0.62) 62%, rgba(${CREAM},0.22) 86%, rgba(${CREAM},0) 100%)` }}>
        <div style={{ position: "absolute", top: 40, left: 68, right: 68, ...rtl }}>
          <div style={{ fontFamily: AD_FONT_HEADLINE, fontSize: 48, fontWeight: 700, lineHeight: 1.2, color: INK, ...glow }}>{p.headline}</div>
          {headlineEnLine()}
          {p.subtitle ? <div style={{ fontSize: 21, fontWeight: 300, color: MUTED, marginTop: 8, lineHeight: 1.45, ...glow }}>{p.subtitle}</div> : null}
        </div>

        {cols.length ? (
          <div style={{ position: "absolute", top: 232, left: 56, right: 56, display: "flex", flexDirection: "row-reverse", justifyContent: "space-around", gap: 14 }}>
            {cols.map((b, i) => (
              <div key={i} style={{ flex: 1, textAlign: "center", direction: "rtl" }}>
                <div style={{ width: 52, height: 52, borderRadius: 26, margin: "0 auto", border: `1.5px solid rgba(${GOLD_RGB},0.45)`, background: "rgba(255,253,248,0.7)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Glyph d={BENEFIT_ICONS[i % BENEFIT_ICONS.length]} size={25} color={GOLD} />
                </div>
                <div style={{ fontSize: 22, fontWeight: 800, color: INK, marginTop: 10, lineHeight: 1.3, ...glow }}>{b.title}</div>
                {b.sub ? <div style={{ fontSize: 15, fontWeight: 300, color: MUTED, marginTop: 3, lineHeight: 1.3, ...glow }}>{b.sub}</div> : null}
              </div>
            ))}
          </div>
        ) : null}

        <div style={{ position: "absolute", bottom: 38, left: 68, right: 68, display: "flex", flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", gap: 18 }}>
          {ctaPill}
          <div style={{ display: "flex", flexDirection: "column", gap: 7, alignItems: "flex-start" }}>
            {websiteLine()}
            {handleLine()}
          </div>
        </div>
      </div>
    </div>
  );
}
