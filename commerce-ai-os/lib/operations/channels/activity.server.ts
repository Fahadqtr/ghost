import "server-only";
// OPS.4 — Cross-channel activity reader (SERVER-ONLY, READ-ONLY).
//
// Reads REAL recorded events from existing sources with BOUNDED queries only
// (order-by + LIMIT, no full-history scan §4/§11) and hands the raw rows to the
// pure normalizer. It creates NO write-side event ledger and writes nothing
// (select-only surface). Cost: 2 bounded reads (malak_audit + talabat_orders).
// Per-channel snapshot freshness is already carried by the dashboard overview, so
// it is not re-read here.

import { safeError } from "@/lib/security/safe-error";
import {
  mergeActivity,
  normalizeAuditRow,
  normalizeTalabatOrder,
  type ActivityEvent,
  type AuditRawRow,
  type TalabatOrderRawRow,
} from "./activity.ts";

const AUDIT_LIMIT = 120;
const TALABAT_LIMIT = 40;
const FEED_LIMIT = 120;
const LOAD_FAILED = "تعذّر تحميل النشاط.";

interface OrderedResult { data: unknown[] | null; error: unknown | null }
interface Ordered extends PromiseLike<OrderedResult> { limit(n: number): PromiseLike<OrderedResult> }
interface Selectable { select(cols: string): { order(col: string, o: { ascending: boolean }): Ordered } }
export interface ActivityReadClient { from(table: string): Selectable }

async function readBounded(client: ActivityReadClient, table: string, cols: string, orderCol: string, limit: number): Promise<{ rows: Record<string, unknown>[]; degraded: boolean }> {
  try {
    const { data, error } = await client.from(table).select(cols).order(orderCol, { ascending: false }).limit(limit);
    if (error || !Array.isArray(data)) return { rows: [], degraded: true };
    return { rows: data.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object"), degraded: false };
  } catch {
    return { rows: [], degraded: true };
  }
}

export interface ActivityView {
  events: ActivityEvent[];
  degraded: boolean;
}

/** Load the bounded, normalized cross-channel activity feed. Read-only + best
 *  effort: a failing source degrades that source to empty (never fabricated). */
export async function loadChannelActivity(client: ActivityReadClient): Promise<ActivityView | { error: string }> {
  try {
    const audit = await readBounded(
      client,
      "malak_audit",
      "id, created_at, action_type, agent, sku, product_id, field, old_value, new_value, details, status",
      "created_at",
      AUDIT_LIMIT,
    );
    const talabat = await readBounded(client, "talabat_orders", "id, order_code, received_at, status, processing_status", "received_at", TALABAT_LIMIT);

    const auditEvents = audit.rows.map((r) => normalizeAuditRow(r as AuditRawRow)).filter((e): e is ActivityEvent => e !== null);
    const talabatEvents = talabat.rows.map((r) => normalizeTalabatOrder(r as TalabatOrderRawRow)).filter((e): e is ActivityEvent => e !== null);

    return { events: mergeActivity([auditEvents, talabatEvents], FEED_LIMIT), degraded: audit.degraded || talabat.degraded };
  } catch (e) {
    return { error: safeError("ops4_activity_load", e, LOAD_FAILED) };
  }
}
