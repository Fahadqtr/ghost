import "server-only";
import crypto from "crypto";

// Staff PINs are short numeric codes (4–8 digits) so they can never carry much
// entropy — but they must NOT sit in the database as plaintext. We store a
// keyed hash (HMAC-SHA256 with the same server secret used for staff sessions)
// in the existing `staff_members.pin` column. The hash is deterministic, so the
// login path can still look an employee up by code in a single indexed query,
// while a database leak no longer exposes the actual codes. Domain-separated
// with a prefix so a hash can never collide with a session token.

function secret(): string {
  const s = process.env.MALAK_SIGNING_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!s) throw new Error("Missing signing secret (set MALAK_SIGNING_SECRET).");
  return s;
}

// Hash a raw PIN into the value stored in the DB.
export function hashPin(pin: string): string {
  const code = String(pin ?? "").trim();
  return crypto.createHmac("sha256", secret()).update(`staff-pin:${code}`).digest("hex");
}

// A stored value is a legacy plaintext PIN (needs upgrading) when it still looks
// like a raw 4–8 digit code; a hash is 64 hex chars and never matches this.
export function isLegacyPlaintextPin(stored: string | null | undefined): boolean {
  return /^\d{4,8}$/.test(String(stored ?? ""));
}
