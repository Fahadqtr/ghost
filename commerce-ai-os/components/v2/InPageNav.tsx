// Malikas V2 — in-page section navigation (UX.2). Server Component, NO client JS:
// a sticky, horizontally-scrollable row of anchor links that jump to on-page
// section ids. RTL, mobile-first. Anchors only — no routes, query params, data
// reads, or client state. Sections carry the matching `id` + a scroll-margin so
// the target lands below the global top bar and this sticky strip.

export interface InPageNavItem {
  /** Fragment target, e.g. "#platforms". */
  href: string;
  label: string;
}

export default function InPageNav({
  items,
  ariaLabel = "التنقّل داخل الصفحة",
}: {
  items: readonly InPageNavItem[];
  ariaLabel?: string;
}) {
  return (
    <nav
      aria-label={ariaLabel}
      dir="rtl"
      className="sticky top-[57px] z-10 -mx-4 overflow-x-auto border-b border-[#efe3d6] bg-[#fffaf4]/90 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6"
    >
      <ul className="flex gap-2 whitespace-nowrap">
        {items.map((it) => (
          <li key={it.href}>
            <a
              href={it.href}
              className="inline-block rounded-full border border-[#e7d9c9] bg-white px-3 py-1 text-xs font-medium text-ink hover:bg-[#faf3ec]"
            >
              {it.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
