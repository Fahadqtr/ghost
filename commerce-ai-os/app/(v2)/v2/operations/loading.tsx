// Route-level loading state for the Operations Center (Phase UI.7.2).

export default function OperationsLoading() {
  return (
    <div className="space-y-5" aria-busy="true">
      <div className="h-6 w-48 animate-pulse rounded bg-[#f1e6d8]" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-xl bg-[#faf3ec]" />
        ))}
      </div>
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl bg-[#faf3ec]" />
        ))}
      </div>
      <span className="sr-only">جارٍ تحميل مركز العمليات…</span>
    </div>
  );
}
