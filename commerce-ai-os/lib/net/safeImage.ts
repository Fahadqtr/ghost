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
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  return false;
}

// Decode a host written as a numeric IPv4 in any inet_aton-accepted form —
// decimal (2130706433), hex (0x7f000001), octal (0177.0.0.1), or a short form
// (127.1) — back to canonical dotted-quad. Returns null when the host is not a
// bare numeric address (e.g. a normal DNS name), so callers can fall through to
// the hostname checks. Blocking only the dotted-decimal form (as we did before)
// let "http://2130706433/" reach 127.0.0.1.
function decodeNumericIpv4(host: string): string | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8); // octal (leading 0)
    else if (/^(0|[1-9][0-9]*)$/.test(p)) n = parseInt(p, 10);
    else return null; // contains a non-numeric label → this is a hostname
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  // inet_aton: the final part fills all the remaining low-order bytes.
  let value: number;
  if (nums.length === 1) {
    value = nums[0];
    if (value > 0xffffffff) return null;
  } else {
    for (let i = 0; i < nums.length - 1; i++) if (nums[i] > 255) return null;
    const last = nums[nums.length - 1];
    if (last >= Math.pow(256, 4 - (nums.length - 1))) return null;
    value = last;
    for (let i = 0; i < nums.length - 1; i++) value += nums[i] * Math.pow(256, 3 - i);
  }
  const a = (value >>> 24) & 255, b = (value >>> 16) & 255, c = (value >>> 8) & 255, d = value & 255;
  return `${a}.${b}.${c}.${d}`;
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h.includes(":")) {
    // IPv6 literal. Only treat it as private when it actually is — matching on a
    // bare "fc"/"fd" prefix (as before) wrongly blocked hostnames like fcbar.com,
    // but those never contain a colon so we're safe to prefix-match here.
    if (h === "::1" || h === "::") return true; // loopback / unspecified
    if (h.startsWith("fe80:")) return true; // link-local
    if (/^f[cd]/.test(h)) return true; // unique local fc00::/7
    const dotted = h.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/); // ::ffff:127.0.0.1
    if (dotted) return isPrivateIpv4(dotted[1]);
    // IPv4-mapped, hex form (Node normalizes ::ffff:127.0.0.1 → ::ffff:7f00:1).
    const hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const v = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
      return isPrivateIpv4(`${(v >>> 24) & 255}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`);
    }
    return false; // other, public IPv6
  }
  const decoded = decodeNumericIpv4(h);
  if (decoded) return isPrivateIpv4(decoded);
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

/**
 * Validate a URL is safe for Malak to browse server-side. Like the image guard
 * but also accepts http:// (some sites still serve over plain http) while still
 * blocking internal/metadata targets. Returns the normalized URL or throws with
 * a human-readable (Arabic) message.
 */
export function assertSafeBrowseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new Error("الرابط غير صالح.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error("الرابط يجب أن يكون موقع ويب (http أو https).");
  }
  if (isPrivateHost(u.hostname)) {
    throw new Error("الرابط يشير إلى عنوان داخلي غير مسموح به.");
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

/**
 * Fetch an already-validated public https image URL, re-validating every redirect
 * hop so a public URL can't 3xx-redirect the request into an internal address.
 * The guard above only checks the URL we're handed; without manual redirect
 * handling a `302 Location: http://169.254.169.254/…` would still be followed.
 */
export async function safeFetchImage(raw: string, init?: RequestInit, maxRedirects = 4): Promise<Response> {
  let url = assertSafeImageUrl(raw);
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetch(url, { ...init, redirect: "manual" });
    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has("location");
    if (!isRedirect) return res;
    url = assertSafeImageUrl(new URL(res.headers.get("location")!, url).toString());
  }
  throw new Error("عدد كبير من عمليات إعادة التوجيه في رابط الصورة.");
}
