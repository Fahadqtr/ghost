// Malikas V2 Operations — Platform Status Engine (Phase UI.7.1).
//
// PURE: no platform API is ever called here. The caller reads presence
// through the EXISTING read models (UI.3 Shopify read model and friends),
// projects it into PlatformPresence, and this engine only interprets it
// against Malikas — the Single Source of Truth.
//
// Status meaning (per platform):
// - review_required : a human must look at the pairing (ambiguity/flag)
// - different       : linked and live, but the platform copy drifted from Malikas
// - published       : linked and live, in sync as far as we know
// - ready           : publishable now — either staged on the platform but not
//                     live yet, or absent while the product is ready to publish
// - missing         : absent from the platform and not yet publishable

import type {
  OperationsProduct,
  PlatformPresence,
  PlatformStatus,
  PlatformStatusValue,
  PlatformType,
} from "../shared/models";

/** The one place the platform list lives (Phase UI.7 scope). */
export const PLATFORM_TYPES: readonly PlatformType[] = ["shopify", "puresoul", "talabat", "rafeeq"];

export const PLATFORM_LABELS: Record<PlatformType, string> = {
  shopify: "Shopify",
  puresoul: "PureSoul",
  talabat: "Talabat",
  rafeeq: "Rafeeq",
};

export const PLATFORM_STATUS_LABELS: Record<PlatformStatusValue, string> = {
  missing: "غير موجود",
  ready: "جاهز للنشر",
  published: "منشور",
  different: "مختلف عن ماليكاس",
  review_required: "يحتاج مراجعة",
};

/** Interpret one platform snapshot for one product. */
export function computePlatformStatusValue(
  presence: PlatformPresence | undefined,
  readyToPublish: boolean,
): PlatformStatusValue {
  if (presence?.reviewRequired) return "review_required";
  if (presence?.linked && presence.live && presence.drift) return "different";
  if (presence?.linked && presence.live) return "published";
  if (presence?.linked) return "ready"; // staged on the platform, not live yet
  return readyToPublish ? "ready" : "missing";
}

/** All tracked platforms for one product, in the fixed platform order. */
export function computePlatformStatuses(
  product: OperationsProduct,
  readyToPublish: boolean,
): PlatformStatus[] {
  return PLATFORM_TYPES.map((platform) => {
    const status = computePlatformStatusValue(product.platforms?.[platform], readyToPublish);
    return { platform, status, label: PLATFORM_STATUS_LABELS[status] };
  });
}
