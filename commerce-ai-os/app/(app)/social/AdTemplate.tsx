import type { CSSProperties } from "react";

// Fixed 1080×1080 LUXURY editorial ad creative, styled with INLINE styles only
// (so nodeToJpeg's SVG foreignObject can rasterize it). Text is laid elegantly
// over the photographic scene's left negative space — Rhode/Aesop style — not
// in a separate boxed panel.

export interface AdTemplateProps {
  imageDataUrl: string;   // full-bleed product scene, inlined as a data: URL
  brandTop: string;       // "MALIKA'S"
  brandSub: string;       // "UNIVERSE BEAUTY"
  title: string;          // product name
  headline: string;       // short luxury marketing line
  benefits: string[];     // 3–5 elegant lines
  features: string[];     // 3 tiny footer features
  priceLabel: string;     // "سعر خاص"
  price: string;          // "48 ر.ق" ("" hides the badge)
  website: string;
}

const INK = "#3a2b1d";
const MUTED = "#7d6b57";
const GOLD = "#b0894f";
const DARK = "#2c2013";
const CREAM = "247,240,230";
const FONT = '"Tajawal","Cairo","Segoe UI",Arial,sans-serif';

const FEATURE_GLYPHS = [
  "M12 21s-7-4.5-9.5-9C1 9 3 5 6.5 5 9.2 5 12 8 12 8s2.8-3 5.5-3C21 5 23 9 21.5 12 19 16.5 12 21 12 21z", // heart
  "M12 2l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V5z",                                                          // shield
  "M12 2a3 3 0 0 1 3 3 3 3 0 0 1 4 4 3 3 0 0 1 0 6 3 3 0 0 1-4 4 3 3 0 0 1-6 0 3 3 0 0 1-4-4 3 3 0 0 1 0-6 3 3 0 0 1 4-4 3 3 0 0 1 3-3z", // flower
];

function Glyph({ d, size, color }: { d: string; size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} xmlns="http://www.w3.org/2000/svg">
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

  return (
    <div style={root}>
      {/* Full-bleed product scene */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={p.imageDataUrl} alt="" style={{ position: "absolute", inset: 0, width: 1080, height: 1080, objectFit: "cover" }} />

      {/* Left wash so the copy reads over the scene's negative space */}
      <div style={{
        position: "absolute", inset: 0,
        background: `linear-gradient(100deg, rgba(${CREAM},0.96) 0%, rgba(${CREAM},0.88) 40%, rgba(${CREAM},0.34) 60%, rgba(${CREAM},0) 76%)`,
      }} />
      {/* Faint bottom wash for the footer */}
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 150, background: `linear-gradient(0deg, rgba(${CREAM},0.9) 0%, rgba(${CREAM},0) 100%)` }} />

      {/* Copy column, over the left negative space */}
      <div style={{ position: "absolute", top: 96, left: 84, width: 486, ...rtl }}>
        <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: 2, lineHeight: 1, color: INK }}>{p.brandTop}</div>
        <div style={{ fontSize: 15, letterSpacing: 7, color: MUTED, marginTop: 6 }}>{p.brandSub}</div>

        <div style={{ width: 66, height: 3, background: GOLD, borderRadius: 2, margin: "28px 0 0 auto" }} />

        {p.title ? <div style={{ fontSize: 27, fontWeight: 600, color: MUTED, marginTop: 22 }}>{p.title}</div> : null}
        <div style={{ fontSize: 50, fontWeight: 800, lineHeight: 1.18, color: INK, marginTop: 10 }}>{p.headline}</div>

        <div style={{ marginTop: 30 }}>
          {p.benefits.slice(0, 5).map((b, i) => (
            <div key={i} style={{ ...rtl, fontSize: 25, fontWeight: 500, color: INK, marginBottom: 14, lineHeight: 1.35 }}>
              <span style={{ color: GOLD, fontWeight: 700 }}>—</span>&nbsp;{b}
            </div>
          ))}
        </div>
      </div>

      {/* Price badge */}
      {p.price ? (
        <div style={{
          position: "absolute", left: 84, bottom: 236, ...rtl,
          background: "rgba(255,255,255,0.72)", border: `1.5px solid rgba(176,137,79,0.55)`,
          borderRadius: 20, padding: "14px 28px", backdropFilter: "blur(2px)",
        }}>
          <div style={{ fontSize: 19, color: GOLD, fontWeight: 600, letterSpacing: 1 }}>{p.priceLabel}</div>
          <div style={{ fontSize: 46, fontWeight: 800, color: INK, lineHeight: 1.05 }}>{p.price}</div>
        </div>
      ) : null}

      {/* CTA button */}
      <div style={{
        position: "absolute", left: 84, bottom: 150,
        background: DARK, color: "#f7f0e6", borderRadius: 40, padding: "18px 46px",
        fontSize: 27, fontWeight: 700, letterSpacing: 2, direction: "rtl",
      }}>
        اطلبيه الآن
      </div>

      {/* Minimal footer — 3 feature chips */}
      {p.features.length ? (
        <div style={{
          position: "absolute", left: 0, right: 0, bottom: 40, height: 54,
          display: "flex", flexDirection: "row-reverse", alignItems: "center", justifyContent: "center", gap: 46,
        }}>
          {p.features.slice(0, 3).map((f, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "row-reverse", alignItems: "center", gap: 9 }}>
              <Glyph d={FEATURE_GLYPHS[i % FEATURE_GLYPHS.length]} size={22} color={GOLD} />
              <span style={{ fontSize: 21, fontWeight: 600, color: INK, direction: "rtl" }}>{f}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
