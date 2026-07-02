import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getLowStockAlerts } from "@/lib/inventory/lowStock";

// In-app notification feed (v1): a COMPUTED aggregation of the alert sources
// that already exist — nothing is stored. Each item has a stable `key` so the
// client can diff against a "seen" watermark kept in localStorage.

export type Notification = {
  key: string;                 // stable identity for seen-tracking
  icon: string;
  ar: string;
  en: string;
  href: string;
  severity: "high" | "med" | "low";
};

function adminClient(): any | null {
  try { return createAdminClient(); } catch { return null; }
}

export async function getNotifications(): Promise<{ items: Notification[] }> {
  const admin = adminClient();
  const items: Notification[] = [];

  // 1) Stock alerts (out first) — reuse the dashboard's low-stock source.
  try {
    const alerts = await getLowStockAlerts(50);
    if (alerts.outCount > 0) {
      items.push({
        key: `stock-out:${alerts.outCount}`,
        icon: "⛔", severity: "high",
        ar: `${alerts.outCount} منتج نافد من المخزون`,
        en: `${alerts.outCount} product${alerts.outCount === 1 ? "" : "s"} out of stock`,
        href: "/inventory/out-of-stock",
      });
    }
    if (alerts.lowCount > 0) {
      items.push({
        key: `stock-low:${alerts.lowCount}`,
        icon: "⚠️", severity: "med",
        ar: `${alerts.lowCount} منتج مخزونه منخفض`,
        en: `${alerts.lowCount} product${alerts.lowCount === 1 ? "" : "s"} low on stock`,
        href: "/inventory/out-of-stock",
      });
    }
  } catch { /* skip source */ }

  if (admin) {
    // 2) Staff movements awaiting approval.
    try {
      const { count } = await admin
        .from("malak_audit")
        .select("id", { count: "exact", head: true })
        .like("agent", "staff:%")
        .in("action_type", ["stock_in", "stock_out"])
        .filter("details->>review", "is", null);
      if ((count ?? 0) > 0) {
        items.push({
          key: `approvals:${count}`,
          icon: "✅", severity: "high",
          ar: `${count} حركة موظفين بانتظار اعتمادك`,
          en: `${count} staff movement${count === 1 ? "" : "s"} awaiting approval`,
          href: "/inventory/approvals",
        });
      }
    } catch { /* skip */ }

    // 3) Staff-submitted products awaiting approval.
    try {
      const { count } = await admin
        .from("products")
        .select("id", { count: "exact", head: true })
        .is("approval", null)
        .like("notes", "staff-new:%");
      if ((count ?? 0) > 0) {
        items.push({
          key: `staff-products:${count}`,
          icon: "🆕", severity: "high",
          ar: `${count} منتج جديد من الموظفين بانتظار اعتمادك`,
          en: `${count} new staff product${count === 1 ? "" : "s"} awaiting approval`,
          href: "/products?review=staff",
        });
      }
    } catch { /* skip */ }

    // 4) Tasks: overdue (high) and open (low).
    try {
      const todayISO = new Date().toISOString().slice(0, 10);
      const { count: overdue } = await admin
        .from("staff_tasks").select("id", { count: "exact", head: true })
        .neq("status", "done").lt("due_date", todayISO);
      if ((overdue ?? 0) > 0) {
        items.push({
          key: `tasks-overdue:${overdue}`,
          icon: "🔴", severity: "high",
          ar: `${overdue} مهمة متأخّرة`,
          en: `${overdue} overdue task${overdue === 1 ? "" : "s"}`,
          href: "/tasks",
        });
      }
      const { count: open } = await admin
        .from("staff_tasks").select("id", { count: "exact", head: true })
        .neq("status", "done");
      if ((open ?? 0) > 0) {
        items.push({
          key: `tasks-open:${open}`,
          icon: "📋", severity: "low",
          ar: `${open} مهمة مفتوحة`,
          en: `${open} open task${open === 1 ? "" : "s"}`,
          href: "/tasks",
        });
      }
    } catch { /* table may not exist yet */ }
  }

  const rank = { high: 0, med: 1, low: 2 } as const;
  items.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { items };
}
