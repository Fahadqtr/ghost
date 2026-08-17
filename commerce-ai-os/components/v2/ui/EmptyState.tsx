// UX.1A — empty-state panel.
//
// Shown when a filter/scan returns no rows: a friendly inline SVG illustration
// plus a clear title and message, instead of a blank table. Presentational only
// (no hooks, no I/O). The SVG uses currentColor so it stays theme-aware.

export default function EmptyState({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-6 py-12 text-center"
    >
      <svg
        role="img"
        aria-label="لا توجد نتائج"
        viewBox="0 0 64 64"
        className="h-14 w-14 text-slate-300"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="10" y="14" width="44" height="36" rx="4" />
        <path d="M10 24h44" />
        <path d="M20 34h14M20 42h20" />
        <circle cx="45" cy="43" r="8" className="text-slate-400" />
        <path d="M51 49l6 6" className="text-slate-400" />
      </svg>
      <div className="space-y-1">
        <div className="text-sm font-semibold text-ink">{title}</div>
        <div className="mx-auto max-w-sm text-xs text-muted">{message}</div>
      </div>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}
