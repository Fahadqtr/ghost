// /v2 — Executive Home Dashboard loading skeleton (HOME.1). Keeps the shell
// responsive while the read-only home read-model composes the certified engines.

export default function V2HomeLoading() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <div className="h-16 animate-pulse rounded-xl bg-slate-100" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-xl bg-slate-100" />
        ))}
      </div>
      <div className="h-40 animate-pulse rounded-xl bg-slate-100" />
      <div className="h-40 animate-pulse rounded-xl bg-slate-100" />
      <div className="h-32 animate-pulse rounded-xl bg-slate-100" />
    </div>
  );
}
