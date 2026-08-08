// Malikas V2 — Platform Snapshot Engine (Phase UI.9.2): stable hashing.
//
// A CONTENT hash: two payloads with equal field values hash to the same digest
// regardless of key order or when they were captured. Object keys are sorted
// recursively before serialization so `{a,b}` and `{b,a}` (common across
// platform payloads) are treated as identical. Deterministic and pure — the
// only dependency is node:crypto (a stable digest, no randomness).

import crypto from "node:crypto";

/** Recursively sort object keys so serialization is order-independent. Arrays
 *  keep their order (order is meaningful); primitives pass through. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}

/** Canonical JSON string of any value (sorted keys). `undefined` is normalized
 *  to null so it round-trips predictably. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value), (_k, v) => (v === undefined ? null : v));
}

/** SHA-256 hex digest of a payload's canonical form. Same content ⇒ same hash. */
export function hashPayload(payload: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");
}
