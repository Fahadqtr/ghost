// INT.2A — export history contract (PURE).
//
// Defines the read-model shape for past export runs. AUDIT RESULT: there is no
// durable export-history table today (malak_audit logs no export/publish action;
// platform_snapshots are platform OBSERVATIONS, not our exports; talabat_queue
// records only Talabat email dispatch). So INT.2A returns history as UNAVAILABLE
// rather than fabricate it — durable persistence is a later scoped phase.

export type ExportRunStatus = "STARTED" | "SUCCEEDED" | "FAILED" | "PARTIAL";

export interface ExportRun {
  id: string;
  destination: string;
  startedAt: string | null;
  finishedAt: string | null;
  actor: string | null;
  status: ExportRunStatus;
  productCount: number | null;
  variantCount: number | null;
  imageCount: number | null;
  warningCount: number | null;
  errorCount: number | null;
  outputFiles: readonly string[];
  source: string;
  metadata: Record<string, unknown>;
}

/** Whether a durable history source exists for a destination. */
export type ExportHistoryAvailability = "AVAILABLE" | "UNAVAILABLE";

export interface ExportHistory {
  destination: string;
  availability: ExportHistoryAvailability;
  runs: readonly ExportRun[];
}

/**
 * The honest INT.2A default: no durable export-history source exists yet, so
 * history is UNAVAILABLE with zero runs (never fabricated). Persistence belongs
 * to a later scoped phase (an export_runs table + writer).
 */
export function unavailableHistory(destination: string): ExportHistory {
  return { destination, availability: "UNAVAILABLE", runs: [] };
}
