// SSRF guard for server-side image fetches. Product `image_url` can be set via
// imports/uploads, so before the server fetches one we make sure it is a public
// https URL and not pointed at an internal/metadata address (e.g. the cloud
// metadata endpoint 169.254.169.254, localhost, or a private LAN range).
//
// We intentionally allow any public https host (Snoonu/retailer CDNs are
// legitimate sources) — the goal is to block internal targets, not to whitelist
// one host.

function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, Number(m[3]), Number(m[4])].some((n) => n > 255)) return true; // malformed → treat as unsafe
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (isPrivateIpv4(h)) return true;
  return false;
}

/**
 * Validate a URL is safe to fetch server-side. Returns the normalized URL string
 * or throws with a human-readable (Arabic) message.
 */
export function assertSafeImageUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new Error("رابط الصورة غير صالح.");
  }
  if (u.protocol !== "https:") {
    throw new Error("رابط الصورة يجب أن يكون عبر https.");
  }
  if (isPrivateHost(u.hostname)) {
    throw new Error("رابط الصورة يشير إلى عنوان داخلي غير مسموح به.");
  }
  return u.toString();
}

/** Non-throwing variant: returns the safe URL or null (handy in bulk loops). */
export function safeImageUrlOrNull(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    return assertSafeImageUrl(raw);
  } catch {
    return null;
  }
}
