// Malikas V2 — CI.1 Product Platform Matrix section (Server Component, RTL,
// mobile-first). Renders the unified per-platform status for one product. It holds
// NO platform logic: it reads only the already-normalized PlatformMatrixItem
// (state + trusted fields) and fixed label maps. Untrusted fields render as "—".
// No client JS.

import {
  MATRIX_STATE_LABELS,
  MATRIX_FLAG_LABELS,
  type MatrixState,
  type PlatformMatrixCell,
  type PlatformMatrixItem,
} from "@/lib/operations/platform-matrix";

const STATE_TONE: Record<MatrixState, string> = {
  present: "bg-emerald-50 text-emerald-700",
  ready: "bg-sky-50 text-sky-700",
  different: "bg-amber-50 text-amber-700",
  review: "bg-amber-50 text-amber-700",
  missing: "bg-rose-50 text-rose-700",
  unknown: "bg-[#f5ece1] text-muted",
};

const DASH = "—";

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[11px]">
      <span className="text-muted">{label}</span>
      <span className="font-medium text-ink">{value && value.trim() !== "" ? value : DASH}</span>
    </div>
  );
}

function Cell({ cell }: { cell: PlatformMatrixCell }) {
  return (
    <div className="card space-y-2 p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-ink">{cell.label}</span>
        <span className={"rounded-full px-2 py-0.5 text-[10px] " + STATE_TONE[cell.state]}>
          {MATRIX_STATE_LABELS[cell.state]}
        </span>
      </div>
      {cell.flags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {cell.flags.map((f) => (
            <span key={f} className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700">
              {MATRIX_FLAG_LABELS[f] ?? f}
            </span>
          ))}
        </div>
      ) : null}
      <div className="space-y-1">
        <Field label="المعرّف الخارجي" value={cell.externalId} />
        <Field label="السعر" value={cell.price === null ? null : String(cell.price)} />
        <Field label="التوفّر" value={cell.availability} />
        <p className="pt-1 text-[10px] text-muted">
          آخر لقطة: {cell.capturedAt ? new Date(cell.capturedAt).toLocaleString("ar") : DASH}
          {cell.capturedAt && cell.stale ? " · ⚠️ قديمة" : ""}
        </p>
      </div>
    </div>
  );
}

export default function PlatformMatrix({ matrix }: { matrix: PlatformMatrixItem }) {
  return (
    <section className="space-y-3" dir="rtl">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">حالة المنصات</h2>
        {matrix.needsAttention ? (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700">
            يحتاج انتباه: {matrix.issueCount}
          </span>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {matrix.cells.map((cell) => (
          <Cell key={cell.platform} cell={cell} />
        ))}
      </div>
    </section>
  );
}
