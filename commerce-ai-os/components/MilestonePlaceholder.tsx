// Temporary placeholder shown for pages not yet built in the current milestone.
// Replaced by the real page when its milestone lands.
export default function MilestonePlaceholder({
  title,
  milestone,
  description,
}: {
  title: string;
  milestone: string;
  description: string;
}) {
  return (
    <div className="card flex flex-col items-start gap-2">
      <span className="badge bg-brand-light text-brand-dark">{milestone}</span>
      <h2 className="text-xl font-semibold text-ink">{title}</h2>
      <p className="max-w-prose text-sm text-muted">{description}</p>
    </div>
  );
}
