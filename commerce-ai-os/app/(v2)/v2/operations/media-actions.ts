"use server";

// OPS.2 / MEDIA.1C-HOTFIX2 — Media Center SERVER ACTIONS.
//
// The Media Center orchestrates existing image workflows; it duplicates none.
// HOTFIX2: the batch scan previously delegated to the legacy CH.6B SPI port,
// whose session state() is a hardcoded session_required no-op — so it reported
// SESSION_REQUIRED for every candidate even with a provisioned, CONNECTED
// session. Scan now delegates to the LIVE discovery batch (same pipeline as the
// per-product discovery page: configured provider + untouched MEDIA.1B engine),
// and apply delegates per item to the MEDIA.1C recovery orchestrator
// (writer-gated inside; fresh discovery + stale protection + the certified
// media boundary per product). These actions add no DB, write, or media logic
// of their own; the client never holds a DB/admin client.

import { revalidatePath } from "next/cache";
import { scanSnoonuMissingImagesLive } from "@/lib/adapters/snoonu/merchant/media-scan.server";
import { recoverSnoonuImage } from "@/lib/adapters/snoonu/merchant/media-recovery.server";
import { recoveryOutcomeToApplyResult } from "@/lib/adapters/snoonu/merchant/recovery-model";
import {
  SNOONU_STOREFRONT_KEYS,
  type SnoonuStorefrontKey,
  type ApplyItemResult,
} from "@/lib/adapters/snoonu/merchant/merchant-contract";
import type { MissingImageScanResult } from "@/lib/adapters/snoonu/merchant/missing-image-scan";

function parseStorefront(v: unknown): SnoonuStorefrontKey | null {
  return typeof v === "string" && (SNOONU_STOREFRONT_KEYS as readonly string[]).includes(v) ? (v as SnoonuStorefrontKey) : null;
}

export async function scanSnoonuImageRecoveryAction(storefront: string): Promise<MissingImageScanResult | { error: string }> {
  const sf = parseStorefront(storefront);
  if (!sf) return { error: "متجر غير معروف." };
  return scanSnoonuMissingImagesLive(sf);
}

export async function recoverSnoonuImagesAction(
  storefront: string,
  productIds: string[],
): Promise<{ results: ApplyItemResult[] } | { error: string }> {
  const sf = parseStorefront(storefront);
  if (!sf) return { error: "متجر غير معروف." };
  const ids = Array.isArray(productIds) ? productIds.filter((s) => typeof s === "string" && s) : [];
  if (ids.length === 0) return { error: "لا توجد منتجات محددة." };

  // Per-item recovery through the MEDIA.1C orchestrator: each item gets its own
  // fresh discovery + stale protection; one failure never aborts the batch. The
  // SAFE_MATCH-only rule is enforced by the orchestrator's pure decision model
  // (an ambiguous item comes back NEEDS_REVIEW, never auto-applied).
  const results: ApplyItemResult[] = [];
  for (const id of ids) {
    const outcome = await recoverSnoonuImage({ productId: id, storefrontKey: sf });
    results.push(recoveryOutcomeToApplyResult(id, outcome));
  }
  if (results.some((r) => r.status === "IMPORTED")) revalidatePath("/v2/operations/media");
  return { results };
}
