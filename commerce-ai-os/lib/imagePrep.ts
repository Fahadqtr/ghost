// Browser-side image preparation, shared by every photo-upload flow (staff
// add-product tab + admin product form). Phone camera photos are 3–12 MB while
// server actions cap request bodies around 1 MB — so we downscale + re-encode
// to a modest JPEG in the browser BEFORE anything is sent. Also normalizes odd
// formats (e.g. HEIC) to JPEG. Client-only (canvas/FileReader).

export interface PreparedImage {
  dataUrl: string;
  base64: string;
  mediaType: string;
}

/** Downscale to ≤1600px and re-encode as JPEG; falls back to a plain read. */
export async function prepareImage(file: File): Promise<PreparedImage> {
  const readRaw = () => new Promise<PreparedImage>((res, rej) => {
    const r = new FileReader();
    r.onload = () => { const d = String(r.result || ""); res({ dataUrl: d, base64: d.replace(/^data:[^,]+,/, ""), mediaType: file.type || "image/jpeg" }); };
    r.onerror = () => rej(new Error("read failed"));
    r.readAsDataURL(file);
  });
  const objUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error("decode failed"));
      im.src = objUrl;
    });
    const maxDim = 1600;
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no ctx");
    ctx.drawImage(img, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
    return { dataUrl, base64: dataUrl.replace(/^data:[^,]+,/, ""), mediaType: "image/jpeg" };
  } catch {
    return readRaw(); // canvas unsupported / decode failed → send as-is
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}

/** Turn a prepared data URL back into a File (for FormData-based actions). */
export function dataUrlToFile(dataUrl: string, name: string): File {
  const [head, b64] = dataUrl.split(",");
  const type = head.match(/^data:([^;]+)/)?.[1] || "image/jpeg";
  const raw = atob(b64 || "");
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const base = name.replace(/\.[^.]+$/, "") || "photo";
  return new File([bytes], `${base}.jpg`, { type });
}
