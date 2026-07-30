import "server-only";

// Central Meta/Instagram Graph API client.
//
// The one job of this module is to keep the access token OUT of the request
// URL (where it leaks into logs, proxies, error traces, and analytics) and
// carry it ONLY in the `Authorization: Bearer <token>` header — the header
// transport the Graph API supports as an equivalent to the `access_token`
// query/body parameter. Every outgoing Graph call in the app should go
// through graphFetch so this guarantee holds in exactly one place.
//
// It also classifies failures into a small, safe set of categories and
// redacts the token from any surfaced message, so nothing downstream can log
// the credential or a raw, secret-bearing response.

export const GRAPH_BASE = "https://graph.facebook.com/v21.0";
// Instagram-Login tokens speak to graph.instagram.com, not the Facebook host.
export const IG_GRAPH_BASE = "https://graph.instagram.com/v21.0";

export type MetaErrorKind =
  | "meta_auth_error"
  | "meta_rate_limited"
  | "meta_api_error"
  | "meta_network_error";

export interface GraphResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  /** Classified, safe category — never contains the token. */
  errorKind?: MetaErrorKind;
  /** Safe, token-redacted message (Meta's error.message when present). */
  errorMessage?: string;
}

/** Map an HTTP status to a safe error category. */
export function classifyMetaStatus(status: number): MetaErrorKind {
  if (status === 401 || status === 403) return "meta_auth_error";
  if (status === 429) return "meta_rate_limited";
  return "meta_api_error";
}

/**
 * Defensively strip a token — and any `access_token=` query fragment — from a
 * string, so a credential can never surface in a message, log, or thrown
 * error even if an upstream echoed it back.
 */
export function redactToken(text: string, token?: string): string {
  let out = String(text ?? "");
  if (token) out = out.split(token).join("[redacted]");
  out = out.replace(/access_token=[^&\s"']+/gi, "access_token=[redacted]");
  return out;
}

export interface GraphFetchOptions {
  /** Access token — carried in the Authorization header only, never the URL. */
  token: string;
  method?: "GET" | "POST";
  /** Host base (defaults to the Facebook Graph host). */
  base?: string;
  /** Query params appended to the URL. `access_token` must NEVER be passed here. */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON request body. `access_token` must NEVER be included here. */
  body?: unknown;
  timeoutMs?: number;
}

/**
 * Perform one Graph API request with the token in the Authorization header.
 * Returns a structured result (never throws for HTTP/network failures) with
 * the response JSON on success and a classified, token-free error otherwise.
 */
export async function graphFetch<T = unknown>(
  path: string,
  opts: GraphFetchOptions,
): Promise<GraphResult<T>> {
  const base = opts.base ?? GRAPH_BASE;
  const method = opts.method ?? "GET";

  // Build the query string WITHOUT the credential — the token only ever rides
  // in the Authorization header.
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined) continue;
    qs.set(k, String(v));
  }
  const query = qs.toString();
  const url = `${base}${path}${query ? (path.includes("?") ? "&" : "?") + query : ""}`;

  const headers: Record<string, string> = { Authorization: `Bearer ${opts.token}` };
  let bodyInit: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyInit = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: bodyInit,
      cache: "no-store",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch {
    // Network/timeout: classify only. Never surface the error object (it can
    // echo the request URL) or the token.
    return { ok: false, status: 0, data: null, errorKind: "meta_network_error", errorMessage: "meta_network_error" };
  }

  let data: T | null = null;
  try { data = (await res.json()) as T; } catch { data = null; }

  if (!res.ok) {
    const kind = classifyMetaStatus(res.status);
    const rawMsg = (data as { error?: { message?: string } } | null)?.error?.message;
    const safeMsg = rawMsg ? redactToken(String(rawMsg), opts.token) : kind;
    return { ok: false, status: res.status, data, errorKind: kind, errorMessage: safeMsg };
  }
  return { ok: true, status: res.status, data };
}
