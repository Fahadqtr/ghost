// D-2 — CRM data minimization for staff readers. Pure, no `@/` or `server-only`
// imports, so the projection is directly unit-testable and the withheld-field
// list is enforced by a test rather than by reviewer attention.
//
// OWNER DECISION: staff read "only the customer/order information necessary for
// daily operations and customer service". Everything else is withheld here, at
// the server, BEFORE the value leaves the action — never merely hidden in the UI.
//
// WITHHELD FROM STAFF and why:
//   spent, orders, currency, segment  — commercial/analytical, not needed to
//                                       answer a customer
//   tags, hasNote, notes              — internal annotations about the customer
//   stats (revenue, top spenders)     — whole-business commercial metrics
//   counts (segment breakdown)        — derived commercial metric
//
// KEPT FOR STAFF: name, phone, instagram, email, channel, lastActivityAt,
// needsHuman, source/sourceId, and the order history (number, date, fulfilment
// status, total) — i.e. exactly what answers "who is this and where is my order".

/** Numeric/derived commercial fields blanked for a staff reader. */
export const STAFF_WITHHELD_CUSTOMER_FIELDS = ["spent", "orders", "segment", "tags", "hasNote"] as const;

/** Detail fields a staff reader never receives. */
export const STAFF_WITHHELD_DETAIL_FIELDS = ["notes", "tags"] as const;

type MinimalCustomer = {
  spent: number; orders: number; segment: string; tags: string[]; hasNote: boolean;
  [k: string]: unknown;
};

/**
 * Blank the commercial and internal fields on every row. The row SHAPE is kept
 * (same keys, neutral values) so no caller or component has to branch on viewer
 * kind — a staff reader simply never sees a real value in those slots.
 */
export function minimizeCustomersForStaff<T extends MinimalCustomer>(rows: readonly T[]): T[] {
  return rows.map((r) => ({ ...r, spent: 0, orders: 0, segment: "lead", tags: [], hasNote: false }));
}

/** Zeroed segment counts — the breakdown is a commercial metric. */
export function minimizeCountsForStaff<T extends Record<string, number>>(counts: T): T {
  const out = {} as Record<string, number>;
  for (const k of Object.keys(counts)) out[k] = 0;
  return out as T;
}

/**
 * Whole-business figures (revenue, order count, average order, top spenders) are
 * never returned to a staff reader — the empty value is returned instead.
 */
export function minimizeStatsForStaff<T extends { top: unknown[] }>(empty: T): T {
  return empty;
}

/** Drop the internal note and tag annotations from a customer detail. */
export function minimizeDetailForStaff<T extends { notes: string; tags: string[] }>(detail: T): T {
  return { ...detail, notes: "", tags: [] };
}
