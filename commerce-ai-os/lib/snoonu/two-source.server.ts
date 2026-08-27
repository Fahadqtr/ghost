// SNOONU TWO-SOURCE SYNC — server adapter. READ-ONLY.
//
// Loads the live catalog once and hands it, together with the parsed rows of
// whichever workbooks the owner uploaded, to the pure combined planner. There
// is no write path in this module at all: the combined preview exists to be
// looked at, and the existing FULL/PARTIAL apply remains the only writer.

import "server-only";

import { loadSnoonuSyncContext } from "./sync.server.ts";
import { planSnoonuCombined, type SnoonuCombinedPlan } from "./two-source.ts";
import type { SnoonuSyncRow } from "./sync.ts";

export interface SnoonuSourceInput {
  rows: readonly SnoonuSyncRow[];
  emptySpiRows: readonly number[];
}

/** READ-ONLY combined preview. Returns null only when the catalog read fails. */
export async function previewSnoonuCombined(input: {
  full: SnoonuSourceInput | null;
  bulk: SnoonuSourceInput | null;
}): Promise<SnoonuCombinedPlan | null> {
  if (!input.full && !input.bulk) return null;
  const ctx = await loadSnoonuSyncContext();
  if (!ctx) return null;
  return planSnoonuCombined({
    full: input.full,
    bulk: input.bulk,
    canonical: ctx.canonical,
    listings: ctx.listings,
  });
}
