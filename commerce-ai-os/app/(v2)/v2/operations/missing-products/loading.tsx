export default function Loading() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="h-6 w-72 animate-pulse rounded bg-slate-200" />
      <div className="h-4 w-full max-w-2xl animate-pulse rounded bg-slate-100" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-xl bg-slate-100" />
        ))}
      </div>
      <div className="h-64 w-full animate-pulse rounded-xl bg-slate-100" />
    </div>
  );
}
