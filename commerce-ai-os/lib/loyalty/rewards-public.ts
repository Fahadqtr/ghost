// Pure, dependency-free decision helpers + constants for the PUBLIC rewards
// endpoints (/api/rewards/*). Deliberately free of any `@/` import and of
// `server-only`, so this module (unlike lib/loyalty/rewards.ts, which pulls in
// the service-role client and WhatsApp) runs under the repo's node:test runner.
// Both the API routes and rewards.ts import these.

/** Per-IP rate-limit budget applied to each public rewards route. */
export const REWARDS_RATE_LIMIT = { limit: 20, windowSec: 300 } as const;

/** Generic, fixed user-facing messages — never expose DB/service errors. */
export const REWARDS_GENERIC_ERROR = "تعذّرت العملية. حاولي مرة أخرى.";
/** Same message for "unknown customer" and "card not complete" — no oracle. */
export const REWARD_CHOOSE_GENERIC_ERROR = "تعذّر إكمال اختيار المكافأة.";
export const RATE_LIMITED_MESSAGE = "طلبات كثيرة. انتظري قليلاً ثم حاولي مرة أخرى.";

/**
 * Decide the stored name when a public /state call arrives:
 * - new phone  → create the customer with the submitted name.
 * - existing   → KEEP the stored name (the public API must not rename an
 *   existing customer); renames happen only from the admin app.
 */
export function planCustomerName(
  existing: { name: string } | null,
  submittedName: string
): { action: "create" | "keep"; name: string } {
  if (!existing) return { action: "create", name: submittedName };
  return { action: "keep", name: existing.name };
}

/**
 * Only write + notify when the customer actually changes their chosen prize.
 * Re-choosing the same prize is a no-op (idempotent → no duplicate WhatsApp).
 */
export function shouldApplyPrizeChange(
  currentPrizeId: string | null | undefined,
  requestedPrizeId: string
): boolean {
  return (currentPrizeId ?? null) !== requestedPrizeId;
}

/** The minimal reward state the public /rewards client consumes. */
export type PublicRewardState = {
  name: string;
  phone: string;
  stamps: number;
  required: number;
  rewardReady: boolean;
  pending: number;
  lastStatus: string | null;
  prizes: { id: string; name: string; imageUrl: string }[];
  chosenPrizeId: string | null;
  voucherCode: string | null;
};

/** Shape accepted by the projection (structural subset of RewardState). */
export type FullRewardStateInput = PublicRewardState & { cyclesCompleted: number };

/**
 * Project the internal reward state to the public response.
 * - DROPS `cyclesCompleted` (the client UI never reads it).
 * - `voucherCode` is returned ONLY when the card is complete (`rewardReady`).
 * - `name` and `phone` are RETAINED: the client greeting shows `state.name`,
 *   and its submit/choose calls read `state.phone` (RewardsClient.tsx). Removing
 *   them would break the current UI, so they stay (documented, not accidental).
 */
export function toPublicRewardState(s: FullRewardStateInput): PublicRewardState {
  return {
    name: s.name,
    phone: s.phone,
    stamps: s.stamps,
    required: s.required,
    rewardReady: s.rewardReady,
    pending: s.pending,
    lastStatus: s.lastStatus,
    prizes: s.prizes,
    chosenPrizeId: s.chosenPrizeId,
    voucherCode: s.rewardReady ? s.voucherCode : null,
  };
}
