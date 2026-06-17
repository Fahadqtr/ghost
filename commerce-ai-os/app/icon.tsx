import { ImageResponse } from "next/og";

// App icon (also the favicon). Brand gradient tile with a centred "M".
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
          background: "linear-gradient(135deg, #4f8bff 0%, #8b5cf6 100%)",
          color: "#ffffff",
          fontSize: 320,
          fontWeight: 800,
          fontFamily: "sans-serif",
        }}
      >
        M
      </div>
    ),
    { ...size }
  );
}
