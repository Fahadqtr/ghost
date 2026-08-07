// Route-level loading state for Smart Tasks (Phase UI.7.3).

export default function TasksLoading() {
  return (
    <div className="space-y-5" aria-busy="true">
      <div className="h-6 w-40 animate-pulse rounded bg-[#f1e6d8]" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-xl bg-[#faf3ec]" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-40 animate-pulse rounded-xl bg-[#faf3ec]" />
        ))}
      </div>
      <span className="sr-only">جارٍ تحميل المهام…</span>
    </div>
  );
}
