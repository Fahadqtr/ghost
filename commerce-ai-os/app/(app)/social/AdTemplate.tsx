import type { CSSProperties } from "react";
import type { AdBullet } from "@/lib/social/ad-copy-compute";
import type { AdPalette } from "@/lib/social/ad-variants";
import { AD_FONT_HEADLINE, AD_FONT_BODY, AD_FONT_LATIN } from "@/lib/social/ad-fonts";

// Fixed 1080×1080 luxury ad, styled with INLINE styles only (so nodeToJpeg's
// SVG foreignObject can rasterize it). The AI scene (product on the right,
// clean negative space on the left) is the background; the Arabic copy is
// printed with embedded luxury fonts (El Messiri display / Almarai text /
// Marcellus for the Latin lockup) over the left — Dior/Rhode editorial feel.

export interface AdTemplateProps {
  imageDataUrl: string;   // AI scene, inlined as a data: URL
  brandTop: string;       // "MALIKA'S"
  brandSub: string;       // "UNIVERSE BEAUTY"
  headline: string;
  subtitle: string;
  benefits: AdBullet[];   // up to 5 (title + optional sub)
  features: AdBullet[];   // up to 3 footer chips
  priceLabel: string;     // "سعر خاص"
  price: string;          // "128 ر.ق" ("" hides the badge)
  palette?: AdPalette;    // per-product design variant colors
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

export default function AdTemplate(p: AdTemplateProps) {
  const { ink: INK, muted: MUTED, gold: GOLD, dark: DARK, panel: CREAM } = p.palette ?? DEFAULT_PALETTE;
  const GOLD_RGB = hexRgb(GOLD);
  const root: CSSProperties = {
    position: "absolute", top: 0, left: 0, width: 1080, height: 1080,
    fontFamily: AD_FONT_BODY, color: INK, overflow: "hidden", background: `rgb(${CREAM})`,
  };
  const rtl: CSSProperties = { direction: "rtl", textAlign: "right" };
  const benefits = p.benefits.slice(0, 5);

  return (
    <div style={root}>
      {/* AI luxury scene (product on the right, empty cream on the left) */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={p.imageDataUrl} alt="" style={{ position: "absolute", inset: 0, width: 1080, height: 1080, objectFit: "cover" }} />
      {/* SOLID cream panel on the left (opaque) with a soft fade into the scene */}
      <div style={{ position: "absolute", inset: 0, background: `linear-gradient(90deg, rgb(${CREAM}) 0%, rgb(${CREAM}) 50%, rgba(${CREAM},0.55) 61%, rgba(${CREAM},0) 76%)` }} />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 170, background: `linear-gradient(0deg, rgba(${CREAM},0.95) 0%, rgba(${CREAM},0) 100%)` }} />

      {/* Brand — Marcellus (Roman caps, Dior-like), wide tracking */}
      <div style={{ position: "absolute", top: 56, left: 64, fontFamily: AD_FONT_LATIN }}>
        <div style={{ fontSize: 47, fontWeight: 400, letterSpacing: 5, lineHeight: 1, color: INK }}>{p.brandTop}</div>
        <div style={{ fontSize: 15, letterSpacing: 10, color: MUTED, marginTop: 9 }}>{p.brandSub}</div>
        <div style={{ width: 56, height: 2, background: GOLD, marginTop: 16 }} />
      </div>

      {/* Headline (El Messiri display) + subtitle (Almarai light) */}
      <div style={{ position: "absolute", top: 182, left: 64, width: 466, ...rtl }}>
        <div style={{ fontFamily: AD_FONT_HEADLINE, fontSize: 50, fontWeight: 700, lineHeight: 1.22, color: INK }}>{p.headline}</div>
        {p.subtitle ? <div style={{ fontSize: 21, fontWeight: 300, color: MUTED, marginTop: 12, lineHeight: 1.5 }}>{p.subtitle}</div> : null}
      </div>

      {/* Benefits — outline icon in a hairline ring, bold title + light sub */}
      <div style={{ position: "absolute", top: 338, left: 64, width: 466 }}>
        {benefits.map((b, i) => (
          <div key={i} style={{
            display: "flex", flexDirection: "row", alignItems: "center", gap: 18,
            paddingBottom: 13, marginBottom: 13,
            borderBottom: i < benefits.length - 1 ? `1px solid rgba(${GOLD_RGB},0.22)` : "none",
          }}>
            <div style={{ width: 52, height: 52, borderRadius: 26, flexShrink: 0, border: `1.5px solid rgba(${GOLD_RGB},0.45)`, background: "rgba(255,253,248,0.6)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Glyph d={BENEFIT_ICONS[i % BENEFIT_ICONS.length]} size={25} color={GOLD} />
            </div>
            <div style={{ flex: 1, ...rtl }}>
              <div style={{ fontSize: 24, fontWeight: 800, color: INK, lineHeight: 1.3 }}>{b.title}</div>
              {b.sub ? <div style={{ fontSize: 16, fontWeight: 300, color: MUTED, marginTop: 3, lineHeight: 1.35 }}>{b.sub}</div> : null}
            </div>
          </div>
        ))}
      </div>

      {/* Price badge + CTA (bottom-left, above the footer) */}
      <div style={{ position: "absolute", left: 64, bottom: 124, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 15 }}>
        {p.price ? (
          <div style={{ ...rtl, background: "rgba(255,253,248,0.82)", border: `1.5px solid rgba(${GOLD_RGB},0.5)`, borderRadius: 20, padding: "13px 28px" }}>
            <div style={{ fontSize: 17, color: GOLD, fontWeight: 400, letterSpacing: 1 }}>{p.priceLabel}</div>
            <div style={{ fontFamily: AD_FONT_HEADLINE, fontSize: 42, fontWeight: 700, color: INK, lineHeight: 1.1 }}>{p.price}</div>
          </div>
        ) : null}
        <div style={{ background: DARK, color: "#f5efe4", borderRadius: 36, padding: "16px 42px", fontSize: 24, fontWeight: 800, letterSpacing: 1, direction: "rtl", display: "flex", alignItems: "center", gap: 13, boxShadow: "0 10px 26px rgba(44,32,19,0.28)" }}>
          <span>اطلبيه الآن</span>
          <Glyph d="M6 8h12l-1 11H7z M9 8a3 3 0 0 1 6 0" size={22} color="#f5efe4" />
        </div>
      </div>

      {/* Footer feature bar */}
      {p.features.length ? (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 104, background: `rgba(${CREAM},0.78)`, display: "flex", flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-around", padding: "0 44px", borderTop: `1px solid rgba(${GOLD_RGB},0.2)` }}>
          {p.features.slice(0, 3).map((f, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "row-reverse", alignItems: "center", gap: 13 }}>
              <Glyph d={FEATURE_ICONS[i % FEATURE_ICONS.length]} size={29} color={GOLD} />
              <div style={{ ...rtl }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: INK, lineHeight: 1.25 }}>{f.title}</div>
                {f.sub ? <div style={{ fontSize: 14, fontWeight: 300, color: MUTED, lineHeight: 1.25 }}>{f.sub}</div> : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
