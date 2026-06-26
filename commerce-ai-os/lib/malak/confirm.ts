// Signed action tokens for Malak's WRITE confirmations (Phase 2B).
// A write tool never mutates data; it returns a CONFIRM panel carrying one of
// these signed tokens. Only /api/malak/commit — after the user taps [أكّد] —
// verifies the token and performs the real write. Signing (HMAC-SHA256, keyed
// by the server-only service-role key) guarantees the committed operation is
// exactly the one the server prepared, and can't be forged or tampered.
import crypto from "node:crypto";

export type MalakActionType =
  | "update_stock"
  | "set_price"
  | "set_approval"
  | "add_product"
  | "set_image"
  | "generate_image"
  | "sync_availability"; // bulk: hide out-of-stock products still listed on channels + push 0 to Shopify

export interface MalakProductDraft {
  name_en: string;
  name_ar: string | null;
  description_en: string | null;
  description_ar: string | null;
  price: number | null;
  main_category: string | null;
  sub_category: string | null;
  brand_id: string | null;
  brand_name: string | null;
  sku: string;
  platform_status: string;
}

export interface MalakAction {
  v: 1;
  type: MalakActionType;
  agent: string; // active agent id (razan / noor / reem)
  sku?: string;
  productId?: string;
  field?: string;
  oldValue?: unknown;
  newValue?: unknown;
  product?: MalakProductDraft;
  style?: string; // image generation style (hero / lifestyle)
  size?: string; // image generation size, e.g. 1024x1024 / 1024x1536
  count?: number; // sync_availability: previewed number of products to fix
  ts: number;
}

function secret(): string {
  // Server-only; never exposed to the client. Prefer the dedicated signing
  // secret; fall back to the service-role key only when it isn't set (so existing
  // deploys keep working). Keeping the dedicated secret first means rotating the
  // database master key doesn't silently invalidate in-flight confirm tokens.
  const s = process.env.MALAK_SIGNING_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!s) throw new Error("Missing signing secret (set MALAK_SIGNING_SECRET).");
  return s;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return Buffer.from(t, "base64");
}

export function signAction(action: MalakAction): string {
  const payload = b64url(Buffer.from(JSON.stringify(action)));
  const mac = crypto.createHmac("sha256", secret()).update(payload).digest();
  return `${payload}.${b64url(mac)}`;
}

// Returns the verified action, or null if the token is malformed, tampered, or
// older than maxAgeMs (default 15 min).
export function verifyAction(token: unknown, maxAgeMs = 15 * 60 * 1000): MalakAction | null {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;

  const expected = b64url(crypto.createHmac("sha256", secret()).update(payload).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const action = JSON.parse(b64urlDecode(payload).toString("utf8")) as MalakAction;
    if (action?.v !== 1) return null;
    if (typeof action.ts !== "number" || Date.now() - action.ts > maxAgeMs) return null;
    return action;
  } catch {
    return null;
  }
}
