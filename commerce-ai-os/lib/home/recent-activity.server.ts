import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ActivityFact } from "./home-model.ts";

// HOME.1 — recent platform activity reader (READ-ONLY).
//
// The audit trail (malak_audit) is the platform's existing activity source; the
// only platform-wide newest-first view of it lives inline in the legacy audit
// page (app/(app)/malak/audit/page.tsx). This is the same read, extracted as a
// bounded, read-only loader so the Executive Home can show "latest N events"
// without duplicating any business logic — it is a plain projection of audit
// rows, adds no rules, and performs NO writes. React.cache-wrapped so a repeat
// request in the same render is free.

const DEFAULT_LIMIT = 20;

interface AuditRow {
  id: string;
  created_at: string | null;
  action_type: string | null;
  sku: string | null;
  field: string | null;
  status: string | null;
}

export const loadRecentActivity = cache(async (limit: number = DEFAULT_LIMIT): Promise<ActivityFact[] | null> => {
  const n = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 50) : DEFAULT_LIMIT;
  try {
    const sb = createAdminClient();
    const { data, error } = await sb
      .from("malak_audit")
      .select("id, created_at, action_type, sku, field, status")
      .order("created_at", { ascending: false })
      .limit(n);
    if (error) return null;
    return ((data ?? []) as AuditRow[]).map((r) => ({
      id: String(r.id),
      at: r.created_at ?? "",
      type: r.action_type ?? "—",
      sku: r.sku ?? "UNKNOWN",
      field: r.field ?? "UNKNOWN",
      status: r.status ?? "UNKNOWN",
    }));
  } catch {
    return null;
  }
});
