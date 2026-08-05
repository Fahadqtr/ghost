// /v2/contest — Beauty contest (first slice).
//
// The navigation target for the "مسابقة الجمال" sidebar entry. This is the
// page SHELL only: there is no contest table yet, so it reads nothing, writes
// nothing, and shows no numbers it cannot prove. The counters render "—"
// (unknown) rather than 0, because 0 would assert "no participants" as a fact
// when the truth is simply that nothing is connected yet.
//
// Auth comes from the (v2) route-group layout, which redirects unauthenticated
// visitors to /login before this page runs.
//
// Deliberately absent until the data model is agreed: any table read, any write
// or server action, any participant/entry list, any mock or placeholder data.

export const dynamic = "force-dynamic";

const NOT_CONFIGURED = "لم يتم إعداد المسابقة بعد. سيظهر هنا سجل المشاركات والنتائج فور ربط البيانات.";

/** A counter whose value is unknown until the data model exists — never 0. */
function StatCard({ label }: { label: string }) {
  return (
    <div className="card px-3 py-2.5 text-center">
      <div className="text-xl font-bold text-ink">—</div>
      <div className="mt-0.5 text-[11px] leading-tight text-muted">{label}</div>
    </div>
  );
}

export default function ContestPage() {
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-serif text-2xl font-semibold text-ink">مسابقة الجمال</h1>
          <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800">
            قيد الإعداد
          </span>
        </div>
        <p className="text-sm text-muted">إدارة مسابقة الجمال والمشاركات والنتائج</p>
      </div>

      {/* Counters — unknown, not zero */}
      <div className="grid grid-cols-3 gap-2.5">
        <StatCard label="المشاركات" />
        <StatCard label="المتأهلات" />
        <StatCard label="الفائزات" />
      </div>

      {/* Empty state */}
      <div className="card flex flex-col items-center gap-3 py-10 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#faf3ec] text-[#d9b48f]">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M8 3h8v4a4 4 0 0 1-8 0V3Z" />
            <path d="M16 4h3v2a3 3 0 0 1-3 3M8 4H5v2a3 3 0 0 0 3 3" />
            <path d="M12 11v4M9 21h6M10 18h4l.5 3h-5l.5-3Z" />
          </svg>
        </div>
        <p className="max-w-md text-sm leading-relaxed text-muted">{NOT_CONFIGURED}</p>
      </div>
    </div>
  );
}
