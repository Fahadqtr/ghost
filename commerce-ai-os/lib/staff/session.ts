import "server-only";
import crypto from "crypto";

// Signed, short-lived "staff session" for the shared-PIN /staff page. After a
// correct PIN we mint an HMAC token carrying the employee's name so every stock
// movement is attributed without giving employees real Supabase accounts. Signed
// with the same server secret as the write-confirm tokens.

export const STAFF_COOKIE = "staff_session";
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // one shift

function secret(): string {
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

export type StaffSession = { name: string; id?: string | null; perms?: string[] };

export function signStaff(input: string | StaffSession): string {
  const s: StaffSession = typeof input === "string" ? { name: input } : input;
  const body: Record<string, unknown> = { name: s.name, ts: Date.now() };
  if (s.id) body.id = s.id;
  if (Array.isArray(s.perms)) body.perms = s.perms;
  const payload = b64url(Buffer.from(JSON.stringify(body)));
  const mac = b64url(crypto.createHmac("sha256", secret()).update(payload).digest());
  return `${payload}.${mac}`;
}

export function verifyStaff(token: string | undefined, maxAgeMs = MAX_AGE_MS): StaffSession | null {
  if (!token) return null;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expected = b64url(crypto.createHmac("sha256", secret()).update(payload).digest());
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(b64urlDecode(payload).toString("utf8"));
    if (typeof obj?.ts !== "number" || Date.now() - obj.ts > maxAgeMs) return null;
    if (typeof obj?.name !== "string" || !obj.name) return null;
    return {
      name: obj.name,
      id: typeof obj.id === "string" ? obj.id : null,
      perms: Array.isArray(obj.perms) ? obj.perms.map(String) : undefined,
    };
  } catch {
    return null;
  }
}
