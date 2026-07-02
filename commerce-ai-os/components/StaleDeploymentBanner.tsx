"use client";
import { useEffect, useState } from "react";

// Vercel gives every deployment a frozen, deployment-specific URL like
// `ghost-78dasrdfz-clanqtr-gmailcoms-projects.vercel.app`. If a user bookmarks
// or home-screens one of those, it NEVER updates — they stay stuck on an old
// build. This banner detects that case and points them to the stable
// production URL (same path), so they stop landing on stale snapshots.
const CANONICAL_HOST = "ghost-rho-two.vercel.app";
// Matches a deployment-hash host: ghost-<one alphanumeric token>-clanqtr-…
// (the canonical `ghost-rho-two` and branch aliases `ghost-git-…` have a dash
// inside the token, so they don't match and won't be flagged.)
const STALE_RE = /^ghost-[a-z0-9]{6,}-clanqtr-gmailcoms-projects\.vercel\.app$/i;

export default function StaleDeploymentBanner() {
  const [stale, setStale] = useState(false);
  const [href, setHref] = useState(`https://${CANONICAL_HOST}`);

  useEffect(() => {
    try {
      const h = window.location.hostname;
      if (h !== CANONICAL_HOST && STALE_RE.test(h)) {
        setStale(true);
        setHref(`https://${CANONICAL_HOST}${window.location.pathname}${window.location.search}`);
      }
    } catch { /* ignore */ }
  }, []);

  if (!stale) return null;

  return (
    <div dir="rtl" className="relative z-200 flex flex-wrap items-center justify-center gap-2 bg-amber-500 px-3 py-2 text-center text-[12px] font-semibold text-black">
      <span>⚠️ أنت على نسخة قديمة مجمّدة — بعض الميزات الجديدة مو موجودة هنا.</span>
      <a href={href} className="rounded-md bg-black px-3 py-1 text-amber-300 hover:bg-black/80">افتح النسخة الحالية ↗</a>
    </div>
  );
}
