"use server";

// OPS.2 — Media Center SERVER ACTIONS.
//
// The Media Center orchestrates existing image workflows; it duplicates none. The
// recovery actions are thin wrappers that DELEGATE to the CH.6B Snoonu image
// recovery orchestrator (scan is read-only + signed-in; apply is writer-gated
// INSIDE the orchestrator and routes writes through the approved media boundary).
// Manual upload / gallery management reuse the existing per-product media editor
// (linked from the UI), so no upload logic lives here. These actions add no DB,
// write, or media logic of their own; the client never holds a DB/admin client.

import { revalidatePath } from "next/cache";
import {
  scanSnoonuMissingImages,
  applySnoonuImageImports,
} from "@/lib/adapters/snoonu/merchant/image-recovery.server";
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
  return scanSnoonuMissingImages(sf);
}

export async function recoverSnoonuImagesAction(
  storefront: string,
  productIds: string[],
): Promise<{ results: ApplyItemResult[] } | { error: string }> {
  const sf = parseStorefront(storefront);
  if (!sf) return { error: "متجر غير معروف." };
  const ids = Array.isArray(productIds) ? productIds.filter((s) => typeof s === "string" && s) : [];
  if (ids.length === 0) return { error: "لا توجد منتجات محددة." };
  const res = await applySnoonuImageImports(sf, ids);
  if (!("error" in res)) revalidatePath("/v2/operations/media");
  return res;
}
