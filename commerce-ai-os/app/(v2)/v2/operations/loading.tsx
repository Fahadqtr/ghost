// Route-level loading state for the Operations Center (Phase UI.8).

export default function OperationsLoading() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="h-6 w-48 animate-pulse rounded bg-[#f1e6d8]" />

      {/* KPI grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 11 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-xl bg-[#faf3ec]" />
        ))}
      </div>

      {/* platform overview */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-xl bg-[#faf3ec]" />
        ))}
      </div>

      {/* queues */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-40 animate-pulse rounded-xl bg-[#faf3ec]" />
        ))}
      </div>

      <span className="sr-only">جارٍ تحميل مركز العمليات…</span>
    </div>
  );
}
