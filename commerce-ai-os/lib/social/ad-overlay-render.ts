// Browser-only ad-card renderer.
//
// Paints the brand / product / price / CTA strings (from ad-overlay-compute)
// onto the AI-styled product photo using a <canvas>, so text is crisp and
// Arabic shapes correctly via the device's system fonts — something AI image
// generators can't do reliably. Returns a JPEG data URL ready to upload.
//
// Runs in the browser only (uses fetch + canvas). Do NOT import from server code.

import type { AdOverlayText } from "./ad-overlay-compute";

const FONT = '"Tajawal","Cairo","Segoe UI","Helvetica Neue",Arial,sans-serif';

/**
 * Fetch the image as a blob first (same-origin object URL) so the canvas is
 * never tainted by a cross-origin draw and toDataURL() stays allowed.
 */
async function loadBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(url, { mode: "cors", cache: "no-store" });
  if (!res.ok) throw new Error(`تعذّر تحميل الصورة (${res.status}).`);
  const blob = await res.blob();
  return await createImageBitmap(blob);
}

function setLetterSpacing(ctx: CanvasRenderingContext2D, px: number) {
  try { (ctx as unknown as { letterSpacing: string }).letterSpacing = `${px}px`; } catch { /* older browsers */ }
}

/** Word-wrap to at most `maxLines`, hard-trimming the last line with an ellipsis. */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width <= maxWidth || !line) { line = next; }
    else { lines.push(line); line = w; if (lines.length === maxLines - 1) break; }
  }
  if (line && lines.length < maxLines) lines.push(line);
  // If words remain, mark the last line as truncated.
  const used = lines.join(" ").split(/\s+/).filter(Boolean).length;
  if (used < words.length && lines.length) {
    let last = lines[lines.length - 1];
    while (last && ctx.measureText(last + "…").width > maxWidth) last = last.slice(0, -1);
    lines[lines.length - 1] = last + "…";
  }
  return lines;
}

/**
 * Compose the ad card. Draws the photo cover-fit, a top+bottom scrim for
 * legibility, then the brand (top), product name + CTA + price pill (bottom).
 * Returns a JPEG data URL.
 */
export async function composeAdImage(imageUrl: string, text: AdOverlayText, size = 1080): Promise<string> {
  const bmp = await loadBitmap(imageUrl);
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas غير مدعوم في هذا المتصفح.");

  // Cover-fit the photo.
  const scale = Math.max(size / bmp.width, size / bmp.height);
  const dw = bmp.width * scale, dh = bmp.height * scale;
  ctx.drawImage(bmp, (size - dw) / 2, (size - dh) / 2, dw, dh);

  // Bottom scrim (dark) for the text block.
  const g = ctx.createLinearGradient(0, size * 0.5, 0, size);
  g.addColorStop(0, "rgba(26,18,14,0)");
  g.addColorStop(1, "rgba(26,18,14,0.82)");
  ctx.fillStyle = g;
  ctx.fillRect(0, size * 0.5, size, size * 0.5);

  const margin = size * 0.06;
  ctx.textBaseline = "alphabetic";

  // Brand — top center, letter-spaced, over a soft top scrim.
  if (text.brand) {
    const tg = ctx.createLinearGradient(0, 0, 0, size * 0.22);
    tg.addColorStop(0, "rgba(26,18,14,0.55)");
    tg.addColorStop(1, "rgba(26,18,14,0)");
    ctx.fillStyle = tg;
    ctx.fillRect(0, 0, size, size * 0.22);

    ctx.direction = "ltr";
    ctx.textAlign = "center";
    ctx.font = `700 ${Math.round(size * 0.05)}px ${FONT}`;
    setLetterSpacing(ctx, size * 0.006);
    ctx.shadowColor = "rgba(0,0,0,0.45)"; ctx.shadowBlur = size * 0.01; ctx.shadowOffsetY = 2;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text.brand.toUpperCase(), size / 2, margin + size * 0.05);
    setLetterSpacing(ctx, 0);
    ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  }

  // ---- bottom block (right-aligned, RTL) ----
  ctx.direction = "rtl";
  ctx.textAlign = "right";
  const right = size - margin;

  // Price pill (accent) — bottom-left, on the CTA row.
  const priceFont = Math.round(size * 0.044);
  let pillTop = size - margin - priceFont * 1.9;
  if (text.price) {
    ctx.direction = "ltr"; ctx.textAlign = "left";
    ctx.font = `800 ${priceFont}px ${FONT}`;
    const padX = size * 0.028, padY = priceFont * 0.5;
    const tw = ctx.measureText(text.price).width;
    const pw = tw + padX * 2, ph = priceFont + padY * 2;
    const px = margin, py = size - margin - ph;
    pillTop = py;
    const r = ph / 2;
    ctx.fillStyle = "#e6b980"; // warm gold accent
    ctx.beginPath();
    ctx.moveTo(px + r, py);
    ctx.arcTo(px + pw, py, px + pw, py + ph, r);
    ctx.arcTo(px + pw, py + ph, px, py + ph, r);
    ctx.arcTo(px, py + ph, px, py, r);
    ctx.arcTo(px, py, px + pw, py, r);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#2a1c12";
    ctx.fillText(text.price, px + padX, py + padY + priceFont * 0.82);
    ctx.direction = "rtl"; ctx.textAlign = "right";
  }

  // CTA — bottom-right, on the same row as the price pill.
  ctx.font = `600 ${Math.round(size * 0.030)}px ${FONT}`;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillText(text.cta, right, size - margin - priceFont * 0.55);

  // Product name — above the pill row, up to 2 lines.
  const prodFont = Math.round(size * 0.058);
  ctx.font = `800 ${prodFont}px ${FONT}`;
  ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = size * 0.012; ctx.shadowOffsetY = 2;
  ctx.fillStyle = "#ffffff";
  const lines = wrap(ctx, text.product, size - margin * 2, 2);
  const lineH = prodFont * 1.18;
  let by = pillTop - margin * 0.5 - (lines.length - 1) * lineH;
  for (const ln of lines) { ctx.fillText(ln, right, by); by += lineH; }
  ctx.shadowColor = "transparent"; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

  return canvas.toDataURL("image/jpeg", 0.9);
}
