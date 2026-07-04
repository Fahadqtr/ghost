// Browser-only: luxury ad fonts, embedded as data: URIs.
//
// The rasterizer (SVG foreignObject → canvas) renders in an isolated document
// that cannot fetch external resources — page-loaded fonts do NOT apply. So we
// fetch the woff2 files once (same-origin /fonts/*), inline them as data: URIs
// in @font-face CSS, and inject that CSS into the captured SVG.

export const AD_FONT_HEADLINE = '"El Messiri","Tajawal",serif';   // elegant Arabic display
export const AD_FONT_BODY = '"Almarai","Tajawal",sans-serif';     // premium Arabic text
export const AD_FONT_LATIN = '"Marcellus","Almarai",serif';       // luxury Latin brand lockup

const FILES: { family: string; weight: number; file: string }[] = [
  { family: "El Messiri", weight: 700, file: "el-messiri-700-arabic.woff2" },
  { family: "El Messiri", weight: 700, file: "el-messiri-700-latin.woff2" },
  { family: "Almarai", weight: 300, file: "almarai-300-arabic.woff2" },
  { family: "Almarai", weight: 300, file: "almarai-300-latin.woff2" },
  { family: "Almarai", weight: 400, file: "almarai-400-arabic.woff2" },
  { family: "Almarai", weight: 400, file: "almarai-400-latin.woff2" },
  { family: "Almarai", weight: 800, file: "almarai-800-arabic.woff2" },
  { family: "Almarai", weight: 800, file: "almarai-800-latin.woff2" },
  { family: "Marcellus", weight: 400, file: "marcellus-400-latin.woff2" },
];

let cached: string | null = null;

/** @font-face CSS with every ad font inlined as a data: URI (cached). */
export async function adFontCss(): Promise<string> {
  if (cached) return cached;
  const rules = await Promise.all(FILES.map(async ({ family, weight, file }) => {
    const res = await fetch(`/fonts/${file}`);
    if (!res.ok) throw new Error(`تعذّر تحميل الخط (${file}).`);
    const blob = await res.blob();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error("تعذّر قراءة الخط."));
      fr.readAsDataURL(blob);
    });
    return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};src:url(${dataUrl}) format('woff2');}`;
  }));
  cached = rules.join("\n");
  return cached;
}
