// Public: register / look up a rewards customer by phone and return their card
// state (hearts earned, pending screenshots, reward readiness). No auth — this
// is the customer-facing loyalty flow reached from the printed QR. Every call
// is rate-limited per IP BEFORE any service-role work, and errors/response are
// kept generic + minimal. Writes go through the service-role client in lib.
import { getOrCreateState } from "@/lib/loyalty/rewards";
import { rateLimit, clientIpFrom, runIfAllowed } from "@/lib/ratelimit";
import {
  REWARDS_RATE_LIMIT,
  RATE_LIMITED_MESSAGE,
  REWARDS_GENERIC_ERROR,
  toPublicRewardState,
} from "@/lib/loyalty/rewards-public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ip = clientIpFrom(req.headers.get("x-forwarded-for"), req.headers.get("x-real-ip"));
  return runIfAllowed(
    () => rateLimit("rewards:state", ip, REWARDS_RATE_LIMIT),
    () => Response.json({ error: RATE_LIMITED_MESSAGE }, { status: 429 }),
    async () => {
      let body: { name?: string; phone?: string };
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "صيغة الطلب غير صحيحة." }, { status: 400 });
      }

      try {
        const state = await getOrCreateState(body.name ?? "", body.phone ?? "");
        return Response.json({ ok: true, state: toPublicRewardState(state) });
      } catch {
        // Never surface a raw DB/service message.
        return Response.json({ error: REWARDS_GENERIC_ERROR }, { status: 400 });
      }
    }
  );
}
