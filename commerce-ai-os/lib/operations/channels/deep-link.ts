// OPS.4 — Deep-link parameter contract (PURE).
//
// Validates the query params the Command Center emits (channel / storefront /
// status / issue) against CANONICAL registries/enums before any workflow consumes
// them (§9). Unknown/malformed values resolve to null so the target safely shows
// its default (no-filter) state — arbitrary URL text is NEVER forwarded as a DB
// filter. Also derives which Missing-Products tab a given GapStatus lives in, so a
// seeded status is actually visible.
//
// PURE: imports only the pure CH.5 storefront registry, the pure channel model,
// and the pure CH.6F discovery model (all relative, not `@/`). node:test loads it
// directly.

import { STOREFRONT_KEYS, storefrontsForChannel } from "../../channels/storefronts.ts";
import { CHANNEL_KEYS, type ChannelKey } from "../../channels/channel-model.ts";
import { GAP_STATUSES, CONFLICT_STATUSES, type GapStatus } from "../../missing-products/discovery-model.ts";

const one = (v: unknown): string | null => {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === "string" && x.trim() !== "" ? x.trim() : null;
};

/** A storefront key, only if it is a real registered storefront; else null. */
export function validStorefront(v: unknown): string | null {
  const s = one(v);
  return s && (STOREFRONT_KEYS as readonly string[]).includes(s) ? s : null;
}

/** A channel key, only if canonical; else null. */
export function validChannel(v: unknown): ChannelKey | null {
  const s = one(v);
  return s && (CHANNEL_KEYS as readonly string[]).includes(s) ? (s as ChannelKey) : null;
}

/** A CH.6F GapStatus, only if canonical; else null. */
export function validGapStatus(v: unknown): GapStatus | null {
  const s = one(v);
  return s && (GAP_STATUSES as readonly string[]).includes(s) ? (s as GapStatus) : null;
}

export type MissingProductsTab = "internal" | "external" | "problems";

/** Which Missing-Products tab a GapStatus is visible under (so a seeded status
 *  is not hidden by the active tab). Conflicts/review → problems; EXTERNAL_ONLY →
 *  external; everything else → internal. */
export function tabForStatus(status: GapStatus): MissingProductsTab {
  if ((CONFLICT_STATUSES as readonly string[]).includes(status)) return "problems";
  if (status === "EXTERNAL_ONLY") return "external";
  return "internal";
}

/**
 * Resolve the storefront a target workflow should preselect from the deep-link
 * params: an explicit valid `storefront` wins; else the first storefront of a
 * valid `channel`; else null (target keeps its own default). Optionally restrict
 * to an allow-list (e.g. the two Snoonu storefronts an availability page accepts).
 */
export function resolveStorefront(
  params: { storefront?: unknown; channel?: unknown },
  allow?: readonly string[],
): string | null {
  const permit = (key: string | null): string | null => (key && (!allow || allow.includes(key)) ? key : null);
  const direct = permit(validStorefront(params.storefront));
  if (direct) return direct;
  const channel = validChannel(params.channel);
  if (channel) {
    const first = storefrontsForChannel(channel)[0]?.key ?? null;
    return permit(first);
  }
  return null;
}

/** A brand/category value, only if it is in the allowed list the caller loaded. */
export function validFromList(v: unknown, allowed: readonly string[]): string | null {
  const s = one(v);
  return s && allowed.includes(s) ? s : null;
}

/** A free-text SKU search seed — sanitized (length-bounded, no filter syntax). It
 *  is a client-side substring filter only, never a DB fragment. */
export function sanitizeSkuParam(v: unknown): string | null {
  const s = one(v);
  if (!s) return null;
  const cleaned = s.slice(0, 64);
  return /^[\w .:/\-]+$/.test(cleaned) ? cleaned : null;
}
