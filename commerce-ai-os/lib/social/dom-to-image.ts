// Browser-only: rasterize a DOM node to a JPEG data URL via an SVG
// <foreignObject> (the same technique html-to-image uses, dependency-free).
//
// Requirements the caller MUST meet so the render is self-contained:
//   • the node is styled with INLINE styles only (foreignObject can't reach
//     external stylesheets), and
//   • every <img> inside uses a data: URL (a cross-origin URL would taint the
//     canvas and break toDataURL, and may not load inside the SVG at all).

/** Fetch an image URL and return it as a data: URL (so it can be inlined). */
export async function fetchAsDataUrl(url: string): Promise<string> {
  const res = await fetch(url, { mode: "cors", cache: "no-store" });
  if (!res.ok) throw new Error(`تعذّر تحميل الصورة (${res.status}).`);
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error("تعذّر قراءة الصورة."));
    fr.readAsDataURL(blob);
  });
}

/** Rasterize `node` (rendered at width×height) to a JPEG data URL. */
export async function nodeToJpeg(node: HTMLElement, width: number, height: number, quality = 0.92): Promise<string> {
  const clone = node.cloneNode(true) as HTMLElement;
  clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  const xml = new XMLSerializer().serializeToString(clone);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject x="0" y="0" width="${width}" height="${height}">${xml}</foreignObject>` +
    `</svg>`;

  const img = new Image();
  img.width = width; img.height = height;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("تعذّر رسم التصميم في هذا المتصفح."));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });

  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas غير مدعوم في هذا المتصفح.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}
