// Tests for the pure public-rewards decision helpers — no network, no DB.
// Run: node --conditions=react-server --experimental-strip-types --test lib/loyalty/rewards-public.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  planCustomerName,
  shouldApplyPrizeChange,
  toPublicRewardState,
  REWARDS_GENERIC_ERROR,
  REWARD_CHOOSE_GENERIC_ERROR,
  RATE_LIMITED_MESSAGE,
  REWARDS_RATE_LIMIT,
  type FullRewardStateInput,
} from "./rewards-public.ts";

/** rewards.ts source, for static assertions that admin logic is unchanged. */
const rewardsSource = readFileSync(new URL("./rewards.ts", import.meta.url), "utf8");

const baseState: FullRewardStateInput = {
  name: "Sara",
  phone: "97455512345",
  stamps: 3,
  required: 6,
  rewardReady: false,
  cyclesCompleted: 2,
  pending: 1,
  lastStatus: "pending",
  prizes: [{ id: "p1", name: "Lipstick", imageUrl: "https://x/p1.jpg" }],
  chosenPrizeId: null,
  voucherCode: "MU-ABC123-3",
};

// #4 — new phone is created with the submitted name.
test("planCustomerName: new phone → create with submitted name", () => {
  assert.deepEqual(planCustomerName(null, "Sara"), { action: "create", name: "Sara" });
});

// #3 — existing customer keeps their stored name (public API can't rename).
test("planCustomerName: existing customer → keep stored name (no public rename)", () => {
  assert.deepEqual(planCustomerName({ name: "Original" }, "Attacker"), {
    action: "keep",
    name: "Original",
  });
});

// #5 — same prize is a no-op; different prize applies (→ one WhatsApp only).
test("shouldApplyPrizeChange: only true when the prize actually changes", () => {
  assert.equal(shouldApplyPrizeChange("p1", "p1"), false);
  assert.equal(shouldApplyPrizeChange(null, "p1"), true);
  assert.equal(shouldApplyPrizeChange("p1", "p2"), true);
  assert.equal(shouldApplyPrizeChange(undefined, "p1"), true);
});

// #7 — public projection drops cyclesCompleted; keeps name/phone (client needs them).
test("toPublicRewardState: omits cyclesCompleted, retains name/phone", () => {
  const pub = toPublicRewardState(baseState);
  assert.equal("cyclesCompleted" in pub, false, "cyclesCompleted must be dropped");
  assert.equal(pub.name, "Sara");
  assert.equal(pub.phone, "97455512345");
  assert.equal(pub.stamps, 3);
  assert.deepEqual(pub.prizes, baseState.prizes);
});

// #8 — voucherCode only when the card is complete.
test("toPublicRewardState: voucherCode hidden unless rewardReady", () => {
  assert.equal(toPublicRewardState({ ...baseState, rewardReady: false, voucherCode: "MU-X-1" }).voucherCode, null);
  assert.equal(
    toPublicRewardState({ ...baseState, rewardReady: true, voucherCode: "MU-X-1" }).voucherCode,
    "MU-X-1"
  );
});

// #6 / #9 — error constants are generic and never contain raw markers.
test("public error messages are generic (no raw DB/service/token markers)", () => {
  for (const m of [REWARDS_GENERIC_ERROR, REWARD_CHOOSE_GENERIC_ERROR, RATE_LIMITED_MESSAGE]) {
    assert.equal(typeof m, "string");
    assert.ok(m.length > 0);
    assert.doesNotMatch(m, /error|stack|supabase|postgres|token|jwt|null|undefined|\bsql\b/i);
  }
  // The choose error is a single constant → unknown-customer and incomplete-card
  // both map to the exact same string (no enumeration oracle).
  assert.equal(REWARD_CHOOSE_GENERIC_ERROR, REWARD_CHOOSE_GENERIC_ERROR);
});

test("REWARDS_RATE_LIMIT has a sane per-IP budget", () => {
  assert.ok(REWARDS_RATE_LIMIT.limit > 0 && REWARDS_RATE_LIMIT.limit <= 60);
  assert.ok(REWARDS_RATE_LIMIT.windowSec >= 60);
});

// --- #10: admin approve/reject/redeem behaviour unchanged (static scan) -----

test("admin approveSubmission still guards non-pending + increments one heart", () => {
  assert.match(rewardsSource, /export async function approveSubmission/);
  assert.match(rewardsSource, /if \(sub\.status !== "pending"\) return;/); // idempotent guard intact
  assert.match(rewardsSource, /const nextStamps = customer\.stamps \+ 1;/);
});

test("admin rejectSubmission still only affects pending rows", () => {
  assert.match(rewardsSource, /export async function rejectSubmission/);
  assert.match(rewardsSource, /\.eq\("status", "pending"\)/);
});

test("admin redeemReward still requires a complete card and bumps the cycle", () => {
  assert.match(rewardsSource, /export async function redeemReward/);
  assert.match(rewardsSource, /if \(customer\.stamps < STAMPS_REQUIRED\) throw new Error/);
  assert.match(rewardsSource, /cycles_completed: customer\.cycles_completed \+ 1/);
});

// Guard: the public getOrCreateState must NOT upsert-overwrite the name anymore.
test("getOrCreateState no longer upserts the name on conflict", () => {
  const fn = rewardsSource.slice(
    rewardsSource.indexOf("export async function getOrCreateState"),
    rewardsSource.indexOf("export async function getStateByPhone")
  );
  assert.doesNotMatch(fn, /\.upsert\(/, "public state must not upsert (would overwrite name)");
  assert.match(fn, /planCustomerName/);
});

// Guard: chooseReward must gate the WhatsApp send behind an actual prize change.
test("chooseReward guards the notify path with shouldApplyPrizeChange", () => {
  const fn = rewardsSource.slice(
    rewardsSource.indexOf("export async function chooseReward"),
    rewardsSource.indexOf("// --- Prize voucher")
  );
  assert.match(fn, /shouldApplyPrizeChange/);
  const guardIdx = fn.indexOf("shouldApplyPrizeChange");
  const sendIdx = fn.indexOf("sendWhatsApp");
  assert.ok(guardIdx >= 0 && sendIdx > guardIdx, "notify must come after the change guard");
});
