"use server";

// MEDIA.1A-P / MEDIA.1C — Snoonu discovery-page actions.
//   • testSnoonuConnection: READ-ONLY per-storefront session test (no write, no
//     Snoonu mutation, never returns secret material).
//   • recoverImageFromSnoonu: single-product image recovery. The mutation itself
//     lives in the WRITER-GATED orchestrator (media-recovery.server), which
//     re-runs discovery fresh, enforces eligibility/stale protection, and writes
//     ONLY through the certified media boundary. This action just validates the
//     storefront + signed-in state and relays the safe outcome.
// Storefronts are validated and isolated — one storefront's secret/session is
// never used for the other.

import { isSignedIn } from "@/lib/auth/requireUser";
import { SNOONU_STOREFRONT_KEYS } from "@/lib/adapters/snoonu/merchant/merchant-contract";
import type { SnoonuStorefrontKey } from "@/lib/adapters/snoonu/merchant/merchant-contract";
import { testSnoonuSession } from "@/lib/adapters/snoonu/merchant/session-status.server";
import type { SnoonuSessionStatus } from "@/lib/adapters/snoonu/merchant/session-status";
import { recoverSnoonuImage } from "@/lib/adapters/snoonu/merchant/media-recovery.server";
import type { RecoveryOutcome } from "@/lib/adapters/snoonu/merchant/recovery-model";
import { runSnoonuIdentityDiagnostic } from "@/lib/adapters/snoonu/merchant/diagnostics.server";

export async function testSnoonuConnection(storefrontKey: string): Promise<SnoonuSessionStatus> {
  const key = SNOONU_STOREFRONT_KEYS.find((k) => k === storefrontKey) as SnoonuStorefrontKey | undefined;
  if (!key) {
    return { storefrontKey: "snoonu:malikas", state: "ERROR", configured: false, connected: false };
  }
  if (!(await isSignedIn())) {
    return { storefrontKey: key, state: "UNKNOWN", configured: false, connected: false };
  }
  // MEDIA.1A-P2: the default live reader performs a real authenticated read
  // against the VERIFIED portal contract when this storefront's session is
  // provisioned. CONNECTED only ever appears from a proven read.
  return testSnoonuSession(key);
}

/** MEDIA.1C-HOTFIX3 — OWNER-ONLY identity-search diagnostic (read-only; gate inside). */
export async function diagnoseSnoonuIdentityAction(input: {
  productId: string;
  storefrontKey: string;
}): Promise<Awaited<ReturnType<typeof runSnoonuIdentityDiagnostic>>> {
  const key = SNOONU_STOREFRONT_KEYS.find((k) => k === input.storefrontKey) as SnoonuStorefrontKey | undefined;
  if (!key) return { error: "متجر غير معروف." };
  return runSnoonuIdentityDiagnostic(input.productId, key);
}

/** MEDIA.1C — single-product image recovery (writer gate enforced inside). */
export async function recoverImageFromSnoonu(input: {
  productId: string;
  storefrontKey: string;
  confirmedSpi?: string | null;
}): Promise<RecoveryOutcome> {
  const key = SNOONU_STOREFRONT_KEYS.find((k) => k === input.storefrontKey) as SnoonuStorefrontKey | undefined;
  if (!key) return { status: "FAILED", reason: "متجر غير معروف." };
  if (!(await isSignedIn())) return { status: "FAILED", reason: "غير مسجّل الدخول." };
  return recoverSnoonuImage({ productId: input.productId, storefrontKey: key, confirmedSpi: input.confirmedSpi ?? null });
}
