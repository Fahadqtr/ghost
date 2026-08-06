// Route-level loading state for the product editor only (Phase UI.4). The
// editor blocks on a per-product read, so a small skeleton beats a frozen
// navigation. Deliberately scoped to this route — adding skeletons across all
// of V2 is its own task.

export default function ProductEditLoading() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="h-9 w-24 animate-pulse rounded-lg bg-[#f1e6d8]" />
      <div className="card space-y-4">
        <div className="h-5 w-40 animate-pulse rounded bg-[#f1e6d8]" />
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="h-10 animate-pulse rounded-lg bg-[#faf3ec]" />
          <div className="h-10 animate-pulse rounded-lg bg-[#faf3ec]" />
          <div className="h-10 animate-pulse rounded-lg bg-[#faf3ec]" />
          <div className="h-10 animate-pulse rounded-lg bg-[#faf3ec]" />
        </div>
      </div>
      <div className="card space-y-3">
        <div className="h-5 w-32 animate-pulse rounded bg-[#f1e6d8]" />
        <div className="h-10 animate-pulse rounded-lg bg-[#faf3ec]" />
        <div className="h-10 animate-pulse rounded-lg bg-[#faf3ec]" />
      </div>
      <span className="sr-only">جارٍ تحميل بيانات المنتج…</span>
    </div>
  );
}
