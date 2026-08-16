"use server";

// CH.6D — Snoonu Barcode Completion SERVER ACTIONS.
//
// Thin server-side wrappers over the orchestrator. The scan is read-only and open
// to any signed-in user (preview). The apply is writer-gated inside the
// orchestrator (requireMalakWriter) and writes ONLY through the narrow Catalog
// barcode boundary — these actions add no write logic of their own. The client
// never holds a service-role client and never touches the DB directly.

import { revalidatePath } from "next/cache";
import {
  scanBarcodeCompletion,
  applyBarcodeCompletion,
  type BarcodeScanResult,
  type BarcodeApplyItem,
  type BarcodeApplySummary,
} from "@/lib/adapters/snoonu/barcode/barcode-completion.server";

export async function scanBarcodeCompletionAction(): Promise<BarcodeScanResult | { error: string }> {
  return scanBarcodeCompletion();
}

export async function applyBarcodeCompletionAction(
  selectedKeys: string[],
): Promise<{ results: BarcodeApplyItem[]; summary: BarcodeApplySummary } | { error: string }> {
  const keys = Array.isArray(selectedKeys) ? selectedKeys.filter((s) => typeof s === "string" && s) : [];
  const res = await applyBarcodeCompletion(keys);
  if (!("error" in res)) revalidatePath("/v2/operations/barcode-completion");
  return res;
}
