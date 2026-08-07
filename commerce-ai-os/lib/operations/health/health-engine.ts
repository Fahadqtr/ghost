// Malikas V2 Operations — Health Engine (Phase UI.7.1).
//
// PURE: aggregates the other engines' outputs into one summary for the
// operations dashboard header. Computes only — never stores, never fetches.

import type { HealthSummary, OperationTask, ProductReadiness } from "../shared/models";

/** Summarize a whole catalog snapshot from readiness results + tasks. */
export function computeHealthSummary(
  readiness: readonly ProductReadiness[],
  tasks: readonly OperationTask[],
): HealthSummary {
  let readyProducts = 0;
  let needsImage = 0;
  let newProducts = 0;
  let percentTotal = 0;
  for (const r of readiness) {
    if (r.readyToPublish) readyProducts++;
    if (r.checks.some((c) => c.code === "image" && !c.passed)) needsImage++;
    if (r.isNew) newProducts++;
    percentTotal += r.percent;
  }
  return {
    totalProducts: readiness.length,
    readyProducts,
    needsImage,
    newProducts,
    generatedTasks: tasks.length,
    readinessAverage: readiness.length === 0 ? 0 : Math.round(percentTotal / readiness.length),
  };
}
