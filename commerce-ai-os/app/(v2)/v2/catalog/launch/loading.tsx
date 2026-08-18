// /v2/catalog/launch — loading skeleton (WAVE.1A).

export default function LaunchCampaignLoading() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <div className="h-28 animate-pulse rounded-xl bg-slate-100" />
      <div className="h-24 animate-pulse rounded-xl bg-slate-100" />
      <div className="h-8 w-2/3 animate-pulse rounded-lg bg-slate-100" />
      <div className="h-96 animate-pulse rounded-xl bg-slate-100" />
    </div>
  );
}
