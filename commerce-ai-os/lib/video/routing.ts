// Video provider routing — FLORA is the primary engine for PRODUCT videos
// (best product/logo/packaging fidelity via image-to-video techniques), while
// Higgsfield stays the engine for talking-person / UGC reels. Pure + testable.

export type VideoProviderId = "flora" | "higgsfield";

export type VideoKind =
  | "product_cinematic"
  | "luxury_product_ad"
  | "product_showcase"
  | "product_demo"
  | "ugc_creator"
  | "talking_presenter";

export interface VideoKindDef {
  kind: VideoKind;
  labelAr: string;
  labelEn: string;
  provider: VideoProviderId; // the engine this kind routes to under "auto"
  talking: boolean;          // true → needs a person speaking to camera
}

// Product kinds → FLORA (product-first). Talking kinds → Higgsfield.
export const VIDEO_KINDS: VideoKindDef[] = [
  { kind: "product_cinematic", labelAr: "منتج سينمائي", labelEn: "Product cinematic", provider: "flora", talking: false },
  { kind: "luxury_product_ad", labelAr: "إعلان منتج فاخر", labelEn: "Luxury product ad", provider: "flora", talking: false },
  { kind: "product_showcase", labelAr: "عرض المنتج", labelEn: "Product showcase", provider: "flora", talking: false },
  { kind: "product_demo", labelAr: "عرض استخدام المنتج", labelEn: "Product demo", provider: "flora", talking: false },
  { kind: "ugc_creator", labelAr: "UGC شخص يتكلم", labelEn: "UGC creator", provider: "higgsfield", talking: true },
  { kind: "talking_presenter", labelAr: "مقدِّمة تتكلم", labelEn: "Talking presenter", provider: "higgsfield", talking: true },
];

export const DEFAULT_VIDEO_KIND: VideoKind = "product_cinematic";

export function videoKindDef(kind: string | null | undefined): VideoKindDef {
  return VIDEO_KINDS.find((k) => k.kind === kind) ?? VIDEO_KINDS.find((k) => k.kind === DEFAULT_VIDEO_KIND)!;
}

/**
 * Resolve which provider a video should use. An explicit engine choice
 * ("flora"/"higgsfield") always wins; "auto"/unset falls back to the kind's
 * default (product → flora, talking → higgsfield).
 */
export function resolveProvider(kind: string | null | undefined, engineChoice?: string | null): VideoProviderId {
  const choice = String(engineChoice ?? "").trim().toLowerCase();
  if (choice === "flora" || choice === "higgsfield") return choice;
  return videoKindDef(kind).provider;
}
