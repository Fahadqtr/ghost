"use server";

// OPS.2 / MEDIA.1C-HOTFIX2 / MEDIA.2 — Media Center SERVER ACTIONS.
//
// The Media Center orchestrates existing image workflows; it duplicates none.
// HOTFIX2: the batch scan previously delegated to the legacy CH.6B SPI port,
// whose session state() is a hardcoded session_required no-op — so it reported
// SESSION_REQUIRED for every candidate even with a provisioned, CONNECTED
// session. Scan delegates to the LIVE discovery batch (same pipeline as the
// per-product discovery page: configured provider + untouched MEDIA.1B engine).
//
// MEDIA.2: recovery is ONE product per action call. The bulk loop lives in the
// client so the operator gets live progress and cancel-after-current-product;
// each call independently runs the full MEDIA.1C orchestrator (writer gate →
// session re-check → fresh product read → fresh discovery → decision →
// certified media boundary → audit), so one failure never aborts a batch and
// no second/weaker write path exists. These actions add no DB, write, or media
// logic of their own; the client never holds a DB/admin client.

import { revalidatePath } from "next/cache";
import { scanSnoonuMissingImagesLive } from "@/lib/adapters/snoonu/merchant/media-scan.server";
import { recoverSnoonuImage } from "@/lib/adapters/snoonu/merchant/media-recovery.server";
import type { RecoveryOutcome } from "@/lib/adapters/snoonu/merchant/recovery-model";
import {
  SNOONU_STOREFRONT_KEYS,
  type SnoonuStorefrontKey,
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

/**
 * Recover ONE product's image through the MEDIA.1C orchestrator (writer-gated
 * inside; fresh discovery + stale protection + the certified media boundary).
 * `confirmedSpi` pins the previewed candidate: required for a NEEDS_REVIEW
 * approval, identity-pin for a SAFE row — enforced by the pure decision model.
 */
export async function recoverOneSnoonuImageAction(
  storefront: string,
  productId: string,
  confirmedSpi?: string,
): Promise<{ outcome: RecoveryOutcome } | { error: string }> {
  const sf = parseStorefront(storefront);
  if (!sf) return { error: "متجر غير معروف." };
  const id = typeof productId === "string" && productId.trim() !== "" ? productId : null;
  if (!id) return { error: "منتج غير محدد." };
  const spi = typeof confirmedSpi === "string" && confirmedSpi.trim() !== "" ? confirmedSpi : null;

  const outcome = await recoverSnoonuImage({ productId: id, storefrontKey: sf, confirmedSpi: spi });
  if (outcome.status === "RECOVERED") revalidatePath("/v2/operations/media");
  return { outcome };
}
