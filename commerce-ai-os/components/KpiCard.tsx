// Presentational KPI card. Shows a graceful empty-state when value is null.
export default function KpiCard({
  title,
  value,
  hint,
  icon,
  emptyLabel = "No data yet",
}: {
  title: string;
  value: number | string | null;
  hint?: string;
  icon?: string;
  emptyLabel?: string;
}) {
  const isEmpty = value === null || value === undefined;
  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-muted">{title}</p>
        {icon ? <span className="text-lg">{icon}</span> : null}
      </div>
      <p
        className={`mt-2 text-2xl font-semibold ${
          isEmpty ? "text-slate-400" : "text-ink"
        }`}
      >
        {isEmpty ? emptyLabel : value}
      </p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}
