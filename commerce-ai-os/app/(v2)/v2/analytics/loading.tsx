export default function Loading() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="h-6 w-56 animate-pulse rounded bg-slate-200" />
      <div className="h-4 w-full max-w-2xl animate-pulse rounded bg-slate-100" />
      <div className="h-12 w-full animate-pulse rounded-xl bg-slate-100" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-xl bg-slate-100" />
        ))}
      </div>
      <div className="h-40 w-full animate-pulse rounded-xl bg-slate-100" />
      <div className="h-40 w-full animate-pulse rounded-xl bg-slate-100" />
    </div>
  );
}
