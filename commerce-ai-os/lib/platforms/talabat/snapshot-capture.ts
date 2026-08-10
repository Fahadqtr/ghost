import "server-only";
// Malikas V2 — Talabat snapshot capture (Phase UI.9.6). SERVER-ONLY.
//
// Persists ONE reliable snapshot per Approved Malika product for Talabat into
// platform_snapshots, built ENTIRELY from the EXISTING trusted upload diff
// (diffTalabat, lib/talabat-diff) — it adds no Talabat API client, credentials
// flow, catalog fetcher, event receiver or scheduled job. READ-only on `products`; INSERT-only on
// platform_snapshots through the SESSION client (RLS) — no service role, no
// product/mapping/order write, no RPC. It NEVER touches the order pipeline, the
// stock-deduction path, or channel_variant_mappings semantics.
//
// SAFE BY CONSTRUCTION:
//  - A failed/empty diff (bad file) is SKIPPED (no write) — absence is never
//    recorded as "missing".
//  - Idempotent via the engine's payload-hash dedupe: re-uploading the same sheet
//    writes nothing.
//  - Persistence failure is caught and returned as a fixed Arabic message — it
//    NEVER throws into the caller, so it can never break the upload/diff flow.
//  - Bounded: the diff is capped upstream; inputs are additionally capped and the
//    store chunks inserts.

import type { SnapshotInput } from "../core/types.ts";
import type { CaptureStore } from "../core/capture.ts";
import {
  diffToSnapshotInputs,
  type TalabatCatalogRow,
  type TalabatDiffResult,
} from "./capture-compute.ts";

export interface CaptureTalabatResult {
  ok: boolean;
  /** true when the diff was empty/failed and capture was safely skipped */
  skipped: boolean;
  error?: string;
  total: number; // Approved products with a verdict (snapshot inputs built)
  created: number;
  changed: number;
  unchanged: number;
  events: number;
  capturedAt?: string;
}

const BASE: CaptureTalabatResult = {
  ok: false,
  skipped: false,
  total: 0,
  created: 0,
  changed: 0,
  unchanged: 0,
  events: 0,
};

/** Reads our catalog rows the diff needs (id, sku, barcode, name, approval). */
export type OurCatalogLoader = (client: unknown) => Promise<TalabatCatalogRow[]>;
/** The existing pure diff (injected in tests; lib/talabat-diff in prod). */
export type TalabatDiffRunner = (
  ours: TalabatCatalogRow[],
  sheetRows: Record<string, unknown>[],
) => TalabatDiffResult;
export type CaptureRunner = (
  store: CaptureStore,
  inputs: readonly SnapshotInput[],
) => Promise<{ created: number; changed: number; unchanged: number; events: unknown[] }>;

const PAGE = 1000;

async function defaultLoadOurCatalog(client: unknown): Promise<TalabatCatalogRow[]> {
  const sb = client as {
    from: (t: string) => { select: (c: string) => { range: (a: number, b: number) => Promise<{ data: unknown[] | null; error: unknown }> } };
  };
  const out: TalabatCatalogRow[] = [];
  // barcode column may not exist on older installs — fall back without it.
  let cols = "id, sku, barcode, name_en, name_ar, approval";
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from("products").select(cols).range(from, from + PAGE - 1);
    if (error) {
      if (cols.includes("barcode")) {
        cols = "id, sku, name_en, name_ar, approval";
        from -= PAGE; // retry this page without the optional column
        continue;
      }
      throw new Error("catalog_read_failed");
    }
    const rows = (Array.isArray(data) ? data : []) as Record<string, unknown>[];
    for (const p of rows) {
      out.push({
        id: String(p.id ?? ""),
        sku: (p.sku as string) ?? null,
        barcode: (p.barcode as string) ?? null,
        name_en: (p.name_en as string) ?? null,
        name_ar: (p.name_ar as string) ?? null,
        approval: (p.approval as string) ?? null,
      });
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

async function defaultDiff(): Promise<TalabatDiffRunner> {
  const m = await import("@/lib/talabat-diff");
  return (ours, rows) => m.diffTalabat(ours as never, rows) as unknown as TalabatDiffResult;
}

async function defaultStore(client: unknown): Promise<CaptureStore> {
  const { SupabaseSnapshotStore } = await import("../core/supabase-store.ts");
  return new SupabaseSnapshotStore(client as never);
}

async function defaultCapture(): Promise<CaptureRunner> {
  const { captureSnapshots } = await import("../core/capture.ts");
  return (store, inputs) => captureSnapshots(store, inputs);
}

/**
 * Capture Talabat snapshots from an uploaded Talabat export. Best-effort and
 * bounded. A failed/empty diff returns `{ skipped: true }` with NO write. Any
 * failure returns `{ ok: false, error }` (a fixed message) and never throws.
 * `capturedAt` MUST be supplied by the caller (the engine never reads a clock).
 */
export async function captureTalabatSnapshots(
  client: unknown,
  sheetRows: Record<string, unknown>[],
  capturedAt: string,
  deps?: {
    loadOurCatalog?: OurCatalogLoader;
    diff?: TalabatDiffRunner;
    store?: CaptureStore;
    capture?: CaptureRunner;
  },
): Promise<CaptureTalabatResult> {
  try {
    if (!Array.isArray(sheetRows) || sheetRows.length === 0) return { ...BASE, ok: true, skipped: true };

    const loadOurCatalog = deps?.loadOurCatalog ?? defaultLoadOurCatalog;
    const diff = deps?.diff ?? (await defaultDiff());
    const ours = await loadOurCatalog(client);
    const result = diff(ours, sheetRows);
    // Only a trusted, successful diff produces snapshots — a bad/unrecognized
    // file is SKIPPED (never written, never recorded as "missing").
    if (!result?.ok) return { ...BASE, ok: true, skipped: true };

    const inputs = diffToSnapshotInputs(ours, result, capturedAt);
    if (inputs.length === 0) return { ...BASE, ok: true, capturedAt };

    const store = deps?.store ?? (await defaultStore(client));
    const capture = deps?.capture ?? (await defaultCapture());
    const captured = await capture(store, inputs);

    return {
      ok: true,
      skipped: false,
      total: inputs.length,
      created: captured.created,
      changed: captured.changed,
      unchanged: captured.unchanged,
      events: captured.events.length,
      capturedAt,
    };
  } catch {
    // Includes the case where the migration hasn't been applied yet (table
    // missing) — the dashboard simply stays "Unknown"/linked-baseline for Talabat.
    return { ...BASE, error: "تعذّر حفظ لقطات طلبات حاليًا." };
  }
}
