// Route-level loading state for the Product Timeline (Phase UI.7.4).

export default function ProductTimelineLoading() {
  return (
    <div className="space-y-5" aria-busy="true">
      <div className="h-8 w-28 animate-pulse rounded bg-[#f1e6d8]" />
      <div className="h-6 w-40 animate-pulse rounded bg-[#f1e6d8]" />
      <div className="h-24 animate-pulse rounded-xl bg-[#faf3ec]" />
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-xl bg-[#faf3ec]" />
        ))}
      </div>
      <span className="sr-only">جارٍ تحميل سجل النشاط…</span>
    </div>
  );
}
