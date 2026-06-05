// Per-channel export buttons. Each links to a server route that pulls the live
// DB and streams a real CSV download (all products). Phase 1: structure-only —
// stock/images/brand left blank; nothing is sent to any marketplace.

const EXPORTS = [
  { key: "shopify", label: "Shopify CSV" },
  { key: "snoonu", label: "Snoonu masterlist" },
  { key: "talabat", label: "Talabat split-CSV" },
  { key: "rafeeq", label: "Rafeeq CSV" },
] as const;

export default function ExportButtons() {
  return (
    <div className="card space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-ink">Export per channel</h3>
        <p className="text-xs text-muted">
          Generates a real CSV from the live database (all products). Downloads locally —
          nothing is sent to any marketplace. Stock & images are left blank for now.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {EXPORTS.map((e) => (
          <a key={e.key} href={`/api/export/${e.key}`} className="btn-ghost" download>
            ⬇ {e.label}
          </a>
        ))}
      </div>
    </div>
  );
}
