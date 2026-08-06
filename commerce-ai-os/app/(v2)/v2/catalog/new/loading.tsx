// Route-level loading state for the AI product creator only (Phase UI.5).

export default function NewAiProductLoading() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="h-6 w-56 animate-pulse rounded bg-[#f1e6d8]" />
      <div className="card space-y-4">
        <div className="h-40 animate-pulse rounded-xl bg-[#faf3ec]" />
        <div className="h-10 w-40 animate-pulse rounded-lg bg-[#f1e6d8]" />
      </div>
      <span className="sr-only">جارٍ تحميل منشئ المنتجات…</span>
    </div>
  );
}
