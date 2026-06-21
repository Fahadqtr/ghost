import type { MetadataRoute } from "next";

// PWA manifest — lets the app be installed to the home screen and run in a
// standalone, full-screen window (no browser chrome) like a native app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Malak AI — Commerce OS",
    short_name: "Malak",
    description: "ملاك — المديرة الذكية لإدارة المتجر متعدد المنصّات",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#eef2f8",
    theme_color: "#ffffff",
    lang: "ar",
    dir: "rtl",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
