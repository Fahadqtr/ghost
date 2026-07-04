import type { CSSProperties } from "react";

// Fixed 1080×1080 ad creative, styled with INLINE styles only so it can be
// rasterized via nodeToJpeg (SVG foreignObject can't reach external CSS).
// Rendered off-screen by SocialClient, captured, then uploaded.

export interface AdTemplateProps {
  imageDataUrl: string;   // product photo, already inlined as a data: URL
  brandTop: string;       // "MALIKA'S"
  brandSub: string;       // "UNIVERSE BEAUTY"
  headline: string;
  benefits: string[];
  features: string[];
  priceLabel: string;     // "سعر خاص"
  price: string;          // "48 ر.ق" ("" hides the badge)
  website: string;
}

const INK = "#4a3728";
const MUTED = "#8c7a66";
const ACCENT = "#c9a06a";
const DARK = "#3d2c1e";
const FONT = '"Tajawal","Cairo","Segoe UI",Arial,sans-serif';

// Filled 24×24 glyphs — decorative (the benefit text carries the meaning).
const BENEFIT_GLYPHS = [
  "M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z",           // sparkle
  "M12 3s6 7 6 12a6 6 0 1 1-12 0c0-5 6-12 6-12z",                         // drop
  "M5 21c0-10 6-16 14-16 0 10-6 16-14 16z",                               // leaf
];
const FEATURE_GLYPHS = [
  "M12 21s-7-4.5-9.5-9C1 9 3 5 6.5 5 9.2 5 12 8 12 8s2.8-3 5.5-3C21 5 23 9 21.5 12 19 16.5 12 21 12 21z", // heart
  "M12 2l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V5z",                           // shield
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
    background: "linear-gradient(135deg,#f6efe3 0%,#ecdecb 100%)",
    fontFamily: FONT, color: INK, overflow: "hidden",
  };

  return (
    <div style={root}>
      {/* Product photo — rounded card, right side */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={p.imageDataUrl}
        alt=""
        style={{
          position: "absolute", top: 150, right: 44, width: 596, height: 680,
          objectFit: "cover", borderRadius: 30, boxShadow: "0 24px 60px rgba(74,55,40,0.22)",
        }}
      />

      {/* Brand lockup */}
      <div style={{ position: "absolute", top: 64, left: 64 }}>
        <div style={{ fontSize: 62, fontWeight: 800, letterSpacing: 2, lineHeight: 1 }}>{p.brandTop}</div>
        <div style={{ fontSize: 21, letterSpacing: 9, color: MUTED, marginTop: 8 }}>{p.brandSub}</div>
      </div>

      {/* Headline */}
      <div style={{ position: "absolute", top: 212, left: 64, width: 470 }}>
        <div style={{ width: 74, height: 5, background: ACCENT, borderRadius: 3, marginBottom: 22 }} />
        <div style={{ fontSize: 58, fontWeight: 800, lineHeight: 1.16, textAlign: "right", direction: "rtl" }}>
          {p.headline}
        </div>
      </div>

      {/* Benefits */}
      <div style={{ position: "absolute", top: 470, left: 64, width: 480 }}>
        {p.benefits.slice(0, 3).map((b, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 18, marginBottom: 26 }}>
            <div style={{
              width: 64, height: 64, borderRadius: 32, flexShrink: 0,
              background: "rgba(201,160,106,0.22)", display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <Glyph d={BENEFIT_GLYPHS[i % BENEFIT_GLYPHS.length]} size={30} color={ACCENT} />
            </div>
            <div style={{ flex: 1, fontSize: 27, fontWeight: 600, color: INK, textAlign: "right", direction: "rtl", lineHeight: 1.3 }}>
              {b}
            </div>
          </div>
        ))}
      </div>

      {/* Price badge */}
      {p.price ? (
        <div style={{
          position: "absolute", left: 64, bottom: 250, background: ACCENT, borderRadius: 22,
          padding: "16px 30px", textAlign: "right", direction: "rtl", boxShadow: "0 12px 30px rgba(201,160,106,0.35)",
        }}>
          <div style={{ fontSize: 22, color: "#5c4326", fontWeight: 600 }}>{p.priceLabel}</div>
          <div style={{ fontSize: 52, fontWeight: 800, color: "#3a2a17", lineHeight: 1.05 }}>{p.price}</div>
        </div>
      ) : null}

      {/* Order button + website */}
      <div style={{ position: "absolute", left: 64, bottom: 168, display: "flex", flexDirection: "row", alignItems: "center", gap: 14 }}>
        <div style={{
          background: DARK, color: "#f6efe3", borderRadius: 40, padding: "16px 34px",
          fontSize: 26, fontWeight: 700, letterSpacing: 3, display: "flex", alignItems: "center", gap: 12,
        }}>
          <span>ORDER NOW</span>
          <Glyph d="M6 6h15l-1.5 9h-12z M6 6l-2-3H2 M9 20a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z M18 20a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z" size={24} color="#f6efe3" />
        </div>
      </div>
      <div style={{ position: "absolute", left: 68, bottom: 130, fontSize: 22, color: MUTED, letterSpacing: 1 }}>{p.website}</div>

      {/* Bottom feature strip */}
      {p.features.length ? (
        <div style={{
          position: "absolute", left: 0, bottom: 0, width: 1080, height: 108,
          background: "rgba(61,44,30,0.06)", display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "space-around", padding: "0 40px",
        }}>
          {p.features.slice(0, 3).map((f, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 12 }}>
              <Glyph d={FEATURE_GLYPHS[i % FEATURE_GLYPHS.length]} size={30} color={ACCENT} />
              <span style={{ fontSize: 23, fontWeight: 600, color: INK, direction: "rtl" }}>{f}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
