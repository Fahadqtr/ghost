// Route-level loading state for the Snoonu sync tool.

export default function SnoonuSyncLoading() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="h-6 w-64 animate-pulse rounded bg-[#f1e6d8]" />
      <div className="card space-y-4">
        <div className="h-32 animate-pulse rounded-xl bg-[#faf3ec]" />
        <div className="h-10 w-48 animate-pulse rounded-lg bg-[#f1e6d8]" />
      </div>
      <span className="sr-only">جارٍ تحميل مزامنة سنونو…</span>
    </div>
  );
}
