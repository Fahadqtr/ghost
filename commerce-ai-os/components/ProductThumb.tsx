"use client";

import { useState } from "react";

// Product thumbnail that shows the photo even when products.image_url is empty
// but a file exists in storage under the SKU name (product-images/<sku>.jpg).
// Tries image_url first, then the SKU-named file in jpg/png/webp, falling back
// to the "no photo" badge only when every candidate fails to load. Pure
// client-side (uses <img> onError) — no server storage probing needed, and it
// can only ADD images that exist, never hide a real one.

const SUPA = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const BUCKET = "product-images";

function candidates(imageUrl: string | null | undefined, sku: string | null | undefined): string[] {
  const list: string[] = [];
  const direct = (imageUrl ?? "").trim();
  if (/^https?:\/\//i.test(direct)) list.push(direct);
  const clean = (sku ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (SUPA && clean) {
    for (const ext of ["jpg", "png", "webp", "jpeg"]) {
      list.push(`${SUPA}/storage/v1/object/public/${BUCKET}/${clean}.${ext}`);
    }
  }
  return list;
}

export default function ProductThumb({
  imageUrl,
  sku,
  sizeClass = "h-12 w-12",
  label = "بدون صورة",
}: {
  imageUrl: string | null | undefined;
  sku: string | null | undefined;
  sizeClass?: string;
  label?: string;
}) {
  const cands = candidates(imageUrl, sku);
  const [i, setI] = useState(0);

  if (i >= cands.length) {
    return (
      <div className={`flex ${sizeClass} shrink-0 items-center justify-center rounded-lg border border-dashed border-amber-300 bg-amber-50 text-center text-[10px] leading-tight text-amber-700`}>
        {label}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={cands[i]}
      alt=""
      loading="lazy"
      onError={() => setI((n) => n + 1)}
      className={`${sizeClass} shrink-0 rounded-lg border border-[#efe3d6] bg-white object-cover`}
    />
  );
}
