// Public: register / look up a rewards customer by phone and return their card
// state (hearts earned, pending screenshots, reward readiness). No auth — this
// is the customer-facing loyalty flow reached from the printed QR. Writes go
// through the service-role client inside lib/loyalty.
import { getOrCreateState } from "@/lib/loyalty/rewards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { name?: string; phone?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "صيغة الطلب غير صحيحة." }, { status: 400 });
  }

  try {
    const state = await getOrCreateState(body.name ?? "", body.phone ?? "");
    return Response.json({ ok: true, state });
  } catch (e: any) {
    return Response.json({ error: e?.message ?? "تعذّرت العملية." }, { status: 400 });
  }
}
