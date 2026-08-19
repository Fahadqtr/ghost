// CH.6B — Snoonu image-source host allow-list (PURE).
//
// Defense-in-depth on top of the repo SSRF guard (lib/net/safeImage.ts). That
// guard blocks internal/private targets but allows any public https host; for
// MERCHANT image recovery we additionally restrict fetches to known Snoonu image
// hosts, so a compromised/spoofed listing cannot make the server fetch an
// arbitrary URL. Only these hosts (or a subdomain of them) are permitted.
//
// NOTE: `images.snoonu.com` is VERIFIED from a live operator capture
// (MEDIA.1A-P2) — it is the host observed serving product `images[].imageUri`.
// It already matched via the `snoonu.com` suffix; it is listed explicitly to
// mark it as the confirmed CDN host. The remaining entries stay conservative
// until observed. One centralized place to review; suffix-anchored, https-only,
// no IP literals — additions must keep passing image-host-policy.test.ts.
//
// PURE: no imports. node:test loads it directly.

export const SNOONU_IMAGE_HOST_SUFFIXES: readonly string[] = [
  "snoonu.com",
  "snoonu.app",
  "cdn.snoonu.com",
  "images.snoonu.com", // VERIFIED (MEDIA.1A-P2 capture)
  "media.snoonu.com",
  "storage.snoonu.com",
];

/**
 * True when `raw` is an https URL whose host is (a subdomain of) an allow-listed
 * Snoonu image host. Everything else — http, other hosts, malformed, IP literals
 * — is rejected. This is an ALLOW-LIST; it never falls open.
 */
export function isAllowedSnoonuImageUrl(raw: unknown, suffixes: readonly string[] = SNOONU_IMAGE_HOST_SUFFIXES): boolean {
  if (typeof raw !== "string" || raw.trim() === "") return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false; // no IP literals
  return suffixes.some((suf) => host === suf || host.endsWith("." + suf));
}
