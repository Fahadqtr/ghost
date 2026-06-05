import Link from "next/link";
import SnoonuSync from "@/components/SnoonuSync";

export const dynamic = "force-dynamic";

export default function SnoonuSyncPage() {
  return (
    <div className="space-y-4">
      <div>
        <Link href="/import-export" className="text-sm text-brand hover:underline">← Import / Export</Link>
        <h2 className="text-lg font-semibold text-ink">Snoonu Sync</h2>
        <p className="text-sm text-muted">
          Reconcile our catalog against a Snoonu export. Matches strictly on <code>snoonu_id</code>; preview a diff
          before applying.
        </p>
      </div>
      <SnoonuSync />
    </div>
  );
}
