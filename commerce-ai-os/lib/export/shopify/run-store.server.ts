import "server-only";
// INT.2E.2 — durable export/publish run store (SERVER-ONLY).
//
// Writes ONE immutable export_runs row per publish run (the durable history SAT.1
// found missing) AND always writes a malak_audit floor row via the shared
// insertAuditRow helper. Both are BEST-EFFORT: a publish never fails because its
// audit write failed, and — critically — an UNMIGRATED production database
// (export_runs absent, 42P01) degrades gracefully to the malak_audit floor
// instead of erroring. It stores NO credentials/tokens/payloads (§13, §20); the
// per-item results are a BOUNDED projection (§14).

import { insertAuditRow } from "@/lib/audit";
import type { PublishRunCounts, PublishRunStatus } from "./publish-plan.ts";

type InsertResult = { data?: { id?: string }[] | null; error: { message?: string; code?: string } | null };
export interface RunWriteAdmin {
  from(table: string): {
    insert(row: Record<string, unknown>): {
      select(cols: string): { maybeSingle(): PromiseLike<{ data: { id?: string } | null; error: { message?: string; code?: string } | null }> };
    } & PromiseLike<InsertResult>;
  };
}

/** One per-item result recorded in run metadata (bounded, no payloads). */
export interface ExportRunItem {
  internalProductId: string;
  sku: string | null;
  externalProductGid: string | null;
  operation: string;
  result: string;
  error: string | null; // fixed/safe text only
}

export interface ExportRunRecord {
  destination: string;
  operation: string;
  status: PublishRunStatus;
  actor: string;
  startedAt: string;
  finishedAt: string;
  counts: PublishRunCounts;
  variantCount: number;
  imageCount: number;
  warningCount: number;
  previewFingerprint: string | null;
  externalRefs: { internalProductId: string; gid: string; kind: "created" | "updated" }[];
  errorSummary: string | null;
  items: ExportRunItem[];
}

const MAX_ITEMS = 500; // bound the metadata payload (§14) — counts stay exact

const UNDEFINED_TABLE = "42P01";

/**
 * Persist a run. Attempts the durable export_runs row; regardless of that
 * outcome, writes a compact malak_audit floor row. Returns whether the durable
 * row persisted and its id (null when the table is absent / write failed).
 */
export async function recordExportRun(admin: RunWriteAdmin, run: ExportRunRecord): Promise<{ persisted: boolean; runId: string | null; tableMissing: boolean }> {
  const items = run.items.slice(0, MAX_ITEMS);
  const row: Record<string, unknown> = {
    destination: run.destination,
    operation: run.operation,
    status: run.status,
    actor: run.actor,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    product_count: run.counts.productCount,
    variant_count: run.variantCount,
    image_count: run.imageCount,
    created_count: run.counts.created,
    updated_count: run.counts.updated,
    unchanged_count: run.counts.unchanged,
    blocked_count: run.counts.blocked + run.counts.conflict,
    failed_count: run.counts.failed + run.counts.needsReconciliation,
    warning_count: run.warningCount,
    preview_fingerprint: run.previewFingerprint,
    external_refs: run.externalRefs,
    error_summary: run.errorSummary,
    metadata: { items, itemsTruncated: run.items.length > MAX_ITEMS, counts: run.counts },
  };

  let persisted = false;
  let runId: string | null = null;
  let tableMissing = false;
  try {
    const res = await admin.from("export_runs").insert(row).select("id").maybeSingle();
    if (res.error) {
      if (String(res.error.code ?? "") === UNDEFINED_TABLE) tableMissing = true;
    } else {
      persisted = true;
      runId = res.data?.id ?? null;
    }
  } catch {
    /* best-effort — fall through to the audit floor */
  }

  // Guaranteed floor: a compact, safe malak_audit row (no payloads/secrets).
  await insertAuditRow(admin as never, {
    action_type: "shopify_publish_run",
    product_id: null,
    details: {
      destination: run.destination,
      operation: run.operation,
      status: run.status,
      actor: run.actor,
      counts: run.counts,
      preview_fingerprint: run.previewFingerprint,
      durable_run_persisted: persisted,
    },
  }).catch(() => {});

  return { persisted, runId, tableMissing };
}

// ── Reader (UI history) ──────────────────────────────────────────────────────────
export interface ExportRunSummary {
  id: string;
  destination: string;
  operation: string;
  status: string;
  actor: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  blockedCount: number;
  failedCount: number;
}

interface ReadClient {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: string): {
        order(col: string, opts: { ascending: boolean }): {
          limit(n: number): PromiseLike<{ data: Record<string, unknown>[] | null; error: { code?: string } | null }>;
        };
      };
    };
  };
}

/** Recent runs for a destination. Table absent / error ⇒ availability UNAVAILABLE. */
export async function loadRecentExportRuns(
  client: ReadClient,
  destination: string,
  limit = 10,
): Promise<{ availability: "AVAILABLE" | "UNAVAILABLE"; runs: ExportRunSummary[] }> {
  try {
    const { data, error } = await client
      .from("export_runs")
      .select("id, destination, operation, status, actor, started_at, finished_at, created_count, updated_count, unchanged_count, blocked_count, failed_count")
      .eq("destination", destination)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error || !Array.isArray(data)) return { availability: "UNAVAILABLE", runs: [] };
    const runs = data.map((r) => ({
      id: String(r.id ?? ""),
      destination: String(r.destination ?? ""),
      operation: String(r.operation ?? ""),
      status: String(r.status ?? ""),
      actor: (r.actor as string | null) ?? null,
      startedAt: (r.started_at as string | null) ?? null,
      finishedAt: (r.finished_at as string | null) ?? null,
      createdCount: Number(r.created_count ?? 0) || 0,
      updatedCount: Number(r.updated_count ?? 0) || 0,
      unchangedCount: Number(r.unchanged_count ?? 0) || 0,
      blockedCount: Number(r.blocked_count ?? 0) || 0,
      failedCount: Number(r.failed_count ?? 0) || 0,
    }));
    return { availability: "AVAILABLE", runs };
  } catch {
    return { availability: "UNAVAILABLE", runs: [] };
  }
}
