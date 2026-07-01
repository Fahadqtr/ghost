import { ImageResponse } from "next/og";

// Distinct icon for the installed staff app (so employees don't confuse it with
// the admin app). Violet tile with a box glyph.
export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)",
          color: "#ffffff",
          fontSize: 300,
        }}
      >
        📦
      </div>
    ),
    { ...size }
  );
}
