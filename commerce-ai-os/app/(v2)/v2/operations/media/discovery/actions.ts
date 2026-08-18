"use server";

// MEDIA.1A-P — read-only Connection Manager action. Runs a per-storefront Snoonu
// session test and returns its truthful state. It performs NO write, NO Snoonu
// mutation, and NEVER returns secret material. Signed-in gated (the (v2) layout
// already enforces auth; this re-checks defensively). Storefront is validated and
// isolated — one storefront's secret is never used for the other.

import { isSignedIn } from "@/lib/auth/requireUser";
import { SNOONU_STOREFRONT_KEYS } from "@/lib/adapters/snoonu/merchant/merchant-contract";
import type { SnoonuStorefrontKey } from "@/lib/adapters/snoonu/merchant/merchant-contract";
import { testSnoonuSession } from "@/lib/adapters/snoonu/merchant/session-status.server";
import type { SnoonuSessionStatus } from "@/lib/adapters/snoonu/merchant/session-status";

export async function testSnoonuConnection(storefrontKey: string): Promise<SnoonuSessionStatus> {
  const key = SNOONU_STOREFRONT_KEYS.find((k) => k === storefrontKey) as SnoonuStorefrontKey | undefined;
  if (!key) {
    return { storefrontKey: "snoonu:malikas", state: "ERROR", configured: false, connected: false };
  }
  if (!(await isSignedIn())) {
    return { storefrontKey: key, state: "UNKNOWN", configured: false, connected: false };
  }
  // No confirmed portal contract ⇒ no live reader injected ⇒ SESSION_REQUIRED /
  // UNKNOWN only. Never CONNECTED until a real authenticated read proves it.
  return testSnoonuSession(key);
}
