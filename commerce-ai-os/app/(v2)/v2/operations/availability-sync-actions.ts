"use server";

// CH.6C — Snoonu Availability Sync SERVER ACTIONS.
//
// Thin server-side wrappers over the orchestrator. The scan is read-only and open
// to any signed-in user (preview). The apply is writer-gated inside the
// orchestrator (requireMalakWriter) and applies ONLY through the Availability
// Engine — these actions add no write logic of their own. The client never holds
// a service-role client and never touches the DB directly. Raw errors are mapped
// to a fixed Arabic message by the orchestrator; nothing sensitive is surfaced.

import { revalidatePath } from "next/cache";
import {
  scanSnoonuAvailability,
  applySnoonuAvailability,
  type AvailabilityScanResult,
  type AvailabilityApplyItem,
  type AvailabilityApplySummary,
} from "@/lib/adapters/snoonu/availability/availability-sync.server";
import { type SnoonuStorefrontKey } from "@/lib/adapters/snoonu/merchant/merchant-contract";

const STOREFRONTS: Record<string, SnoonuStorefrontKey> = {
  "snoonu:malikas": "snoonu:malikas",
  "snoonu:pure_seoul": "snoonu:pure_seoul",
};

function parseStorefront(raw: unknown): SnoonuStorefrontKey | null {
  return typeof raw === "string" && raw in STOREFRONTS ? STOREFRONTS[raw] : null;
}

export async function scanSnoonuAvailabilityAction(
  storefront: string,
): Promise<AvailabilityScanResult | { error: string }> {
  const sf = parseStorefront(storefront);
  if (!sf) return { error: "متجر غير صالح." };
  return scanSnoonuAvailability(sf);
}

export async function applySnoonuAvailabilityAction(
  storefront: string,
  selectedProductIds: string[],
): Promise<{ results: AvailabilityApplyItem[]; summary: AvailabilityApplySummary } | { error: string }> {
  const sf = parseStorefront(storefront);
  if (!sf) return { error: "متجر غير صالح." };
  const ids = Array.isArray(selectedProductIds) ? selectedProductIds.filter((s) => typeof s === "string" && s) : [];
  const res = await applySnoonuAvailability(sf, ids);
  if (!("error" in res)) revalidatePath("/v2/operations/availability-sync");
  return res;
}
