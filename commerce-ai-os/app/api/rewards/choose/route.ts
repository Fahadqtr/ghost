// Public: a customer who completed their card picks which prize they want.
// Guarded inside lib/loyalty (must be complete + prize must be active).
// Rate-limited per IP before any service-role work. On any business failure we
// return ONE generic error so the response can't be used to tell "unknown
// customer" apart from "card not complete" (no enumeration oracle).
import { chooseReward } from "@/lib/loyalty/rewards";
import { rateLimit, clientIpFrom, runIfAllowed } from "@/lib/ratelimit";
import {
  REWARDS_RATE_LIMIT,
  RATE_LIMITED_MESSAGE,
  REWARD_CHOOSE_GENERIC_ERROR,
  toPublicRewardState,
} from "@/lib/loyalty/rewards-public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ip = clientIpFrom(req.headers.get("x-forwarded-for"), req.headers.get("x-real-ip"));
  return runIfAllowed(
    () => rateLimit("rewards:choose", ip, REWARDS_RATE_LIMIT),
    () => Response.json({ error: RATE_LIMITED_MESSAGE }, { status: 429 }),
    async () => {
      let body: { phone?: string; prizeId?: string };
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "صيغة الطلب غير صحيحة." }, { status: 400 });
      }
      if (!body.prizeId) return Response.json({ error: "اختاري جائزة." }, { status: 400 });

      try {
        const state = await chooseReward(body.phone ?? "", body.prizeId);
        return Response.json({ ok: true, state: toPublicRewardState(state) });
      } catch {
        // Unified generic error — does NOT reveal not-found vs incomplete vs
        // inactive-prize, and never leaks a raw DB/service message.
        return Response.json({ error: REWARD_CHOOSE_GENERIC_ERROR }, { status: 400 });
      }
    }
  );
}
