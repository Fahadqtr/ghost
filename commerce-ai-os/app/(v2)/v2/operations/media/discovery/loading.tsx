// /v2/operations/media/discovery — loading skeleton (MEDIA.1B).

export default function SnoonuDiscoveryLoading() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <div className="h-20 animate-pulse rounded-xl bg-slate-100" />
      <div className="h-8 w-2/3 animate-pulse rounded-lg bg-slate-100" />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="h-48 animate-pulse rounded-xl bg-slate-100" />
        <div className="h-48 animate-pulse rounded-xl bg-slate-100" />
      </div>
    </div>
  );
}
