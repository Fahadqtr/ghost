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
import {
  DIFF_FIELD_LABELS,
  type CrossPlatformDiffItem,
  type CrossPlatformFieldDiff,
} from "@/lib/operations/cross-platform-diff";
import type { PlatformType } from "@/lib/operations/shared/models";

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

const DIFF_TONE: Record<string, string> = {
  different: "text-rose-700",
  equal: "text-emerald-700",
};

/** One "field vs Malikas" row. Values already carry the SoT/platform split; this
 *  holds no comparison logic (status is decided in the pure diff module). */
function DiffRow({ diff }: { diff: CrossPlatformFieldDiff }) {
  const fmt = (v: string | number | null) => (v === null || v === "" ? DASH : String(v));
  return (
    <div className="flex items-center justify-between gap-2 text-[11px]">
      <span className="text-muted">{DIFF_FIELD_LABELS[diff.field]}</span>
      <span className="flex items-center gap-1">
        <span className="text-ink">{fmt(diff.sourceValue)}</span>
        <span className="text-muted">↔</span>
        <span className={"font-medium " + (DIFF_TONE[diff.status] ?? "text-ink")}>
          {fmt(diff.platformValue)}
        </span>
      </span>
    </div>
  );
}

/** Expandable "الفروقات مقابل ماليكاس" — native <details>, no client JS. Only
 *  shown when the platform has at least one comparable (equal/different) field. */
function DiffDetail({ diff }: { diff: CrossPlatformDiffItem | undefined }) {
  if (!diff || diff.fields.length === 0) return null;
  return (
    <details className="rounded-lg bg-[#faf5ee] px-2 py-1.5">
      <summary className="flex cursor-pointer items-center justify-between text-[11px] font-medium text-ink">
        <span>الفروقات مقابل ماليكاس</span>
        {diff.issueCount > 0 ? (
          <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[10px] text-rose-700">
            {diff.issueCount}
          </span>
        ) : (
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-700">
            مطابق
          </span>
        )}
      </summary>
      <div className="mt-1.5 space-y-1">
        {diff.fields.map((f) => (
          <DiffRow key={f.field} diff={f} />
        ))}
      </div>
    </details>
  );
}

function Cell({ cell, diff }: { cell: PlatformMatrixCell; diff: CrossPlatformDiffItem | undefined }) {
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
      <DiffDetail diff={diff} />
    </div>
  );
}

export default function PlatformMatrix({
  matrix,
  diffs = [],
}: {
  matrix: PlatformMatrixItem;
  diffs?: readonly CrossPlatformDiffItem[];
}) {
  // Index the (already-built) diff items by platform for per-cell lookup. The UI
  // holds no comparison logic — every field row is decided in the pure module.
  const diffByPlatform = new Map<PlatformType, CrossPlatformDiffItem>();
  for (const d of diffs) diffByPlatform.set(d.platform, d);

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
          <Cell key={cell.platform} cell={cell} diff={diffByPlatform.get(cell.platform)} />
        ))}
      </div>
    </section>
  );
}
