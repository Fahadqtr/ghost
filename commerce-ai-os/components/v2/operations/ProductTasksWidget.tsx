// Malikas V2 — «المهام» widget for the product detail page (Phase UI.7.3).
// Read-only: it renders the tasks already COMPUTED by lib/operations/* for this
// one product (first 3 + a "+N أخرى" hint). No business logic, no data access,
// no complete/assign/delete action — tasks are computed, never stored.

import { productWidgetTasks } from "@/lib/operations/tasks-view";
import { PLATFORM_LABELS } from "@/lib/operations/platforms/platform-status";
import type { OperationTask, TaskPriority } from "@/lib/operations/shared/models";

const PRIORITY_TONE: Record<TaskPriority, string> = {
  high: "bg-rose-50 text-rose-700",
  medium: "bg-amber-50 text-amber-800",
  low: "bg-[#f5ece1] text-ink",
};

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  high: "عالية",
  medium: "متوسطة",
  low: "منخفضة",
};

export default function ProductTasksWidget({ tasks }: { tasks: readonly OperationTask[] }) {
  if (!tasks || tasks.length === 0) {
    return (
      <div className="card space-y-2 p-4">
        <h2 className="text-sm font-semibold text-ink">المهام</h2>
        <p className="text-sm text-muted">لا توجد مهام على هذا المنتج حاليًا.</p>
      </div>
    );
  }

  const { shown, remaining } = productWidgetTasks(tasks, 3);

  return (
    <div className="card space-y-2 p-4">
      <h2 className="text-sm font-semibold text-ink">المهام ({tasks.length})</h2>
      <ul className="space-y-2">
        {shown.map((t) => (
          <li key={t.id} className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-ink">
                {t.title}
                {t.platform ? <span className="text-muted"> · {PLATFORM_LABELS[t.platform]}</span> : null}
              </div>
              {t.description ? <div className="text-[11px] text-muted">{t.description}</div> : null}
            </div>
            <span className={"shrink-0 rounded-full px-2 py-0.5 text-[11px] " + PRIORITY_TONE[t.priority]}>
              {PRIORITY_LABEL[t.priority]}
            </span>
          </li>
        ))}
      </ul>
      {remaining > 0 ? <div className="text-xs text-muted">+{remaining} أخرى</div> : null}
    </div>
  );
}
