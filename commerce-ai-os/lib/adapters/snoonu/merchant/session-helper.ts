// MEDIA.1A-P4 — Snoonu session ENV JSON builder (PURE, CLIENT-SAFE).
//
// Prepares the JSON string an operator pastes into the reserved Vercel env var
// (SNOONU_*_MERCHANT_SESSION). It builds the EXACT shape the merged live
// adapter consumes and proves it by ROUND-TRIPPING the result through the very
// parser the adapter uses (parseSnoonuSessionConfig, live-contract.ts) — there
// is no second schema to drift.
//
// SECURITY MODEL: this module runs where it is called (the helper page calls it
// in the BROWSER only). It performs no IO of any kind — no network, no storage,
// no env, no logging — the caller holds the result in memory and copies it to
// the clipboard. Sensitive header values pass through untouched and are never
// inspected beyond trimming.
//
// PURE: relative imports only; no server-only, no env, no network, no IO.

import type { SnoonuStorefrontKey } from "./merchant-contract.ts";
import { parseSnoonuSessionConfig } from "./live-contract.ts";

/**
 * The reserved server env var each storefront's session JSON must be pasted
 * into. Storefront isolation is enforced by these DISTINCT destinations — one
 * storefront's JSON is never valid provisioning for the other's key.
 */
export const SNOONU_SESSION_ENV_KEYS: Record<SnoonuStorefrontKey, string> = {
  "snoonu:malikas": "SNOONU_MALIKAS_MERCHANT_SESSION",
  "snoonu:pure_seoul": "SNOONU_PURE_SEOUL_MERCHANT_SESSION",
};

/** Operator-entered values (copied manually from an authenticated DevTools request). */
export interface SessionHelperInput {
  businessUnitId: string;
  /** Sensitive; optional — only when the captured request carried it. */
  authorization: string;
  /** Sensitive; optional — only when the captured request carried it. */
  cookie: string;
  /** One extra confirmed header (both fields required to include it). */
  extraHeaderName: string;
  /** Sensitive when used. */
  extraHeaderValue: string;
}

export type SessionHelperResult =
  | { ok: true; json: string }
  | { ok: false; error: string };

const clean = (v: string): string => (typeof v === "string" ? v.trim() : "");

/**
 * Build the env JSON for ONE storefront's session. Returns the pretty-printed
 * JSON string on success. Fails (never throws) when businessUnitId is blank,
 * when no authenticated header was provided, or — defensively — when the built
 * JSON would not round-trip through the adapter's own parser.
 */
export function buildSnoonuSessionEnvJson(input: SessionHelperInput): SessionHelperResult {
  const businessUnitId = clean(input.businessUnitId);
  if (!businessUnitId) return { ok: false, error: "businessUnitId مطلوب." };

  const headers: Record<string, string> = {};
  const authorization = clean(input.authorization);
  if (authorization) headers["Authorization"] = authorization;
  const cookie = clean(input.cookie);
  if (cookie) headers["Cookie"] = cookie;
  const extraName = clean(input.extraHeaderName);
  const extraValue = clean(input.extraHeaderValue);
  if (extraName && extraValue) headers[extraName] = extraValue;
  else if (extraName || extraValue) {
    return { ok: false, error: "الترويسة الإضافية تحتاج الاسم والقيمة معًا." };
  }

  if (Object.keys(headers).length === 0) {
    return { ok: false, error: "أدخل ترويسة مصادَقة واحدة على الأقل (Authorization أو Cookie)." };
  }

  const json = JSON.stringify({ businessUnitId, headers }, null, 2);

  // Round-trip through the adapter's OWN parser: what the operator pastes is
  // exactly what the merged live adapter will accept.
  const parsed = parseSnoonuSessionConfig(json);
  if (!parsed || parsed.businessUnitId !== businessUnitId) {
    return { ok: false, error: "تعذّر توليد JSON صالح للمحوّل." };
  }
  return { ok: true, json };
}
