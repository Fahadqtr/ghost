import type { CSSProperties } from "react";
import type { AdBullet } from "@/lib/social/ad-copy-compute";

// Fixed 1080×1080 luxury ad, styled with INLINE styles only (so nodeToJpeg's
// SVG foreignObject can rasterize it). The AI scene (product on the right,
// clean negative space on the left) is the background; the Arabic copy is
// printed with real fonts over the left — matching the reference layout.

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
}

const INK = "#3a2b1d";
const MUTED = "#8c7a66";
const GOLD = "#b0894f";
const DARK = "#2c2013";
const CREAM = "247,240,230";
const FONT = '"Tajawal","Cairo","Segoe UI",Arial,sans-serif';

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

function Glyph({ d, size, color, w = 1.6 }: { d: string; size: number; color: string; w?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
      strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" xmlns="http://www.w3.org/2000/svg">
      <path d={d} />
    </svg>
  );
}

export default function AdTemplate(p: AdTemplateProps) {
  const root: CSSProperties = {
    position: "absolute", top: 0, left: 0, width: 1080, height: 1080,
    fontFamily: FONT, color: INK, overflow: "hidden", background: "#f7f0e6",
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

      {/* Brand */}
      <div style={{ position: "absolute", top: 54, left: 64 }}>
        <div style={{ fontSize: 46, fontWeight: 800, letterSpacing: 2, lineHeight: 1, color: INK }}>{p.brandTop}</div>
        <div style={{ fontSize: 16, letterSpacing: 8, color: MUTED, marginTop: 6 }}>{p.brandSub}</div>
        <div style={{ width: 60, height: 3, background: GOLD, borderRadius: 2, marginTop: 14 }} />
      </div>

      {/* Headline + subtitle */}
      <div style={{ position: "absolute", top: 176, left: 64, width: 466, ...rtl }}>
        <div style={{ fontSize: 46, fontWeight: 800, lineHeight: 1.16, color: INK }}>{p.headline}</div>
        {p.subtitle ? <div style={{ fontSize: 22, color: MUTED, marginTop: 12, lineHeight: 1.4 }}>{p.subtitle}</div> : null}
      </div>

      {/* Benefits */}
      <div style={{ position: "absolute", top: 322, left: 64, width: 466 }}>
        {benefits.map((b, i) => (
          <div key={i} style={{
            display: "flex", flexDirection: "row", alignItems: "center", gap: 16,
            paddingBottom: 13, marginBottom: 13,
            borderBottom: i < benefits.length - 1 ? "1px solid rgba(176,137,79,0.28)" : "none",
          }}>
            <div style={{ width: 50, height: 50, borderRadius: 25, flexShrink: 0, background: "rgba(176,137,79,0.14)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Glyph d={BENEFIT_ICONS[i % BENEFIT_ICONS.length]} size={26} color={GOLD} />
            </div>
            <div style={{ flex: 1, ...rtl }}>
              <div style={{ fontSize: 24, fontWeight: 700, color: INK, lineHeight: 1.25 }}>{b.title}</div>
              {b.sub ? <div style={{ fontSize: 16, color: MUTED, marginTop: 2, lineHeight: 1.3 }}>{b.sub}</div> : null}
            </div>
          </div>
        ))}
      </div>

      {/* Price badge + CTA (bottom-left, above the footer) */}
      <div style={{ position: "absolute", left: 64, bottom: 122, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 14 }}>
        {p.price ? (
          <div style={{ ...rtl, background: "rgba(255,255,255,0.72)", border: "1.5px solid rgba(176,137,79,0.55)", borderRadius: 18, padding: "12px 26px" }}>
            <div style={{ fontSize: 18, color: GOLD, fontWeight: 600, letterSpacing: 1 }}>{p.priceLabel}</div>
            <div style={{ fontSize: 40, fontWeight: 800, color: INK, lineHeight: 1.05 }}>{p.price}</div>
          </div>
        ) : null}
        <div style={{ background: DARK, color: "#f7f0e6", borderRadius: 36, padding: "15px 40px", fontSize: 25, fontWeight: 700, letterSpacing: 2, direction: "rtl", display: "flex", alignItems: "center", gap: 12 }}>
          <span>اطلبيه الآن</span>
          <Glyph d="M6 8h12l-1 11H7z M9 8a3 3 0 0 1 6 0" size={22} color="#f7f0e6" />
        </div>
      </div>

      {/* Footer feature bar */}
      {p.features.length ? (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 104, background: `rgba(${CREAM},0.75)`, display: "flex", flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-around", padding: "0 44px", borderTop: "1px solid rgba(176,137,79,0.2)" }}>
          {p.features.slice(0, 3).map((f, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "row-reverse", alignItems: "center", gap: 12 }}>
              <Glyph d={FEATURE_ICONS[i % FEATURE_ICONS.length]} size={30} color={GOLD} />
              <div style={{ ...rtl }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: INK, lineHeight: 1.2 }}>{f.title}</div>
                {f.sub ? <div style={{ fontSize: 14, color: MUTED, lineHeight: 1.2 }}>{f.sub}</div> : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
